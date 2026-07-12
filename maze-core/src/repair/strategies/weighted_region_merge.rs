use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{RegionNeedsExpansionIssue, Issue, REGION_NEEDS_EXPANSION};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig};
use crate::repair::snapshot::SnapshotStack;
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
    NestedSlot { slot_id: SLOT_MERGE_TARGET, kind: REGION_NEEDS_EXPANSION, min: 1, max: None },
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
/// The parent issue is passed through to the nested call unchanged — this strategy only picks the
/// merge *mechanism*, not which region needs merging; that's already `issue.region_id`.
///
/// **One dispatch per `apply()` call, exactly matching one region**: since GitHub issue #99, an
/// issue names exactly one undersized region, so this strategy's own weight-ratio-vs-batch-size
/// mismatch (see GitHub issue #90's follow-up, which tried and reverted per-region dispatch here)
/// no longer applies — the fixpoint loop calling `apply()` once per rule dispatch already means
/// once per region.
pub struct WeightedRegionMergeStrategy;

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
        maze: &mut Maze<T>,
        snapshots: &mut SnapshotStack,
        rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> RepairResult {
        // Defensive runtime filter, not the primary validation: `maze-runner`'s `build_nested`
        // already guarantees every entry in `nested` fills a slot this strategy actually
        // declared (the sole `merge_target` slot here). This filter only protects direct
        // `apply()` calls made outside the runner (tests, future internal callers) — same
        // posture `ReduceSccCountStrategy` takes toward its own single slot.
        let candidate_configs: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_MERGE_TARGET).collect();
        if candidate_configs.is_empty() {
            return RepairResult::Failed;
        }

        debug_assert!(
            candidate_configs.iter().all(|c| !c.strategy.params().iter().any(|p| p.id == WEIGHT_KEY)),
            "a merge_target candidate declares its own \"{WEIGHT_KEY}\" param — this collides with \
             resolve_weight's reserved param_overrides key; rename the candidate's param"
        );

        let candidates: Vec<WeightedCandidate<T>> = candidate_configs.iter()
            .map(|&config| WeightedCandidate { config, weight: resolve_weight(&config.param_overrides) })
            .collect();

        dispatch_weighted(issue as &dyn Issue, maze, snapshots, rng, preset_state, &candidates)
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
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::params::build_params;
    use crate::repair::strategies::{ExpandRegionPassageStrategy, TeleportRegionMergeStrategy};
    use crate::repair::strategy::ErasedRepairStrategy;
    use std::collections::HashMap;

    fn no_params() -> StrategyParams {
        build_params(<WeightedRegionMergeStrategy as RepairStrategy<SquareTessellation, RegionNeedsExpansionIssue>>::params(&WeightedRegionMergeStrategy), None)
    }

    /// 1x4 row of cells, no edges at all -> 4 singleton SCC components, all geometrically
    /// adjacent in a chain: 0-1-2-3. Same fixture shape as `reduce_scc_count.rs`'s tests.
    fn maze_4_singletons() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        Maze::new(field, g)
    }

    /// Resolves `node`'s current region id/members via a fresh `scc()` and builds a single-region
    /// issue for it.
    fn issue_for_node<T: Tessellation>(maze: &Maze<T>, node: crate::ids::NodeId) -> RegionNeedsExpansionIssue {
        let scc = maze.analysis.scc(&maze.graph);
        let region_id = scc.component_of(node).unwrap();
        RegionNeedsExpansionIssue::new_from_check("test", region_id, scc.components[region_id].clone(), Vec::new())
    }

    fn node0<T: Tessellation>(maze: &Maze<T>) -> crate::ids::NodeId {
        maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).next().unwrap()
    }

    fn nested_with(strategy: Box<dyn ErasedRepairStrategy<SquareTessellation>>, weight: Option<&str>) -> NestedStrategyConfig<SquareTessellation> {
        let mut param_overrides = HashMap::new();
        if let Some(w) = weight {
            param_overrides.insert(WEIGHT_KEY.to_string(), w.to_string());
        }
        NestedStrategyConfig { slot: &NESTED_SLOTS[0], strategy, param_overrides, nested: vec![] }
    }

    #[test]
    fn apply_fails_when_no_candidate_fills_the_slot() {
        let maze = maze_4_singletons();
        let issue = issue_for_node(&maze, node0(&maze));
        let mut maze = maze;
        let mut rng = MazeRng::seed_from_u64(1);
        let result = RepairStrategy::apply(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_fails_when_nested_slot_id_does_not_match() {
        let maze = maze_4_singletons();
        let issue = issue_for_node(&maze, node0(&maze));
        let mut maze = maze;
        let mut rng = MazeRng::seed_from_u64(1);
        static OTHER_SLOT: NestedSlot = NestedSlot { slot_id: "some_other_slot", kind: REGION_NEEDS_EXPANSION, min: 1, max: None };
        let nested = vec![NestedStrategyConfig {
            slot: &OTHER_SLOT,
            strategy: Box::new(ExpandRegionPassageStrategy),
            param_overrides: HashMap::new(),
            nested: vec![],
        }];
        let result = RepairStrategy::apply(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_delegates_to_single_candidate_and_actually_merges() {
        let maze = maze_4_singletons();
        let issue = issue_for_node(&maze, node0(&maze));
        let mut maze = maze;
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![nested_with(Box::new(ExpandRegionPassageStrategy), None)];
        let edges_before = maze.graph.edges().count();
        let result = RepairStrategy::apply(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }));
        assert!(maze.graph.edges().count() > edges_before, "delegate must have actually merged the region");
    }

    #[test]
    fn invalid_weight_values_fall_back_to_default_and_do_not_break_apply() {
        for bad in ["not_a_number", "-3.0", "0", "NaN", "inf"] {
            assert_eq!(resolve_weight(&HashMap::from([(WEIGHT_KEY.to_string(), bad.to_string())])), DEFAULT_WEIGHT, "bad weight {bad:?} must fall back to default");
        }
        assert_eq!(resolve_weight(&HashMap::new()), DEFAULT_WEIGHT, "missing weight must fall back to default");
        assert_eq!(resolve_weight(&HashMap::from([(WEIGHT_KEY.to_string(), "3.5".to_string())])), 3.5);

        let maze = maze_4_singletons();
        let issue = issue_for_node(&maze, node0(&maze));
        let mut maze = maze;
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![nested_with(Box::new(ExpandRegionPassageStrategy), Some("not_a_number"))];
        let result = RepairStrategy::apply(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &nested);
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
        let nodes: Vec<_> = maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).collect();
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let issue = issue_for_node(&maze, nodes[0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), None),
            nested_with(Box::new(TeleportRegionMergeStrategy), None),
        ];
        let result = RepairStrategy::apply(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &preset_state, &nested);
        assert!(matches!(result, RepairResult::Fixed { .. }), "teleport candidate must succeed after the geometry-blocked candidate fails");
        let has_basic_bridge = maze.graph.edges().any(|e| {
            (e.from == nodes[0] && e.to == nodes[1]) || (e.from == nodes[1] && e.to == nodes[0])
        });
        assert!(!has_basic_bridge, "the blocked pair must never have been bridged — ExpandRegionPassageStrategy's failed attempt must be rolled back");
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let maze_probe = maze_4_singletons();
        let issue = issue_for_node(&maze_probe, node0(&maze_probe));

        let mut maze_a = maze_4_singletons();
        let mut rng_a = MazeRng::seed_from_u64(99);
        let nested_a = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), Some("2.0")),
            nested_with(Box::new(TeleportRegionMergeStrategy), Some("1.0")),
        ];
        RepairStrategy::apply(&WeightedRegionMergeStrategy, &issue, &mut maze_a, &mut SnapshotStack::new(), &mut rng_a, &no_params(), &PresetState::empty(), &nested_a);

        let mut maze_b = maze_4_singletons();
        let mut rng_b = MazeRng::seed_from_u64(99);
        let nested_b = vec![
            nested_with(Box::new(ExpandRegionPassageStrategy), Some("2.0")),
            nested_with(Box::new(TeleportRegionMergeStrategy), Some("1.0")),
        ];
        RepairStrategy::apply(&WeightedRegionMergeStrategy, &issue, &mut maze_b, &mut SnapshotStack::new(), &mut rng_b, &no_params(), &PresetState::empty(), &nested_b);

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
            &self, _issue: &RegionNeedsExpansionIssue, _maze: &mut Maze<T>, _snapshots: &mut SnapshotStack,
            _rng: &mut dyn RngCore, _params: &StrategyParams, _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> RepairResult {
            RepairResult::Fixed { score: None }
        }
    }
    crate::impl_erased_repair_strategy!(DeclaresWeightParamStrategy, RegionNeedsExpansionIssue);

    #[test]
    #[should_panic(expected = "collides with resolve_weight's reserved param_overrides key")]
    fn apply_panics_in_debug_when_a_candidate_declares_its_own_weight_param() {
        let mut maze = maze_4_singletons();
        let issue = issue_for_node(&maze, node0(&maze));
        let mut rng = MazeRng::seed_from_u64(1);
        let nested = vec![nested_with(Box::new(DeclaresWeightParamStrategy), None)];
        RepairStrategy::apply(&WeightedRegionMergeStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &nested);
    }
}
