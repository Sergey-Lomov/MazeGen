use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::nav::{NavGraph, NavNodeId, NavEdge};
use crate::graph::pathfinding::{dijkstra_with_prev, build_outgoing_index};
use crate::quality_control::Issue;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;
use crate::repair::snapshot::SnapshotStack;
use crate::generation::PresetState;

pub const PARAM_PATH_WEIGHT: &str = "path_weight";
pub const PARAM_JUNCTION_WEIGHT: &str = "junction_weight";
pub const PARAM_ONEWAY_WEIGHT: &str = "oneway_weight";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_PATH_WEIGHT,
        label: "Path length weight",
        kind: StrategyParamKind::Float { default: 1.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_JUNCTION_WEIGHT,
        label: "Junction weight",
        kind: StrategyParamKind::Float { default: 3.0, min: 0.0, max: 100.0 },
    },
    StrategyParam {
        id: PARAM_ONEWAY_WEIGHT,
        label: "One-way passage weight",
        kind: StrategyParamKind::Float { default: 5.0, min: 0.0, max: 100.0 },
    },
];

pub struct ScoredEndpointsStrategy;

impl<T: Tessellation> RepairStrategy<T> for ScoredEndpointsStrategy {
    fn strategy_id(&self) -> &'static str { "scored_endpoints" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        _issue: &Issue,
        maze: &mut Maze<T>,
        _snapshots: &mut SnapshotStack,
        _rng: &mut dyn RngCore,
        params: &StrategyParams,
        _preset_state: &PresetState,
    ) -> RepairResult {
        if maze.meta.start.is_some() && maze.meta.finish.is_some() {
            return RepairResult::Fixed { score: None };
        }

        let path_weight    = params.get(PARAM_PATH_WEIGHT).and_then(|v| v.as_float()).unwrap_or(1.0);
        let junction_weight = params.get(PARAM_JUNCTION_WEIGHT).and_then(|v| v.as_float()).unwrap_or(3.0);
        let oneway_weight  = params.get(PARAM_ONEWAY_WEIGHT).and_then(|v| v.as_float()).unwrap_or(5.0);

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let nav = &nav;

        if nav.nodes.is_empty() {
            return RepairResult::Failed;
        }

        let ctx = ScoredPathContext::build(nav);
        let weights = ScoreWeights { path_weight, junction_weight, oneway_weight };

        let achieved_score;

        match (maze.meta.start, maze.meta.finish) {
            (None, None) => {
                match ctx.best_pair(nav, None, None, &weights) {
                    Some((s, f, score)) => {
                        maze.meta.start  = Some(nav.nodes[s].node_id);
                        maze.meta.finish = Some(nav.nodes[f].node_id);
                        achieved_score = score;
                    }
                    None => return RepairResult::Failed,
                }
            }
            (Some(start), None) => {
                let start_nav = match nav.nav_node_for(start) {
                    Some(id) => id,
                    None => return RepairResult::Failed,
                };
                match ctx.best_pair(nav, Some(start_nav), None, &weights) {
                    Some((_, f, score)) => {
                        maze.meta.finish = Some(nav.nodes[f].node_id);
                        achieved_score = score;
                    }
                    None => return RepairResult::Failed,
                }
            }
            (None, Some(finish)) => {
                let finish_nav = match nav.nav_node_for(finish) {
                    Some(id) => id,
                    None => return RepairResult::Failed,
                };
                match ctx.best_pair(nav, None, Some(finish_nav), &weights) {
                    Some((s, _, score)) => {
                        maze.meta.start = Some(nav.nodes[s].node_id);
                        achieved_score = score;
                    }
                    None => return RepairResult::Failed,
                }
            }
            (Some(_), Some(_)) => unreachable!(),
        }

        RepairResult::Fixed { score: Some(achieved_score) }
    }
}

struct ScoreWeights {
    path_weight:    f64,
    junction_weight: f64,
    oneway_weight:  f64,
}

/// Precomputed data derived from NavGraph for scoring endpoint pairs.
struct ScoredPathContext<'a> {
    edges:           Vec<&'a NavEdge>,
    junction_flags:  Vec<bool>,
    oneway_flags:    Vec<bool>,
    outgoing_by_node: Vec<Vec<usize>>,
}

impl<'a> ScoredPathContext<'a> {
    fn build(nav: &'a NavGraph) -> Self {
        let edges: Vec<&'a NavEdge> = nav.edges().collect();
        let junction_flags = junction_flags(nav);
        let oneway_flags   = oneway_flags(&edges);
        let outgoing_by_node = build_outgoing_index(nav, &edges);
        Self { edges, junction_flags, oneway_flags, outgoing_by_node }
    }

