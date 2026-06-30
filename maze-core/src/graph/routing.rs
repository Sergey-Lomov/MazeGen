use std::collections::HashSet;
use crate::ids::NodeId;
use crate::graph::nav::{NavGraph, NavNodeId};
use super::pathfinding::{dijkstra_with_prev, build_outgoing_index};

#[derive(Clone)]
pub struct RouteInfo {
    pub path_length: usize,    // node count including start and finish
    pub junction_count: usize, // nav-nodes with degree >= 3 on the path
    pub one_way_count: usize,  // nav-edges without reverse on the path
    pub path: Vec<NodeId>,     // all maze nodes on the route in order
}

/// Resolve a maze NodeId to its NavNodeId in O(1).
fn resolve_nav_node(nav: &NavGraph, node_id: NodeId) -> Option<NavNodeId> {
    nav.nav_node_for(node_id)
        .or_else(|| nav.corridor_index.get(&node_id).copied())
}


fn reconstruct_path_edges(
    prev_edge: &[Option<usize>],
    all_edges: &[&crate::graph::nav::NavEdge],
    start_nav: NavNodeId,
    finish_nav: NavNodeId,
) -> Option<Vec<usize>> {
    let n = prev_edge.len();
    let mut path_edge_indices: Vec<usize> = Vec::new();
    let mut cur = finish_nav;
    while cur != start_nav {
        let ei = prev_edge[cur]?;
        path_edge_indices.push(ei);
        cur = all_edges[ei].from;
        if path_edge_indices.len() > n {
            return None;
        }
    }
    path_edge_indices.reverse();
    Some(path_edge_indices)
}

fn build_maze_path(
    path_edge_indices: &[usize],
    all_edges: &[&crate::graph::nav::NavEdge],
    start: NodeId,
) -> Vec<NodeId> {
    let mut maze_path: Vec<NodeId> = Vec::new();
    for (i, &ei) in path_edge_indices.iter().enumerate() {
        let edge_path = &all_edges[ei].path;
        if i == 0 {
            maze_path.extend_from_slice(edge_path);
        } else {
            maze_path.extend_from_slice(&edge_path[1..]);
        }
    }
    if path_edge_indices.is_empty() {
        maze_path.push(start);
    }
    maze_path
}

fn count_one_way(
    path_edge_indices: &[usize],
    all_edges: &[&crate::graph::nav::NavEdge],
    edge_pairs: &HashSet<(NavNodeId, NavNodeId)>,
) -> usize {
    path_edge_indices.iter().filter(|&&ei| {
        let e = all_edges[ei];
        !edge_pairs.contains(&(e.to, e.from))
    }).count()
}

fn count_junctions(nav: &NavGraph, nav_nodes_on_path: &[NavNodeId]) -> usize {
    nav_nodes_on_path.iter().filter(|&&nid| {
        let out: HashSet<NavNodeId> = nav.outgoing_edges(nid).map(|e| e.to).collect();
        out.len() >= 3
    }).count()
}

