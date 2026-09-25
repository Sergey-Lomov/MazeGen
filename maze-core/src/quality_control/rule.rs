use super::apply_commands::{ApplyOutcome, apply_commands, qc_event_proposed_for_command};
use super::check::Check;
use super::event::QcEvent;
use super::issue::{Issue, IssueMerge, IssueRequirement};
use crate::Maze;
use crate::event_log::ScopeGuard;
use crate::generation::PresetState;
use crate::repair::{
    NestedStrategyConfig, RepairResult, RepairStrategy,
    params::{StrategyParams, build_params},
};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

/// One rule's strategy assignment — checks + strategy + resolved params/requirement, held
/// together so `Rule` can dispatch repair by itself. `None` on `Rule::strategy` (not this type)
/// means "no_fix". `params`/`requirement` are resolved once in `Rule::new` (not `param_overrides`
/// kept around raw) — see GitHub issue #105: both are pure functions of `strategy`+
/// `param_overrides`, computed once and reused by every `check_and_repair_typed` call instead of
/// rebuilt per call.
struct RuleStrategy<T: Tessellation, I: IssueRequirement + IssueMerge> {
    strategy: Box<dyn RepairStrategy<T, I>>,
    nested: Vec<NestedStrategyConfig<T>>,
    params: StrategyParams,
    requirement: I::Requirement,
}

/// What happened when `Rule::check_and_repair_typed` ran this rule for one fixpoint iteration —
/// the issue itself never crosses back out to the caller (GitHub issue #170's Stage/Rule
/// simplification: the check→strategy pipeline is now fully internal to `Rule`, not surfaced as a
/// `Box<dyn Issue>` the caller has to hold onto between a check step and a dispatch step).
pub enum RuleIterationOutcome {
    /// No check in this rule found anything this iteration.
    NoIssue,
    /// A check found an issue, but this rule has no registered strategy ("no_fix") — nothing to
    /// dispatch.
    NoStrategy,
    /// A check found an issue and this rule's strategy was dispatched against it.
    Repaired(RepairResult, ApplyOutcome),
}

/// A user-defined QC rule: a set of checks producing one `Issue` type `I`, driving its own check
/// dispatch, issue merge, and (if configured) repair dispatch. `I` is fixed at the type level —
/// there is no runtime `kind` field to independently agree with, and no possibility of
/// constructing a `Rule` whose checks disagree on kind (see GitHub issue #113): every `Box<dyn
/// Check<T, I>>` in `checks` and the one `Box<dyn RepairStrategy<T, I>>` in `strategy` are all
/// generic over the exact same `I`.
///
pub struct Rule<T: Tessellation, I: IssueRequirement + IssueMerge> {
    pub id: String,
    checks: Vec<(String, Box<dyn Check<T, I>>)>,
    strategy: Option<RuleStrategy<T, I>>,
}

impl<T: Tessellation, I: IssueRequirement + IssueMerge> Rule<T, I> {
    pub fn new(
        id: String,
        checks: Vec<(String, Box<dyn Check<T, I>>)>,
        strategy: Option<Box<dyn RepairStrategy<T, I>>>,
        param_overrides: HashMap<String, String>,
        nested: Vec<NestedStrategyConfig<T>>,
    ) -> Self {
        let strategy = strategy.map(|strategy| {
            let params = build_params(strategy.params(), Some(&param_overrides));
            let requirement = strategy.requirement(&params);
            RuleStrategy {
                strategy,
                nested,
                params,
                requirement,
            }
        });
        Self {
            id,
            checks,
            strategy,
        }
    }

    /// `(local_id, &dyn Check<T, I>)` pairs, in the order checks were configured.
    pub fn checks(&self) -> impl Iterator<Item = (&str, &dyn Check<T, I>)> {
        self.checks
            .iter()
            .map(|(local_id, check)| (local_id.as_str(), check.as_ref()))
    }

    pub fn has_strategy(&self) -> bool {
        self.strategy.is_some()
    }

