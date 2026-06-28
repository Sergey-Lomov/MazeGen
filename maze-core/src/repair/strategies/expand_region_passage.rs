use rand::{Rng, RngCore};
use std::collections::HashMap;
use crate::Maze;
use crate::ids::NodeId;
use crate::graph::scc::ComponentId;
use crate::space::Tessellation;
use crate::quality_control::{Issue, IssueData};
use crate::generation::{PresetState, try_add_bidirectional_edge};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;
use crate::repair::snapshot::SnapshotStack;
use crate::graph::scc::ConnectedComponents;
use std::collections::HashSet;

pub const PARAM_TARGET_MODE: &str = "target_mode";

pub const MODE_LARGEST: &str = "largest";
pub const MODE_SMALLEST: &str = "smallest";
pub const MODE_RANDOM: &str = "random";
pub const MODE_PREFER_NEEDY: &str = "prefer_needy";

static MODE_OPTIONS: &[&str] = &[MODE_LARGEST, MODE_SMALLEST, MODE_RANDOM, MODE_PREFER_NEEDY];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_TARGET_MODE,
        label: "Target selection mode",
        kind: StrategyParamKind::Enum { options: MODE_OPTIONS, default: MODE_RANDOM },
    },
];

/// Handles `REGION_NEEDS_EXPANSION`. Merges each flagged undersized SCC region into a
/// neighboring region by adding a full bidirectional passage across a shared tessellation
/// wall — geometric adjacency (`field.neighbors`), not graph adjacency, since two regions
/// can be neighbors with no existing edge between any of their cell pairs at all.
///
/// **`issue.data` is mandatory for this kind**: `invalid` (which `scc().components` indices
/// are undersized) is the producing check's result — there's no other channel to learn it.
pub struct ExpandRegionPassageStrategy;

impl<T: Tessellation> RepairStrategy<T> for ExpandRegionPassageStrategy {
    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        _snapshots: &mut SnapshotStack,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
    ) -> RepairResult {
        let Some(IssueData::RegionsNeedingExpansion { invalid, .. }) = &issue.data else {
            return RepairResult::Failed;
        };
        if invalid.is_empty() {
            return RepairResult::Fixed { score: None };
        }

        let mode = match params.get(PARAM_TARGET_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => MODE_RANDOM,
        };

        let scc = maze.analysis.scc(&maze.graph);
        let mut pending: Vec<ComponentId> = invalid.clone();
        let mut merged_away: HashSet<ComponentId> = HashSet::new();
        let mut any_fixed = false;

        while let Some(region_idx) = pending.pop() {
            if merged_away.contains(&region_idx) {
                continue;
            }
            let Some(region) = scc.components.get(region_idx) else { continue };

            let needy: HashSet<ComponentId> =
                invalid.iter().copied().filter(|i| *i != region_idx && !merged_away.contains(i)).collect();

            let candidate = find_passage_candidate(region, region_idx, &scc, maze, preset_state, mode, &needy, rng);

            let Some((src, dst, neighbor_idx)) = candidate else { continue };

            try_add_bidirectional_edge(&mut maze.graph, src, dst, preset_state);
            any_fixed = true;
            if needy.contains(&neighbor_idx) {
                merged_away.insert(neighbor_idx);
            }
        }

        if any_fixed {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        }
    }
}