pub fn compute_route_info(nav: &NavGraph, start: NodeId, finish: NodeId) -> Option<RouteInfo> {
    // Callers must build `nav` with build_nav_graph_pinned({start, finish}) so that both
    // nodes are guaranteed to be junction (nav) nodes, not corridor nodes.
    debug_assert!(
        nav.nav_node_for(start).is_some(),
        "compute_route_info: start node {start:?} is not a nav node; build nav graph with start pinned"
    );
    debug_assert!(
        nav.nav_node_for(finish).is_some(),
        "compute_route_info: finish node {finish:?} is not a nav node; build nav graph with finish pinned"
    );

    let start_nav  = resolve_nav_node(nav, start)?;
    let finish_nav = resolve_nav_node(nav, finish)?;

    if start_nav == finish_nav {
        let path = if start == finish { vec![start] } else { vec![start, finish] };
        let path_length = path.len();
        return Some(RouteInfo { path_length, junction_count: 0, one_way_count: 0, path });
    }

    let all_edges: Vec<_> = nav.edges().collect();
    let edge_pairs: HashSet<(NavNodeId, NavNodeId)> =
        all_edges.iter().map(|e| (e.from, e.to)).collect();

    let outgoing = build_outgoing_index(nav, &all_edges);
    let (dist, prev_edge) = dijkstra_with_prev(nav, start_nav, &all_edges, &outgoing);
    if dist[finish_nav] == usize::MAX { return None; }
    let path_edge_indices = reconstruct_path_edges(&prev_edge, &all_edges, start_nav, finish_nav)?;

    let mut nav_nodes_on_path: Vec<NavNodeId> = vec![start_nav];
    for &ei in &path_edge_indices {
        nav_nodes_on_path.push(all_edges[ei].to);
    }

    let maze_path     = build_maze_path(&path_edge_indices, &all_edges, start);
    let path_length   = maze_path.len();
    let one_way_count = count_one_way(&path_edge_indices, &all_edges, &edge_pairs);
    let junction_count = count_junctions(nav, &nav_nodes_on_path);

    Some(RouteInfo { path_length, junction_count, one_way_count, path: maze_path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use crate::graph::{Graph, EdgeKind};
    use crate::graph::nav::build_nav_graph_pinned;

    fn bidir(g: &mut Graph, a: NodeId, b: NodeId) {
        g.add_edge(a, b, EdgeKind::Basic);
        g.add_edge(b, a, EdgeKind::Basic);
    }

    fn pinned(nodes: &[NodeId]) -> HashSet<NodeId> {
        nodes.iter().copied().collect()
    }

    #[test]
    fn same_node_start_equals_finish() {
        let mut g = Graph::new();
        g.add_node(1);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1]));
        let route = compute_route_info(&nav, 1, 1).unwrap();
        assert_eq!(route.path, vec![1]);
        assert_eq!(route.path_length, 1);
        assert_eq!(route.junction_count, 0);
        assert_eq!(route.one_way_count, 0);
    }

    #[test]
    fn directly_adjacent_nav_nodes_same_component() {
        // start and finish are both junctions directly connected by one corridor edge each
        // way -- start_nav != finish_nav here since both are pinned, no corridor compression.
        let mut g = Graph::new();
        for id in [1u64, 2, 3] { g.add_node(id); }
        bidir(&mut g, 1, 2);
        bidir(&mut g, 2, 3);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 3]));
        let route = compute_route_info(&nav, 1, 3).unwrap();
        assert_eq!(route.path, vec![1, 2, 3]);
        assert_eq!(route.path_length, 3);
        assert_eq!(route.one_way_count, 0, "bidirectional corridor must not count as one-way");
    }

    #[test]
    fn one_way_corridor_is_counted() {
        let mut g = Graph::new();
        for id in [1u64, 2] { g.add_node(id); }
        g.add_edge(1, 2, EdgeKind::Basic); // one-way only
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2]));
        let route = compute_route_info(&nav, 1, 2).unwrap();
        assert_eq!(route.path, vec![1, 2]);
        assert_eq!(route.one_way_count, 1);
    }

    #[test]
    fn junction_on_path_is_counted() {
        // 1 -> 2 -> 3, plus 2 -> 4 (extra branch) makes node 2 a junction (3 distinct
        // outgoing/incoming neighbors: 1,3,4).
        let mut g = Graph::new();
        for id in [1u64, 2, 3, 4] { g.add_node(id); }
        bidir(&mut g, 1, 2);
        bidir(&mut g, 2, 3);
        bidir(&mut g, 2, 4);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 3]));
        let route = compute_route_info(&nav, 1, 3).unwrap();
        assert_eq!(route.path, vec![1, 2, 3]);
        assert_eq!(route.junction_count, 1, "node 2 has 3 distinct neighbors -> junction");
    }

    #[test]
    fn unreachable_finish_returns_none() {
        let mut g = Graph::new();
        for id in [1u64, 2] { g.add_node(id); }
        // no edges at all -- 1 and 2 are disconnected.
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2]));
        assert!(compute_route_info(&nav, 1, 2).is_none());
    }

    #[test]
    fn unreachable_via_one_way_wrong_direction_returns_none() {
        let mut g = Graph::new();
        for id in [1u64, 2] { g.add_node(id); }
        g.add_edge(2, 1, EdgeKind::Basic); // only 2 -> 1, not 1 -> 2
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2]));
        assert!(compute_route_info(&nav, 1, 2).is_none());
    }

    #[test]
    fn picks_shortest_of_two_routes() {
        // 1 -> 2 -> 5 (long way, through extra junction) and 1 -> 3 -> 5 (short way) both
        // reach finish=5; 1 is pinned (3 neighbors: 2,3,? no -- keep it simple: two parallel
        // corridors of different lengths via dedicated branch nodes).
        let mut g = Graph::new();
        for id in [1u64, 2, 3, 4, 5] { g.add_node(id); }
        // short path: 1 -> 2 -> 5 (2 hops)
        bidir(&mut g, 1, 2);
        bidir(&mut g, 2, 5);
        // long path: 1 -> 3 -> 4 -> 5 (3 hops)
        bidir(&mut g, 1, 3);
        bidir(&mut g, 3, 4);
        bidir(&mut g, 4, 5);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 5]));
        let route = compute_route_info(&nav, 1, 5).unwrap();
        assert_eq!(route.path, vec![1, 2, 5], "must pick the 2-hop route over the 3-hop one");
        assert_eq!(route.path_length, 3);
    }

    #[test]
    fn corridor_nodes_are_included_in_path() {
        // 1 -> 2 -> 3 -> 4, only 1 and 4 pinned -- 2,3 are corridor nodes compressed into one
        // nav edge, but their maze NodeIds must still appear in RouteInfo.path.
        let mut g = Graph::new();
        for id in [1u64, 2, 3, 4] { g.add_node(id); }
        bidir(&mut g, 1, 2);
        bidir(&mut g, 2, 3);
        bidir(&mut g, 3, 4);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 4]));
        let route = compute_route_info(&nav, 1, 4).unwrap();
        assert_eq!(route.path, vec![1, 2, 3, 4]);
        assert_eq!(route.path_length, 4);
    }
}
