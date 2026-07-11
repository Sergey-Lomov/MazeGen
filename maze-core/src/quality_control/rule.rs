use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::{RepairStrategy, RepairResult, NestedStrategyConfig, SnapshotStack, params::{build_params, StrategyParams}};
use super::check::Check;
use super::issue::{Issue, IssueMerge, IssueKind};

/// One rule's strategy assignment — checks + strategy + param overrides, held together so `Rule`
/// can build `StrategyParams` and dispatch repair by itself. `None` on `Rule::strategy` (not this
/// type) means "no_fix".
struct RuleStrategy<T: Tessellation, I: Issue + IssueMerge> {
    strategy: Box<dyn RepairStrategy<T, I>>,
    param_overrides: HashMap<String, String>,
    nested: Vec<NestedStrategyConfig<T>>,
}

/// A user-defined QC rule: a set of checks producing one `Issue` type `I`, driving its own check
/// dispatch, issue merge, and (if configured) repair dispatch. `I` is fixed at the type level —
/// there is no runtime `kind` field to independently agree with, and no possibility of
/// constructing a `Rule` whose checks disagree on kind (see GitHub issue #113): every `Box<dyn
/// Check<T, I>>` in `checks` and the one `Box<dyn RepairStrategy<T, I>>` in `strategy` are all
/// generic over the exact same `I`.
///
/// Composite routing ids (`{rule_id}:{local_id}`) are a DTO-protocol detail (issue #60), not a
/// concern of this type — `Rule` only stores each check's own `local_id`, unique within this
/// rule's `checks`. Composite id construction lives entirely in
/// `QualityControlEngine::check_id_to_rule` (the one place across the whole engine that needs it).
pub struct Rule<T: Tessellation, I: Issue + IssueMerge> {
    pub id: String,
    checks: Vec<(String, Box<dyn Check<T, I>>)>,
    strategy: Option<RuleStrategy<T, I>>,
}

impl<T: Tessellation, I: Issue + IssueMerge> Rule<T, I> {
    pub fn new(
        id: String,
        checks: Vec<(String, Box<dyn Check<T, I>>)>,
        strategy: Option<Box<dyn RepairStrategy<T, I>>>,
        param_overrides: HashMap<String, String>,
        nested: Vec<NestedStrategyConfig<T>>,
    ) -> Self {
        let strategy = strategy.map(|strategy| RuleStrategy { strategy, param_overrides, nested });
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
        let mut merged: Option<I> = None;
        for (_, check) in &self.checks {
            let issues = timed(timing, check.check_type_id(), now_ms, || {
                let mut v = Vec::new();
                check.repair_check(maze, &mut v, rng);
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

    /// Dispatches this rule's strategy against `issue` (already merged by `run_checks_typed`).
    /// Returns `None` if this rule has no registered strategy ("no_fix").
    pub fn dispatch_repair_typed(
        &self,
        issue: &I,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
    ) -> Option<RepairResult> {
        let rule_strategy = self.strategy.as_ref()?;
        let params: StrategyParams = build_params(rule_strategy.strategy.params(), Some(&rule_strategy.param_overrides));
        let mut snapshots = SnapshotStack::new();
        let start = now_ms();
        let result = rule_strategy.strategy.apply(issue, maze, &mut snapshots, rng, &params, preset_state, &rule_strategy.nested);
        let elapsed = now_ms() - start;
        let entry = timing.entry(rule_strategy.strategy.strategy_id()).or_insert((0.0, 0));
        entry.0 += elapsed;
        entry.1 += 1;
        Some(result)
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
    /// Local check ids configured on this rule, in order — the only thing
    /// `QualityControlEngine::check_id_to_rule` actually needs from a rule's checks (composite id
    /// construction happens entirely there).
    fn local_check_ids(&self) -> Vec<&str>;
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
    ) -> Option<RepairResult>;
}

impl<T: Tessellation, I: Issue + IssueMerge + 'static> RuleTrait<T> for Rule<T, I> {
    fn id(&self) -> &str {
        &self.id
    }

    fn kind(&self) -> IssueKind {
        I::KIND
    }

    fn local_check_ids(&self) -> Vec<&str> {
        self.checks.iter().map(|(local_id, _)| local_id.as_str()).collect()
    }

    fn has_strategy(&self) -> bool {
        self.strategy.is_some()
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
    ) -> Option<RepairResult> {
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
