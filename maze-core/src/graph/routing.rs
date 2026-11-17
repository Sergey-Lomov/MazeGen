use super::pathfinding::{build_outgoing_index, dijkstra_with_prev, route_aware_junction_flags};
use crate::graph::nav::{NavGraph, NavNodeId};
use crate::ids::NodeId;
use crate::space::{MultiLevelField, Tessellation};
use std::collections::HashSet;

#[derive(Clone)]
pub struct RouteInfo {
    pub path_length: usize, // number of tile-to-tile transitions (node count - 1), matching the unit every other score component is counted in (GitHub issue #535 follow-up)
    pub junction_count: usize, // nav-nodes on the path with >1 outgoing edge besides the way back (GitHub issue #535 follow-up: route-aware, not a whole-graph degree check)
    pub one_way_count: usize,  // nav-edges without reverse on the path
    pub split_count: usize, // occurrences of a split tile's node among path nodes (each hop counted, not deduped by tile)
    pub teleport_count: usize, // Teleport-kind nav-edges on the path
    pub vertical_bidirectional_count: usize, // VerticalPassage-kind nav-edges on the path with a reverse edge
    pub vertical_one_way_count: usize, // VerticalPassage-kind nav-edges on the path without a reverse edge
    pub elevator_count: usize,         // Elevator-kind nav-edges on the path
    pub path: Vec<NodeId>,             // all maze nodes on the route in order
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
    path_edge_indices
        .iter()
        .filter(|&&ei| {
            let e = all_edges[ei];
            !edge_pairs.contains(&(e.to, e.from))
        })
        .count()
}

fn count_by_kind(
    path_edge_indices: &[usize],
    all_edges: &[&crate::graph::nav::NavEdge],
    is_kind: impl Fn(&crate::graph::nav::NavEdge) -> bool,
) -> usize {
    path_edge_indices
        .iter()
        .filter(|&&ei| is_kind(all_edges[ei]))
        .count()
}

/// Counts every path-node occurrence that sits on a split tile (a field point with >= 2 nodes) —
/// each hop is counted independently, so a route crossing the same split tile twice counts twice.
fn count_splits<T: Tessellation>(field: &MultiLevelField<T>, path: &[NodeId]) -> usize {
    path.iter()
        .filter(|&&node_id| {
            field
                .level_of(node_id)
                .zip(field.cell_of(node_id))
                .is_some_and(|(level, point)| field.is_split_cell(level, point))
        })
        .count()
}

pub fn compute_route_info<T: Tessellation>(
    nav: &NavGraph,
    field: &MultiLevelField<T>,
    start: NodeId,
    finish: NodeId,
) -> Option<RouteInfo> {
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

    let start_nav = resolve_nav_node(nav, start)?;
    let finish_nav = resolve_nav_node(nav, finish)?;

    if start_nav == finish_nav {
        let path = if start == finish {
            vec![start]
        } else {
            vec![start, finish]
        };
        let path_length = path.len().saturating_sub(1);
        let split_count = count_splits(field, &path);
        return Some(RouteInfo {
            path_length,
            junction_count: 0,
            one_way_count: 0,
            split_count,
            teleport_count: 0,
            vertical_bidirectional_count: 0,
            vertical_one_way_count: 0,
            elevator_count: 0,
            path,
        });
    }

    let all_edges: Vec<_> = nav.edges().collect();
    let edge_pairs: HashSet<(NavNodeId, NavNodeId)> =
        all_edges.iter().map(|e| (e.from, e.to)).collect();

    let outgoing = build_outgoing_index(nav, &all_edges);
    let (dist, prev_edge) = dijkstra_with_prev(nav, start_nav, &all_edges, &outgoing);
    if dist[finish_nav] == usize::MAX {
        return None;
    }
    let path_edge_indices = reconstruct_path_edges(&prev_edge, &all_edges, start_nav, finish_nav)?;

    let mut nav_nodes_on_path: Vec<NavNodeId> = vec![start_nav];
    for &ei in &path_edge_indices {
        nav_nodes_on_path.push(all_edges[ei].to);
    }

    let maze_path = build_maze_path(&path_edge_indices, &all_edges, start);
    let path_length = maze_path.len().saturating_sub(1);
    let one_way_count = count_one_way(&path_edge_indices, &all_edges, &edge_pairs);
    let junction_count = route_aware_junction_flags(
        nav,
        &nav_nodes_on_path,
        &path_edge_indices,
        &all_edges,
        &mut std::collections::HashMap::new(),
    )
    .into_iter()
    .filter(|&j| j)
    .count();
    let split_count = count_splits(field, &maze_path);
    let teleport_count = count_by_kind(&path_edge_indices, &all_edges, |e| e.is_teleport);
    let vertical_bidirectional_count = count_by_kind(&path_edge_indices, &all_edges, |e| {
        e.is_vertical && e.reverse_edge.is_some()
    });
    let vertical_one_way_count = count_by_kind(&path_edge_indices, &all_edges, |e| {
        e.is_vertical && e.reverse_edge.is_none()
    });
    let elevator_count = count_by_kind(&path_edge_indices, &all_edges, |e| e.is_elevator);

    Some(RouteInfo {
        path_length,
        junction_count,
        one_way_count,
        split_count,
        teleport_count,
        vertical_bidirectional_count,
        vertical_one_way_count,
        elevator_count,
        path: maze_path,
    })
}

#[cfg(test)]
#[path = "routing_tests.rs"]
mod tests;