    /// Runs every check in this rule via `Check::repair_check`, folding all raw issues into at
    /// most one merged issue via `IssueMerge::merge` — the per-rule concern issue #106 calls out
    /// ("gives rule-level issue merging a natural home"). Returns `None` if no check in this rule
    /// found anything this call. `pub` so tests can exercise per-rule check-merge behavior
    /// directly, without needing a real repair dispatch.
    ///
    /// `event_log` (GitHub issue #147) emits one `QcEvent::CheckRan` per check, each carrying that
    /// check's own raw (pre-merge) issue if any — resolved against the same `maze`/graph the check
    /// itself just ran against, via `resolve_issue_payload` (this crate's shared payload resolver;
    /// see `issue_payload.rs`). When two or more checks in this rule each contribute a raw issue,
    /// one `QcEvent::IssuesMerged` is emitted after the per-check events, once merging has actually
    /// combined them — a rule with only one contributing check never emits it.
    pub fn run_checks_typed(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        mut event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
    ) -> Option<I> {
        // Resolved once per call (not per check) from the bound strategy's cached requirement —
        // no_fix (no strategy) falls back to the default (all()), same as an unmigrated check
        // always got before this mechanism existed. See GitHub issue #105.
        let requirement = self
            .strategy
            .as_ref()
            .map(|s| s.requirement)
            .unwrap_or_default();
        // Built once, only when narration is actually on — `resolve_issue_payload` is the only
        // consumer, and most issue kinds don't even need it (see its own doc comment).
        let scc = event_log
            .is_some()
            .then(|| crate::graph::scc::build_scc(&maze.graph));
        // Instance id -> type id, exposed to the frontend via `IssueDto::source_check_types` (see
        // `maze-wasm/src/analytics/snapshot.rs`) and needed by `resolve_issue_payload`'s
        // `resolve_edge_group_map` (via `resolvers::is_batch_edge_group_type`) to tell a batch
        // check (e.g. `max_teleport_count`) apart from a proximity/pair-style one sharing the same
        // resolver — only this rule's own checks (their type id is only known here, via
        // `Check::check_type_id`), same lazy-build rationale as `scc` above.
        let check_types: Option<HashMap<String, String>> = event_log.is_some().then(|| {
            self.checks
                .iter()
                .map(|(local_id, check)| {
                    (
                        format!("{}:{}", self.id, local_id),
                        check.check_type_id().to_string(),
                    )
                })
                .collect()
        });

        let mut merged: Option<I> = None;
        let mut contributing_checks = 0u32;
        for (local_id, check) in &self.checks {
            // The composite routing key `Issue::details()`/`source_checks()` are keyed by (see
            // `issue.rs`'s doc comment on `new_from_check`) — mirrors `composite_check_id` in
            // `maze-runner/src/runner/check_factory.rs`, which built this same string once, at
            // construction time, to seed each `Check`'s own `instance_id` field; `self.checks`
            // only carries the plain `local_id` half of that (see `rule_factory.rs`'s
            // `build_rule_for!`), so it must be re-derived here rather than read off the tuple
            // directly — `maze-core` has no dependency on `maze-runner` to call the same helper.
            let instance_id = format!("{}:{}", self.id, local_id);
            let issues = timed(timing, check.check_type_id(), now_ms, || {
                let mut v = Vec::new();
                check.repair_check(maze, &mut v, rng, requirement);
                v
            });
            let check_issue = issues.into_iter().reduce(|mut acc, issue| {
                acc.merge(issue);
                acc
            });
            if let Some(log) = event_log.as_mut() {
                let payload = check_issue.as_ref().map(|issue| {
                    let payload = super::issue_payload::resolve_issue_payload(
                        issue,
                        &maze.graph,
                        &maze.field,
                        scc.as_ref().unwrap(),
                        preset_state,
                        check_types.as_ref(),
                    );
                    let details = issue
                        .details()
                        .get(instance_id.as_str())
                        .cloned()
                        .unwrap_or_default();
                    (I::KIND, payload, details)
                });
                log.emit(QcEvent::CheckRan {
                    check_id: instance_id,
                    issue: payload,
                });
            }
            if let Some(issue) = check_issue {
                contributing_checks += 1;
                match &mut merged {
                    None => merged = Some(issue),
                    Some(existing) => existing.merge(issue),
                }
            }
        }
        if contributing_checks > 1
            && let Some(log) = event_log.as_mut()
        {
            let payload = merged
                .as_ref()
                .map(|issue| {
                    super::issue_payload::resolve_issue_payload(
                        issue,
                        &maze.graph,
                        &maze.field,
                        scc.as_ref().unwrap(),
                        preset_state,
                        check_types.as_ref(),
                    )
                })
                .unwrap_or_default();
            let details = merged
                .as_ref()
                .map(|issue| issue.details().clone())
                .unwrap_or_default();
            log.emit(QcEvent::IssuesMerged {
                issue_kind: I::KIND,
                payload,
                details,
            });
        }
        merged
    }

