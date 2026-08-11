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
use crate::repair::nested_dispatch::{dispatch_weighted, WeightedCandidate};

/// `param_overrides` key a nested candidate's selection weight is read from — see
/// `resolve_weight` below. Not a declared `StrategyParam` of the nested strategy itself (it's a
/// convention this dispatcher imposes on top of whatever params the nested strategy already
/// has), so it never appears in any strategy's `params()`.
const WEIGHT_KEY: &str = "weight";

/// Fallback weight used whenever `WEIGHT_KEY` is absent, unparsable, non-finite, or `<= 0.0`.
const DEFAULT_WEIGHT: f64 = 1.0;

/// Slot id for the nested region-merge strategies this strategy dispatches across — see
/// `Specs/repair.md`'s nested-strategy pattern. Public: part of this strategy's configuration
/// API (`StrategyConfig.slot_id` in `maze-runner`), not an internal detail. Deliberately its own
/// constant, not a reuse of `reduce_scc_count::SLOT_MERGE_TARGET` — `slot_id` is part of each
/// strategy's own public API and is never shared indirectly through another strategy's constant,
/// even when the string value happens to coincide.
pub const SLOT_MERGE_TARGET: &str = "merge_target";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot { slot_id: SLOT_MERGE_TARGET, kind: REGION_NEEDS_EXPANSION, min: 1, max: None, dispatch_kind: NestedDispatchKind::Weighted },
];

/// Resolves a nested candidate's selection weight from its `param_overrides`. Never returns a
/// non-finite or non-positive value — any missing/unparsable/non-finite/`<= 0.0` input falls
/// back to `DEFAULT_WEIGHT`, guaranteeing that as long as at least one nested candidate is
/// configured, the pool passed to `dispatch_weighted` always has a strictly positive total
/// weight.
fn resolve_weight(param_overrides: &std::collections::HashMap<String, String>) -> f64 {
    param_overrides.get(WEIGHT_KEY)
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(DEFAULT_WEIGHT)
}

/// Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #90. Unlike `ExpandRegionPassageStrategy`/
/// `TeleportRegionMergeStrategy`, which each implement one specific merge mechanism, this
/// strategy picks *which* nested region-merge strategy to actually run: it holds N nested
/// strategies under the `merge_target` slot, each with a weight (`param_overrides["weight"]`,
/// see `resolve_weight`), and delegates to `dispatch_weighted` (`nested_dispatch.rs`) — weighted
/// random selection without replacement, retrying a different nested strategy if the chosen one
/// returns `Failed`, until one succeeds or every candidate has been tried.
///
/// **One dispatch per region, not per `apply()` call** (GitHub issue #120): `issue.invalid` can
/// carry several independent undersized regions in one batch. Dispatching the *whole* batch to a
/// single weighted pick (the original #90 design) meant a low-weight candidate that happened to
/// win controlled the outcome for every region still left in the batch at that point, not just
/// its own configured share — a rare 1%-odds win could still absorb most of a large batch,
/// making the configured weight ratio not track the actual per-region merge frequency. Splitting
/// `invalid` into one independent `dispatch_weighted` call per region was tried when #90 first
/// shipped and reverted at the time: it broke snapshot-reuse, since re-dispatching per region
/// forced a fresh, possibly differently-numbered `scc()` snapshot after every mutation. That
/// blocker no longer applies — the immutable-snapshot `MutationCommand` contract (GitHub issue
/// #118) means `apply()` only ever proposes commands, never mutates `maze.graph` in place, so one
/// `scc()` snapshot taken up front stays valid (and correctly numbered) for the whole `apply()`
/// call. This strategy now runs its own `invalid`-batch loop directly, synthesizing a
/// single-region `RegionNeedsExpansionIssue` for each `dispatch_weighted` call so a weight always
/// governs exactly one region's outcome.
///
/// The parent issue is passed through to each nested call as a synthetic single-region copy
/// (unlike `ReduceSccCountStrategy`, which synthesizes a new `Issue` naming which regions to
/// merge for a different reason) — this strategy only picks the merge *mechanism* per region, not
/// which regions need merging; that's already `issue.invalid`.
///
/// **`issue.data` is mandatory for this kind**, same contract as `ExpandRegionPassageStrategy`:
/// `invalid` is the producing check's result — there is no other channel to learn it.
pub struct WeightedRegionMergeStrategy;

/// Every `NodeId` a `MutationCommand` connects — used to find which SCC component (other than the
/// one just dispatched) a nested strategy's proposed command actually reached, so an already-
/// merged neighbor from the same batch can be skipped rather than re-dispatched. `SetStart`/
/// `SetFinish`/`RemoveEdge` (by opaque `EdgeId`, endpoints not recoverable without the graph)
/// never arise here — every `merge_target` nested strategy only ever proposes an
/// edge/teleport-adding command between two region nodes.
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
/// mutation actually connects to — that neighbor, if it's also a still-pending region in this
/// batch, has effectively been merged away by this dispatch and must not be separately
/// dispatched later in the same `apply()` call's loop.
fn merged_neighbor(commands: &[MutationCommand], scc: &ConnectedComponents, region_idx: usize) -> Option<usize> {
    commands.iter().find_map(|cmd| {
        let (a, b) = command_endpoints(cmd)?;
        [a, b].into_iter()
            .filter_map(|node| scc.component_of(node))
            .find(|&idx| idx != region_idx)
    })
}

