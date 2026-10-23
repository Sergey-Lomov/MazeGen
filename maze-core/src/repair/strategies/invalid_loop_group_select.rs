use crate::Maze;
use crate::generation::PresetState;
use crate::ids::EdgeId;
use crate::quality_control::{
    INVALID_LOOP, InvalidLoopGroupIssue, InvalidLoopGroupRequirement, InvalidLoopIssue,
};
use crate::repair::command::{MutationCommand, removed_edge_ids};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::{Rng, RngCore};
use std::collections::{HashSet, VecDeque};

pub const PARAM_SELECTION_MODE: &str = "selection_mode";
pub const PARAM_SAMPLE_MODE: &str = "sample_mode";
pub const PARAM_SAMPLE_SIZE: &str = "sample_size";

pub const SELECTION_RANDOM: &str = "random";
pub const SELECTION_SHORTEST: &str = "shortest";
pub const SELECTION_LONGEST: &str = "longest";

pub const SAMPLE_MODE_COUNT: &str = "count";
pub const SAMPLE_MODE_PERCENT: &str = "percent";

static SELECTION_MODE_OPTIONS: &[&str] = &[SELECTION_RANDOM, SELECTION_SHORTEST, SELECTION_LONGEST];
static SAMPLE_MODE_OPTIONS: &[&str] = &[SAMPLE_MODE_COUNT, SAMPLE_MODE_PERCENT];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_SELECTION_MODE,
        label: "Target cycle selection",
        kind: StrategyParamKind::Enum {
            options: SELECTION_MODE_OPTIONS,
            default: SELECTION_RANDOM,
        },
    },
    StrategyParam {
        id: PARAM_SAMPLE_MODE,
        label: "Sample size mode",
        kind: StrategyParamKind::Enum {
            options: SAMPLE_MODE_OPTIONS,
            default: SAMPLE_MODE_COUNT,
        },
    },
    StrategyParam {
        id: PARAM_SAMPLE_SIZE,
        label: "Sample size",
        kind: StrategyParamKind::Float {
            default: 1.0,
            min: 0.0,
            max: 100_000.0,
        },
    },
];

/// Slot id for the nested strategy this strategy delegates the actual cut to — see
/// `Specs/repair.md`'s nested-strategy pattern.
pub const SLOT_CUT_TARGET: &str = "cut_target";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_CUT_TARGET,
    kind: INVALID_LOOP,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
}];

/// Handles `INVALID_LOOP_GROUP` (see GitHub issue #183) by picking a *sample* of the flagged
/// cycles (sized by `sample_mode`/`sample_size`, ordered by `selection_mode`) and resolving them
/// one at a time against a nested strategy (typically `InvalidLoopRandomStrategy`/
/// `InvalidLoopScoredStrategy`) filling the `cut_target` slot.
///
/// `sample_mode`/`sample_size` control how many of `issue.invalid` enter the sample: `count` takes
/// `sample_size` cycles literally (rounded up), `percent` takes `ceil(sample_size / 100 *
/// issue.invalid.len())` — either way, at least 1 (there is always something to do when
/// `issue.invalid` is non-empty at all). `selection_mode` (random/shortest/longest) both orders
/// the sample and is reused as the tie-break/pick criterion within it, exactly as before this
/// sampling was added.
///
/// The sample is treated as a queue: each iteration pops the front cycle as the nested strategy's
/// target, synthesizes an `InvalidLoopIssue` where every *other* still-pending sample cycle is
/// `invalid` context and every non-sampled cycle (both the rest of `issue.invalid` and all of
/// `issue.valid`) is `valid` context, and delegates to the nested strategy. After each nested
/// call, any edge it reports removing (`removed_edge_ids`) is used to drop every remaining queued
/// cycle that shares that edge — those cycles are already broken by the same cut and are neither
/// re-offered nor carried forward as context, distinct from a cycle that simply wasn't sampled
/// this round. The loop ends when the queue empties; `apply()` concatenates every nested call's
/// commands, in order (`Specs/repair.md`'s nested-strategy contract).
///
/// Returns `Fixed` if at least one nested call in the batch succeeded (its commands are kept,
/// even if a later cycle in the same batch failed), `Failed` only if every nested call in the
/// batch failed (nothing was actually fixed, so no commands are returned) — a mix of successes
/// and failures within one sample is not itself surfaced beyond "at least one worked."
pub struct InvalidLoopGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidLoopGroupIssue> for InvalidLoopGroupSelectStrategy {
    fn strategy_id(&self) -> &'static str {
        "invalid_loop_group_select"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    /// Cannot translate the nested strategy's own `requirement()` here — `Rule::new` resolves
    /// `requirement()` from `&self, params` alone (see `rule.rs`), before `nested` is known to
    /// this strategy at all, so there is no nested `RepairStrategy` to consult yet. Always
    /// requests `all()` ("compute everything"), same as every other unmigrated strategy's
    /// default — safe (never wrong, just potentially wasted computation), and correct regardless
    /// of what the eventually-configured nested strategy turns out to need.
    fn requirement(&self, _params: &StrategyParams) -> InvalidLoopGroupRequirement {
        InvalidLoopGroupRequirement::all()
    }

