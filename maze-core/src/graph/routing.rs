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
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::nav::build_nav_graph_pinned;
    use crate::graph::{EdgeKind, Graph};
    use crate::space::{SquarePoint, SquareTessellation, square_rect};
    use std::collections::HashSet;
    use std::sync::Arc;

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
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(n.max(1), 1), &mut ids)
                .unwrap();
        let level = field.single_level_id();
        let nodes = (0..n)
            .map(|x| {
                field
                    .node_at(level, SquarePoint { x: x as i32, y: 0 })
                    .unwrap()
            })
            .collect();
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
        assert_eq!(route.path_length, 0, "start == finish -> zero transitions");
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
        for &id in &nodes {
            g.add_node(id);
        }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[2]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[2]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[2]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[2]]);
        assert_eq!(route.path_length, 2, "3 nodes -> 2 transitions");
        assert_eq!(
            route.one_way_count, 0,
            "bidirectional corridor must not count as one-way"
        );
    }

    #[test]
    fn one_way_corridor_is_counted() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // one-way only
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1]]);
        assert_eq!(route.one_way_count, 1);
    }

    #[test]
    fn junction_on_path_is_counted() {
        // 1 -> 2 -> 3, plus 2 -> 4 (extra branch). Route 1->2->3 arrives at node 2 via the
        // 1->2 edge; excluding that edge's reverse (2->1) still leaves 2 outgoing choices
        // (2->3, 2->4), so node 2 is a junction under the route-aware definition too.
        let (field, nodes) = field_with_nodes(4);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[2]);
        bidir(&mut g, nodes[1], nodes[3]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[2]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[2]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[2]]);
        assert_eq!(
            route.junction_count, 1,
            "node 2 keeps 2 outgoing choices besides the way back -> junction"
        );
    }

    #[test]
    fn start_node_with_two_outgoing_edges_is_a_junction() {
        // Start node has no "arrived via" edge to exclude, so its full outgoing set is used
        // directly: 2 outgoing edges (0->1, 0->2) already makes it a junction, unlike a
        // mid-route node which would need a 3rd edge besides the way back.
        let (field, nodes) = field_with_nodes(3);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[0], nodes[2]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1], nodes[2]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(
            route.junction_count, 1,
            "start with 2 outgoing edges -> junction"
        );
    }

    #[test]
    fn mid_route_node_with_only_the_reverse_edge_besides_forward_is_not_a_junction() {
        // 0 -> 1 -> 2, node 1 has exactly 2 outgoing edges (1->0, 1->2). 1->0 is the reverse
        // of the arrival edge 0->1, so excluding it leaves only 1 genuine forward choice ->
        // not a junction, even though node 1 has 2 outgoing edges in total.
        let (field, nodes) = field_with_nodes(3);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[2]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1], nodes[2]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[2]).unwrap();
        assert_eq!(
            route.junction_count, 0,
            "only the way back remains besides forward -> not a junction"
        );
    }

    #[test]
    fn finish_node_is_never_counted_as_a_junction() {
        // 1 -> 2 -> 3, plus 2 -> 4 (extra branch), route 1->2->4: the route ends at node 4,
        // but node 2 -- despite having 2 outgoing choices besides the way back (2->3, 2->4) --
        // is a genuine junction along the way. Node 4 itself is the finish and must never
        // count, regardless of its own outgoing edges (it has none here, but the rule holds
        // unconditionally, not just when the finish happens to be a dead end).
        let (field, nodes) = field_with_nodes(4);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[2]);
        bidir(&mut g, nodes[1], nodes[3]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[3]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[3]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[3]]);
        assert_eq!(
            route.junction_count, 1,
            "node 1 (mid-route) is the only junction, finish node 3 never counts"
        );
    }

    #[test]
    fn finish_node_with_multiple_outgoing_edges_is_not_a_junction() {
        // 0 -> 1 -> 2, plus 1 -> 3 (extra branch off the finish itself): finish=1. Node 1 has
        // 2 outgoing edges besides the way back (1->2, 1->3) -- under the plain route-aware
        // rule it would be a junction, but as the finish node it must not count, since the
        // player has already arrived and no further choice is presented to them.
        let (field, nodes) = field_with_nodes(4);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[2]);
        bidir(&mut g, nodes[1], nodes[3]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1]]);
        assert_eq!(
            route.junction_count, 0,
            "finish node never counts as a junction"
        );
    }

    #[test]
    fn unreachable_finish_returns_none() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        // no edges at all -- nodes are disconnected.
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        assert!(compute_route_info(&nav, &field, nodes[0], nodes[1]).is_none());
    }

    #[test]
    fn unreachable_via_one_way_wrong_direction_returns_none() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
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
        for &id in &nodes {
            g.add_node(id);
        }
        // short path: 0 -> 1 -> 4 (2 hops)
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[4]);
        // long path: 0 -> 2 -> 3 -> 4 (3 hops)
        bidir(&mut g, nodes[0], nodes[2]);
        bidir(&mut g, nodes[2], nodes[3]);
        bidir(&mut g, nodes[3], nodes[4]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[4]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[4]).unwrap();
        assert_eq!(
            route.path,
            vec![nodes[0], nodes[1], nodes[4]],
            "must pick the 2-hop route over the 3-hop one"
        );
        assert_eq!(route.path_length, 2, "3 nodes -> 2 transitions");
    }

    #[test]
    fn corridor_nodes_are_included_in_path() {
        // 0 -> 1 -> 2 -> 3, only 0 and 3 pinned -- 1,2 are corridor nodes compressed into one
        // nav edge, but their maze NodeIds must still appear in RouteInfo.path.
        let (field, nodes) = field_with_nodes(4);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[2]);
        bidir(&mut g, nodes[2], nodes[3]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[3]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[3]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[2], nodes[3]]);
        assert_eq!(route.path_length, 3, "4 nodes -> 3 transitions");
    }

    #[test]
    fn split_tile_on_path_is_counted_once_per_occurrence() {
        // A 3-point field where point x=1 carries two nodes (a split tile). The route walks
        // through the split node once, so split_count must be 1 -- not deduped further, but
        // also not double-counted for the tile's other (off-route) node.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let extra = field.add_node_at(level, SquarePoint { x: 1, y: 0 }, &mut ids);
        let n0 = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let n1 = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        let n2 = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        assert_ne!(n1, extra, "split tile must carry two distinct nodes");

        let mut g = Graph::new();
        for id in [n0, n1, n2, extra] {
            g.add_node(id);
        }
        bidir(&mut g, n0, n1);
        bidir(&mut g, n1, n2);

        let nav = build_nav_graph_pinned(&g, &pinned(&[n0, n2]));
        let route = compute_route_info(&nav, &field, n0, n2).unwrap();
        assert_eq!(route.path, vec![n0, n1, n2]);
        assert_eq!(
            route.split_count, 1,
            "route crosses the split tile's routed node exactly once"
        );
    }

    #[test]
    fn split_tile_crossed_via_two_distinct_nodes_counts_twice() {
        // Point x=1 is a split tile with two distinct nodes, n1 and extra. The route visits
        // both of them (n0 -> n1 -> extra -> n2), so split_count must count each occurrence --
        // 2 -- even though no single NodeId repeats (shortest-path routes never revisit a node).
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let extra = field.add_node_at(level, SquarePoint { x: 1, y: 0 }, &mut ids);
        let n0 = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let n1 = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
        let n2 = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();

        let mut g = Graph::new();
        for id in [n0, n1, n2, extra] {
            g.add_node(id);
        }
        g.add_edge(n0, n1, EdgeKind::Basic);
        g.add_edge(n1, extra, EdgeKind::Basic);
        g.add_edge(extra, n2, EdgeKind::Basic);

        let nav = build_nav_graph_pinned(&g, &pinned(&[n0, n2]));
        let route = compute_route_info(&nav, &field, n0, n2).unwrap();
        assert_eq!(route.path, vec![n0, n1, extra, n2]);
        assert_eq!(
            route.split_count, 2,
            "route crosses the split tile via two distinct nodes, each must count"
        );
    }

    #[test]
    fn teleport_hop_on_path_is_counted() {
        let (field, nodes) = field_with_nodes(2);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
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
        for &id in &nodes {
            g.add_node(id);
        }
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
        for &id in &nodes {
            g.add_node(id);
        }
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
        for &id in &nodes {
            g.add_node(id);
        }
        g.add_edge(nodes[0], nodes[1], EdgeKind::Elevator);
        g.add_edge(nodes[1], nodes[0], EdgeKind::Elevator);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(route.elevator_count, 1);
        assert_eq!(route.teleport_count, 0);
        assert_eq!(route.vertical_bidirectional_count, 0);
        assert_eq!(route.vertical_one_way_count, 0);
    }

    fn elevator_fan(g: &mut Graph, stops: &[NodeId]) {
        for &a in stops {
            for &b in stops {
                if a != b {
                    g.add_edge(a, b, EdgeKind::Elevator);
                }
            }
        }
    }

    #[test]
    fn elevator_group_arrived_via_corridor_is_a_single_choice_not_a_junction() {
        // 0 --corridor--> 1, elevator fan {1,2,3,4} (3 stops besides node 1). Route 0->1->2.
        // Arriving at node 1 via the corridor, all 3 outgoing elevator edges (1->2, 1->3, 1->4)
        // collapse into exactly 1 logical choice ("take the elevator"), not 3 -- so node 1 is
        // NOT a junction, even though a dead-end elevator with 3+ stops would look like one
        // under a naive per-edge count.
        let (field, nodes) = field_with_nodes(5);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        bidir(&mut g, nodes[0], nodes[1]);
        elevator_fan(&mut g, &[nodes[1], nodes[2], nodes[3], nodes[4]]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[2]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[2]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[2]]);
        assert_eq!(
            route.junction_count, 0,
            "whole elevator group is 1 choice, not a junction"
        );
    }

    #[test]
    fn elevator_group_arrived_via_corridor_plus_another_corridor_is_a_junction() {
        // Like above, but node 1 also has a second corridor exit (1 -> 5). Now node 1 has 2
        // genuine choices: the elevator (as one option) and the other corridor -- a junction.
        let (field, nodes) = field_with_nodes(6);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        bidir(&mut g, nodes[0], nodes[1]);
        bidir(&mut g, nodes[1], nodes[5]);
        elevator_fan(&mut g, &[nodes[1], nodes[2], nodes[3], nodes[4]]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[2]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[2]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[2]]);
        assert_eq!(
            route.junction_count, 1,
            "elevator (1 choice) + other corridor (1 choice) -> junction"
        );
    }

    #[test]
    fn elevator_group_arrived_via_elevator_grants_no_further_elevator_choice() {
        // Elevator fan {0,1,2,3}, route starts by riding the elevator 0->1, then continues via
        // a corridor 1->4. Arriving at node 1 via the elevator, the elevator has already been
        // used to get here -- its remaining stops (1->2, 1->3) grant no further choice, so node
        // 1 has exactly 1 genuine way forward (the corridor) and is not a junction, even though
        // node 1 still has 2 outgoing elevator edges plus the corridor in the raw graph.
        let (field, nodes) = field_with_nodes(5);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        elevator_fan(&mut g, &[nodes[0], nodes[1], nodes[2], nodes[3]]);
        bidir(&mut g, nodes[1], nodes[4]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[4]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[4]).unwrap();
        assert_eq!(route.path, vec![nodes[0], nodes[1], nodes[4]]);
        assert_eq!(
            route.junction_count, 0,
            "elevator already used to arrive -> no further elevator choice"
        );
    }

    #[test]
    fn start_node_elevator_group_is_a_single_choice() {
        // Start node has no arrival edge to exclude, but the elevator-group folding still
        // applies: elevator fan {0,1,2,3} plus a corridor 0->4. The elevator (3 outgoing edges)
        // collapses into 1 choice, so the start has exactly 2 genuine choices (elevator,
        // corridor) -- a junction, not 4.
        let (field, nodes) = field_with_nodes(5);
        let mut g = Graph::new();
        for &id in &nodes {
            g.add_node(id);
        }
        elevator_fan(&mut g, &[nodes[0], nodes[1], nodes[2], nodes[3]]);
        bidir(&mut g, nodes[0], nodes[4]);
        let nav = build_nav_graph_pinned(&g, &pinned(&[nodes[0], nodes[1], nodes[4]]));
        let route = compute_route_info(&nav, &field, nodes[0], nodes[1]).unwrap();
        assert_eq!(
            route.junction_count, 1,
            "elevator (1 choice) + corridor (1 choice) at start -> junction"
        );
    }
}
