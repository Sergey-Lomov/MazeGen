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

/// Every nav node reachable from `start` by following only `is_elevator` edges (either direction) —
/// the nav-graph-local view of one elevator's full stop set (GitHub issue #535 follow-up). Mirrors
/// `quality_control::checks::elevator_core::elevator_groups`, but that helper walks the underlying
/// maze `Graph`/`EdgeKind::Elevator`, while junction detection needs the same grouping in `NavNodeId`
/// space, so it is reimplemented here rather than shared. Generation always wires an elevator's
/// floors as a fully-connected two-way fan, but this makes no such assumption -- it just follows
/// whatever `is_elevator` edges actually exist, both directions, so a partially-repaired fan is
/// still recognized as one group. Always includes `start` itself.
fn elevator_group(nav: &NavGraph, start: NavNodeId) -> std::collections::HashSet<NavNodeId> {
    let mut group = std::collections::HashSet::new();
    let mut stack = vec![start];
    while let Some(nid) = stack.pop() {
        if !group.insert(nid) {
            continue;
        }
        for e in nav.outgoing_edges(nid).filter(|e| e.is_elevator) {
            if !group.contains(&e.to) {
                stack.push(e.to);
            }
        }
        for e in nav.incoming_edges(nid).filter(|e| e.is_elevator) {
            if !group.contains(&e.from) {
                stack.push(e.from);
            }
        }
    }
    group
}

/// Route-aware junction count (GitHub issue #535 follow-up): a nav node on a specific path counts
/// as a junction if it has more than one outgoing "genuine choice" that isn't simply backtracking
/// the way the route just arrived. Concretely, for each node visited (in order, `nav_nodes_on_path[0]`
/// being the route's start), the incoming edge's `reverse_edge` (if any) is excluded from that
/// node's outgoing edges before counting -- a node with exactly one way forward (the common
/// "2-in/2-out corridor" shape, once the way back is excluded) is not a junction, but a node with
/// two or more ways forward is, whether or not one of those ways can also lead back where the route
/// came from by some other, non-reverse edge. The start node has no incoming edge to exclude, so
/// its full outgoing set is used directly -- unlike a whole-graph, route-agnostic degree check, this
/// means a start with exactly 2 outgoing edges already counts as a junction (the player never
/// "arrived", so both are genuine choices), while a mid-route node needs 2 outgoing edges *besides*
/// the way back. The finish node (last entry) is never a junction, regardless of its outgoing
/// edges: the player has already reached the finish, so no further choice is ever presented to them
/// there.
///
/// An elevator's whole stop set is folded into a single logical choice (GitHub issue #535 follow-up
/// part 2), since a player picks a destination floor directly rather than treating each stop as its
/// own branch: instead of counting each `is_elevator` outgoing edge as a separate option (which
/// would make a dead-end elevator with 3+ stops look like a junction, plus grant it every other
/// per-hop bonus on top), all `is_elevator` outgoing edges collapse into at most one "take the
/// elevator" option. And if the route arrived via an `is_elevator` edge, the elevator has already
/// been used to get here -- riding it again is not a fresh choice, so the whole group (every
/// `is_elevator` edge reachable from this node, not just the exact reverse edge) is excluded
/// entirely, leaving only non-elevator ways forward.
///
/// `nav_nodes_on_path` and `path_edge_indices` must be built the same way `routing::compute_route_info`
/// and `scored_endpoints::score_path` already do: `nav_nodes_on_path[i+1] == edges[path_edge_indices[i]].to`,
/// `nav_nodes_on_path[0] == edges[path_edge_indices[0]].from`. `edges` must be indexed the same way
/// `nav.edges()` enumerates them (i.e. built via `nav.edges().collect()`), since `reverse_edge` indices
/// are only meaningful in that space.
///
/// `elevator_group_cache` memoizes `elevator_group` by its start node across calls -- callers that
/// invoke this in a loop over many candidate routes (e.g. `scored_endpoints::best_pair`) should keep
/// one cache alive for the whole loop, since the same elevator group is often revisited across
/// different candidate pairs; a call site scoring a single route can pass a fresh, throwaway map.
pub(crate) fn route_aware_junction_flags(
    nav: &NavGraph,
    nav_nodes_on_path: &[NavNodeId],
    path_edge_indices: &[usize],
    edges: &[&super::nav::NavEdge],
    elevator_group_cache: &mut std::collections::HashMap<NavNodeId, std::rc::Rc<std::collections::HashSet<NavNodeId>>>,
) -> Vec<bool> {
    let last = nav_nodes_on_path.len().saturating_sub(1);
    nav_nodes_on_path.iter().enumerate().map(|(i, &nid)| {
        if i == last {
            return false;
        }
        let arrival_edge = if i == 0 { None } else { Some(edges[path_edge_indices[i - 1]]) };
        let arrived_via_elevator = arrival_edge.is_some_and(|e| e.is_elevator);
        let excluded_reverse = arrival_edge.and_then(|e| e.reverse_edge);

        let elevator_group = if arrived_via_elevator {
            Some(elevator_group_cache.entry(nid).or_insert_with(|| std::rc::Rc::new(elevator_group(nav, nid))).clone())
        } else {
            None
        };

        let mut choices = 0usize;
        let mut elevator_choice_taken = false;
        for ei in nav.outgoing_edge_indices(nid) {
            if Some(ei) == excluded_reverse {
                continue;
            }
            let e = &edges[ei];
            if e.is_elevator {
                if let Some(group) = &elevator_group {
                    if group.contains(&e.to) {
                        continue;
                    }
                }
                if !elevator_choice_taken {
                    elevator_choice_taken = true;
                    choices += 1;
                }
                continue;
            }
            choices += 1;
        }
        choices > 1
    }).collect()
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
