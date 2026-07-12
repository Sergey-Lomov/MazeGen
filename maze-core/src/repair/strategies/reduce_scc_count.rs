use rand::{Rng, RngCore};
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{ExcessiveSccCountIssue, RegionNeedsExpansionIssue, REGION_NEEDS_EXPANSION};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams, build_params};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

pub const PARAM_MERGE_PRIORITY: &str = "merge_priority";

pub const PRIORITY_SMALLEST: &str = "smallest";
pub const PRIORITY_LARGEST: &str = "largest";
pub const PRIORITY_RANDOM: &str = "random";

static PRIORITY_OPTIONS: &[&str] = &[PRIORITY_SMALLEST, PRIORITY_LARGEST, PRIORITY_RANDOM];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_MERGE_PRIORITY,
        label: "Merge priority",
        kind: StrategyParamKind::Enum { options: PRIORITY_OPTIONS, default: PRIORITY_SMALLEST },
    },
];

/// Slot id for the nested strategy this strategy delegates the actual merge to — see
/// `Specs/repair.md`'s nested-strategy pattern. Public: part of this strategy's configuration
/// API (`StrategyConfig.slot_id` in `maze-runner`), not an internal detail.
pub const SLOT_MERGE_TARGET: &str = "merge_target";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot { slot_id: SLOT_MERGE_TARGET, kind: REGION_NEEDS_EXPANSION, min: 1, max: Some(1) },
];

/// Picks which of `sizes.len()` components to merge away, by `mode` (`smallest`/`largest`/
/// `random`), returning exactly `to_merge` component indices (or all of them, if `to_merge >=
/// sizes.len()`). Pure — takes only component sizes (not `ConnectedComponents`/`Maze`), so it's
/// unit-testable directly against synthetic size arrays without any graph/field/tessellation
/// setup, unlike `ReduceSccCountStrategy::apply` itself which needs a full `Maze` to compute
/// `sizes` from in the first place.
///
/// Sorts by size then index for determinism — component indices come from a `HashMap`-backed
/// build order that isn't itself randomized per-process, but sizes can tie, and `random` mode's
/// own pick must still be seed-reproducible (see `ExpandRegionPassageStrategy`'s identical
/// rationale for sorting before any rng-involving selection).
fn select_merge_candidates(sizes: &[usize], mode: &str, to_merge: usize, rng: &mut dyn RngCore) -> Vec<usize> {
    let mut candidates: Vec<usize> = (0..sizes.len()).collect();
    match mode {
        PRIORITY_SMALLEST => candidates.sort_by_key(|&i| (sizes[i], i)),
        PRIORITY_LARGEST => candidates.sort_by_key(|&i| (std::cmp::Reverse(sizes[i]), i)),
        _ => {
            // `random`: shuffle deterministically via `rng` (Fisher-Yates), rather than leaving
            // `candidates`' initial (ascending index) order in place — a fixed order would make
            // "random" mode pick the same regions every time regardless of seed.
            for i in (1..candidates.len()).rev() {
                let j = rng.random_range(0..=i);
                candidates.swap(i, j);
            }
        }
    }
    candidates.into_iter().take(to_merge).collect()
}

/// Handles `EXCESSIVE_SCC_COUNT` — see GitHub issue #68. The graph has more strongly-connected
/// components than a check's configured limit allows, but `SccCountCheck`'s issue carries no
/// specific regions to merge (unlike `REGION_NEEDS_EXPANSION`'s `RegionsNeedingExpansion`).
/// Instead of duplicating `ExpandRegionPassageStrategy`'s merge logic, this strategy picks which
/// regions to merge (by `merge_priority`: smallest/largest/random, however many are needed to
/// reach `max_scc_count`), synthesizes a `RegionsNeedingExpansion` issue naming them, and
/// delegates the actual merge to a nested strategy (typically `ExpandRegionPassageStrategy`)
/// filling the `merge_target` slot. The synthetic issue is never published to the shared issue
/// pool — only the original `EXCESSIVE_SCC_COUNT` issue is ever visible to the user.
///
/// **`issue.data` is mandatory for this kind**: `max_scc_count` is the producing check's
/// configured threshold — there is no other channel to learn it.
pub struct ReduceSccCountStrategy;

impl<T: Tessellation> RepairStrategy<T, ExcessiveSccCountIssue> for ReduceSccCountStrategy {
    fn strategy_id(&self) -> &'static str { "reduce_scc_count" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &ExcessiveSccCountIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let max_scc_count = issue.max_scc_count;

