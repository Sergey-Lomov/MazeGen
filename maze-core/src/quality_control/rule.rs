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
/// Composite routing ids (`{rule_id}:{local_id}`) are a DTO-protocol detail (issue #60), not a
/// concern of this type — `Rule` only stores each check's own `local_id`, unique within this
/// rule's `checks`. Composite id construction lives entirely in
/// `QualityControlEngine::check_id_to_rule` (the one place across the whole engine that needs it).
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
        let start = now_ms();
        let (result, commands) = rule_strategy.strategy.apply(issue, maze, rng, &rule_strategy.params, preset_state, &rule_strategy.nested);
        let elapsed = now_ms() - start;
        let entry = timing.entry(rule_strategy.strategy.strategy_id()).or_insert((0.0, 0));
        entry.0 += elapsed;
        entry.1 += 1;
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
    ) -> Option<(RepairResult, ApplyOutcome)>;
}

impl<T: Tessellation, I: IssueRequirement + IssueMerge + 'static> RuleTrait<T> for Rule<T, I> {
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
mod apply_commands_tests {
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::space::{SquareTessellation, Field, square_rect};
    use crate::graph::{Graph, EdgeKind};
    use crate::generation::PresetState;
    use crate::repair::MutationCommand;
    use super::*;

    fn maze_n(n: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = crate::IdGenerator::new();
        let field = Field::new(square_rect(n, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        (Maze::new(field, g), nodes)
    }

    #[test]
    fn add_directed_edge_applies_and_counts() {
        let (mut maze, nodes) = maze_n(2);
        let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddDirectedEdge { from: nodes[0], to: nodes[1] }]);
        assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
    }

