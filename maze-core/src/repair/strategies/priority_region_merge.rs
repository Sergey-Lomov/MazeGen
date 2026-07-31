use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{RegionNeedsExpansionIssue, Issue, REGION_NEEDS_EXPANSION};
use crate::generation::PresetState;
use crate::graph::scc::ConnectedComponents;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig, NestedDispatchKind};
use crate::repair::command::MutationCommand;
use crate::repair::nested_dispatch::dispatch_priority;

/// Slot id for the nested region-merge strategies this strategy dispatches across — see
/// `Specs/repair.md`'s nested-strategy pattern. Its own constant, not a reuse of
/// `WeightedRegionMergeStrategy::SLOT_MERGE_TARGET` — `slot_id` is part of each strategy's own
/// public API and is never shared indirectly through another strategy's constant, even when the
/// string value happens to coincide.
pub const SLOT_MERGE_TARGET: &str = "merge_target";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot { slot_id: SLOT_MERGE_TARGET, kind: REGION_NEEDS_EXPANSION, min: 1, max: None, dispatch_kind: NestedDispatchKind::Priority },
];

/// Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #259, the priority-fallback companion to
/// `WeightedRegionMergeStrategy` (issue #90). Same role — picks *which* nested region-merge
/// strategy actually runs — but selection is by configured order rather than weighted-random: it
/// holds any number of nested strategies under one slot and delegates to `dispatch_priority`
/// (`nested_dispatch.rs`), trying them in list order and falling through to the next on `Failed`,
/// until one succeeds or every candidate has been tried.
///
/// **One dispatch per region, not per `apply()` call** — same batching rationale as
/// `WeightedRegionMergeStrategy` (see its own doc comment for the full GitHub issue #120
/// background): `issue.invalid` can carry several independent undersized regions in one batch,
/// and folding the whole batch into a single dispatch would let the first-in-priority candidate's
/// success or failure govern every region still left in the batch, not just decide the mechanism
/// once per region. This strategy runs its own `invalid`-batch loop directly, synthesizing a
/// single-region `RegionNeedsExpansionIssue` for each `dispatch_priority` call.
///
/// The parent issue is passed through to each nested call as a synthetic single-region copy, same
/// as `WeightedRegionMergeStrategy` — this strategy only picks the merge *mechanism* per region,
/// not which regions need merging.
///
/// **`issue.data` is mandatory for this kind**, same contract as `ExpandRegionPassageStrategy`.
pub struct PriorityRegionMergeStrategy;

/// Every `NodeId` a `MutationCommand` connects — used to find which SCC component (other than the
/// one just dispatched) a nested strategy's proposed command actually reached, so an already-
/// merged neighbor from the same batch can be skipped rather than re-dispatched. Same contract as
/// `weighted_region_merge::command_endpoints`.
fn command_endpoints(command: &MutationCommand) -> Option<(crate::ids::NodeId, crate::ids::NodeId)> {
    match *command {
        MutationCommand::AddDirectedEdge { from, to } => Some((from, to)),
        MutationCommand::AddBidirectionalEdge { a, b } => Some((a, b)),
        MutationCommand::AddDirectedTeleport { from, to } => Some((from, to)),
        MutationCommand::AddBidirectionalTeleport { a, b } => Some((a, b)),
        MutationCommand::RemoveEdge { .. }
        | MutationCommand::RemoveEdgeBetween { .. }
        | MutationCommand::RemoveEdgeWithReverse { .. }
        | MutationCommand::RemoveTeleportWithReverse { .. }
        | MutationCommand::SetStart(_)
        | MutationCommand::SetFinish(_)
        | MutationCommand::RemoveNode { .. }
        | MutationCommand::ReplacePointNodes { .. } => None,
    }
}

/// Scans `commands` for any component index (other than `region_idx` itself) that a proposed
/// mutation actually connects to — see `weighted_region_merge::merged_neighbor`.
fn merged_neighbor(commands: &[MutationCommand], scc: &ConnectedComponents, region_idx: usize) -> Option<usize> {
    commands.iter().find_map(|cmd| {
        let (a, b) = command_endpoints(cmd)?;
        [a, b].into_iter()
            .filter_map(|node| scc.component_of(node))
            .find(|&idx| idx != region_idx)
    })
}

impl<T: Tessellation> RepairStrategy<T, RegionNeedsExpansionIssue> for PriorityRegionMergeStrategy {
    fn strategy_id(&self) -> &'static str { "priority_region_merge" }

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

