use crate::Maze;
use crate::generation::PresetState;
use crate::quality_control::{REGION_NEEDS_EXPANSION, RegionNeedsExpansionIssue};
use crate::repair::command::MutationCommand;
use crate::repair::nested_dispatch::{nested_params, slot_candidates};
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategies::region_merge_core;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashMap;

/// Slot id for the nested region-merge strategies this strategy chooses between. Its own
/// constant, never shared with another dispatcher's — see `WeightedRegionMergeStrategy`'s
/// `SLOT_MERGE_TARGET` for the rationale.
pub const SLOT_MERGE_TARGET: &str = "merge_target";

/// `param_overrides` key a nested candidate's upper size bound is read from — see
/// `resolve_max_size`. Like the weighted dispatchers' `"weight"`, a convention this dispatcher
/// imposes on top of the nested strategy's own params, never a declared `StrategyParam`.
pub const PARAM_MAX_SIZE: &str = "max_size";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_MERGE_TARGET,
    kind: REGION_NEEDS_EXPANSION,
    min: 1,
    max: None,
    dispatch_kind: NestedDispatchKind::SizeThreshold,
}];

/// Upper size bound (inclusive) of a candidate's range, from its `param_overrides`. A missing,
/// unparsable or negative value is unbounded (`usize::MAX`) — the same value the last entry
/// effectively always has.
fn resolve_max_size(param_overrides: &HashMap<String, String>) -> usize {
    param_overrides
        .get(PARAM_MAX_SIZE)
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(usize::MAX)
}

/// Index into `candidates` (configured order, ascending by `max_size`) whose range contains
/// `size`: the first non-last entry with `size <= max_size`, else the last entry (the fallback;
/// its own bound is ignored). `None` only for an empty list.
fn pick_by_size<T: Tessellation>(
    candidates: &[&NestedStrategyConfig<T>],
    size: usize,
) -> Option<usize> {
    let last = candidates.len().checked_sub(1)?;
    Some(
        candidates[..last]
            .iter()
            .position(|c| size <= resolve_max_size(&c.param_overrides))
            .unwrap_or(last),
    )
}

/// Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #91. Like `WeightedRegionMergeStrategy`/
/// `PriorityRegionMergeStrategy` it only picks *which* nested region-merge strategy runs, but
/// the pick is deterministic by the flagged region's own size: candidates carry a `max_size`
/// (`PARAM_MAX_SIZE`) and are matched in configured order — the first covers sizes up to its
/// `max_size`, each next one `(previous max_size, max_size]`, and the last is the fallback for
/// everything larger (its own `max_size` is ignored). The list is expected sorted ascending by
/// `max_size`; the strategy does not reorder it.
///
/// **One dispatch per region** — same batching as the other dispatchers
/// (`region_merge_core::run_per_region_dispatch`). **No fallback on `Failed`**: the size range
/// fully determines the mechanism, so a failing candidate leaves its region unmerged rather than
/// handing it to a strategy configured for a different size.
///
/// **`issue.data` is mandatory for this kind**, same contract as `ExpandRegionPassageStrategy`.
pub struct SizeThresholdRegionMergeStrategy;

impl<T: Tessellation> RepairStrategy<T, RegionNeedsExpansionIssue>
    for SizeThresholdRegionMergeStrategy
{
    fn strategy_id(&self) -> &'static str {
        "size_threshold_region_merge"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &[]
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &RegionNeedsExpansionIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let invalid = &issue.invalid;
        if invalid.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let candidates = slot_candidates(nested, SLOT_MERGE_TARGET);
        if candidates.is_empty() {
            return (RepairResult::Failed, vec![]);
        }

        region_merge_core::run_per_region_dispatch(
            invalid,
            maze,
            rng,
            |region, scc, single_region_issue, rng| {
                let size = scc.components[region].len();
                let Some(idx) = pick_by_size(&candidates, size) else {
                    return (RepairResult::Failed, vec![]);
                };
                let config = candidates[idx];
                let params = nested_params(config, &HashMap::new());
                config.strategy.apply(
                    single_region_issue,
                    maze,
                    rng,
                    &params,
                    preset_state,
                    &config.nested,
                )
            },
        )
    }
}