    #[test]
    fn add_bidirectional_edge_applies_both_directions() {
        let (mut maze, nodes) = maze_n(2);
        let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddBidirectionalEdge { a: nodes[0], b: nodes[1] }]);
        assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some());
    }

    #[test]
    fn add_directed_teleport_applies() {
        let (mut maze, nodes) = maze_n(2);
        let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddDirectedTeleport { from: nodes[0], to: nodes[1] }]);
        assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
        let edge = maze.graph.edge_between(nodes[0], nodes[1]).and_then(|id| maze.graph.edge(id));
        assert_eq!(edge.map(|e| e.kind.clone()), Some(EdgeKind::Teleport));
    }

    #[test]
    fn add_bidirectional_teleport_applies_both_directions() {
        let (mut maze, nodes) = maze_n(2);
        let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::AddBidirectionalTeleport { a: nodes[0], b: nodes[1] }]);
        assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
        assert!(maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count() == 2);
    }

    #[test]
    fn remove_edge_by_id_applies() {
        let (mut maze, nodes) = maze_n(2);
        let id = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveEdge { id }]);
        assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
        assert!(maze.graph.edge(id).is_none());
    }

    #[test]
    fn remove_edge_between_applies() {
        let (mut maze, nodes) = maze_n(2);
        maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }]);
        assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none());
    }

    #[test]
    fn remove_teleport_with_reverse_removes_both_directions() {
        let (mut maze, nodes) = maze_n(2);
        let fwd = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let bwd = maze.graph.build_initial_edge(nodes[1], nodes[0], EdgeKind::Teleport);
        let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::RemoveTeleportWithReverse { id: fwd }]);
        assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 1 });
        assert!(maze.graph.edge(fwd).is_none());
        assert!(maze.graph.edge(bwd).is_none());
    }

    #[test]
    fn set_start_and_finish_apply_and_are_idempotent() {
        let (mut maze, nodes) = maze_n(2);
        let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![
            MutationCommand::SetStart(nodes[0]),
            MutationCommand::SetFinish(nodes[1]),
        ]);
        assert_eq!(outcome, ApplyOutcome { proposed: 2, applied: 2 });
        assert_eq!(maze.meta.start, Some(nodes[0]));
        assert_eq!(maze.meta.finish, Some(nodes[1]));

        // Idempotent: a second SetStart with a different node must not overwrite an already-set one.
        let outcome2 = apply_commands(&mut maze, &PresetState::empty(), vec![MutationCommand::SetStart(nodes[1])]);
        assert_eq!(outcome2, ApplyOutcome { proposed: 1, applied: 1 }, "SetStart always reports applied, even when it's a no-op due to idempotency");
        assert_eq!(maze.meta.start, Some(nodes[0]), "already-set start must not be overwritten");
    }

    #[test]
    fn preset_protected_edge_removal_is_dropped_silently() {
        let (mut maze, nodes) = maze_n(2);
        maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((nodes[0], nodes[1]));

        let outcome = apply_commands(&mut maze, &preset_state, vec![MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }]);
        assert_eq!(outcome, ApplyOutcome { proposed: 1, applied: 0 }, "preset-protected removal must be silently dropped, not panic or error");
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some(), "protected edge must survive");
    }

    /// Core revalidate-and-drop scenario (GitHub issue #118): a batch built against one snapshot
    /// contains a command that no longer holds by commit time (here, removing an edge that a
    /// preceding command in the same batch already removed) — it must be dropped silently, and
    /// the rest of the batch must still apply. This is the mechanism that structurally replaces
    /// #98/#99's one-issue-per-item split: a batched issue's stale sub-command is simply skipped
    /// instead of corrupting state or requiring the whole batch be rejected.
    #[test]
    fn stale_command_in_a_batch_is_dropped_without_blocking_the_rest() {
        let (mut maze, nodes) = maze_n(3);
        let id_01 = maze.graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        maze.graph.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);

        // Batch: remove (0,1) by id, then remove the same pair again by node pair (stale —
        // simulates a nested/weighted sub-strategy proposing an overlapping mutation against the
        // same immutable snapshot), then remove (1,2) — must still land despite the stale entry
        // in between.
        let commands = vec![
            MutationCommand::RemoveEdge { id: id_01 },
            MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }, // stale: already gone
            MutationCommand::RemoveEdgeBetween { from: nodes[1], to: nodes[2] },
        ];
        let outcome = apply_commands(&mut maze, &PresetState::empty(), commands);
        assert_eq!(outcome, ApplyOutcome { proposed: 3, applied: 2 }, "exactly the stale middle command must be dropped");
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_none());
        assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_none());
    }

    #[test]
    fn empty_batch_is_a_no_op() {
        let (mut maze, _) = maze_n(2);
        let edges_before = maze.graph.edges().count();
        let outcome = apply_commands(&mut maze, &PresetState::empty(), vec![]);
        assert_eq!(outcome, ApplyOutcome { proposed: 0, applied: 0 });
        assert_eq!(maze.graph.edges().count(), edges_before);
    }

    /// Full integration path (GitHub issue #118): `strategy.apply` -> `(RepairResult,
    /// Vec<MutationCommand>)` -> `Rule::dispatch_repair_typed` -> `apply_commands` -> real `Maze`.
    /// Proves the `Rule`-level commit point actually wires the pieces together correctly, not just
    /// that `apply_commands` in isolation behaves — a strategy returning several commands must see
    /// all of them land on the real maze after one `dispatch_repair_typed` call, and the returned
    /// `ApplyOutcome` must reflect that.
    struct MultiCommandStrategy;
    impl RepairStrategy<SquareTessellation, crate::quality_control::MissingEndpointsIssue> for MultiCommandStrategy {
        fn strategy_id(&self) -> &'static str { "test_multi_command" }
        fn apply(
            &self,
            _issue: &crate::quality_control::MissingEndpointsIssue,
            maze: &Maze<SquareTessellation>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<SquareTessellation>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
            (
                RepairResult::Fixed { score: None },
                vec![
                    MutationCommand::SetStart(nodes[0]),
                    MutationCommand::SetFinish(nodes[1]),
                    MutationCommand::AddBidirectionalEdge { a: nodes[0], b: nodes[1] },
                ],
            )
        }
    }
    #[test]
    fn dispatch_repair_typed_applies_every_returned_command_to_the_real_maze() {
        let (mut maze, _nodes) = maze_n(2);
        let rule: Rule<SquareTessellation, crate::quality_control::MissingEndpointsIssue> = Rule::new(
            "r".to_string(), vec![], Some(Box::new(MultiCommandStrategy)), HashMap::new(), vec![],
        );
        let issue = crate::quality_control::MissingEndpointsIssue::default();
        let mut rng = MazeRng::seed_from_u64(0);
        let mut timing = HashMap::new();
        let result = rule.dispatch_repair_typed(&issue, &mut maze, &mut rng, &PresetState::empty(), &mut timing, &|| 0.0);

        let Some((repair_result, outcome)) = result else { panic!("rule has a strategy, must return Some") };
        assert!(matches!(repair_result, RepairResult::Fixed { score: None }));
        assert_eq!(outcome, ApplyOutcome { proposed: 3, applied: 3 });
        assert!(maze.meta.start.is_some());
        assert!(maze.meta.finish.is_some());
        assert!(maze.graph.edges().count() >= 2, "the bidirectional edge command must have landed too");
    }
}