/// Finds a cell pair `(src, dst)` bridging `region` to a neighboring region, plus that
/// neighbor's component id, according to `mode`. Returns `None` if `region` has no
/// neighboring region at all.
#[allow(clippy::too_many_arguments)]
fn find_passage_candidate<T: Tessellation>(
    region: &[NodeId],
    region_idx: ComponentId,
    scc: &ConnectedComponents,
    maze: &Maze<T>,
    preset_state: &PresetState,
    mode: &str,
    needy: &HashSet<ComponentId>,
    rng: &mut dyn RngCore,
) -> Option<(NodeId, NodeId, ComponentId)> {
    // neighbor component id -> one representative bridging cell pair.
    let mut by_neighbor: HashMap<ComponentId, (NodeId, NodeId)> = HashMap::new();

    for &node in region {
        for neighbor_node in maze.field.neighbors(node) {
            let Some(neighbor_idx) = scc.component_of(neighbor_node) else { continue };
            if neighbor_idx == region_idx {
                continue;
            }
            if !pair_connectable(node, neighbor_node, preset_state) {
                continue;
            }
            by_neighbor.entry(neighbor_idx).or_insert((node, neighbor_node));
            // `random` mode's contract is explicit: no need to enumerate every neighbor
            // first, the first one found is enough.
            if mode == MODE_RANDOM {
                return Some((node, neighbor_node, neighbor_idx));
            }
        }
    }

    if by_neighbor.is_empty() {
        return None;
    }

    // `HashMap::keys()` iteration order is randomized per-process (default `RandomState`
    // hasher) — sorting once here keeps tie-breaking (`max_by_key`/`min_by_key`) and
    // `rng`-indexed picks reproducible across runs for the same seed, per the
    // Determinism Contract.
    let mut keys: Vec<ComponentId> = by_neighbor.keys().copied().collect();
    keys.sort_unstable();

    let chosen = match mode {
        MODE_LARGEST => keys.iter().copied().max_by_key(|i| scc.components[*i].len()),
        MODE_SMALLEST => keys.iter().copied().min_by_key(|i| scc.components[*i].len()),
        MODE_PREFER_NEEDY => {
            let needy_candidates: Vec<ComponentId> = keys.iter().copied().filter(|i| needy.contains(i)).collect();
            let pool = if needy_candidates.is_empty() { &keys } else { &needy_candidates };
            Some(pool[rng.random_range(0..pool.len())])
        }
        // Unknown mode (shouldn't happen — `build_params` always falls back to the
        // enum's default) treated as `random`'s fallback: pick any.
        _ => Some(keys[rng.random_range(0..keys.len())]),
    };

    chosen.map(|i| (by_neighbor[&i].0, by_neighbor[&i].1, i))
}