    /// Runs this rule's checks (`run_checks_typed`) then, if a check found anything and this rule
    /// has a registered strategy, dispatches repair against it immediately and applies the
    /// returned commands (see `apply_commands` above) — the Rule-level commit point
    /// `Specs/repair.md` specifies, not batched across the whole `Stage`. The merged issue never
    /// leaves this call — see GitHub issue #170: the check→strategy pipeline is fully internal to
    /// `Rule` from the caller's perspective (the erased `RuleTrait::check_and_repair` entry point
    /// below never sees a `Box<dyn Issue>`), unlike the pre-#170 split, where `Stage` held the
    /// issue between a separate `run_checks`/`dispatch_repair` call pair.
    ///
    /// `per_check`/`per_strategy` accumulate this call's own check/strategy timing — the caller
    /// (`Stage::check_and_dispatch`) folds them into this rule's own `TimingNode` in the
    /// hierarchical tree (see GitHub issue #285, `GenerationTiming::qc`), keyed by this rule's
    /// `self.id`.
    ///
    /// `event_log` (GitHub issue #147): the dispatched strategy gets its own nested `"strategy
    /// <id>"` scope, holding one `QcEvent::*Proposed` per command the strategy's `apply()`
    /// returned — narrating what was *asked for*, before any of it has been revalidated or
    /// applied (a strategy never mutates `Maze` itself, see `RepairStrategy::apply`'s doc comment
    /// — it only proposes `MutationCommand`s). When `commands` is non-empty, a second, separate
    /// `"apply requests"` scope follows (a sibling of `"strategy <id>"`, not nested inside it),
    /// holding the mutating/`*Declined` events `apply_commands` emits for this same batch. No
    /// `"apply requests"` scope is opened when `commands` is empty (a strategy that proposed
    /// nothing has nothing to apply). Its own applied/proposed outcome is narrated by resolving
    /// the scope's *label* from its children's mutating-vs-`*Declined` counts (mirrors
    /// `CustomVertexBased`'s `"junction_count"` scope label — see `algorithmRegistry.ts`'s
    /// `scopeLabel`) rather than a dedicated summary event — there is no `QcEvent` carrying
    /// `proposed`/`applied` directly. What a strategy itself narrates *inside* its own `"strategy
    /// <id>"` scope beyond the `*Proposed` line (e.g. per-strategy decision events) is each
    /// strategy's own concern, added issue-by-issue in later tickets.
    #[allow(clippy::too_many_arguments)]
    pub fn check_and_repair_typed(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        mut event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
        mut debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> RuleIterationOutcome {
        let issue = self.run_checks_typed(
            maze,
            rng,
            preset_state,
            per_check,
            now_ms,
            event_log.as_deref_mut(),
        );
        let Some(issue) = issue else {
            return RuleIterationOutcome::NoIssue;
        };
        let Some(rule_strategy) = self.strategy.as_ref() else {
            return RuleIterationOutcome::NoStrategy;
        };

        let (result, commands) = timed(
            per_strategy,
            rule_strategy.strategy.strategy_id(),
            now_ms,
            || {
                rule_strategy.strategy.apply(
                    &issue,
                    maze,
                    rng,
                    &rule_strategy.params,
                    preset_state,
                    &rule_strategy.nested,
                )
            },
        );

        {
            let mut strategy_scope = event_log
                .as_mut()
                .map(|log| log.enter(format!("strategy {}", rule_strategy.strategy.strategy_id())));
            if let Some(scope) = strategy_scope.as_mut() {
                for cmd in &commands {
                    if let Some(event) = qc_event_proposed_for_command(cmd, maze) {
                        scope.emit(event);
                    }
                }
                if matches!(result, RepairResult::Failed) {
                    scope.emit(QcEvent::StrategyFailed {
                        strategy_id: rule_strategy.strategy.strategy_id(),
                    });
                }
            }
        }

        let outcome = if commands.is_empty() {
            apply_commands(
                maze,
                preset_state,
                commands,
                None,
                debug_state.as_deref_mut(),
            )
        } else {
            let mut apply_scope = event_log.as_mut().map(|log| log.enter("apply requests"));
            apply_commands(
                maze,
                preset_state,
                commands,
                apply_scope.as_mut(),
                debug_state,
            )
        };
        RuleIterationOutcome::Repaired(result, outcome)
    }

    /// Runs every check in this rule via `Check::report_check` — one issue per flagged problem
    /// instance, no merge (see GitHub issue #102).
    pub fn report_checks_typed(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
    ) -> Vec<I> {
        let mut issues = Vec::new();
        for (_, check) in &self.checks {
            let mut found = timed(timing, check.check_type_id(), now_ms, || {
                check.report_check(maze, rng)
            });
            issues.append(&mut found);
        }
        issues
    }
}

/// Type-erased view of `Rule<T, I>` for the one place genuine cross-`I` heterogeneity is
/// unavoidable: `Stage.rules` (a `Stage` deliberately groups rules of different kinds together —
/// see GitHub issue #113). The check→strategy pipeline itself never crosses this boundary — `I`
/// stays entirely inside `Rule::check_and_repair_typed` (see GitHub issue #170); `check_and_repair`
/// below is the only erased entry point into it.
pub trait RuleTrait<T: Tessellation> {
    fn id(&self) -> &str;
    fn report_checks(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
    ) -> Vec<Box<dyn Issue>>;
    #[allow(clippy::too_many_arguments)]
    fn check_and_repair(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
        debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> RuleIterationOutcome;
}

impl<T: Tessellation, I: IssueRequirement + IssueMerge + 'static> RuleTrait<T> for Rule<T, I> {
    fn id(&self) -> &str {
        &self.id
    }

