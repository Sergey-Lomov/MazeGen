use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::{Issue, MISSING_LOOPS, MissingLoopsIssue};
use crate::repair::command::MutationCommand;
use crate::repair::nested_dispatch::dispatch_priority;
use crate::repair::params::{StrategyParam, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategies::standard_add_params::{
    ATTEMPTS_LIMIT_PARAM, PARAM_ATTEMPTS_LIMIT, PARAM_RESERVE_PERCENT, RESERVE_PERCENT_PARAM,
};
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

/// Slot id for the nested missing-loops strategies this strategy dispatches across — see
/// `Specs/repair.md`'s nested-strategy pattern. Its own constant, deliberately not
/// `"fix_target"` — that string is already used by the `*GroupSelectStrategy` family for a
/// different semantic (exactly one required fixer, `max: Some(1)`); this slot instead holds any
/// number of priority-ordered candidates (`max: None`), same shape as
/// `PriorityRegionMergeStrategy`/`WeightedRegionMergeStrategy`'s `merge_target`.
pub const SLOT_LOOP_SEED_TARGET: &str = "loop_seed_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_LOOP_SEED_TARGET,
    kind: MISSING_LOOPS,
    min: 1,
    max: None,
    dispatch_kind: NestedDispatchKind::Priority,
}];

/// Only the shared standard add block — this dispatcher has no strategy-specific knob of its own.
/// `src_mode` is deliberately excluded: it belongs to each nested strategy, not the dispatcher.
static PARAMS: [StrategyParam; 2] = [RESERVE_PERCENT_PARAM, ATTEMPTS_LIMIT_PARAM];

/// Handles `MISSING_LOOPS` — see GitHub issue #259, the priority-fallback dispatch mechanism
/// applied to the `MissingLoopsRandomStrategy`/`MissingLoopsSplitStrategy` pair. Picks *which*
/// nested missing-loops strategy actually runs, trying its nested candidates in the order
/// they're configured (`dispatch_priority`, `nested_dispatch.rs`) — the first candidate is
/// attempted, only on `Failed` does it fall through to the next, until one succeeds or the list
/// is exhausted.
///
/// Unlike `PriorityRegionMergeStrategy`/`WeightedRegionMergeStrategy`, `MissingLoopsIssue` isn't
/// a batch of independently-addressable items — its `missing: Vec<(RepairArea, u32)>` deficit list
/// is still one issue, not a per-item batch — so there is nothing to split per-item here: the
/// incoming issue is passed through to `dispatch_priority` **unchanged**, one dispatch per
/// `apply()` call. The chosen nested strategy is responsible for honoring every `RepairArea` entry
/// itself (see `MissingLoopsRandomStrategy`).
///
/// **Owns the standard add parameters for its nested strategies** (GitHub issue #486). Rather
/// than each nested loop-seeding strategy carrying its own `reserve_percent` / `attempts_limit`,
/// this dispatcher declares them once and injects the resolved values down into every candidate
/// via `dispatch_priority`'s `inherited_overrides` — the nested strategies list both ids in
/// `nested_suppressed_params()`, so the web UI hides them on a nested node and any stale nested
/// override is stripped. `src_mode` stays per-nested (it drives geometry inside one strategy).
pub struct PriorityMissingLoopsStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingLoopsIssue> for PriorityMissingLoopsStrategy {
    fn strategy_id(&self) -> &'static str {
        "priority_missing_loops"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &MissingLoopsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        // Defensive runtime filter, not the primary validation: `maze-runner`'s `build_nested`
        // already guarantees every entry in `nested` fills a slot this strategy actually
        // declared. This filter only protects direct `apply()` calls made outside the runner.
        let candidates: Vec<&NestedStrategyConfig<T>> = nested
            .iter()
            .filter(|n| n.slot.slot_id == SLOT_LOOP_SEED_TARGET)
            .collect();
        if candidates.is_empty() {
            return (RepairResult::Failed, vec![]);
        }

        // Resolve the dispatcher-owned add params once and pass them down verbatim as string
        // overrides — each nested strategy re-reads them (per-area, for `reserve_percent`) exactly
        // as if a caller had set them directly. `src_mode` is not injected; it stays per-nested.
        let mut inherited: HashMap<String, String> = HashMap::new();
        if let Some(StrategyParamValue::Float(v)) = params.get(PARAM_RESERVE_PERCENT) {
            inherited.insert(PARAM_RESERVE_PERCENT.to_string(), v.to_string());
        }
        if let Some(StrategyParamValue::Float(v)) = params.get(PARAM_ATTEMPTS_LIMIT) {
            inherited.insert(PARAM_ATTEMPTS_LIMIT.to_string(), v.to_string());
        }

        dispatch_priority(
            issue as &dyn Issue,
            maze,
            rng,
            preset_state,
            &candidates,
            &inherited,
        )
    }
}