    fn best_pair(
        &self,
        nav: &NavGraph,
        fixed_start: Option<NavNodeId>,
        fixed_finish: Option<NavNodeId>,
        weights: &ScoreWeights,
    ) -> Option<(NavNodeId, NavNodeId, f64)> {
        let n = nav.nodes.len();

        let starts: Vec<NavNodeId> = match fixed_start {
            Some(s) => vec![s],
            None => (0..n).collect(),
        };

        let mut best_score: Option<f64> = None;
        let mut best: Option<(NavNodeId, NavNodeId, f64)> = None;

        for &s in &starts {
            let (dist, prev_edge) = dijkstra_with_prev(nav, s, &self.edges, &self.outgoing_by_node);

            let finishes: Vec<NavNodeId> = match fixed_finish {
                Some(f) => vec![f],
                None => (0..n).collect(),
            };

            for f in finishes {
                if f == s { continue; }
                if dist[f] == usize::MAX { continue; }

                let path_edges = reconstruct_path_edges(&self.edges, &prev_edge, s, f);
                let score = score_path(
                    &self.junction_flags, &self.oneway_flags,
                    &path_edges, &self.edges, dist[f], weights,
                );

                if best_score.map_or(true, |b| score > b) {
                    best_score = Some(score);
                    best = Some((s, f, score));
                }
            }
        }

        best
    }
}

fn junction_flags(nav: &NavGraph) -> Vec<bool> {
    nav.nodes.iter().enumerate().map(|(i, _)| {
        let mut neighbors = HashSet::new();
        for e in nav.outgoing_edges(i) { neighbors.insert(e.to); }
        for e in nav.incoming_edges(i) { neighbors.insert(e.from); }
        neighbors.len() >= 3
    }).collect()
}

fn oneway_flags(edges: &[&NavEdge]) -> Vec<bool> {
    let pairs: HashSet<(NavNodeId, NavNodeId)> = edges.iter().map(|e| (e.from, e.to)).collect();
    edges.iter().map(|e| !pairs.contains(&(e.to, e.from))).collect()
}

fn score_path(
    junction_flags: &[bool],
    oneway_flags: &[bool],
    path_edge_indices: &[usize],
    edges: &[&NavEdge],
    path_tiles: usize,
    weights: &ScoreWeights,
) -> f64 {
    if path_edge_indices.is_empty() {
        return 0.0;
    }

    let mut nav_nodes_on_path: Vec<NavNodeId> = Vec::new();
    for (i, &ei) in path_edge_indices.iter().enumerate() {
        if i == 0 { nav_nodes_on_path.push(edges[ei].from); }
        nav_nodes_on_path.push(edges[ei].to);
    }

    let junction_count = nav_nodes_on_path.iter()
        .filter(|&&nid| junction_flags[nid])
        .count() as f64;

    let oneway_count = path_edge_indices.iter()
        .filter(|&&ei| oneway_flags[ei])
        .count() as f64;

    path_tiles as f64 * weights.path_weight
        + junction_count * weights.junction_weight
        + oneway_count * weights.oneway_weight
}

