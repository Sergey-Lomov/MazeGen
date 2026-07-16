use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::{RepairStrategy, RepairResult, NestedStrategyConfig, MutationCommand, params::{build_params, StrategyParams}};
use crate::event_log::ScopeGuard;
use super::check::Check;
use super::event::QcEvent;
use super::issue::{Issue, IssueRequirement, IssueMerge};

/// How many of a strategy's proposed `MutationCommand`s actually applied — see GitHub issue #118,
/// `Specs/repair.md`. Carried on `RuleIterationOutcome::Repaired` back to the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ApplyOutcome {
    pub proposed: usize,
    pub applied: usize,
}

/// Applies `commands` to the real `maze`, revalidating each one right before it's applied and
/// silently dropping it (not an error, doesn't change the caller's `RepairResult`) if it no longer
/// holds — see `Specs/repair.md`'s "Where commands are applied and revalidated". Contains no
/// feasibility logic of its own: every arm calls the same `try_*` helper `generation::mod`'s
/// `cmd_*` builders already use internally, so construction-time and apply-time feasibility can
/// never disagree (see `MutationCommand`'s own doc comment).
///
/// `pub` (not `pub(crate)`) so integration tests (`maze-core/tests/*.rs`, a separate crate) can
/// exercise the same apply-then-commit sequencing `Rule::check_and_repair_typed` uses internally.
///
/// `event_log` (GitHub issue #147) emits one `QcEvent` per command, in the same order commands are
/// applied — the mutating mirror variant when `ok == true`, the matching `*Declined` trace variant
/// (same fields) when `ok == false`. Emitted here, not by the caller, because this function is the
/// only place that knows both the command's real fields (already at hand from the `match`) and its
/// actual revalidation outcome — a caller re-deriving that from `ApplyOutcome`'s aggregate counts
/// couldn't tell *which* command in the batch was declined.
pub fn apply_commands<T: Tessellation>(
    maze: &mut Maze<T>,
    preset_state: &PresetState,
    commands: Vec<MutationCommand>,
    mut event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
) -> ApplyOutcome {
    let proposed = commands.len();
    let mut applied = 0;
    for cmd in commands {
        let ok = match cmd {
            MutationCommand::AddDirectedEdge { from, to } =>
                crate::generation::try_add_directed_edge(&mut maze.graph, from, to, preset_state),
            MutationCommand::AddBidirectionalEdge { a, b } =>
                crate::generation::try_add_bidirectional_edge(&mut maze.graph, a, b, preset_state),
            MutationCommand::AddDirectedTeleport { from, to } =>
                crate::generation::try_add_directed_teleport(&mut maze.graph, from, to, preset_state),
            MutationCommand::AddBidirectionalTeleport { a, b } =>
                crate::generation::try_add_bidirectional_teleport(&mut maze.graph, a, b, preset_state),
            MutationCommand::RemoveEdge { id } =>
                crate::generation::try_remove_edge_by_id(&mut maze.graph, id, preset_state),
            MutationCommand::RemoveEdgeBetween { from, to } =>
                crate::generation::try_remove_edge(&mut maze.graph, from, to, preset_state),
            MutationCommand::RemoveTeleportWithReverse { id } =>
                !crate::generation::try_remove_teleport_with_reverse(&mut maze.graph, id, preset_state).is_empty(),
            MutationCommand::SetStart(node) => {
                if maze.meta.start.is_none() { maze.meta.start = Some(node); }
                true
            }
            MutationCommand::SetFinish(node) => {
                if maze.meta.finish.is_none() { maze.meta.finish = Some(node); }
                true
            }
        };
        if ok { applied += 1; }
        if let Some(log) = event_log.as_mut() {
            log.emit(qc_event_for_command(&cmd, ok));
        }
    }
    ApplyOutcome { proposed, applied }
}