    fn apply(
        &self,
        issue: &InvalidLoopGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.invalid.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        // `build_nested` (maze-runner) already enforces exactly one nested strategy for this
        // slot via `expected_nested()`'s `max: Some(1)` — this is a defensive re-check, not the
        // primary guard, same posture `ReduceSccCountStrategy` takes toward its own nested slot.
        let matching: Vec<&NestedStrategyConfig<T>> = nested
            .iter()
            .filter(|n| n.slot.slot_id == SLOT_CUT_TARGET)
            .collect();
        debug_assert!(
            matching.len() <= 1,
            "InvalidLoopGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_CUT_TARGET}\" should prevent more than one nested strategy filling it"
        );
        let Some(&cut_target) = matching.first() else {
            return (RepairResult::Failed, vec![]);
        };

        let selection_mode = match params.get(PARAM_SELECTION_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => SELECTION_RANDOM,
        };
        let sample_mode = match params.get(PARAM_SAMPLE_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => SAMPLE_MODE_COUNT,
        };
        let sample_size = params
            .get(PARAM_SAMPLE_SIZE)
            .and_then(|v| v.as_float())
            .unwrap_or(1.0);

        let mut ordered_indices: Vec<usize> = (0..issue.invalid.len()).collect();
        sort_by_selection_mode(&mut ordered_indices, &issue.invalid, selection_mode, rng);

        let sample_count = resolve_sample_count(issue.invalid.len(), sample_mode, sample_size);
        let (sample_indices, rest_indices) = ordered_indices.split_at(sample_count);

        let mut pending: VecDeque<Vec<EdgeId>> = sample_indices
            .iter()
            .map(|&idx| issue.invalid[idx].clone())
            .collect();
        let mut local_valid: Vec<Vec<EdgeId>> = rest_indices
            .iter()
            .map(|&idx| issue.invalid[idx].clone())
            .chain(issue.valid.iter().cloned())
            .collect();

        let nested_params = crate::repair::params::build_params(
            cut_target.strategy.params(),
            Some(&cut_target.param_overrides),
        );
        let mut commands = Vec::new();
        let mut any_succeeded = false;

        while let Some(target) = pending.pop_front() {
            let mut synthetic_all: Vec<Vec<EdgeId>> =
                Vec::with_capacity(1 + pending.len() + local_valid.len());
            synthetic_all.push(target);
            synthetic_all.extend(pending.iter().cloned());
            synthetic_all.extend(local_valid.iter().cloned());
            let synthetic = InvalidLoopIssue::new_from_check(
                "invalid_loop_group_select",
                synthetic_all,
                vec![0],
                Default::default(),
            );

            let (nested_result, nested_commands) = cut_target.strategy.apply(
                &synthetic as &dyn crate::quality_control::Issue,
                maze,
                rng,
                &nested_params,
                preset_state,
                &cut_target.nested,
            );
            any_succeeded |= matches!(nested_result, RepairResult::Fixed { .. });

            let removed: HashSet<EdgeId> = removed_edge_ids(&nested_commands).into_iter().collect();
            if !removed.is_empty() {
                pending.retain(|cycle| !cycle.iter().any(|e| removed.contains(e)));
                local_valid.retain(|cycle| !cycle.iter().any(|e| removed.contains(e)));
            }

            commands.extend(nested_commands);
        }

        if any_succeeded {
            (RepairResult::Fixed { score: None }, commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(InvalidLoopGroupSelectStrategy, InvalidLoopGroupIssue);

/// Reorders `indices` (into `invalid`) in place by `mode` — `shortest`/`longest` by edge count
/// (ties broken by ascending original index for determinism), `random`/unrecognized via a
/// Fisher-Yates shuffle through `rng` (seed-reproducible, unlike leaving ascending index order in
/// place under a "random" label).
fn sort_by_selection_mode(
    indices: &mut [usize],
    invalid: &[Vec<EdgeId>],
    mode: &str,
    rng: &mut dyn RngCore,
) {
    match mode {
        SELECTION_SHORTEST => indices.sort_by_key(|&i| (invalid[i].len(), i)),
        SELECTION_LONGEST => indices.sort_by_key(|&i| (std::cmp::Reverse(invalid[i].len()), i)),
        _ => {
            for i in (1..indices.len()).rev() {
                let j = rng.random_range(0..=i);
                indices.swap(i, j);
            }
        }
    }
}

/// How many of `invalid_count` flagged cycles enter the sample — `count` mode takes `sample_size`
/// literally (rounded up), `percent` mode takes `ceil(sample_size / 100 * invalid_count)`. Either
/// way, clamped to `[1, invalid_count]`: at least 1 (there is always something to do when
/// `invalid_count > 0`, the only case this is called for — see `apply`'s early return), never more
/// than what's actually available.
fn resolve_sample_count(invalid_count: usize, sample_mode: &str, sample_size: f64) -> usize {
    let raw = match sample_mode {
        SAMPLE_MODE_PERCENT => (sample_size / 100.0 * invalid_count as f64).ceil(),
        _ => sample_size.ceil(),
    };
    (raw as usize).clamp(1, invalid_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::random::MazeRng;
    use crate::repair::strategies::InvalidLoopRandomStrategy;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::space::{SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    fn no_params() -> StrategyParams {
        crate::repair::params::build_params(
            <InvalidLoopGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                InvalidLoopGroupIssue,
            >>::params(&InvalidLoopGroupSelectStrategy),
            None,
        )
    }

    fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
        let mut map = std::collections::HashMap::new();
        for &(k, v) in overrides {
            map.insert(k.to_string(), v.to_string());
        }
        crate::repair::params::build_params(
            <InvalidLoopGroupSelectStrategy as RepairStrategy<
                SquareTessellation,
                InvalidLoopGroupIssue,
            >>::params(&InvalidLoopGroupSelectStrategy),
            Some(&map),
        )
    }

    fn cut_target_nested<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
        vec![NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy: Box::new(InvalidLoopRandomStrategy),
            param_overrides: std::collections::HashMap::new(),
            nested: vec![],
        }]
    }

    /// Triangle (3 tile-hops) and a 4-node square loop (4 tile-hops), disjoint edge sets, both
    /// flagged invalid.
    fn maze_with_two_disjoint_loops() -> (Maze<SquareTessellation>, Vec<EdgeId>, Vec<EdgeId>) {
        let mut ids = IdGenerator::new();
        let field = crate::space::MultiLevelField::single_level(
            Arc::default(),
            square_rect(7, 1),
            &mut ids,
        )
        .unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let e0 = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let e1 = g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let e2 = g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        let e3 = g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
        let e4 = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
        let e5 = g.add_edge(nodes[5], nodes[6], EdgeKind::Basic);
        let e6 = g.add_edge(nodes[6], nodes[3], EdgeKind::Basic);
        let triangle = vec![e0, e1, e2];
        let square = vec![e3, e4, e5, e6];
        (Maze::new(field, g), triangle, square)
    }

    fn group_issue(invalid: Vec<Vec<EdgeId>>) -> InvalidLoopGroupIssue {
        InvalidLoopGroupIssue::new_from_check(
            "max_loop_density",
            invalid,
            vec![],
            Default::default(),
        )
    }

    #[test]
    fn apply_fails_when_nested_is_empty() {
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle, square]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
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
    fn apply_succeeds_on_empty_invalid_list() {
        let (mut maze, _, _) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = cut_target_nested();
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn default_sample_size_one_cuts_only_the_shortest_loop() {
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle.clone(), square.clone()]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = cut_target_nested();
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(&[(PARAM_SELECTION_MODE, SELECTION_SHORTEST)]),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let square_intact = square.iter().all(|&id| maze.graph.edge(id).is_some());
        assert!(
            square_intact,
            "sample size 1: only the shorter (triangle) loop must be touched"
        );
        let triangle_intact = triangle.iter().all(|&id| maze.graph.edge(id).is_some());
        assert!(!triangle_intact, "the triangle must have lost an edge");
    }

    #[test]
    fn longest_mode_cuts_only_the_longer_square_loop() {
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle.clone(), square.clone()]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = cut_target_nested();
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(&[(PARAM_SELECTION_MODE, SELECTION_LONGEST)]),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let triangle_intact = triangle.iter().all(|&id| maze.graph.edge(id).is_some());
        assert!(
            triangle_intact,
            "sample size 1, longest mode: the shorter (triangle) loop must survive untouched"
        );
        let square_intact = square.iter().all(|&id| maze.graph.edge(id).is_some());
        assert!(
            !square_intact,
            "the longer (square) loop must have lost an edge"
        );
    }

    #[test]
    fn sample_count_two_resolves_both_loops_in_one_apply() {
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle.clone(), square.clone()]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = cut_target_nested();
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(&[
                (PARAM_SAMPLE_MODE, SAMPLE_MODE_COUNT),
                (PARAM_SAMPLE_SIZE, "2"),
            ]),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let triangle_intact = triangle.iter().all(|&id| maze.graph.edge(id).is_some());
        let square_intact = square.iter().all(|&id| maze.graph.edge(id).is_some());
        assert!(
            !triangle_intact && !square_intact,
            "sample size 2: both loops must be cut in one apply() call"
        );
    }

    #[test]
    fn sample_percent_100_resolves_all_flagged_loops() {
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle.clone(), square.clone()]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = cut_target_nested();
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(&[
                (PARAM_SAMPLE_MODE, SAMPLE_MODE_PERCENT),
                (PARAM_SAMPLE_SIZE, "100"),
            ]),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let triangle_intact = triangle.iter().all(|&id| maze.graph.edge(id).is_some());
        let square_intact = square.iter().all(|&id| maze.graph.edge(id).is_some());
        assert!(
            !triangle_intact && !square_intact,
            "100% sample must resolve every flagged loop"
        );
    }