        // Idempotency check comes before the nested-strategy lookup — an already-resolved issue
        // must return Fixed regardless of whether a nested strategy is configured, per the
        // idempotency contract (Specs/repair.md): "if the relevant meta field is already set,
        // return Fixed immediately... without consuming rng". Checking `nested` first would
        // return Failed for an already-fixed issue whenever `nested` happened to be empty.
        let scc = maze.analysis.scc(&maze.graph);
        let count = scc.components.len() as u32;
        if count <= max_scc_count {
            return (RepairResult::Fixed { score: None }, vec![]);
        }
        let to_merge = (count - max_scc_count) as usize;

        // `build_nested` (maze-runner) already enforces exactly one nested strategy for this
        // slot via `expected_nested()`'s `max: Some(1)` — this is a defensive re-check, not the
        // primary guard, same posture other strategies take toward their own mandatory inputs
        // (e.g. `ExpandRegionPassageStrategy` on missing `issue.data`).
        let matching: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_MERGE_TARGET).collect();
        debug_assert!(matching.len() <= 1,
            "ReduceSccCountStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_MERGE_TARGET}\" should prevent more than one nested strategy filling it");
        let Some(&merge_target) = matching.first() else {
            return (RepairResult::Failed, vec![]);
        };

        let mode = match params.get(PARAM_MERGE_PRIORITY) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => PRIORITY_SMALLEST,
        };

        let sizes: Vec<usize> = scc.components.iter().map(|c| c.len()).collect();
        let chosen = select_merge_candidates(&sizes, mode, to_merge, rng);
        if chosen.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let synthetic = RegionNeedsExpansionIssue::synthetic(chosen);

        let nested_params = build_params(merge_target.strategy.params(), Some(&merge_target.param_overrides));
        // Parent has accumulated no commands of its own before delegating — nested_commands are
        // the entire returned batch, already in "parent, then nested" order (Specs/repair.md).
        merge_target.strategy.apply(&synthetic as &dyn crate::quality_control::Issue, maze, rng, &nested_params, preset_state, &merge_target.nested)
    }
}