    fn report_checks(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
    ) -> Vec<Box<dyn Issue>> {
        self.report_checks_typed(maze, rng, timing, now_ms)
            .into_iter()
            .map(|i| Box::new(i) as Box<dyn Issue>)
            .collect()
    }

    fn check_and_repair(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
        debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> RuleIterationOutcome {
        self.check_and_repair_typed(
            maze,
            rng,
            preset_state,
            per_check,
            per_strategy,
            now_ms,
            event_log,
            debug_state,
        )
    }
}

/// Times one `f` call, accumulating elapsed milliseconds and call count under `check_type_id` —
/// shared by `run_checks_typed`/`report_checks_typed`, the two call sites whose only difference is
/// which `Check` method they invoke (`repair_check`'s out-parameter vs `report_check`'s return
/// value), not worth unifying behind a generic per-check callback for just two call sites.
fn timed<R>(
    timing: &mut HashMap<&'static str, (f64, u32)>,
    check_type_id: &'static str,
    now_ms: &dyn Fn() -> f64,
    f: impl FnOnce() -> R,
) -> R {
    let start = now_ms();
    let result = f();
    let elapsed = now_ms() - start;
    let entry = timing.entry(check_type_id).or_insert((0.0, 0));
    entry.0 += elapsed;
    entry.1 += 1;
    result
}

/// See GitHub issue #105 — proves `Rule::new` resolves a strategy's `requirement()` once and
/// `run_checks_typed` actually threads that exact value into every `Check::repair_check` call in
/// the rule, rather than defaulting to `I::Requirement::default()` or resolving it again per call.
#[cfg(test)]
#[path = "requirement_wiring_tests.rs"]
mod requirement_wiring_tests;
