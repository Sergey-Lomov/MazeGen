use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::{RepairStrategy, RepairResult, NestedStrategyConfig, MutationCommand, params::{build_params, StrategyParams}};
use super::check::Check;
use super::issue::{Issue, IssueRequirement, IssueMerge, IssueKind};

/// How many of a strategy's proposed `MutationCommand`s actually applied — see GitHub issue #118,
/// `Specs/repair.md`. `Stage::run_repair`'s extended no-progress guard tracks `applied == 0 &&
/// proposed > 0` across iterations, independent of the existing `(rule_id, Issue)` comparison.
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
/// exercise the same apply-then-commit sequencing `Rule::dispatch_repair_typed` uses internally.
pub fn apply_commands<T: Tessellation>(
    maze: &mut Maze<T>,
    preset_state: &PresetState,
    commands: Vec<MutationCommand>,
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
    }
    ApplyOutcome { proposed, applied }
}

/// One rule's strategy assignment — checks + strategy + resolved params/requirement, held
/// together so `Rule` can dispatch repair by itself. `None` on `Rule::strategy` (not this type)
/// means "no_fix". `params`/`requirement` are resolved once in `Rule::new` (not `param_overrides`
/// kept around raw) — see GitHub issue #105: both are pure functions of `strategy`+
/// `param_overrides`, computed once and reused by every `dispatch_repair_typed`/`run_checks_typed`
/// call instead of rebuilt per call.
struct RuleStrategy<T: Tessellation, I: IssueRequirement + IssueMerge> {
    strategy: Box<dyn RepairStrategy<T, I>>,
    nested: Vec<NestedStrategyConfig<T>>,
    params: StrategyParams,
    requirement: I::Requirement,
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
    /// found anything this call.
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

    /// Dispatches this rule's strategy against `issue` (already merged by `run_checks_typed`),
    /// then immediately applies and revalidates the returned commands against the real `maze`
    /// (see `apply_commands` above) — the Rule-level commit point `Specs/repair.md` specifies,
    /// not batched across the whole `Stage`. Returns `None` if this rule has no registered
    /// strategy ("no_fix").
    pub fn dispatch_repair_typed(
        &self,
        issue: &I,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
    ) -> Option<(RepairResult, ApplyOutcome)> {
        let rule_strategy = self.strategy.as_ref()?;
        let (result, commands) = timed(timing, rule_strategy.strategy.strategy_id(), now_ms, || {
            rule_strategy.strategy.apply(issue, maze, rng, &rule_strategy.params, preset_state, &rule_strategy.nested)
        });
        let outcome = apply_commands(maze, preset_state, commands);
        Some((result, outcome))
    }
}

/// Type-erased view of `Rule<T, I>` for the one place genuine cross-`I` heterogeneity is
/// unavoidable: `Stage.rules` (a `Stage` deliberately groups rules of different kinds together —
/// see GitHub issue #113). `Box<dyn Issue>`/`&dyn Issue` cross this boundary; `Stage` never mixes
/// an `Issue` from one rule into another rule's `dispatch_repair` call (see that method's own doc
/// comment for the invariant this relies on).
pub trait RuleTrait<T: Tessellation> {
    fn id(&self) -> &str;
    fn kind(&self) -> IssueKind;
    fn has_strategy(&self) -> bool;
    fn run_checks(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Option<Box<dyn Issue>>;
    fn report_checks(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Vec<Box<dyn Issue>>;
    /// **Invariant, caller's responsibility**: `issue` must originate from `self.run_checks(...)`
    /// of this exact same `Rule`, in the same QC iteration — `Stage::run_repair`'s
    /// `collect_active`/dispatch always calls `dispatch_repair` with an `Issue` previously
    /// obtained from `run_checks` on that same `(&dyn RuleTrait<T>, Box<dyn Issue>)` pair —
    /// `Stage` never hands one rule's issue to another rule. Violating this invariant is an
    /// internal `Stage`-loop bug, never legitimate external input; the implementation is entitled
    /// to `panic!`/`expect()` on a downcast mismatch instead of returning a `Result`.
    fn dispatch_repair(
        &self, issue: &dyn Issue, maze: &mut Maze<T>, rng: &mut dyn RngCore,
        preset_state: &PresetState, timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
    ) -> Option<(RepairResult, ApplyOutcome)>;
}

impl<T: Tessellation, I: IssueRequirement + IssueMerge + 'static> RuleTrait<T> for Rule<T, I> {
    fn id(&self) -> &str {
        &self.id
    }

    fn kind(&self) -> IssueKind {
        I::KIND
    }

    fn has_strategy(&self) -> bool {
        Rule::has_strategy(self)
    }

    fn run_checks(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Option<Box<dyn Issue>> {
        self.run_checks_typed(maze, rng, timing, now_ms).map(|i| Box::new(i) as Box<dyn Issue>)
    }

    fn report_checks(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Vec<Box<dyn Issue>> {
        self.report_checks_typed(maze, rng, timing, now_ms).into_iter()
            .map(|i| Box::new(i) as Box<dyn Issue>)
            .collect()
    }

    fn dispatch_repair(
        &self, issue: &dyn Issue, maze: &mut Maze<T>, rng: &mut dyn RngCore,
        preset_state: &PresetState, timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
    ) -> Option<(RepairResult, ApplyOutcome)> {
        let typed: &I = issue.as_any().downcast_ref::<I>()
            .expect("RuleTrait::dispatch_repair: issue must originate from this same Rule's own run_checks — see this trait method's doc comment");
        self.dispatch_repair_typed(typed, maze, rng, preset_state, timing, now_ms)
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