/// See GitHub issue #105 — proves `Rule::new` resolves a strategy's `requirement()` once and
/// `run_checks_typed` actually threads that exact value into every `Check::repair_check` call in
/// the rule, rather than defaulting to `I::Requirement::default()` or resolving it again per call.
#[cfg(test)]
mod requirement_wiring_tests {
    use std::cell::RefCell;
    use rand::SeedableRng;
    use crate::space::SquareTessellation;
    use crate::quality_control::{InvalidLoopIssue, InvalidLoopRequirement};
    use crate::repair::{RepairResult, RepairStrategy, NestedStrategyConfig, MutationCommand};
    use crate::repair::params::StrategyParams;
    use crate::generation::PresetState;
    use super::*;

    /// Records every `requirement` value it's called with — lets the test assert exactly what
    /// `Rule::run_checks_typed` threads through, not just that *an* issue was produced.
    struct RecordingCheck {
        received: std::rc::Rc<RefCell<Vec<InvalidLoopRequirement>>>,
    }
    impl Check<SquareTessellation, InvalidLoopIssue> for RecordingCheck {
        fn check_type_id(&self) -> &'static str { "recording_check" }
        fn repair_check(&self, _maze: &Maze<SquareTessellation>, _issues: &mut Vec<InvalidLoopIssue>, _rng: &mut dyn RngCore, requirement: InvalidLoopRequirement) {
            self.received.borrow_mut().push(requirement);
        }
    }

    struct InvalidOnlyStrategy;
    impl RepairStrategy<SquareTessellation, InvalidLoopIssue> for InvalidOnlyStrategy {
        fn strategy_id(&self) -> &'static str { "invalid_only_test_strategy" }
        fn requirement(&self, _params: &StrategyParams) -> InvalidLoopRequirement {
            InvalidLoopRequirement::empty()
        }
        fn apply(
            &self, _issue: &InvalidLoopIssue, _maze: &Maze<SquareTessellation>,
            _rng: &mut dyn RngCore, _params: &StrategyParams,
            _preset_state: &PresetState, _nested: &[NestedStrategyConfig<SquareTessellation>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            (RepairResult::Fixed { score: None }, vec![])
        }
    }

    fn empty_maze() -> Maze<SquareTessellation> {
        let mut ids = crate::IdGenerator::new();
        let field = crate::space::Field::new(crate::space::square_rect(1, 1), &mut ids).unwrap();
        let mut g = crate::Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    #[test]
    fn run_checks_typed_threads_the_strategys_resolved_requirement_into_repair_check() {
        let received = std::rc::Rc::new(RefCell::new(Vec::new()));
        let check = RecordingCheck { received: received.clone() };
        let rule: Rule<SquareTessellation, InvalidLoopIssue> = Rule::new(
            "r".to_string(),
            vec![("a".to_string(), Box::new(check) as Box<dyn Check<SquareTessellation, InvalidLoopIssue>>)],
            Some(Box::new(InvalidOnlyStrategy)),
            HashMap::new(),
            vec![],
        );

        let maze = empty_maze();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        let mut timing = HashMap::new();
        rule.run_checks_typed(&maze, &mut rng, &mut timing, &|| 0.0);

        assert_eq!(received.borrow().as_slice(), &[InvalidLoopRequirement::empty()],
            "the strategy's resolved requirement must reach the check's repair_check call");
    }

    #[test]
    fn no_fix_rule_falls_back_to_full() {
        let received = std::rc::Rc::new(RefCell::new(Vec::new()));
        let check = RecordingCheck { received: received.clone() };
        let rule: Rule<SquareTessellation, InvalidLoopIssue> = Rule::new(
            "r".to_string(),
            vec![("a".to_string(), Box::new(check) as Box<dyn Check<SquareTessellation, InvalidLoopIssue>>)],
            None,
            HashMap::new(),
            vec![],
        );

        let maze = empty_maze();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        let mut timing = HashMap::new();
        rule.run_checks_typed(&maze, &mut rng, &mut timing, &|| 0.0);

        assert_eq!(received.borrow().as_slice(), &[InvalidLoopRequirement::all()],
            "a rule with no strategy (no_fix) must still pass all() to its checks");
    }
}