/// Builds the `QcEvent` mirroring `cmd` — the mutating variant when `applied`, the matching
/// `*Declined` trace variant (same fields) otherwise. See `apply_commands`'s doc comment.
fn qc_event_for_command(cmd: &MutationCommand, applied: bool) -> QcEvent {
    match (cmd, applied) {
        (MutationCommand::AddDirectedEdge { from, to }, true) => QcEvent::DirectedEdgeAdded { from: *from, to: *to },
        (MutationCommand::AddDirectedEdge { from, to }, false) => QcEvent::DirectedEdgeDeclined { from: *from, to: *to },
        (MutationCommand::AddBidirectionalEdge { a, b }, true) => QcEvent::BidirectionalEdgeAdded { a: *a, b: *b },
        (MutationCommand::AddBidirectionalEdge { a, b }, false) => QcEvent::BidirectionalEdgeDeclined { a: *a, b: *b },
        (MutationCommand::AddDirectedTeleport { from, to }, true) => QcEvent::DirectedTeleportAdded { from: *from, to: *to },
        (MutationCommand::AddDirectedTeleport { from, to }, false) => QcEvent::DirectedTeleportDeclined { from: *from, to: *to },
        (MutationCommand::AddBidirectionalTeleport { a, b }, true) => QcEvent::BidirectionalTeleportAdded { a: *a, b: *b },
        (MutationCommand::AddBidirectionalTeleport { a, b }, false) => QcEvent::BidirectionalTeleportDeclined { a: *a, b: *b },
        (MutationCommand::RemoveEdge { id }, true) => QcEvent::EdgeRemoved { id: *id },
        (MutationCommand::RemoveEdge { id }, false) => QcEvent::EdgeRemoveDeclined { id: *id },
        (MutationCommand::RemoveEdgeBetween { from, to }, true) => QcEvent::EdgeRemovedBetween { from: *from, to: *to },
        (MutationCommand::RemoveEdgeBetween { from, to }, false) => QcEvent::EdgeRemoveBetweenDeclined { from: *from, to: *to },
        (MutationCommand::RemoveTeleportWithReverse { id }, true) => QcEvent::TeleportRemovedWithReverse { id: *id },
        (MutationCommand::RemoveTeleportWithReverse { id }, false) => QcEvent::TeleportRemoveWithReverseDeclined { id: *id },
        (MutationCommand::SetStart(node), true) => QcEvent::StartSet(*node),
        (MutationCommand::SetStart(node), false) => QcEvent::StartSetDeclined(*node),
        (MutationCommand::SetFinish(node), true) => QcEvent::FinishSet(*node),
        (MutationCommand::SetFinish(node), false) => QcEvent::FinishSetDeclined(*node),
    }
}

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
            RuleStrategy { strategy, nested, params, requirement }
        });
        Self { id, checks, strategy }
    }

    /// `(local_id, &dyn Check<T, I>)` pairs, in the order checks were configured.
    pub fn checks(&self) -> impl Iterator<Item = (&str, &dyn Check<T, I>)> {
        self.checks.iter().map(|(local_id, check)| (local_id.as_str(), check.as_ref()))
    }

    pub fn has_strategy(&self) -> bool {
        self.strategy.is_some()
    }

    /// Runs every check in this rule via `Check::repair_check`, folding all raw issues into at
    /// most one merged issue via `IssueMerge::merge` — the per-rule concern issue #106 calls out
    /// ("gives rule-level issue merging a natural home"). Returns `None` if no check in this rule
    /// found anything this call. `pub` so tests can exercise per-rule check-merge behavior
    /// directly, without needing a real repair dispatch.
    pub fn run_checks_typed(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
    ) -> Option<I> {
        // Resolved once per call (not per check) from the bound strategy's cached requirement —
        // no_fix (no strategy) falls back to the default (all()), same as an unmigrated check
        // always got before this mechanism existed. See GitHub issue #105.
        let requirement = self.strategy.as_ref()
            .map(|s| s.requirement)
            .unwrap_or_default();
        let mut merged: Option<I> = None;
        for (_, check) in &self.checks {
            let issues = timed(timing, check.check_type_id(), now_ms, || {
                let mut v = Vec::new();
                check.repair_check(maze, &mut v, rng, requirement);
                v
            });
            for issue in issues {
                match &mut merged {
                    None => merged = Some(issue),
                    Some(existing) => existing.merge(issue),
                }
            }
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
    /// `per_check`/`per_strategy` are separate accumulators (not one shared map) so
    /// `GenerationTiming.per_check`/`per_strategy` stay distinct on the caller side, matching the
    /// pre-#170 split where `Stage` timed `collect_active`/`dispatch` independently. `qc_ms`/
    /// `repair_ms` accumulate this call's own elapsed time into the caller's stage-level totals
    /// (`GenerationTiming.qc_total_ms`/`repair_total_ms`) — split the same way: `qc_ms` covers
    /// `run_checks_typed`, `repair_ms` covers `apply`+`apply_commands`.
    pub fn check_and_repair_typed(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        qc_ms: &mut f64,
        repair_ms: &mut f64,
        now_ms: &dyn Fn() -> f64,
        event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
    ) -> RuleIterationOutcome {
        let qc_start = now_ms();
        let issue = self.run_checks_typed(maze, rng, per_check, now_ms);
        *qc_ms += now_ms() - qc_start;
        let Some(issue) = issue else { return RuleIterationOutcome::NoIssue };
        let Some(rule_strategy) = self.strategy.as_ref() else { return RuleIterationOutcome::NoStrategy };

        let repair_start = now_ms();
        let (result, commands) = timed(per_strategy, rule_strategy.strategy.strategy_id(), now_ms, || {
            rule_strategy.strategy.apply(&issue, maze, rng, &rule_strategy.params, preset_state, &rule_strategy.nested)
        });
        let outcome = apply_commands(maze, preset_state, commands, event_log);
        *repair_ms += now_ms() - repair_start;
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
            let mut found = timed(timing, check.check_type_id(), now_ms, || check.report_check(maze, rng));
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
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Vec<Box<dyn Issue>>;
    fn check_and_repair(
        &self, maze: &mut Maze<T>, rng: &mut dyn RngCore,
        preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        qc_ms: &mut f64, repair_ms: &mut f64,
        now_ms: &dyn Fn() -> f64, event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
    ) -> RuleIterationOutcome;
}

impl<T: Tessellation, I: IssueRequirement + IssueMerge + 'static> RuleTrait<T> for Rule<T, I> {
    fn id(&self) -> &str {
        &self.id
    }

    fn report_checks(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Vec<Box<dyn Issue>> {
        self.report_checks_typed(maze, rng, timing, now_ms).into_iter()
            .map(|i| Box::new(i) as Box<dyn Issue>)
            .collect()
    }

    fn check_and_repair(
        &self, maze: &mut Maze<T>, rng: &mut dyn RngCore,
        preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        qc_ms: &mut f64, repair_ms: &mut f64,
        now_ms: &dyn Fn() -> f64, event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
    ) -> RuleIterationOutcome {
        self.check_and_repair_typed(maze, rng, preset_state, per_check, per_strategy, qc_ms, repair_ms, now_ms, event_log)
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

/// Direct unit tests for `apply_commands` — one revalidation arm per `MutationCommand` variant,
/// plus the revalidate-and-drop mechanism itself (GitHub issue #118, `Specs/repair.md`'s
/// mutation-command contract): a command built against an earlier snapshot that no longer holds
/// by commit time must be silently dropped, not panic or corrupt the graph, and must not prevent
/// the rest of the batch from applying.
#[cfg(test)]
#[path = "apply_commands_tests.rs"]
mod apply_commands_tests;

/// See GitHub issue #105 — proves `Rule::new` resolves a strategy's `requirement()` once and
/// `run_checks_typed` actually threads that exact value into every `Check::repair_check` call in
/// the rule, rather than defaulting to `I::Requirement::default()` or resolving it again per call.
#[cfg(test)]
#[path = "requirement_wiring_tests.rs"]
mod requirement_wiring_tests;