crate::impl_erased_repair_strategy!(ReduceSccCountStrategy, ExcessiveSccCountIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::Graph;
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::strategies::ExpandRegionPassageStrategy;
    use crate::repair::strategies::test_utils::apply_and_commit;

    // `select_merge_candidates` needs no Maze/Graph/Field setup at all — pure sort/shuffle logic
    // over plain sizes, unlike the rest of this file's tests which all build a real maze just to
    // exercise selection as a side effect of calling `apply()`.
    mod select_merge_candidates_tests {
        use super::*;

        #[test]
        fn smallest_picks_lowest_sizes_first() {
            let sizes = [5, 1, 3, 2, 4];
            let mut rng = MazeRng::seed_from_u64(1);
            assert_eq!(select_merge_candidates(&sizes, PRIORITY_SMALLEST, 2, &mut rng), vec![1, 3]);
        }

        #[test]
        fn largest_picks_highest_sizes_first() {
            let sizes = [5, 1, 3, 2, 4];
            let mut rng = MazeRng::seed_from_u64(1);
            assert_eq!(select_merge_candidates(&sizes, PRIORITY_LARGEST, 2, &mut rng), vec![0, 4]);
        }

        #[test]
        fn ties_break_by_ascending_index_for_both_smallest_and_largest() {
            let sizes = [2, 2, 2];
            let mut rng = MazeRng::seed_from_u64(1);
            assert_eq!(select_merge_candidates(&sizes, PRIORITY_SMALLEST, 3, &mut rng), vec![0, 1, 2]);
            assert_eq!(select_merge_candidates(&sizes, PRIORITY_LARGEST, 3, &mut rng), vec![0, 1, 2]);
        }

        #[test]
        fn to_merge_zero_returns_empty() {
            let sizes = [5, 1, 3];
            let mut rng = MazeRng::seed_from_u64(1);
            assert_eq!(select_merge_candidates(&sizes, PRIORITY_SMALLEST, 0, &mut rng), Vec::<usize>::new());
        }

        #[test]
        fn to_merge_beyond_len_returns_all_indices() {
            let sizes = [5, 1, 3];
            let mut rng = MazeRng::seed_from_u64(1);
            let result = select_merge_candidates(&sizes, PRIORITY_SMALLEST, 100, &mut rng);
            let mut sorted = result.clone();
            sorted.sort();
            assert_eq!(sorted, vec![0, 1, 2], "must return every index, not panic or truncate silently");
        }

        #[test]
        fn empty_sizes_returns_empty_regardless_of_mode() {
            let sizes: [usize; 0] = [];
            let mut rng = MazeRng::seed_from_u64(1);
            for mode in [PRIORITY_SMALLEST, PRIORITY_LARGEST, PRIORITY_RANDOM] {
                assert_eq!(select_merge_candidates(&sizes, mode, 2, &mut rng), Vec::<usize>::new());
            }
        }

        #[test]
        fn random_is_deterministic_for_a_fixed_seed() {
            let sizes = [1, 2, 3, 4, 5, 6, 7, 8];
            let mut rng_a = MazeRng::seed_from_u64(42);
            let mut rng_b = MazeRng::seed_from_u64(42);
            let a = select_merge_candidates(&sizes, PRIORITY_RANDOM, 4, &mut rng_a);
            let b = select_merge_candidates(&sizes, PRIORITY_RANDOM, 4, &mut rng_b);
            assert_eq!(a, b);
        }

        #[test]
        fn random_returns_distinct_indices() {
            let sizes = [1, 2, 3, 4, 5];
            let mut rng = MazeRng::seed_from_u64(7);
            let result = select_merge_candidates(&sizes, PRIORITY_RANDOM, 5, &mut rng);
            let mut sorted = result.clone();
            sorted.sort();
            assert_eq!(sorted, vec![0, 1, 2, 3, 4], "a full-length random pick must be a permutation, not repeat/skip indices");
        }

        #[test]
        fn unknown_mode_falls_back_to_the_random_shuffle_branch() {
            // `select_merge_candidates`'s own `match` treats anything other than
            // `PRIORITY_SMALLEST`/`PRIORITY_LARGEST` as `random` (same fallback `PRIORITY_RANDOM`
            // itself uses) — `apply()` is what defaults an unrecognized *param value* to
            // `PRIORITY_SMALLEST` before ever calling this function, so this function's own
            // default is deliberately the opposite: `random`, not `smallest`.
            let sizes = [1, 2, 3, 4, 5, 6, 7, 8];
            let mut rng_a = MazeRng::seed_from_u64(42);
            let mut rng_b = MazeRng::seed_from_u64(42);
            let unknown = select_merge_candidates(&sizes, "not_a_real_mode", 4, &mut rng_a);
            let random = select_merge_candidates(&sizes, PRIORITY_RANDOM, 4, &mut rng_b);
            assert_eq!(unknown, random, "an unrecognized mode string must behave exactly like PRIORITY_RANDOM, not PRIORITY_SMALLEST");
        }
    }

    fn no_params() -> StrategyParams {
        build_params(<ReduceSccCountStrategy as RepairStrategy<SquareTessellation, ExcessiveSccCountIssue>>::params(&ReduceSccCountStrategy), None)
    }

    fn params_with_priority(priority: &str) -> StrategyParams {
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(PARAM_MERGE_PRIORITY.to_string(), priority.to_string());
        build_params(<ReduceSccCountStrategy as RepairStrategy<SquareTessellation, ExcessiveSccCountIssue>>::params(&ReduceSccCountStrategy), Some(&overrides))
    }

    fn expand_region_passage_nested<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
        vec![NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy: Box::new(ExpandRegionPassageStrategy),
            param_overrides: std::collections::HashMap::new(),
            nested: vec![],
        }]
    }

    /// Nested `ExpandRegionPassageStrategy` pinned to the legacy fast path (`random` target
    /// mode, `prefer_partially_connected` off) — first geometrically-adjacent neighbor found,
    /// no `rng` involvement, no risk of two `ReduceSccCountStrategy`-selected sibling regions
    /// picking each other and collapsing two intended merges into one.
    fn expand_region_passage_nested_legacy_fast_path<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
        let mut param_overrides = std::collections::HashMap::new();
        param_overrides.insert(
            crate::repair::strategies::region_merge_core::PARAM_PREFER_PARTIALLY_CONNECTED.to_string(),
            "false".to_string(),
        );
        vec![NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy: Box::new(ExpandRegionPassageStrategy),
            param_overrides,
            nested: vec![],
        }]
    }

    /// 1x4 row of cells, no edges at all -> 4 singleton SCC components, all geometrically
    /// adjacent in a chain: 0-1-2-3.
    fn maze_4_singletons() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn issue_for(max_scc_count: u32) -> ExcessiveSccCountIssue {
        ExcessiveSccCountIssue::with_data(max_scc_count)
    }

    #[test]
    fn apply_fails_when_nested_is_empty() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_fixed_immediately_when_count_within_limit_even_if_nested_is_empty() {
        // Idempotency must take priority over the nested-strategy lookup: an already-resolved
        // issue returns Fixed regardless of whether a nested strategy is configured, matching
        // every other strategy's idempotency contract (Specs/repair.md).
        let mut maze = maze_4_singletons();
        let issue = issue_for(4);
        let mut rng = MazeRng::seed_from_u64(1);
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), edges_before);
    }

    #[test]
    fn apply_fixed_immediately_when_count_within_limit() {
        // 4 singletons is 4 components; max_scc_count of 4 (or more) needs no merging at all.
        let mut maze = maze_4_singletons();
        let issue = issue_for(4);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = expand_region_passage_nested();
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), edges_before);
    }

    #[test]
    fn apply_merges_exactly_count_minus_max_regions() {
        // 4 singletons, max_scc_count = 2 -> exactly 2 regions must be merged away, leaving
        // exactly 2 SCC components (a merge always reduces the component count by exactly one,
        // since it bridges two previously-separate singleton regions into one). Nested strategy
        // pinned to `smallest` target selection (deterministic by component size, no rng-indexed
        // picks) so the outcome doesn't depend on which two adjacent regions the parent's default
        // `smallest` merge_priority happens to pick in a chain topology (see
        // `ExpandRegionPassageStrategy`'s own accepted "chosen regions can merge into each other"
        // imprecision, documented in `Specs/repair.md`).
        let mut maze = maze_4_singletons();
        let issue = issue_for(2);
        let mut rng = MazeRng::seed_from_u64(7);
        let nested = expand_region_passage_nested_legacy_fast_path();
        let result = apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let fresh = Maze::<SquareTessellation>::new(maze.field, maze.graph);
        let scc = fresh.analysis.scc(&fresh.graph);
        assert_eq!(scc.components.len(), 2, "exactly 2 merges must bring the component count down to max_scc_count");
    }

    #[test]
    fn mode_smallest_and_largest_still_make_progress() {
        // A single `apply()` call selects `count - max_scc_count` regions and delegates their
        // merge to the nested strategy — it does not itself guarantee full convergence to
        // `max_scc_count` in one call (chosen regions can merge into each other rather than
        // into fresh neighbors, same accepted imprecision `ExpandRegionPassageStrategy` already
        // has for its own `invalid` set). Full convergence is the pipeline's fixpoint loop's
        // job across iterations, not a single `apply()` call's contract. This test only asserts
        // every mode succeeds and strictly reduces the component count.
        for mode in [PRIORITY_SMALLEST, PRIORITY_LARGEST, PRIORITY_RANDOM] {
            let mut maze = maze_4_singletons();
            let issue = issue_for(1);
            let mut rng = MazeRng::seed_from_u64(3);
            let nested = expand_region_passage_nested();
            let count_before = maze.analysis.scc(&maze.graph).components.len();
            let result = apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze, &mut rng, &params_with_priority(mode), &PresetState::empty(), &nested);
            assert!(matches!(result, RepairResult::Fixed { score: None }), "mode {mode} must succeed");
            let fresh = Maze::<SquareTessellation>::new(maze.field, maze.graph);
            let scc = fresh.analysis.scc(&fresh.graph);
            assert!(scc.components.len() < count_before, "mode {mode} must strictly reduce the component count");
        }
    }

    #[test]
    fn apply_delegates_to_nested_strategy_and_actually_merges() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(3);
        let mut rng = MazeRng::seed_from_u64(11);
        let nested = expand_region_passage_nested();
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // A merge via ExpandRegionPassageStrategy adds a full bidirectional passage (2 edges).
        assert_eq!(maze.graph.edges().count(), edges_before + 2, "nested strategy must have actually added a passage");
    }

    #[test]
    fn apply_respects_preset_blocked_pairs_via_nested_strategy() {
        // Block every possible bridge -- nested ExpandRegionPassageStrategy must fail to find
        // any candidate, and that Failed must propagate through unchanged.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let issue = issue_for(1);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = expand_region_passage_nested();
        let result = apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &nested);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = issue_for(2);

        let mut maze_a = maze_4_singletons();
        let mut rng_a = MazeRng::seed_from_u64(99);
        let nested_a = expand_region_passage_nested();
        apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze_a, &mut rng_a, &params_with_priority(PRIORITY_RANDOM), &PresetState::empty(), &nested_a);

        let mut maze_b = maze_4_singletons();
        let mut rng_b = MazeRng::seed_from_u64(99);
        let nested_b = expand_region_passage_nested();
        apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze_b, &mut rng_b, &params_with_priority(PRIORITY_RANDOM), &PresetState::empty(), &nested_b);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }

    #[test]
    fn apply_fails_when_nested_slot_id_does_not_match() {
        // A nested strategy present but filed under a different slot_id must not be picked up —
        // the strategy must fail the same way it does when nested is empty.
        let mut maze = maze_4_singletons();
        let issue = issue_for(1);
        let mut rng = MazeRng::seed_from_u64(1);
        static OTHER_SLOT: NestedSlot = NestedSlot { slot_id: "some_other_slot", kind: REGION_NEEDS_EXPANSION, min: 1, max: Some(1) };
        let nested = vec![NestedStrategyConfig {
            slot: &OTHER_SLOT,
            strategy: Box::new(ExpandRegionPassageStrategy),
            param_overrides: std::collections::HashMap::new(),
            nested: vec![],
        }];
        let result = apply_and_commit(&ReduceSccCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Failed));
    }
}