impl<T: Tessellation> RepairStrategy<T, RegionNeedsExpansionIssue> for WeightedRegionMergeStrategy {
    fn strategy_id(&self) -> &'static str { "weighted_region_merge" }

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

        // Defensive runtime filter, not the primary validation: `maze-runner`'s `build_nested`
        // already guarantees every entry in `nested` fills a slot this strategy actually
        // declared (the sole `merge_target` slot here). This filter only protects direct
        // `apply()` calls made outside the runner (tests, future internal callers) — same
        // posture `ReduceSccCountStrategy` takes toward its own single slot.
        let candidate_configs: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_MERGE_TARGET).collect();
        if candidate_configs.is_empty() {
            return (RepairResult::Failed, vec![]);
        }

        debug_assert!(
            candidate_configs.iter().all(|c| !c.strategy.params().iter().any(|p| p.id == WEIGHT_KEY)),
            "a merge_target candidate declares its own \"{WEIGHT_KEY}\" param — this collides with \
             resolve_weight's reserved param_overrides key; rename the candidate's param"
        );

        let candidates: Vec<WeightedCandidate<T>> = candidate_configs.iter()
            .map(|&config| WeightedCandidate { config, weight: resolve_weight(&config.param_overrides) })
            .collect();

        // One fixed snapshot for the whole batch loop — every nested strategy's own `apply()`
        // would otherwise re-fetch this same cache entry per region anyway (keyed on
        // `graph.version()`, untouched since this call never mutates `maze.graph`), so reading it
        // once here just skips the redundant re-fetch, not a new caching decision.
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
            let (result, commands) = dispatch_weighted(
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

crate::impl_erased_repair_strategy!(WeightedRegionMergeStrategy, RegionNeedsExpansionIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::Graph;
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, MultiLevelField};
    use crate::repair::params::build_params;
    use crate::repair::strategies::{ExpandRegionPassageStrategy, TeleportRegionMergeStrategy};
    use crate::repair::strategy::ErasedRepairStrategy;
    use std::collections::HashMap;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<WeightedRegionMergeStrategy as RepairStrategy<SquareTessellation, RegionNeedsExpansionIssue>>::params(&WeightedRegionMergeStrategy), None)
    }

    /// 1x4 row of cells, no edges at all -> 4 singleton SCC components, all geometrically
    /// adjacent in a chain: 0-1-2-3. Same fixture shape as `reduce_scc_count.rs`'s tests.
    fn maze_4_singletons() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        Maze::new(field, g)
    }

    fn issue_for(invalid: Vec<usize>) -> RegionNeedsExpansionIssue {
        RegionNeedsExpansionIssue::new_from_check("test", invalid, Default::default())
    }

    fn nested_with(strategy: Box<dyn ErasedRepairStrategy<SquareTessellation>>, weight: Option<&str>) -> NestedStrategyConfig<SquareTessellation> {
        let mut param_overrides = HashMap::new();
        if let Some(w) = weight {
            param_overrides.insert(WEIGHT_KEY.to_string(), w.to_string());
        }
        NestedStrategyConfig { slot: &NESTED_SLOTS[0], strategy, param_overrides, nested: vec![] }
    }

    #[test]
    fn apply_fixed_immediately_on_empty_invalid_without_rng_or_nested() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![]);
        let mut rng_a = MazeRng::seed_from_u64(1);
        let mut rng_b = MazeRng::seed_from_u64(1);
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut rng_a, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), edges_before);
        assert_eq!(rng_a.next_u64(), rng_b.next_u64(), "rng must not be consumed on the empty-invalid idempotency path");
    }

    #[test]
    fn apply_fails_when_no_candidate_fills_the_slot() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_fails_when_nested_slot_id_does_not_match() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        static OTHER_SLOT: NestedSlot = NestedSlot { slot_id: "some_other_slot", kind: REGION_NEEDS_EXPANSION, min: 1, max: None, dispatch_kind: NestedDispatchKind::Weighted };
        let nested = vec![NestedStrategyConfig {
            slot: &OTHER_SLOT,
            strategy: Box::new(ExpandRegionPassageStrategy),
            param_overrides: HashMap::new(),
            nested: vec![],
        }];
        let result = apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_delegates_to_single_candidate_and_actually_merges() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![nested_with(Box::new(ExpandRegionPassageStrategy), None)];
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(maze.graph.edges().count() > edges_before, "delegate must have actually merged the region");
    }

    #[test]
    fn apply_forwards_a_multi_region_batch_unchanged_and_merges_more_than_one_region() {
        // 1x4 chain: 0-1-2-3, four singleton regions. `invalid: vec![0, 2]` names two of them —
        // if `WeightedRegionMergeStrategy::apply` silently truncated `invalid` to its first
        // element (or otherwise failed to forward the full batch to the nested strategy), only
        // one merge would happen instead of two. `ExpandRegionPassageStrategy`'s own
        // `run_merge_loop` is what actually walks the whole batch in one `apply()` call — this
        // test only proves the batch reaches it intact, not `run_merge_loop`'s own behavior.
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0, 2]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![nested_with(Box::new(ExpandRegionPassageStrategy), None)];
        let edges_before = maze.graph.edges().count();
        let result = apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        // Each successful merge in a 1x4 singleton chain adds exactly one bidirectional passage
        // (2 directed edges) between geometrically-adjacent nodes — two regions merged means two
        // such passages, not one.
        assert_eq!(maze.graph.edges().count() - edges_before, 4, "both regions in the batch must have been merged, not just the first");
    }

    #[test]
    fn invalid_weight_values_fall_back_to_default_and_do_not_break_apply() {
        for bad in ["not_a_number", "-3.0", "0", "NaN", "inf"] {
            assert_eq!(resolve_weight(&HashMap::from([(WEIGHT_KEY.to_string(), bad.to_string())])), DEFAULT_WEIGHT, "bad weight {bad:?} must fall back to default");
        }
        assert_eq!(resolve_weight(&HashMap::new()), DEFAULT_WEIGHT, "missing weight must fall back to default");
        assert_eq!(resolve_weight(&HashMap::from([(WEIGHT_KEY.to_string(), "3.5".to_string())])), 3.5);

        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![nested_with(Box::new(ExpandRegionPassageStrategy), Some("not_a_number"))];
        let result = apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }), "a broken weight override must not break apply — falls back to default");
    }

    #[test]
    fn apply_retries_after_a_guaranteed_failure_and_ends_fixed_without_its_trace() {
        // 1x4 chain: 0-1-2-3, region 0 (node 0) has exactly one geometric neighbor (node 1).
        // Blocking just that (node0, node1) pair in both directions makes
        // ExpandRegionPassageStrategy guaranteed to fail for region 0 (no other geometrically
        // adjacent neighbor exists), while TeleportRegionMergeStrategy — not geometry-bound, any
        // other SCC component is a valid candidate (e.g. region 2 or 3) — is guaranteed to
        // succeed. Whichever dispatch_weighted tries first, the end result must be Fixed with no
        // trace of ExpandRegionPassageStrategy's (rolled-back) attempt.
        let mut maze = maze_4_singletons();
        let nodes: Vec<_> = maze.field.field_of(maze.field.single_level_id()).unwrap().all_points().map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap()).collect();
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), None),
            nested_with(Box::new(TeleportRegionMergeStrategy), None),
        ];
        let result = apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }), "teleport candidate must succeed after the geometry-blocked candidate fails");
        let has_basic_bridge = maze.graph.edges().any(|e| {
            (e.from == nodes[0] && e.to == nodes[1]) || (e.from == nodes[1] && e.to == nodes[0])
        });
        assert!(!has_basic_bridge, "the blocked pair must never have been bridged — ExpandRegionPassageStrategy's failed attempt must be rolled back");
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let issue = issue_for(vec![0]);

        let mut maze_a = maze_4_singletons();
        let mut rng_a = MazeRng::seed_from_u64(99);
        let nested_a = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), Some("2.0")),
            nested_with(Box::new(TeleportRegionMergeStrategy), Some("1.0")),
        ];
        apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &nested_a);

        let mut maze_b = maze_4_singletons();
        let mut rng_b = MazeRng::seed_from_u64(99);
        let nested_b = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), Some("2.0")),
            nested_with(Box::new(TeleportRegionMergeStrategy), Some("1.0")),
        ];
        apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &nested_b);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }

    /// Declares its own `"weight"` param — used to verify the collision guard against
    /// `resolve_weight`'s reserved `param_overrides` key.
    struct DeclaresWeightParamStrategy;
    impl<T: Tessellation> RepairStrategy<T, RegionNeedsExpansionIssue> for DeclaresWeightParamStrategy {
        fn strategy_id(&self) -> &'static str { "test_declares_weight_param" }
        fn params(&self) -> &'static [StrategyParam] {
            &[StrategyParam { id: WEIGHT_KEY, label: "Weight", kind: crate::repair::StrategyParamKind::Float { default: 1.0, min: 0.0, max: 1.0 } }]
        }
        fn apply(
            &self, _issue: &RegionNeedsExpansionIssue, _maze: &Maze<T>,
            _rng: &mut dyn RngCore, _params: &StrategyParams, _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            (RepairResult::Fixed { score: None }, vec![])
        }
    }
    crate::impl_erased_repair_strategy!(DeclaresWeightParamStrategy, RegionNeedsExpansionIssue);

    #[test]
    #[should_panic(expected = "collides with resolve_weight's reserved param_overrides key")]
    fn apply_panics_in_debug_when_a_candidate_declares_its_own_weight_param() {
        let mut maze = maze_4_singletons();
        let issue = issue_for(vec![0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![nested_with(Box::new(DeclaresWeightParamStrategy), None)];
        apply_and_commit(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    }
}
