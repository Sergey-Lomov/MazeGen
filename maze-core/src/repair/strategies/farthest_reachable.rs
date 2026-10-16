use crate::graph::Graph;
use crate::graph::nav::NavGraph;
use crate::graph::pathfinding::{dijkstra_forward, dijkstra_reverse};
use crate::ids::NodeId;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use std::collections::{HashMap, VecDeque};

/// `search_mode` — see GitHub issue #515. Shared by `FarthestEndpointsStrategy` and
/// `MissingTeleportsStrategy`'s `entry_pick: farthest_from_random`, both of which need a
/// "farthest point" search and both of which can pick between the two modes below.
pub const PARAM_SEARCH_MODE: &str = "search_mode";

/// Dijkstra over the corridor-compressed `NavGraph` (default) — fast, but the farthest point can
/// only ever be a junction/dead-end node, never mid-corridor.
pub const SEARCH_MODE_NAV_GRAPH: &str = "nav_graph";
/// Plain BFS over every maze tile node (the raw `Graph`) — correct even when the true farthest
/// point sits mid-corridor on a loop bridge, at the cost of visiting every tile instead of only
/// junctions/dead-ends.
pub const SEARCH_MODE_EXHAUSTIVE: &str = "exhaustive";

static SEARCH_MODE_OPTIONS: &[&str] = &[SEARCH_MODE_NAV_GRAPH, SEARCH_MODE_EXHAUSTIVE];

pub const SEARCH_MODE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_SEARCH_MODE,
    label: "Search mode",
    kind: StrategyParamKind::Enum {
        options: SEARCH_MODE_OPTIONS,
        default: SEARCH_MODE_NAV_GRAPH,
    },
};

/// Reads `search_mode` as a `&str`, falling back to the `nav_graph` default.
pub(crate) fn search_mode(params: &StrategyParams) -> &str {
    match params.get(PARAM_SEARCH_MODE) {
        Some(StrategyParamValue::Enum(s)) => s.as_str(),
        _ => SEARCH_MODE_NAV_GRAPH,
    }
}