        // Defensive runtime filter, not the primary validation — see
        // `WeightedRegionMergeStrategy::apply`'s identical comment for the rationale.
        let candidates: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_MERGE_TARGET).collect();
        if candidates.is_empty() {
            return (RepairResult::Failed, vec![]);
        }

        // One fixed snapshot for the whole batch loop — same rationale as
        // `WeightedRegionMergeStrategy::apply`.
        let scc = maze.analysis.scc(&maze.graph);

        let mut pending: Vec<usize> = invalid.clone();
        let mut merged_away: HashSet<usize> = HashSet::new();
        let mut all_commands: Vec<MutationCommand> = Vec::new();
        let mut any_fixed = false;

        while let Some(region_idx) = pending.pop() {
            if merged_away.contains(&region_idx) {
                continue;
            }

            let single_region_issue = RegionNeedsExpansionIssue::synthetic(vec![region_idx]);
            let (result, commands) = dispatch_priority(
                &single_region_issue as &dyn Issue, maze, rng, preset_state, &candidates,
            );

            if matches!(result, RepairResult::Fixed { .. }) {
                any_fixed = true;
                if let Some(neighbor_idx) = merged_neighbor(&commands, &scc, region_idx) {
                    if invalid.contains(&neighbor_idx) {
                        merged_away.insert(neighbor_idx);
                    }
                }
                all_commands.extend(commands);
            }
        }

        if any_fixed {
            (RepairResult::Fixed { score: None }, all_commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(PriorityRegionMergeStrategy, RegionNeedsExpansionIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::params::build_params;
    use crate::repair::strategies::{ExpandRegionPassageStrategy, TeleportRegionMergeStrategy};
    use crate::repair::strategy::ErasedRepairStrategy;
    use std::collections::HashMap;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<PriorityRegionMergeStrategy as RepairStrategy<SquareTessellation, RegionNeedsExpansionIssue>>::params(&PriorityRegionMergeStrategy), None)
    }

    /// 1x4 row of cells, no edges at all -> 4 singleton SCC components, all geometrically
    /// adjacent in a chain: 0-1-2-3. Same fixture shape as `weighted_region_merge.rs`'s tests.
    fn maze_4_singletons() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    fn issue_for(invalid: Vec<usize>) -> RegionNeedsExpansionIssue {
        RegionNeedsExpansionIssue::new_from_check("test", invalid, Default::default())
    }

    fn nested_with(strategy: Box<dyn ErasedRepairStrategy<SquareTessellation>>) -> NestedStrategyConfig<SquareTessellation> {
        NestedStrategyConfig { slot: &NESTED_SLOTS[0], strategy, param_overrides: HashMap::new(), nested: vec![] }
    }

    #[test]
    fn apply_fixed_immediately_on_empty_invalid_without_rng_or_nested() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![]);
        let mut rng_a = MazeRng::seed_from_u64(1);
        let mut rng_b = MazeRng::seed_from_u64(1);
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&PriorityRegionMergeStrategy, &issue, &mut maze, &mut rng_a, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), edges_before);
        assert_eq!(rng_a.next_u64(), rng_b.next_u64(), "rng must not be consumed on the empty-invalid idempotency path");
    }

    #[test]
    fn apply_fails_when_no_candidate_fills_the_slot() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&PriorityRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_fails_when_nested_slot_id_does_not_match() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        static OTHER_SLOT: NestedSlot = NestedSlot { slot_id: "some_other_slot", kind: REGION_NEEDS_EXPANSION, min: 1, max: None, dispatch_kind: NestedDispatchKind::Priority };
        let nested = vec![NestedStrategyConfig {
            slot: &OTHER_SLOT,
            strategy: Box::new(ExpandRegionPassageStrategy),
            param_overrides: HashMap::new(),
            nested: vec![],
        }];
        let result = apply_and_commit(&PriorityRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_delegates_to_single_candidate_and_actually_merges() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![nested_with(Box::new(ExpandRegionPassageStrategy))];
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&PriorityRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(maze.graph.edges().count() > edges_before, "delegate must have actually merged the region");
    }

    #[test]
    fn apply_forwards_a_multi_region_batch_unchanged_and_merges_more_than_one_region() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0, 2]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![nested_with(Box::new(ExpandRegionPassageStrategy))];
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&PriorityRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(maze.graph.edges().count() - edges_before, 4, "both regions in the batch must have been merged, not just the first");
    }

    #[test]
    fn apply_falls_through_to_the_next_priority_candidate_after_a_guaranteed_failure() {
        // 1x4 chain: 0-1-2-3, region 0 (node 0) has exactly one geometric neighbor (node 1).
        // Blocking that pair in both directions makes ExpandRegionPassageStrategy guaranteed to
        // fail for region 0, while TeleportRegionMergeStrategy is guaranteed to succeed (not
        // geometry-bound). ExpandRegionPassageStrategy is listed first — its failure must fall
        // through to the second candidate, not abort the whole dispatch.
        let mut maze = maze_4_singletons();
        let nodes: Vec<_> = maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).collect();
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy)),
            nested_with(Box::new(TeleportRegionMergeStrategy)),
        ];
        let result = apply_and_commit(&PriorityRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }), "the priority-second teleport candidate must succeed after the first, geometry-blocked candidate fails");
        let has_basic_bridge = maze.graph.edges().any(|e| {
            (e.from == nodes[0] && e.to == nodes[1]) || (e.from == nodes[1] && e.to == nodes[0])
        });
        assert!(!has_basic_bridge, "the blocked pair must never have been bridged — the failed first candidate's attempt must be rolled back");
    }

    #[test]
    fn apply_never_tries_a_lower_priority_candidate_once_the_first_succeeds() {
        // Both candidates can succeed for region 0 (no geometry block here) — with
        // ExpandRegionPassageStrategy listed first, only its own kind of connection (a
        // geometrically-adjacent bidirectional passage) must land; TeleportRegionMergeStrategy
        // must never even run.
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy)),
            nested_with(Box::new(TeleportRegionMergeStrategy)),
        ];
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&PriorityRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert_eq!(maze.graph.edges().count() - edges_before, 2, "exactly one bidirectional passage from the first (priority) candidate must land");
        assert!(maze.graph.edges().all(|e| e.kind != EdgeKind::Teleport), "the second candidate (teleport) must never have run");
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = issue_for(vec![0]);

        let mut maze_a = maze_4_singletons();
        let mut rng_a = MazeRng::seed_from_u64(99);
        let nested_a = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy)),
            nested_with(Box::new(TeleportRegionMergeStrategy)),
        ];
        apply_and_commit(&PriorityRegionMergeStrategy, &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &nested_a);

        let mut maze_b = maze_4_singletons();
        let mut rng_b = MazeRng::seed_from_u64(99);
        let nested_b = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy)),
            nested_with(Box::new(TeleportRegionMergeStrategy)),
        ];
        apply_and_commit(&PriorityRegionMergeStrategy, &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &nested_b);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }
}