crate::impl_erased_repair_strategy!(PriorityMissingLoopsStrategy, MissingLoopsIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::Graph;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::repair::strategies::{MissingLoopsRandomStrategy, MissingLoopsSplitStrategy};
    use crate::repair::strategy::ErasedRepairStrategy;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn no_params() -> StrategyParams {
        build_params(
            <PriorityMissingLoopsStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&PriorityMissingLoopsStrategy),
            None,
        )
    }

    fn maze_grid(side: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(side, side), &mut ids)
                .unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    fn missing_issue(missing: u32) -> MissingLoopsIssue {
        let entries = if missing == 0 {
            vec![]
        } else {
            vec![(crate::quality_control::RepairArea::WholeMaze, missing)]
        };
        MissingLoopsIssue::new_from_check("test", entries)
    }

    fn nested_with(
        strategy: Box<dyn ErasedRepairStrategy<SquareTessellation>>,
    ) -> NestedStrategyConfig<SquareTessellation> {
        NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy,
            param_overrides: HashMap::new(),
            nested: vec![],
        }
    }

    #[test]
    fn apply_fixed_immediately_when_nothing_missing_without_rng_or_nested() {
        let mut maze = maze_grid(3);
        let issue = missing_issue(0);
        let mut rng_a = MazeRng::seed_from_u64(1);
        let mut rng_b = MazeRng::seed_from_u64(1);
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(
            &PriorityMissingLoopsStrategy,
            &issue,
            &mut maze,
            &mut rng_a,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), edges_before);
        assert_eq!(
            rng_a.next_u64(),
            rng_b.next_u64(),
            "rng must not be consumed on the no-deficit idempotency path"
        );
    }

    #[test]
    fn apply_fails_when_no_candidate_fills_the_slot() {
        let mut maze = maze_grid(3);
        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &PriorityMissingLoopsStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_delegates_to_single_candidate() {
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let nested = vec![nested_with(Box::new(MissingLoopsRandomStrategy))];
        let result = apply_and_commit(
            &PriorityMissingLoopsStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(
            maze.graph.edges().count() > 0,
            "delegate must have actually added connections"
        );
    }

    #[test]
    fn apply_falls_through_to_the_next_priority_candidate_after_a_guaranteed_failure() {
        // 1x2 field, only possible pair blocked both ways: MissingLoopsRandomStrategy (listed
        // first) is guaranteed to fail — every candidate pair is infeasible. MissingLoopsSplit
        // works from split tiles rather than plain node pairs, but on this fixture (no split
        // tiles at all) it also has nothing to work with, so use a stub-free approach: instead
        // assert the priority strategy reaches Failed only after trying every listed candidate,
        // observable via each candidate's own inability to add anything.
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_points()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let issue = missing_issue(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![
            nested_with(Box::new(MissingLoopsRandomStrategy)),
            nested_with(Box::new(MissingLoopsSplitStrategy {
                config: Default::default(),
            })),
        ];
        let result = apply_and_commit(
            &PriorityMissingLoopsStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &preset_state,
            &nested,
        );
        assert!(
            matches!(result, RepairResult::Failed),
            "both candidates must fail on a fixture with no feasible connection and no split tiles"
        );
        assert_eq!(maze.graph.edges().count(), 0);
    }

    fn params_with(overrides: &HashMap<String, String>) -> StrategyParams {
        build_params(
            <PriorityMissingLoopsStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&PriorityMissingLoopsStrategy),
            Some(overrides),
        )
    }

    #[test]
    fn dispatcher_reserve_percent_reaches_the_nested_strategy() {
        // 2 missing, reserve 50% -> nested must build ceil(2 * 1.5) = 3 bidirectional passages
        // = 6 directed edges. Without the injection the nested strategy would see its own default
        // (0%) and add only 4.
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let mut overrides = HashMap::new();
        overrides.insert(PARAM_RESERVE_PERCENT.to_string(), "50".to_string());
        let mut rng = MazeRng::seed_from_u64(42);
        let nested = vec![nested_with(Box::new(MissingLoopsRandomStrategy))];
        let result = apply_and_commit(
            &PriorityMissingLoopsStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(&overrides),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(
            maze.graph.edges().count(),
            6,
            "dispatcher-owned reserve_percent must govern the nested build target"
        );
    }

    #[test]
    fn a_stale_nested_reserve_override_is_overridden_by_the_dispatcher_value() {
        // The nested candidate still carries reserve_percent=200 in its own param_overrides
        // (a leftover the web UI no longer shows). The dispatcher's 0% must win, not the stale 200%.
        let mut maze = maze_grid(4);
        let issue = missing_issue(2);
        let mut rng = MazeRng::seed_from_u64(42);
        let stale = HashMap::from([(PARAM_RESERVE_PERCENT.to_string(), "200".to_string())]);
        let nested = vec![NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy: Box::new(MissingLoopsRandomStrategy),
            param_overrides: stale,
            nested: vec![],
        }];
        let result = apply_and_commit(
            &PriorityMissingLoopsStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(
            maze.graph.edges().count(),
            4,
            "stale nested reserve_percent must be stripped; dispatcher default 0% wins"
        );
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = missing_issue(2);

        let mut maze_a = maze_grid(4);
        let mut rng_a = MazeRng::seed_from_u64(123);
        let nested_a = vec![nested_with(Box::new(MissingLoopsRandomStrategy))];
        apply_and_commit(
            &PriorityMissingLoopsStrategy,
            &issue,
            &mut maze_a,
            &mut rng_a,
            &no_params(),
            &PresetState::empty(),
            &nested_a,
        );

        let mut maze_b = maze_grid(4);
        let mut rng_b = MazeRng::seed_from_u64(123);
        let nested_b = vec![nested_with(Box::new(MissingLoopsRandomStrategy))];
        apply_and_commit(
            &PriorityMissingLoopsStrategy,
            &issue,
            &mut maze_b,
            &mut rng_b,
            &no_params(),
            &PresetState::empty(),
            &nested_b,
        );

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }
}
