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
