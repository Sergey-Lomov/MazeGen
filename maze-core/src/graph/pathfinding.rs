use std::collections::BinaryHeap;
use std::cmp::Reverse;
use super::nav::{NavEdge, NavGraph};

pub(crate) type NavNodeId = super::nav::NavNodeId;

/// Generic Dijkstra on NavGraph. `neighbors` returns `(neighbor_id, edge_weight)` for a node.
pub(crate) fn dijkstra_generic<'a, I, F>(
    nav: &'a NavGraph,
    source: NavNodeId,
    neighbors: F,
) -> Vec<usize>
where
    I: Iterator<Item = (NavNodeId, usize)> + 'a,
    F: Fn(&'a NavGraph, NavNodeId) -> I,
{
    dijkstra_generic_bounded(nav, source, neighbors, None)
}

/// Like `dijkstra_generic`, but stops expanding once the popped cost exceeds `max_dist` (when
/// `Some`) — everything still in the heap at that point is guaranteed at least as far, per
/// Dijkstra's non-decreasing pop order, so the remainder of the reachable graph is safely
/// skipped. Nodes beyond `max_dist` are left at `usize::MAX` (i.e. reported unreachable), same
/// as any other node the traversal never got to — callers only using this to test "is anything
/// within max_dist" don't care about their true distance.
pub(crate) fn dijkstra_generic_bounded<'a, I, F>(
    nav: &'a NavGraph,
    source: NavNodeId,
    neighbors: F,
    max_dist: Option<usize>,
) -> Vec<usize>
where
    I: Iterator<Item = (NavNodeId, usize)> + 'a,
    F: Fn(&'a NavGraph, NavNodeId) -> I,
{
    let n = nav.nodes.len();
    let mut dist = vec![usize::MAX; n];
    let mut heap: BinaryHeap<Reverse<(usize, NavNodeId)>> = BinaryHeap::new();

    dist[source] = 0;
    heap.push(Reverse((0, source)));

    while let Some(Reverse((cost, u))) = heap.pop() {
        if dist[u] < cost { continue; }
        if let Some(max) = max_dist {
            if cost > max { break; }
        }
        for (v, weight) in neighbors(nav, u) {
            let next_cost = cost + weight;
            if next_cost < dist[v] {
                dist[v] = next_cost;
                heap.push(Reverse((next_cost, v)));
            }
        }
    }

    dist
}

/// Forward Dijkstra: distances from `source` following outgoing edges.
pub(crate) fn dijkstra_forward(nav: &NavGraph, source: NavNodeId) -> Vec<usize> {
    dijkstra_generic(nav, source, |nav, u| {
        nav.outgoing_edges(u).map(|e| (e.to, e.path.len().saturating_sub(1)))
    })
}

/// Reverse Dijkstra: distances from nodes that can reach `target` (follows incoming edges).
pub(crate) fn dijkstra_reverse(nav: &NavGraph, target: NavNodeId) -> Vec<usize> {
    dijkstra_generic(nav, target, |nav, u| {
        nav.incoming_edges(u).map(|e| (e.from, e.path.len().saturating_sub(1)))
    })
}

/// Like `dijkstra_forward`, but a nav-edge is only traversable if `edge_filter` accepts it —
/// lets a caller exclude specific transitions (e.g. a teleport hop) from the traversal entirely,
/// rather than merely filtering results after the fact. `edge_filter` sees the full `NavEdge`
/// (its `path` is enough to resolve back to base-graph edges/kinds if needed). Also stops
/// expanding once the popped cost exceeds `max_dist` (when `Some`) — see `dijkstra_generic_bounded`.
pub(crate) fn dijkstra_forward_filtered_bounded(
    nav: &NavGraph,
    source: NavNodeId,
    edge_filter: impl Fn(&NavEdge) -> bool,
    max_dist: Option<usize>,
) -> Vec<usize> {
    dijkstra_generic_bounded(nav, source, |nav, u| {
        nav.outgoing_edges(u).filter(|e| edge_filter(e)).map(|e| (e.to, e.path.len().saturating_sub(1)))
    }, max_dist)
}

/// Like `dijkstra_reverse`, but a nav-edge is only traversable if `edge_filter` accepts it, and
/// stops expanding once the popped cost exceeds `max_dist` (when `Some`) — see
/// `dijkstra_forward_filtered_bounded`/`dijkstra_generic_bounded`.
pub(crate) fn dijkstra_reverse_filtered_bounded(
    nav: &NavGraph,
    target: NavNodeId,
    edge_filter: impl Fn(&NavEdge) -> bool,
    max_dist: Option<usize>,
) -> Vec<usize> {
    dijkstra_generic_bounded(nav, target, |nav, u| {
        nav.incoming_edges(u).filter(|e| edge_filter(e)).map(|e| (e.from, e.path.len().saturating_sub(1)))
    }, max_dist)
}

/// Dijkstra with prev_edge tracking for path reconstruction.
/// Returns `(dist, prev_edge)` where `prev_edge[v]` is the index into `edges` that leads to `v`.
pub(crate) fn dijkstra_with_prev<'a>(
    nav: &'a NavGraph,
    source: NavNodeId,
    edges: &[&'a super::nav::NavEdge],
    outgoing_by_node: &[Vec<usize>],
) -> (Vec<usize>, Vec<Option<usize>>) {
    let n = nav.nodes.len();
    let mut dist = vec![usize::MAX; n];
    let mut prev_edge = vec![None::<usize>; n];
    let mut heap: BinaryHeap<Reverse<(usize, NavNodeId)>> = BinaryHeap::new();

    dist[source] = 0;
    heap.push(Reverse((0, source)));

    while let Some(Reverse((cost, u))) = heap.pop() {
        if dist[u] < cost { continue; }
        for &ei in &outgoing_by_node[u] {
            let e = edges[ei];
            let weight = e.path.len().saturating_sub(1);
            let next_cost = cost + weight;
            if next_cost < dist[e.to] {
                dist[e.to] = next_cost;
                prev_edge[e.to] = Some(ei);
                heap.push(Reverse((next_cost, e.to)));
            }
        }
    }

    (dist, prev_edge)
}

/// Build outgoing edge index: `result[node_id]` = list of edge indices departing from `node_id`.
pub(crate) fn build_outgoing_index(
    nav: &NavGraph,
    edges: &[&super::nav::NavEdge],
) -> Vec<Vec<usize>> {
    let mut out = vec![Vec::new(); nav.nodes.len()];
    for (ei, e) in edges.iter().enumerate() {
        out[e.from].push(ei);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, EdgeKind};
    use crate::graph::nav::build_nav_graph_pinned;
    use std::collections::HashSet;
    use crate::ids::NodeId;

    fn bidir(g: &mut Graph, a: NodeId, b: NodeId) {
        g.add_edge(a, b, EdgeKind::Basic);
        g.add_edge(b, a, EdgeKind::Basic);
    }

    fn pinned(nodes: &[NodeId]) -> HashSet<NodeId> {
        nodes.iter().copied().collect()
    }

    #[test]
    fn dijkstra_forward_finds_shortest_distance() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3, 4] { g.add_node(id); }
        bidir(&mut g, 1, 2);
        bidir(&mut g, 2, 3);
        bidir(&mut g, 1, 4);
        bidir(&mut g, 4, 3);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3, 4]));
        let source = nav.nav_node_for(1).unwrap();
        let dist = dijkstra_forward(&nav, source);
        let target = nav.nav_node_for(3).unwrap();
        assert_eq!(dist[target], 2, "both 1->2->3 and 1->4->3 are 2 hops");
    }

    #[test]
    fn dijkstra_forward_unreachable_node_is_max() {
        let mut g = Graph::new();
        for id in [1u64, 2] { g.add_node(id); }
        // no edges -- disconnected.
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2]));
        let source = nav.nav_node_for(1).unwrap();
        let dist = dijkstra_forward(&nav, source);
        let target = nav.nav_node_for(2).unwrap();
        assert_eq!(dist[target], usize::MAX);
    }

    #[test]
    fn dijkstra_forward_respects_edge_direction() {
        let mut g = Graph::new();
        for id in [1u64, 2] { g.add_node(id); }
        g.add_edge(1, 2, EdgeKind::Basic); // one-way only
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2]));
        let source = nav.nav_node_for(2).unwrap();
        let dist = dijkstra_forward(&nav, source);
        let target = nav.nav_node_for(1).unwrap();
        assert_eq!(dist[target], usize::MAX, "forward Dijkstra from 2 must not reach 1 via a 1->2-only edge");
    }

    #[test]
    fn dijkstra_reverse_finds_nodes_that_can_reach_target() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3] { g.add_node(id); }
        g.add_edge(1, 2, EdgeKind::Basic);
        g.add_edge(2, 3, EdgeKind::Basic);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3]));
        let target = nav.nav_node_for(3).unwrap();
        let dist = dijkstra_reverse(&nav, target);
        let source = nav.nav_node_for(1).unwrap();
        assert_eq!(dist[source], 2, "1 can reach 3 in 2 hops via incoming-edge traversal");
    }

    #[test]
    fn dijkstra_with_prev_reconstructs_correct_predecessor_chain() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3] { g.add_node(id); }
        bidir(&mut g, 1, 2);
        bidir(&mut g, 2, 3);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3]));
        let all_edges: Vec<_> = nav.edges().collect();
        let outgoing = build_outgoing_index(&nav, &all_edges);
        let source = nav.nav_node_for(1).unwrap();
        let (dist, prev_edge) = dijkstra_with_prev(&nav, source, &all_edges, &outgoing);
        let target = nav.nav_node_for(3).unwrap();
        assert_eq!(dist[target], 2);
        // Walk prev_edge back from target to source.
        let mut cur = target;
        let mut hops = 0;
        while cur != source {
            let ei = prev_edge[cur].expect("path must exist");
            cur = all_edges[ei].from;
            hops += 1;
            assert!(hops <= 3, "predecessor chain must not loop");
        }
        assert_eq!(hops, 2);
    }

    #[test]
    fn dijkstra_forward_filtered_bounded_leaves_nodes_past_max_dist_unreached() {
        // A 10-hop chain 0->1->...->10. With max_dist=2, node 10 (true distance 10) must stay
        // at usize::MAX -- not merely because it's filtered out afterward, but because the heap
        // never got far enough to relax it. This is the actual proof the traversal stops early
        // (GitHub issue #196), as opposed to just computing the full map and discarding results.
        let mut g = Graph::new();
        let ids: Vec<u64> = (0..=10).collect();
        for &id in &ids { g.add_node(id); }
        for w in ids.windows(2) {
            g.add_edge(w[0], w[1], EdgeKind::Basic);
        }
        let nav = build_nav_graph_pinned(&g, &pinned(&ids));
        let source = nav.nav_node_for(0).unwrap();
        let far = nav.nav_node_for(10).unwrap();
        let near = nav.nav_node_for(2).unwrap();

        let bounded = dijkstra_forward_filtered_bounded(&nav, source, |_| true, Some(2));
        assert_eq!(bounded[near], 2, "node within max_dist must still get its correct distance");
        assert_eq!(bounded[far], usize::MAX, "node past max_dist must be left unreached, not merely filtered");

        let unbounded = dijkstra_forward_filtered_bounded(&nav, source, |_| true, None);
        assert_eq!(unbounded[far], 10, "sanity check: without a bound the same traversal does reach node 10");
    }

    #[test]
    fn build_outgoing_index_groups_edges_by_source() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3] { g.add_node(id); }
        g.add_edge(1, 2, EdgeKind::Basic);
        g.add_edge(1, 3, EdgeKind::Basic);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3]));
        let all_edges: Vec<_> = nav.edges().collect();
        let outgoing = build_outgoing_index(&nav, &all_edges);
        let source = nav.nav_node_for(1).unwrap();
        assert_eq!(outgoing[source].len(), 2, "node 1 has 2 outgoing nav edges");
    }
}