/// Farthest node forward-reachable from `source` via directed BFS/Dijkstra — ties break toward
/// the lowest `NodeId` (Determinism Contract, `Specs/repair.md`). Falls back to `source` itself
/// when nothing else is reachable. Shared by `FarthestEndpointsStrategy` (GitHub issue #89) and
/// `MissingTeleportsStrategy`'s `entry_pick: farthest_from_random` (GitHub issue #212) — both need
/// "farthest node you can walk to from here" on the same directed `NavGraph`.
pub(crate) fn farthest_from(nav: &NavGraph, source: usize) -> NodeId {
    let dist = dijkstra_forward(nav, source);
    dist.iter()
        .enumerate()
        .filter(|&(_, &d)| d != usize::MAX)
        .max_by_key(|&(nav_id, &d)| (d, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
        .unwrap_or(nav.nodes[source].node_id)
}

/// Farthest node that can forward-reach `target` (reverse BFS/Dijkstra) — same tie-break and
/// fallback rules as `farthest_from`, mirrored for the incoming direction.
pub(crate) fn farthest_to(nav: &NavGraph, target: usize) -> NodeId {
    let dist = dijkstra_reverse(nav, target);
    dist.iter()
        .enumerate()
        .filter(|&(_, &d)| d != usize::MAX)
        .max_by_key(|&(nav_id, &d)| (d, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
        .unwrap_or(nav.nodes[target].node_id)
}

/// `SEARCH_MODE_EXHAUSTIVE` counterpart to `farthest_from`: plain BFS over every raw-graph node
/// (outgoing edges), not just nav nodes — can land mid-corridor. Same tie-break/fallback rules.
pub(crate) fn farthest_from_exhaustive(graph: &Graph, source: NodeId) -> NodeId {
    let dist = bfs_distances(graph, source, true);
    farthest_from_distances(&dist, source)
}

/// `SEARCH_MODE_EXHAUSTIVE` counterpart to `farthest_to`: plain reverse BFS (incoming edges) over
/// every raw-graph node. Same tie-break/fallback rules.
pub(crate) fn farthest_to_exhaustive(graph: &Graph, target: NodeId) -> NodeId {
    let dist = bfs_distances(graph, target, false);
    farthest_from_distances(&dist, target)
}

/// Raw-graph forward tile-hop distance from `a` to `b`, `None` if unreachable — used by
/// `FarthestEndpointsStrategy`'s exhaustive-mode `orient_farthest_pair` to compare both
/// directions of a candidate pair, same as the nav-graph mode does via `dijkstra_forward`.
pub(crate) fn exhaustive_distance(graph: &Graph, a: NodeId, b: NodeId) -> Option<usize> {
    bfs_distances(graph, a, true).get(&b).copied()
}

fn farthest_from_distances(dist: &HashMap<NodeId, usize>, fallback: NodeId) -> NodeId {
    dist.iter()
        .max_by_key(|&(&node_id, &d)| (d, std::cmp::Reverse(node_id)))
        .map(|(&node_id, _)| node_id)
        .unwrap_or(fallback)
}

/// BFS distances from `source` over the raw graph — `forward` selects outgoing (true) vs incoming
/// (false) edges. `usize::MAX`-style "unreachable" nodes are simply absent from the map.
fn bfs_distances(graph: &Graph, source: NodeId, forward: bool) -> HashMap<NodeId, usize> {
    let mut dist = HashMap::new();
    let mut queue: VecDeque<(NodeId, usize)> = VecDeque::new();
    dist.insert(source, 0);
    queue.push_back((source, 0));
    while let Some((node, d)) = queue.pop_front() {
        let neighbors: Vec<NodeId> = if forward {
            graph.outgoing_neighbors(node).collect()
        } else {
            graph.incoming_neighbors(node).collect()
        };
        for next in neighbors {
            if let std::collections::hash_map::Entry::Vacant(e) = dist.entry(next) {
                e.insert(d + 1);
                queue.push_back((next, d + 1));
            }
        }
    }
    dist
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::Maze;
    use crate::graph::{EdgeKind, Graph};
    use crate::space::{MultiLevelField, SquareTessellation, square_rect};
    use std::sync::Arc;

    fn nav_for(maze: &Maze<SquareTessellation>) -> NavGraph {
        maze.analysis.nav_graph(&maze.graph, &maze.meta)
    }

    #[test]
    fn farthest_from_breaks_ties_by_lowest_node_id() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
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
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.build_initial_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let nav = nav_for(&maze);
        let source = nav.nav_node_for(nodes[0]).unwrap();
        let farthest = farthest_from(&nav, source);
        assert_eq!(
            farthest, nodes[1],
            "tie between nodes[1]/nodes[2] must break toward the lower NodeId"
        );
    }

    #[test]
    fn farthest_from_returns_source_itself_when_nothing_else_is_reachable() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
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
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let nav = nav_for(&maze);
        let source = nav.nav_node_for(nodes[0]).unwrap();
        assert_eq!(farthest_from(&nav, source), nodes[0]);
    }

    #[test]
    fn farthest_from_exhaustive_breaks_ties_by_lowest_node_id() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
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
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.build_initial_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let farthest = farthest_from_exhaustive(&maze.graph, nodes[0]);
        assert_eq!(
            farthest, nodes[1],
            "tie between nodes[1]/nodes[2] must break toward the lower NodeId"
        );
    }

    #[test]
    fn farthest_from_exhaustive_returns_source_itself_when_nothing_else_is_reachable() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
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
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        assert_eq!(farthest_from_exhaustive(&maze.graph, nodes[0]), nodes[0]);
    }

    /// The case the issue is about: a loop where the true tile-hop-farthest node from the source
    /// sits mid-corridor on a bridge segment, invisible to the nav-graph search (which only ever
    /// returns a junction/dead-end node). Layout: a 3-way junction at nodes[0] branching into a
    /// short 1-hop dead-end (nodes[1]) and a long corridor back into the junction via nodes[2..6]
    /// (a loop), with the corridor's midpoint (nodes[3]) being 2 hops from nodes[0] either way
    /// round -- farther in tile-hops than the 1-hop dead-end, but not a nav node at all.
    #[test]
    fn exhaustive_search_finds_a_mid_corridor_farthest_point_that_nav_graph_search_cannot() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(6, 1), &mut ids).unwrap();
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
        // Dead-end branch: 0 -> 1 (1 hop, then stuck).
        g.build_initial_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        // Loop branch: 0 -> 2 -> 3 -> 4 -> 5 -> 0 (corridor loop back into the junction).
        g.build_initial_bidirectional_edge(nodes[0], nodes[2], EdgeKind::Basic);
        g.build_initial_bidirectional_edge(nodes[2], nodes[3], EdgeKind::Basic);
        g.build_initial_bidirectional_edge(nodes[3], nodes[4], EdgeKind::Basic);
        g.build_initial_bidirectional_edge(nodes[4], nodes[5], EdgeKind::Basic);
        g.build_initial_bidirectional_edge(nodes[5], nodes[0], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let nav = nav_for(&maze);
        let source_nav = nav.nav_node_for(nodes[0]).unwrap();
        let nav_result = farthest_from(&nav, source_nav);
        assert_eq!(
            nav_result, nodes[1],
            "nav-graph search can only ever land on a junction/dead-end node"
        );

        let exhaustive_result = farthest_from_exhaustive(&maze.graph, nodes[0]);
        assert_eq!(
            exhaustive_result, nodes[3],
            "exhaustive search finds the true tile-hop-farthest mid-corridor node on the loop"
        );
    }

    #[test]
    fn farthest_to_finds_the_node_with_the_longest_incoming_path() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
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
        for i in 0..3 {
            g.build_initial_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let nav = nav_for(&maze);
        let target = nav.nav_node_for(nodes[3]).unwrap();
        assert_eq!(
            farthest_to(&nav, target),
            nodes[0],
            "node farthest upstream from the target via reverse BFS"
        );
    }

    #[test]
    fn farthest_to_exhaustive_finds_the_node_with_the_longest_incoming_path() {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
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
        for i in 0..3 {
            g.build_initial_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        assert_eq!(
            farthest_to_exhaustive(&maze.graph, nodes[3]),
            nodes[0],
            "node farthest upstream from the target via reverse BFS"
        );
    }
}
