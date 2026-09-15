use std::collections::HashSet;
use crate::ids::NodeId;
use crate::space::{MultiLevelField, Tessellation};
use crate::graph::nav::{NavGraph, NavNodeId};
use super::pathfinding::{dijkstra_with_prev, build_outgoing_index};

#[derive(Clone)]
pub struct RouteInfo {
    pub path_length: usize,    // node count including start and finish
    pub junction_count: usize, // nav-nodes with degree >= 3 on the path
    pub one_way_count: usize,  // nav-edges without reverse on the path
    pub split_count: usize,    // occurrences of a split tile's node among path nodes (each hop counted, not deduped by tile)
    pub teleport_count: usize, // Teleport-kind nav-edges on the path
    pub vertical_bidirectional_count: usize, // VerticalPassage-kind nav-edges on the path with a reverse edge
    pub vertical_one_way_count: usize,       // VerticalPassage-kind nav-edges on the path without a reverse edge
    pub elevator_count: usize, // Elevator-kind nav-edges on the path
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

fn count_by_kind(
    path_edge_indices: &[usize],
    all_edges: &[&crate::graph::nav::NavEdge],
    is_kind: impl Fn(&crate::graph::nav::NavEdge) -> bool,
) -> usize {
    path_edge_indices.iter().filter(|&&ei| is_kind(all_edges[ei])).count()
}

/// Counts every path-node occurrence that sits on a split tile (a field point with >= 2 nodes) —
/// each hop is counted independently, so a route crossing the same split tile twice counts twice.
fn count_splits<T: Tessellation>(field: &MultiLevelField<T>, path: &[NodeId]) -> usize {
    path.iter().filter(|&&node_id| {
        field.level_of(node_id).zip(field.point_of(node_id))
            .is_some_and(|(level, point)| field.nodes_at(level, point).len() >= 2)
    }).count()
}

pub fn compute_route_info<T: Tessellation>(nav: &NavGraph, field: &MultiLevelField<T>, start: NodeId, finish: NodeId) -> Option<RouteInfo> {
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
    let split_count   = count_splits(field, &maze_path);
    let teleport_count = count_by_kind(&path_edge_indices, &all_edges, |e| e.is_teleport);
    let vertical_bidirectional_count = count_by_kind(&path_edge_indices, &all_edges, |e| e.is_vertical && e.reverse_edge.is_some());
    let vertical_one_way_count = count_by_kind(&path_edge_indices, &all_edges, |e| e.is_vertical && e.reverse_edge.is_none());
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
mod tests {
    use super::*;
    use std::collections::HashSet;
    use crate::graph::{Graph, EdgeKind};
    use crate::graph::nav::build_nav_graph_pinned;
    use crate::space::{SquareTessellation, SquarePoint, square_rect};
    use crate::IdGenerator;

    fn bidir(g: &mut Graph, a: NodeId, b: NodeId) {
        g.add_edge(a, b, EdgeKind::Basic);
        g.add_edge(b, a, EdgeKind::Basic);
    }

    fn pinned(nodes: &[NodeId]) -> HashSet<NodeId> {
        nodes.iter().copied().collect()
    }

    /// A no-split `n`-node field (one node per point) — `NodeId`s come back in point order
    /// (x = 0..n) so tests can still address nodes by position, same as the old literal ids.
    fn field_with_nodes(n: usize) -> (MultiLevelField<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(n.max(1), 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let nodes = (0..n).map(|x| field.node_at(level, SquarePoint { x: x as i32, y: 0 }).unwrap()).collect();
        (field, nodes)
    }

    #[test]
    fn same_node_start_equals_finish() {
        let (field, nodes) = field_with_nodes(1);
        let mut g = Graph::new();
        g.add_node(nodes[0]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[0]).unwrap();
        assert_eq!(route.path, vec![nodes[0]]);
        assert_eq!(route.path_length, 1);
        assert_eq!(route.junction_count, 0);
        assert_eq!(route.one_way_count, 0);
        assert_eq!(route.split_count, 0);
    }

    #[test]
    fn directly_adjacent_nav_nodes_same_component() {
        // start and finish are both junctions directly connected by one corridor edge each
        // way -- start_nav != finish_nav here since both are pinned, no corridor compression.
        let (field, nodes) = field_with_nodes(3);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[2]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[2]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[2]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[2]]);
        assert_eq!(route.path_length, 3);
        assert_eq!(route.one_way_count, 0, "bidirectional corridor must not count as one-way");
    }

    #[test]
    fn one_way_corridor_is_counted() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // one-way only
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1]]);
        assert_eq!(route.one_way_count, 1);
    }

    #[test]
    fn junction_on_path_is_counted() {
        // 1 -> 2 -> 3, plus 2 -> 4 (extra branch) makes node 2 a junction (3 distinct
        // outgoing/incoming neighbors: 1,3,4).
        let (field, nodes) = field_with_nodes(4);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[2]);
        bidir(&mut g, nodes[1], nodes[3]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[2]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[2]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[2]]);
        assert_eq!(route.junction_count, 1, "node 2 has 3 distinct neighbors -> junction");
    }

    #[test]
    fn unreachable_finish_returns_none() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        // no edges at all -- nodes are disconnected.
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        assert!(compute_route_info(&nav, &field, nodes[0], nodes[1]).is_none());
    }

    #[test]
    fn unreachable_via_one_way_wrong_direction_returns_none() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        g.add_edge(nodes[1], nodes[0], EdgeKind::Basic); // only 1 -> 0, not 0 -> 1
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        assert!(compute_route_info(&nav, &field, nodes[0], nodes[1]).is_none());
    }

    #[test]
    fn picks_shortest_of_two_routes() {
        // 0 -> 1 -> 4 (short way) and 0 -> 2 -> 3 -> 4 (long way) both reach finish=4;
        // two parallel corridors of different lengths via dedicated branch nodes.
        let (field, nodes) = field_with_nodes(5);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        // short path: 0 -> 1 -> 4 (2 hops)
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[4]);
        // long path: 0 -> 2 -> 3 -> 4 (3 hops)
        bidir(&mut g, nodes[0], nodes[2]);
        bidir(&mut g, nodes[2], nodes[3]);
        bidir(&mut g, nodes[3], nodes[4]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[4]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[4]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[4]], "must pick the 2-hop route over the 3-hop one");
        assert_eq!(route.path_length, 3);
    }

    #[test]
    fn corridor_nodes_are_included_in_path() {
        // 0 -> 1 -> 2 -> 3, only 0 and 3 pinned -- 1,2 are corridor nodes compressed into one
        // nav edge, but their maze NodeIds must still appear in RouteInfo.path.
        let (field, nodes) = field_with_nodes(4);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[2]);
        bidir(&mut g, nodes[2], nodes[3]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[3]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[3]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[2], nodes[3]]);
        assert_eq!(route.path_length, 4);
    }

    #[test]
    fn split_tile_on_path_is_counted_once_per_occurrence() {
        // A 3-point field where point x=1 carries two nodes (a split tile). The route walks
        // through the split node once, so split_count must be 1 -- not deduped further, but
        // also not double-counted for the tile's other (off-route) node.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let extra = field.add_node_at(level, SquarePoint { x: 1, y: 0 }, &mut ids);
        let n0 = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let n1 = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        let n2 = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        assert_ne!(n1, extra, "split tile must carry two distinct nodes");

        let mut g = Graph::new();
        for id in [n0, n1, n2, extra] { g.add_node(id); }
        bidir(&mut g, n0, n1);
        bidir(&mut g, n1, n2);

        let nav = build_nav_graph_pinned(&g, &pinned(&[n0, n2]));
        let route = compute_route_info(&nav, &field, n0, n2).unwrap();
        assert_eq!(route.path, vec![n0, n1, n2]);
        assert_eq!(route.split_count, 1, "route crosses the split tile's routed node exactly once");
    }

    #[test]
    fn split_tile_crossed_via_two_distinct_nodes_counts_twice() {
        // Point x=1 is a split tile with two distinct nodes, n1 and extra. The route visits
        // both of them (n0 -> n1 -> extra -> n2), so split_count must count each occurrence --
        // 2 -- even though no single NodeId repeats (shortest-path routes never revisit a node).
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let extra = field.add_node_at(level, SquarePoint { x: 1, y: 0 }, &mut ids);
        let n0 = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let n1 = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        let n2 = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();

        let mut g = Graph::new();
        for id in [n0, n1, n2, extra] { g.add_node(id); }
        g.add_edge(n0, n1, EdgeKind::Basic);
        g.add_edge(n1, extra, EdgeKind::Basic);
        g.add_edge(extra, n2, EdgeKind::Basic);

        let nav = build_nav_graph_pinned(&g, &pinned(&[n0, n2]));
        let route = compute_route_info(&nav, &field, n0, n2).unwrap();
        assert_eq!(route.path, vec![n0, n1, extra, n2]);
        assert_eq!(route.split_count, 2, "route crosses the split tile via two distinct nodes, each must count");
    }

    #[test]
    fn teleport_hop_on_path_is_counted() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(route.teleport_count, 1);
        assert_eq!(route.vertical_bidirectional_count, 0);
        assert_eq!(route.vertical_one_way_count, 0);
        assert_eq!(route.elevator_count, 0);
    }

    #[test]
    fn bidirectional_vertical_passage_on_path_counts_as_bidirectional_not_one_way() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        g.add_edge(nodes[0], nodes[1], EdgeKind::VerticalPassage);
        g.add_edge(nodes[1], nodes[0], EdgeKind::VerticalPassage);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(route.vertical_bidirectional_count, 1);
        assert_eq!(route.vertical_one_way_count, 0);
    }

    #[test]
    fn one_way_vertical_passage_on_path_counts_as_one_way_not_bidirectional() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        g.add_edge(nodes[0], nodes[1], EdgeKind::VerticalPassage); // one-way only
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(route.vertical_bidirectional_count, 0);
        assert_eq!(route.vertical_one_way_count, 1);
    }

    #[test]
    fn elevator_hop_on_path_is_counted() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes { g.add_node(id); }
        g.add_edge(nodes[0], nodes[1], EdgeKind::Elevator);
        g.add_edge(nodes[1], nodes[0], EdgeKind::Elevator);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(route.elevator_count, 1);
        assert_eq!(route.teleport_count, 0);
        assert_eq!(route.vertical_bidirectional_count, 0);
        assert_eq!(route.vertical_one_way_count, 0);
    }
}