fn reconstruct_path_edges(
    edges: &[&NavEdge],
    prev_edge: &[Option<usize>],
    source: NavNodeId,
    target: NavNodeId,
) -> Vec<usize> {
    let mut result = Vec::new();
    let mut cur = target;
    while cur != source {
        match prev_edge[cur] {
            None => return vec![],
            Some(ei) => {
                result.push(ei);
                cur = edges[ei].from;
            }
        }
    }
    result.reverse();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;
    use rand::SeedableRng;
    use rand::rngs::SmallRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field, SquarePoint};
    use crate::repair::params::build_params;
    use crate::quality_control::{Issue, MISSING_ENDPOINTS};

    fn default_params() -> StrategyParams {
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation>>::params(&ScoredEndpointsStrategy),
            None,
        )
    }

    fn make_maze(n_cols: usize, n_rows: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(n_cols, n_rows), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        Maze::new(field, graph)
    }

    fn make_connected_maze(n_cols: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut maze = make_maze(n_cols, 1);
        let ordered: Vec<_> = (0..n_cols)
            .map(|x| maze.field.node_at(SquarePoint { x: x as i32, y: 0 }).unwrap())
            .collect();
        for i in 0..ordered.len() - 1 {
            maze.graph.build_initial_bidirectional_edge(ordered[i], ordered[i + 1], EdgeKind::Basic);
        }
        (maze, ordered)
    }

    fn rng() -> SmallRng { SmallRng::seed_from_u64(7) }

    fn issue() -> Issue { Issue::new(MISSING_ENDPOINTS) }

    #[test]
    fn apply_fixed_immediately_when_both_already_set() {
        let (mut maze, nodes) = make_connected_maze(3);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);
        let result = ScoredEndpointsStrategy.apply(&issue(), &mut maze, &mut SnapshotStack::new(), &mut rng(), &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_fails_on_single_isolated_node_no_reachable_pair() {
        // A single node has a nav node but no second node to pair with -- `best_pair` must
        // find no valid (s, f) pair (every candidate requires f != s and a finite distance).
        let mut maze = make_maze(1, 1);
        let result = ScoredEndpointsStrategy.apply(&issue(), &mut maze, &mut SnapshotStack::new(), &mut rng(), &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_picks_best_pair_when_neither_endpoint_set() {
        let (mut maze, nodes) = make_connected_maze(5);
        let result = ScoredEndpointsStrategy.apply(&issue(), &mut maze, &mut SnapshotStack::new(), &mut rng(), &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
        assert!(maze.meta.start.is_some());
        assert!(maze.meta.finish.is_some());
        assert_ne!(maze.meta.start, maze.meta.finish);
        // On a straight 5-node corridor, the longest path is start..end (endpoints), since
        // path_weight rewards length and there are no junctions/one-ways to compete with it.
        let (a, b) = (maze.meta.start.unwrap(), maze.meta.finish.unwrap());
        assert!((a == nodes[0] && b == nodes[4]) || (a == nodes[4] && b == nodes[0]));
    }

    #[test]
    fn apply_fixes_finish_when_only_start_set() {
        let (mut maze, nodes) = make_connected_maze(5);
        maze.meta.start = Some(nodes[0]);
        let result = ScoredEndpointsStrategy.apply(&issue(), &mut maze, &mut SnapshotStack::new(), &mut rng(), &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
        assert_eq!(maze.meta.start, Some(nodes[0]));
        assert_eq!(maze.meta.finish, Some(nodes[4]), "farthest/highest-scoring node on a straight corridor is the opposite end");
    }

    #[test]
    fn apply_fixes_start_when_only_finish_set() {
        let (mut maze, nodes) = make_connected_maze(5);
        maze.meta.finish = Some(nodes[4]);
        let result = ScoredEndpointsStrategy.apply(&issue(), &mut maze, &mut SnapshotStack::new(), &mut rng(), &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
        assert_eq!(maze.meta.finish, Some(nodes[4]));
        assert_eq!(maze.meta.start, Some(nodes[0]));
    }

    #[test]
    fn apply_fails_when_fixed_start_node_not_in_nav_graph() {
        let (mut maze, nodes) = make_connected_maze(3);
        // start set to a node id that doesn't exist in the graph at all.
        let _ = nodes;
        maze.meta.start = Some(999_999);
        let result = ScoredEndpointsStrategy.apply(&issue(), &mut maze, &mut SnapshotStack::new(), &mut rng(), &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_fails_when_disconnected_and_start_cannot_reach_anything() {
        // Two disconnected singleton nodes -- no edges at all -- start fixed, no finish
        // reachable from it.
        let mut maze = make_maze(2, 1);
        let a = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        maze.meta.start = Some(a);
        let result = ScoredEndpointsStrategy.apply(&issue(), &mut maze, &mut SnapshotStack::new(), &mut rng(), &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_prefers_junction_path_when_junction_weight_dominates() {
        // Row 0: corridor 0-1-2-3. A side branch at (1,1) hangs off node (1,0), making
        // (1,0) a 3-way junction. With junction_weight dominating and path/one-way zeroed,
        // the best-scoring pair must be the one whose route passes through (1,0).
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 2), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> = [(0, 0), (1, 0), (2, 0), (3, 0), (1, 1)]
            .iter()
            .map(|&(x, y)| ((x, y), field.node_at(SquarePoint { x, y }).unwrap()))
            .collect();
        for x in 0..3 {
            graph.build_initial_bidirectional_edge(nodes[&(x, 0)], nodes[&(x + 1, 0)], EdgeKind::Basic);
        }
        graph.build_initial_bidirectional_edge(nodes[&(1, 0)], nodes[&(1, 1)], EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, graph);

        let mut overrides = StdHashMap::new();
        overrides.insert(PARAM_JUNCTION_WEIGHT.to_string(), "1000".to_string());
        overrides.insert(PARAM_PATH_WEIGHT.to_string(), "0".to_string());
        overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
        let params = build_params(
            <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation>>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

        let result = ScoredEndpointsStrategy.apply(&issue(), &mut maze, &mut SnapshotStack::new(), &mut rng(), &params, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
        // With path/one-way weight zeroed, any pair whose route never crosses the junction
        // scores exactly 0 -- the winning pair must have a strictly positive score, which
        // only happens if its route passes through junction node (1,0).
        let start = maze.meta.start.unwrap();
        let finish = maze.meta.finish.unwrap();
        let nav = crate::graph::nav::build_nav_graph_pinned(&maze.graph, &[start, finish].into_iter().collect());
        let route = crate::graph::routing::compute_route_info(&nav, start, finish)
            .expect("route must exist between the chosen pair");
        let junction = nodes[&(1, 0)];
        assert!(route.path.contains(&junction), "winning route must pass through the junction node");
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let (mut maze_a, _) = make_connected_maze(5);
        let mut rng_a = SmallRng::seed_from_u64(123);
        ScoredEndpointsStrategy.apply(&issue(), &mut maze_a, &mut SnapshotStack::new(), &mut rng_a, &default_params(), &PresetState::empty());

        let (mut maze_b, _) = make_connected_maze(5);
        let mut rng_b = SmallRng::seed_from_u64(123);
        ScoredEndpointsStrategy.apply(&issue(), &mut maze_b, &mut SnapshotStack::new(), &mut rng_b, &default_params(), &PresetState::empty());

        assert_eq!(maze_a.meta.start, maze_b.meta.start);
        assert_eq!(maze_a.meta.finish, maze_b.meta.finish);
    }
}