    #[test]
    fn sample_percent_rounds_up_to_at_least_one() {
        // 10% of 2 cycles rounds up to 1, not down to 0 -- with sample_size 1, exactly one loop
        // must be touched, same observable outcome as the default-sample test above.
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle.clone(), square.clone()]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = cut_target_nested();
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(&[
                (PARAM_SAMPLE_MODE, SAMPLE_MODE_PERCENT),
                (PARAM_SAMPLE_SIZE, "10"),
                (PARAM_SELECTION_MODE, SELECTION_SHORTEST),
            ]),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let square_intact = square.iter().all(|&id| maze.graph.edge(id).is_some());
        let triangle_intact = triangle.iter().all(|&id| maze.graph.edge(id).is_some());
        assert!(
            square_intact && !triangle_intact,
            "10% of 2 must round up to sample exactly 1 (the shortest)"
        );
    }

    #[test]
    fn sample_count_beyond_available_clamps_to_all_invalid() {
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle.clone(), square.clone()]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = cut_target_nested();
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(&[
                (PARAM_SAMPLE_MODE, SAMPLE_MODE_COUNT),
                (PARAM_SAMPLE_SIZE, "50"),
            ]),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let triangle_intact = triangle.iter().all(|&id| maze.graph.edge(id).is_some());
        let square_intact = square.iter().all(|&id| maze.graph.edge(id).is_some());
        assert!(
            !triangle_intact && !square_intact,
            "sample size beyond invalid.len() must clamp, not panic or skip"
        );
    }

    #[test]
    fn shared_edge_removal_drops_the_other_pending_cycle_without_a_second_cut() {
        // Bowtie: two triangles sharing edge A->B. Sampling both (count=2) must not double-cut:
        // once the shared edge is removed while resolving the first, the second triangle is
        // already broken and must be dropped from the queue rather than offered to the nested
        // strategy a second time.
        let mut ids = IdGenerator::new();
        let field: crate::space::MultiLevelField<SquareTessellation> =
            crate::space::MultiLevelField::single_level(
                Arc::default(),
                square_rect(4, 1),
                &mut ids,
            )
            .unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = field
            .field_of(field_level)
            .unwrap()
            .all_cells()
            .map(|p| field.node_at(field_level, p).unwrap())
            .collect();
        let shared = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B (shared)
        let bc = g.add_edge(nodes[1], nodes[2], EdgeKind::Basic); // B->C
        let ca = g.add_edge(nodes[2], nodes[0], EdgeKind::Basic); // C->A
        let bd = g.add_edge(nodes[1], nodes[3], EdgeKind::Basic); // B->D
        let da = g.add_edge(nodes[3], nodes[0], EdgeKind::Basic); // D->A
        let maze = Maze::new(field, g);

        let triangle_abc = vec![shared, bc, ca];
        let triangle_abd = vec![shared, bd, da];
        let issue = group_issue(vec![triangle_abc, triangle_abd]);

        // Force the shared edge to be the only unprotected candidate in the first triangle
        // processed, so the nested strategy is guaranteed to cut it (not bc/ca) regardless of
        // seed — isolates this test from InvalidLoopRandomStrategy's own random edge choice.
        let mut preset_state = PresetState::empty();
        let (b, c) = (nodes[1], nodes[2]);
        let (c2, a) = (nodes[2], nodes[0]);
        preset_state.preset_edges.insert((b, c));
        preset_state.preset_edges.insert((c2, a));

        let mut maze_try = maze;
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = cut_target_nested();
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze_try,
            &mut rng,
            &params_with(&[
                (PARAM_SAMPLE_MODE, SAMPLE_MODE_COUNT),
                (PARAM_SAMPLE_SIZE, "2"),
            ]),
            &preset_state,
            &nested,
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let d = nodes[3];
        let d_degree = maze_try
            .graph
            .edges()
            .filter(|e| e.from == d || e.to == d)
            .count();
        assert!(
            d_degree > 0,
            "D must keep at least one edge -- the second triangle must be dropped from the queue once the shared edge is cut, not independently cut again"
        );
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let (_, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle, square]);

        let (mut maze_a, _, _) = maze_with_two_disjoint_loops();
        let mut rng_a = MazeRng::seed_from_u64(42);
        let nested_a = cut_target_nested();
        apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze_a,
            &mut rng_a,
            &params_with(&[
                (PARAM_SAMPLE_MODE, SAMPLE_MODE_COUNT),
                (PARAM_SAMPLE_SIZE, "2"),
            ]),
            &PresetState::empty(),
            &nested_a,
        );

        let (mut maze_b, _, _) = maze_with_two_disjoint_loops();
        let mut rng_b = MazeRng::seed_from_u64(42);
        let nested_b = cut_target_nested();
        apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze_b,
            &mut rng_b,
            &params_with(&[
                (PARAM_SAMPLE_MODE, SAMPLE_MODE_COUNT),
                (PARAM_SAMPLE_SIZE, "2"),
            ]),
            &PresetState::empty(),
            &nested_b,
        );

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| e.id).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| e.id).collect();
        assert_eq!(edges_a, edges_b);
    }

    #[test]
    fn apply_fails_when_nested_slot_id_does_not_match() {
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle, square]);
        let mut rng = MazeRng::seed_from_u64(1);
        static OTHER_SLOT: NestedSlot = NestedSlot {
            slot_id: "some_other_slot",
            kind: INVALID_LOOP,
            min: 1,
            max: Some(1),
            dispatch_kind: NestedDispatchKind::Unordered,
        };
        let nested = vec![NestedStrategyConfig {
            slot: &OTHER_SLOT,
            strategy: Box::new(InvalidLoopRandomStrategy),
            param_overrides: std::collections::HashMap::new(),
            nested: vec![],
        }];
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &nested,
        );
        assert!(matches!(result, RepairResult::Failed));
    }

    /// Stub nested strategy that always fails without proposing any command — used to exercise
    /// `apply`'s `any_succeeded` bookkeeping. Neither `InvalidLoopRandomStrategy` nor
    /// `InvalidLoopScoredStrategy` (the strategies this actually ships with) ever return `Failed`
    /// themselves, so a real nested-failure path needs a dedicated stub.
    struct AlwaysFailsStrategy;

    impl<T: Tessellation> RepairStrategy<T, InvalidLoopIssue> for AlwaysFailsStrategy {
        fn strategy_id(&self) -> &'static str {
            "always_fails_stub"
        }
        fn apply(
            &self,
            _issue: &InvalidLoopIssue,
            _maze: &Maze<T>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            (RepairResult::Failed, vec![])
        }
    }
    crate::impl_erased_repair_strategy!(AlwaysFailsStrategy, InvalidLoopIssue);

    #[test]
    fn apply_fails_when_every_nested_call_in_the_batch_fails() {
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle, square]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy: Box::new(AlwaysFailsStrategy),
            param_overrides: std::collections::HashMap::new(),
            nested: vec![],
        }];
        let result = apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(&[
                (PARAM_SAMPLE_MODE, SAMPLE_MODE_COUNT),
                (PARAM_SAMPLE_SIZE, "2"),
            ]),
            &PresetState::empty(),
            &nested,
        );
        assert!(
            matches!(result, RepairResult::Failed),
            "every nested call failed, so the batch as a whole must be Failed"
        );
    }

    #[test]
    fn resolve_sample_count_count_mode_rounds_up_and_clamps() {
        assert_eq!(resolve_sample_count(10, SAMPLE_MODE_COUNT, 3.2), 4);
        assert_eq!(
            resolve_sample_count(10, SAMPLE_MODE_COUNT, 0.0),
            1,
            "must never go below 1"
        );
        assert_eq!(
            resolve_sample_count(10, SAMPLE_MODE_COUNT, 999.0),
            10,
            "must clamp to invalid_count"
        );
    }

    #[test]
    fn resolve_sample_count_percent_mode_rounds_up_and_clamps() {
        assert_eq!(resolve_sample_count(10, SAMPLE_MODE_PERCENT, 50.0), 5);
        assert_eq!(
            resolve_sample_count(2, SAMPLE_MODE_PERCENT, 10.0),
            1,
            "10% of 2 rounds up to 1, not down to 0"
        );
        assert_eq!(resolve_sample_count(4, SAMPLE_MODE_PERCENT, 100.0), 4);
        assert_eq!(
            resolve_sample_count(4, SAMPLE_MODE_PERCENT, 0.0),
            1,
            "must never go below 1"
        );
    }
}