crate::impl_erased_repair_strategy!(SizeThresholdRegionMergeStrategy, RegionNeedsExpansionIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::Graph;
    use crate::random::MazeRng;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::repair::strategies::{ExpandRegionPassageStrategy, TeleportRegionMergeStrategy};
    use crate::repair::strategy::ErasedRepairStrategy;
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use rand::SeedableRng;
    use std::sync::Arc;

    fn no_params() -> StrategyParams {
        build_params(
            <SizeThresholdRegionMergeStrategy as RepairStrategy<
                SquareTessellation,
                RegionNeedsExpansionIssue,
            >>::params(&SizeThresholdRegionMergeStrategy),
            None,
        )
    }

    /// 1x4 row of cells, no edges -> 4 singleton regions, chained 0-1-2-3.
    fn maze_4_singletons() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    fn issue_for(invalid: Vec<usize>) -> RegionNeedsExpansionIssue {
        RegionNeedsExpansionIssue::new_from_check("test", invalid, Default::default())
    }

    fn nested_with(
        strategy: Box<dyn ErasedRepairStrategy<SquareTessellation>>,
        max_size: Option<&str>,
    ) -> NestedStrategyConfig<SquareTessellation> {
        let mut param_overrides = HashMap::new();
        if let Some(v) = max_size {
            param_overrides.insert(PARAM_MAX_SIZE.to_string(), v.to_string());
        }
        NestedStrategyConfig {
            slot: &NESTED_SLOTS[0],
            strategy,
            param_overrides,
            nested: vec![],
        }
    }

    fn run(
        nested: &[NestedStrategyConfig<SquareTessellation>],
        preset_state: &PresetState,
    ) -> (RepairResult, Maze<SquareTessellation>) {
        let mut maze = maze_4_singletons();
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(
            &SizeThresholdRegionMergeStrategy,
            &issue_for(vec![0]),
            &mut maze,
            &mut rng,
            &no_params(),
            preset_state,
            nested,
        );
        (result, maze)
    }

    fn has_teleport(maze: &Maze<SquareTessellation>) -> bool {
        maze.graph
            .edges()
            .any(|e| matches!(e.kind, crate::graph::EdgeKind::Teleport { .. }))
    }

    #[test]
    fn resolve_max_size_falls_back_to_unbounded() {
        let mut o = HashMap::new();
        assert_eq!(resolve_max_size(&o), usize::MAX);
        o.insert(PARAM_MAX_SIZE.to_string(), "abc".to_string());
        assert_eq!(resolve_max_size(&o), usize::MAX);
        o.insert(PARAM_MAX_SIZE.to_string(), "-3".to_string());
        assert_eq!(resolve_max_size(&o), usize::MAX);
        o.insert(PARAM_MAX_SIZE.to_string(), " 7 ".to_string());
        assert_eq!(resolve_max_size(&o), 7);
    }

    #[test]
    fn pick_by_size_matches_inclusive_ranges_and_falls_back_to_last() {
        let configs = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), Some("3")),
            nested_with(Box::new(ExpandRegionPassageStrategy), Some("10")),
            nested_with(Box::new(TeleportRegionMergeStrategy), Some("1")),
        ];
        let refs: Vec<_> = configs.iter().collect();
        // (.., 3], (3, 10], then the last entry for everything above (its own bound ignored).
        for (size, expected) in [(1, 0), (3, 0), (4, 1), (10, 1), (11, 2), (1000, 2)] {
            assert_eq!(pick_by_size(&refs, size), Some(expected), "size {size}");
        }
        assert_eq!(pick_by_size::<SquareTessellation>(&[], 5), None);
    }

    #[test]
    fn empty_invalid_is_fixed_and_empty_slot_fails() {
        let mut maze = maze_4_singletons();
        let mut rng = MazeRng::seed_from_u64(1);
        let r = apply_and_commit(
            &SizeThresholdRegionMergeStrategy,
            &issue_for(vec![]),
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(r, RepairResult::Fixed { score: None }));
        let (r, _) = run(&[], &PresetState::empty());
        assert!(matches!(r, RepairResult::Failed));
    }

    #[test]
    fn region_within_first_threshold_uses_first_candidate() {
        // Singleton region (size 1) <= 1 -> expand (plain passage, no teleport).
        let nested = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), Some("1")),
            nested_with(Box::new(TeleportRegionMergeStrategy), None),
        ];
        let (r, maze) = run(&nested, &PresetState::empty());
        assert!(matches!(r, RepairResult::Fixed { .. }));
        assert!(!has_teleport(&maze));
    }

    #[test]
    fn region_above_all_thresholds_uses_last_candidate_ignoring_its_own_bound() {
        // Size 1 > 0 -> falls to the last entry, whose max_size (0) must be ignored.
        let nested = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), Some("0")),
            nested_with(Box::new(TeleportRegionMergeStrategy), Some("0")),
        ];
        let (r, maze) = run(&nested, &PresetState::empty());
        assert!(matches!(r, RepairResult::Fixed { .. }));
        assert!(has_teleport(&maze));
    }

    #[test]
    fn single_candidate_handles_every_size() {
        let nested = vec![nested_with(
            Box::new(ExpandRegionPassageStrategy),
            Some("0"),
        )];
        let (r, _) = run(&nested, &PresetState::empty());
        assert!(matches!(r, RepairResult::Fixed { .. }));
    }

    #[test]
    fn failed_candidate_is_not_retried_with_another_range() {
        // Region 0's only neighbor pair is blocked -> expand fails; teleport (other range) must
        // not be tried.
        let nodes: Vec<_> = maze_4_singletons().field.all_node_ids().collect();
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));
        let nested = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), Some("1")),
            nested_with(Box::new(TeleportRegionMergeStrategy), None),
        ];
        let (r, maze) = run(&nested, &preset_state);
        assert!(matches!(r, RepairResult::Failed));
        assert!(!has_teleport(&maze));
    }
}