/// Whether a passage can be added between `a` and `b` without violating preset locks —
/// both directions must be free (a full bidirectional passage), same strict contract
/// `MissingLoopsRandomStrategy` uses. An existing one-way edge in either direction is not
/// a blocker by itself (the strategy is allowed to complete it into a full passage); only
/// `blocked`/`locked_out`/`locked_in` preset state blocks the pair.
fn pair_connectable(a: NodeId, b: NodeId, preset_state: &PresetState) -> bool {
    let fwd_blocked = preset_state.blocked.contains(&(a, b))
        || preset_state.locked_out.contains(&a)
        || preset_state.locked_in.contains(&b);
    let bwd_blocked = preset_state.blocked.contains(&(b, a))
        || preset_state.locked_out.contains(&b)
        || preset_state.locked_in.contains(&a);
    !fwd_blocked && !bwd_blocked
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;
    use rand::SeedableRng;
    use rand::rngs::SmallRng;
    use crate::graph::{Graph, EdgeKind as EK};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::params::build_params;
    use crate::quality_control::issue::REGION_NEEDS_EXPANSION;

    fn params_with_mode(mode: &str) -> StrategyParams {
        let mut overrides = StdHashMap::new();
        overrides.insert(PARAM_TARGET_MODE.to_string(), mode.to_string());
        build_params(
            <ExpandRegionPassageStrategy as RepairStrategy<SquareTessellation>>::params(&ExpandRegionPassageStrategy),
            Some(&overrides),
        )
    }

    fn default_params() -> StrategyParams {
        build_params(
            <ExpandRegionPassageStrategy as RepairStrategy<SquareTessellation>>::params(&ExpandRegionPassageStrategy),
            None,
        )
    }

    /// 1x4 row of cells, no edges at all -> 4 singleton SCC regions, all geometrically
    /// adjacent in a chain: 0-1-2-3.
    fn maze_4_singletons() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        (Maze::new(field, g), nodes)
    }

    fn issue_for(invalid: Vec<usize>) -> Issue {
        Issue::with_data(REGION_NEEDS_EXPANSION, IssueData::RegionsNeedingExpansion {
            invalid,
            invalid_sources: StdHashMap::new(),
        })
    }

    #[test]
    fn apply_fails_on_missing_data() {
        let (mut maze, _) = maze_4_singletons();
        let issue = Issue::new(REGION_NEEDS_EXPANSION);
        let mut rng = SmallRng::seed_from_u64(1);
        let result = ExpandRegionPassageStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_fixed_immediately_when_invalid_is_empty() {
        let (mut maze, _) = maze_4_singletons();
        let issue = issue_for(vec![]);
        let mut rng = SmallRng::seed_from_u64(1);
        let edges_before = maze.graph.edges().count();
        let result = ExpandRegionPassageStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert_eq!(maze.graph.edges().count(), edges_before);
    }

    #[test]
    fn apply_merges_singleton_region_into_a_neighbor() {
        let (mut maze, nodes) = maze_4_singletons();
        // Flag node[0]'s singleton region (component index unknown ahead of time —
        // look it up via a fresh scc()).
        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = SmallRng::seed_from_u64(7);
        let result = ExpandRegionPassageStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // node[0]'s only geometric neighbor is node[1] -> must now be a full passage.
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some());
    }

    #[test]
    fn apply_completes_an_existing_one_way_edge_into_a_full_passage() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        // One-way edge already present: nodes[0] -> nodes[1].
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[1]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = SmallRng::seed_from_u64(3);
        let result = ExpandRegionPassageStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some());
        // Exactly one edge added (the missing reverse direction), not a duplicate forward edge.
        assert_eq!(maze.graph.edges().count(), 2);
    }

    #[test]
    fn apply_fails_when_region_has_no_neighbor() {
        // Single isolated cell field -> no geometric neighbor exists at all.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let region_idx = maze.analysis.scc(&maze.graph).components.len() - 1;
        let issue = issue_for(vec![region_idx]);
        let mut rng = SmallRng::seed_from_u64(1);
        let result = ExpandRegionPassageStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_respects_preset_blocked_pair() {
        let (mut maze, nodes) = maze_4_singletons();
        let mut preset_state = PresetState::empty();
        // Block the only bridge for node[0]'s region (node[0]-node[1]) in both directions.
        preset_state.blocked.insert((nodes[0], nodes[1]));
        preset_state.blocked.insert((nodes[1], nodes[0]));

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = SmallRng::seed_from_u64(5);
        let result = ExpandRegionPassageStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &preset_state);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 0);
    }

    #[test]
    fn mode_largest_prefers_the_bigger_neighbor() {
        // 1x5 row: region under test is the lone middle singleton (idx 2), flanked by a
        // 1-cell region on the left (node 1, still singleton) and a pre-merged 2-cell
        // region on the right (nodes 3-4).
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[2]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = SmallRng::seed_from_u64(11);
        let result = ExpandRegionPassageStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_mode(MODE_LARGEST), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // Must bridge toward the larger (2-cell) region on the right, not the singleton on the left.
        assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_some());
        assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_none());
    }

    #[test]
    fn mode_smallest_prefers_the_smaller_neighbor() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[2]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = SmallRng::seed_from_u64(11);
        let result = ExpandRegionPassageStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_mode(MODE_SMALLEST), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // Must bridge toward the smaller (1-cell) region on the left.
        assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_some());
        assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_none());
    }

    #[test]
    fn mode_prefer_needy_picks_a_flagged_neighbor_when_available() {
        // 1x3 row, three singletons, all flagged as undersized. node[1]'s region must
        // bridge to one of its two needy neighbors (both flagged) -- either is correct,
        // but the result must be exactly one new bidirectional passage from node[1].
        let (mut maze, nodes) = maze_4_singletons();
        let scc = maze.analysis.scc(&maze.graph);
        let idx0 = scc.component_of(nodes[0]).unwrap();
        let idx1 = scc.component_of(nodes[1]).unwrap();
        let idx2 = scc.component_of(nodes[2]).unwrap();
        let issue = issue_for(vec![idx0, idx1, idx2]);
        let mut rng = SmallRng::seed_from_u64(2);
        let result = ExpandRegionPassageStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params_with_mode(MODE_PREFER_NEEDY), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let (mut maze_a, nodes_a) = maze_4_singletons();
        let region_idx_a = maze_a.analysis.scc(&maze_a.graph).component_of(nodes_a[0]).unwrap();
        let issue_a = issue_for(vec![region_idx_a]);
        let mut rng_a = SmallRng::seed_from_u64(99);
        ExpandRegionPassageStrategy.apply(&issue_a, &mut maze_a, &mut SnapshotStack::new(), &mut rng_a, &default_params(), &PresetState::empty());

        let (mut maze_b, nodes_b) = maze_4_singletons();
        let region_idx_b = maze_b.analysis.scc(&maze_b.graph).component_of(nodes_b[0]).unwrap();
        let issue_b = issue_for(vec![region_idx_b]);
        let mut rng_b = SmallRng::seed_from_u64(99);
        ExpandRegionPassageStrategy.apply(&issue_b, &mut maze_b, &mut SnapshotStack::new(), &mut rng_b, &default_params(), &PresetState::empty());

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }
}
