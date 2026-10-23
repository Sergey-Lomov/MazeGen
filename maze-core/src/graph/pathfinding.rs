use super::nav::{NavEdge, NavGraph};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

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
        if dist[u] < cost {
            continue;
        }
        if let Some(max) = max_dist
            && cost > max
        {
            break;
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

/// Like `dijkstra_forward_filtered_bounded`, but instead of returning a full distance map, calls
/// `on_edge` once for every nav-edge relaxed during the traversal (i.e. every edge leaving a node
/// whose shortest distance is already known to be within `max_dist`), passing the exact edge and
/// the already-known distance to its `from` end (`edge.path.len() - 1` further hops reach `to`,
/// with every intermediate tile in `edge.path` at its own exact offset in between).
///
/// This is the hook a caller needs to find the *nearest* of several targets sprinkled both on
/// nav-nodes (an edge's own `from`/`to`) and on corridor-interior tiles (any other position in an
/// edge's `path`, e.g. a `Split` occurrence) without either building the whole bounded distance
/// map up front (wasted work once the nearest target is known) or resolving each target with its
/// own separate traversal (`pairwise_graph_proximity_scan`'s pre-optimization shape, GitHub issue
/// #512 follow-up) — one traversal, one edge callback, every reachable tile seen exactly where
/// Dijkstra would have expanded it, in non-decreasing distance order across *nodes* (though not
/// perfectly across the interior of a single long edge — see the caller's own doc comment on how
/// it resolves that). The traversal stops the same way `dijkstra_generic_bounded` does: once the
/// popped cost exceeds `max_dist`, or `on_edge` itself returns `false` (a caller-driven early
/// exit, e.g. once it already knows further nodes can only be farther).
pub(crate) fn dijkstra_forward_visit_edges_bounded(
    nav: &NavGraph,
    source: NavNodeId,
    edge_filter: impl Fn(&NavEdge) -> bool,
    max_dist: Option<usize>,
    mut on_edge: impl FnMut(&NavEdge, usize) -> bool,
) {
    let n = nav.nodes.len();
    let mut dist = vec![usize::MAX; n];
    let mut heap: BinaryHeap<Reverse<(usize, NavNodeId)>> = BinaryHeap::new();

    dist[source] = 0;
    heap.push(Reverse((0, source)));

    while let Some(Reverse((cost, u))) = heap.pop() {
        if dist[u] < cost {
            continue;
        }
        if let Some(max) = max_dist
            && cost > max
        {
            break;
        }
        for edge in nav.outgoing_edges(u).filter(|e| edge_filter(e)) {
            if !on_edge(edge, cost) {
                return;
            }
            let weight = edge.path.len().saturating_sub(1);
            let next_cost = cost + weight;
            if next_cost < dist[edge.to] {
                dist[edge.to] = next_cost;
                heap.push(Reverse((next_cost, edge.to)));
            }
        }
    }
}

/// Like `dijkstra_forward_visit_edges_bounded`, but follows incoming edges instead — for a caller
/// resolving "how close is X to something that can reach it" (reverse-direction proximity, e.g.
/// `TeleportGroupProximityCheck`/`OneWayGroupGraphProximityCheck`'s own directed `min(forward,
/// reverse)` reduction) via the same single-pass nearest-candidate-tracking shape. `on_edge` is
/// called once per relaxed incoming edge, passing the edge and the already-known distance to its
/// `to` end (`source`'s side gets closer as the edge's `path` is walked backward from `to` toward
/// `from`) — a caller inspecting `edge.path` for a corridor-interior candidate must therefore
/// index from the end, not the start, unlike the forward variant.
pub(crate) fn dijkstra_reverse_visit_edges_bounded(
    nav: &NavGraph,
    source: NavNodeId,
    edge_filter: impl Fn(&NavEdge) -> bool,
    max_dist: Option<usize>,
    mut on_edge: impl FnMut(&NavEdge, usize) -> bool,
) {
    let n = nav.nodes.len();
    let mut dist = vec![usize::MAX; n];
    let mut heap: BinaryHeap<Reverse<(usize, NavNodeId)>> = BinaryHeap::new();

    dist[source] = 0;
    heap.push(Reverse((0, source)));

    while let Some(Reverse((cost, u))) = heap.pop() {
        if dist[u] < cost {
            continue;
        }
        if let Some(max) = max_dist
            && cost > max
        {
            break;
        }
        for edge in nav.incoming_edges(u).filter(|e| edge_filter(e)) {
            if !on_edge(edge, cost) {
                return;
            }
            let weight = edge.path.len().saturating_sub(1);
            let next_cost = cost + weight;
            if next_cost < dist[edge.from] {
                dist[edge.from] = next_cost;
                heap.push(Reverse((next_cost, edge.from)));
            }
        }
    }
}

/// Forward Dijkstra: distances from `source` following outgoing edges.
pub(crate) fn dijkstra_forward(nav: &NavGraph, source: NavNodeId) -> Vec<usize> {
    dijkstra_generic(nav, source, |nav, u| {
        nav.outgoing_edges(u)
            .map(|e| (e.to, e.path.len().saturating_sub(1)))
    })
}

/// Reverse Dijkstra: distances from nodes that can reach `target` (follows incoming edges).
pub(crate) fn dijkstra_reverse(nav: &NavGraph, target: NavNodeId) -> Vec<usize> {
    dijkstra_generic(nav, target, |nav, u| {
        nav.incoming_edges(u)
            .map(|e| (e.from, e.path.len().saturating_sub(1)))
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
    dijkstra_generic_bounded(
        nav,
        source,
        |nav, u| {
            nav.outgoing_edges(u)
                .filter(|e| edge_filter(e))
                .map(|e| (e.to, e.path.len().saturating_sub(1)))
        },
        max_dist,
    )
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
    dijkstra_generic_bounded(
        nav,
        target,
        |nav, u| {
            nav.incoming_edges(u)
                .filter(|e| edge_filter(e))
                .map(|e| (e.from, e.path.len().saturating_sub(1)))
        },
        max_dist,
    )
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
        if dist[u] < cost {
            continue;
        }
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

/// Flat (CSR-style) equivalent of `build_outgoing_index`'s `Vec<Vec<usize>>` -- one contiguous
/// `Vec<usize>` of edge indices plus a per-node `[start, end)` range into it, instead of one
/// separate heap allocation per node. Built once per `ScoredPathContext` and then read by every
/// one of `best_pair`'s `O(n)` `dijkstra_with_prev_into` calls, so the flat layout also means
/// those repeated reads stay close together in memory instead of chasing a pointer per node.
pub(crate) struct OutgoingIndex {
    starts: Vec<usize>,
    edge_indices: Vec<usize>,
}

impl OutgoingIndex {
    pub(crate) fn build(nav: &NavGraph, edges: &[&super::nav::NavEdge]) -> Self {
        let n = nav.nodes.len();
        let mut counts = vec![0usize; n + 1];
        for e in edges {
            counts[e.from + 1] += 1;
        }
        for i in 0..n {
            counts[i + 1] += counts[i];
        }
        let starts = counts.clone();
        let mut cursor = counts;
        let mut edge_indices = vec![0usize; edges.len()];
        for (ei, e) in edges.iter().enumerate() {
            edge_indices[cursor[e.from]] = ei;
            cursor[e.from] += 1;
        }
        Self {
            starts,
            edge_indices,
        }
    }

    #[inline]
    fn outgoing(&self, node: NavNodeId) -> &[usize] {
        &self.edge_indices[self.starts[node]..self.starts[node + 1]]
    }
}

/// Scratch buffers for `dijkstra_with_prev_into`, reused across `best_pair`'s `O(n)` Dijkstra
/// calls instead of each call allocating its own `dist`/`prev_edge` `Vec`s and `BinaryHeap` from
/// scratch. `reset` clears them for the next source node while keeping the backing storage (heap
/// capacity in particular tends to stabilize after the first few calls on a given graph).
pub(crate) struct DijkstraScratch {
    dist: Vec<usize>,
    prev_edge: Vec<Option<usize>>,
    heap: BinaryHeap<Reverse<(usize, NavNodeId)>>,
}

impl DijkstraScratch {
    pub(crate) fn new(n: usize) -> Self {
        Self {
            dist: vec![usize::MAX; n],
            prev_edge: vec![None; n],
            heap: BinaryHeap::new(),
        }
    }

    fn reset(&mut self) {
        self.dist.fill(usize::MAX);
        self.prev_edge.fill(None);
        self.heap.clear();
    }
}

/// Like `dijkstra_with_prev`, but takes a `DijkstraScratch` to reuse across repeated calls (e.g.
/// `best_pair`'s one-Dijkstra-per-candidate-start loop) instead of allocating a fresh `dist`/
/// `prev_edge`/heap every time, and reads edges via `OutgoingIndex`'s flat layout instead of a
/// `Vec<Vec<usize>>`. Returns borrows into `scratch` rather than owned `Vec`s -- valid until the
/// next call that mutates `scratch` (i.e. the next `dijkstra_with_prev_into` call reusing it).
pub(crate) fn dijkstra_with_prev_into<'s>(
    source: NavNodeId,
    edges: &[&super::nav::NavEdge],
    outgoing: &OutgoingIndex,
    scratch: &'s mut DijkstraScratch,
) -> (&'s [usize], &'s [Option<usize>]) {
    scratch.reset();

    scratch.dist[source] = 0;
    scratch.heap.push(Reverse((0, source)));

    while let Some(Reverse((cost, u))) = scratch.heap.pop() {
        if scratch.dist[u] < cost {
            continue;
        }
        for &ei in outgoing.outgoing(u) {
            let e = edges[ei];
            let weight = e.path.len().saturating_sub(1);
            let next_cost = cost + weight;
            if next_cost < scratch.dist[e.to] {
                scratch.dist[e.to] = next_cost;
                scratch.prev_edge[e.to] = Some(ei);
                scratch.heap.push(Reverse((next_cost, e.to)));
            }
        }
    }

    (&scratch.dist, &scratch.prev_edge)
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
    elevator_group_cache: &mut std::collections::HashMap<
        NavNodeId,
        std::rc::Rc<std::collections::HashSet<NavNodeId>>,
    >,
) -> Vec<bool> {
    let last = nav_nodes_on_path.len().saturating_sub(1);
    nav_nodes_on_path
        .iter()
        .enumerate()
        .map(|(i, &nid)| {
            if i == last {
                return false;
            }
            let arrival_edge = if i == 0 {
                None
            } else {
                Some(edges[path_edge_indices[i - 1]])
            };
            let arrived_via_elevator = arrival_edge.is_some_and(|e| e.is_elevator);
            let excluded_reverse = arrival_edge.and_then(|e| e.reverse_edge);

            let elevator_group = if arrived_via_elevator {
                Some(
                    elevator_group_cache
                        .entry(nid)
                        .or_insert_with(|| std::rc::Rc::new(elevator_group(nav, nid)))
                        .clone(),
                )
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
                    if let Some(group) = &elevator_group
                        && group.contains(&e.to)
                    {
                        continue;
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
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::nav::build_nav_graph_pinned;
    use crate::graph::{EdgeKind, Graph};
    use crate::ids::NodeId;
    use std::collections::HashSet;

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
        for id in [1u64, 2, 3, 4] {
            g.add_node(id);
        }
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
        for id in [1u64, 2] {
            g.add_node(id);
        }
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
        for id in [1u64, 2] {
            g.add_node(id);
        }
        g.add_edge(1, 2, EdgeKind::Basic); // one-way only
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2]));
        let source = nav.nav_node_for(2).unwrap();
        let dist = dijkstra_forward(&nav, source);
        let target = nav.nav_node_for(1).unwrap();
        assert_eq!(
            dist[target],
            usize::MAX,
            "forward Dijkstra from 2 must not reach 1 via a 1->2-only edge"
        );
    }

    #[test]
    fn dijkstra_reverse_finds_nodes_that_can_reach_target() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3] {
            g.add_node(id);
        }
        g.add_edge(1, 2, EdgeKind::Basic);
        g.add_edge(2, 3, EdgeKind::Basic);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3]));
        let target = nav.nav_node_for(3).unwrap();
        let dist = dijkstra_reverse(&nav, target);
        let source = nav.nav_node_for(1).unwrap();
        assert_eq!(
            dist[source], 2,
            "1 can reach 3 in 2 hops via incoming-edge traversal"
        );
    }

    #[test]
    fn dijkstra_with_prev_reconstructs_correct_predecessor_chain() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3] {
            g.add_node(id);
        }
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
        for &id in &ids {
            g.add_node(id);
        }
        for w in ids.windows(2) {
            g.add_edge(w[0], w[1], EdgeKind::Basic);
        }
        let nav = build_nav_graph_pinned(&g, &pinned(&ids));
        let source = nav.nav_node_for(0).unwrap();
        let far = nav.nav_node_for(10).unwrap();
        let near = nav.nav_node_for(2).unwrap();

        let bounded = dijkstra_forward_filtered_bounded(&nav, source, |_| true, Some(2));
        assert_eq!(
            bounded[near], 2,
            "node within max_dist must still get its correct distance"
        );
        assert_eq!(
            bounded[far],
            usize::MAX,
            "node past max_dist must be left unreached, not merely filtered"
        );

        let unbounded = dijkstra_forward_filtered_bounded(&nav, source, |_| true, None);
        assert_eq!(
            unbounded[far], 10,
            "sanity check: without a bound the same traversal does reach node 10"
        );
    }

    #[test]
    fn dijkstra_forward_visit_edges_bounded_visits_every_edge_in_non_decreasing_distance_order() {
        // Diamond: 0->1, 0->2, 1->3, 2->3. Edges leaving a node are visited only once that node's
        // own shortest distance is known, so the two edges out of 0 (distance 0) are seen before
        // the two edges out of 1/2 (distance 1) -- direct proof of the function's own "visits an
        // edge with the already-known distance to its `from` end" contract, and that it reaches
        // every edge in the graph rather than stopping early.
        let mut g = Graph::new();
        for id in [0u64, 1, 2, 3] {
            g.add_node(id);
        }
        g.add_edge(0, 1, EdgeKind::Basic);
        g.add_edge(0, 2, EdgeKind::Basic);
        g.add_edge(1, 3, EdgeKind::Basic);
        g.add_edge(2, 3, EdgeKind::Basic);
        let nav = build_nav_graph_pinned(&g, &pinned(&[0, 1, 2, 3]));
        let source = nav.nav_node_for(0).unwrap();

        let mut seen: Vec<(NodeId, NodeId, usize)> = Vec::new();
        dijkstra_forward_visit_edges_bounded(
            &nav,
            source,
            |_| true,
            None,
            |edge, dist| {
                let from_id = nav.nodes[edge.from].node_id;
                let to_id = nav.nodes[edge.to].node_id;
                seen.push((from_id, to_id, dist));
                true
            },
        );

        assert_eq!(
            seen.len(),
            4,
            "every edge in the diamond must be visited exactly once"
        );
        assert!(
            seen.iter()
                .all(|&(from, _, dist)| (from == 0) == (dist == 0)),
            "an edge leaving node 0 must be visited at distance 0, no other edge at distance 0: {seen:?}"
        );
        assert!(
            seen.iter()
                .any(|&(from, to, dist)| from == 1 && to == 3 && dist == 1),
            "edge 1->3 must be visited once node 1's own distance (1) is known: {seen:?}"
        );
    }

    #[test]
    fn dijkstra_forward_visit_edges_bounded_stops_early_when_on_edge_returns_false() {
        let mut g = Graph::new();
        for id in [0u64, 1, 2] {
            g.add_node(id);
        }
        g.add_edge(0, 1, EdgeKind::Basic);
        g.add_edge(1, 2, EdgeKind::Basic);
        let nav = build_nav_graph_pinned(&g, &pinned(&[0, 1, 2]));
        let source = nav.nav_node_for(0).unwrap();

        let mut visits = 0;
        dijkstra_forward_visit_edges_bounded(
            &nav,
            source,
            |_| true,
            None,
            |_, _| {
                visits += 1;
                false // stop right after the first edge
            },
        );
        assert_eq!(
            visits, 1,
            "on_edge returning false must end the traversal immediately"
        );
    }

    #[test]
    fn dijkstra_reverse_visit_edges_bounded_visits_incoming_edges_with_distance_to_their_to_end() {
        // Chain 0->1->2 (one-way). Scanning in reverse from 2 must visit edge 1->2 first (distance
        // 0 to 2, its own `to` end), then edge 0->1 (distance 1, once node 1's own distance from 2
        // is known) -- proves it follows `incoming_edges` and relaxes toward `edge.from`, the
        // mirror image of the forward variant's own contract.
        let mut g = Graph::new();
        for id in [0u64, 1, 2] {
            g.add_node(id);
        }
        g.add_edge(0, 1, EdgeKind::Basic);
        g.add_edge(1, 2, EdgeKind::Basic);
        let nav = build_nav_graph_pinned(&g, &pinned(&[0, 1, 2]));
        let target = nav.nav_node_for(2).unwrap();

        let mut seen: Vec<(NodeId, NodeId, usize)> = Vec::new();
        dijkstra_reverse_visit_edges_bounded(
            &nav,
            target,
            |_| true,
            None,
            |edge, dist| {
                let from_id = nav.nodes[edge.from].node_id;
                let to_id = nav.nodes[edge.to].node_id;
                seen.push((from_id, to_id, dist));
                true
            },
        );

        assert_eq!(seen.len(), 2, "both edges on the chain must be visited");
        assert_eq!(
            seen[0],
            (1, 2, 0),
            "edge 1->2 must be visited first, at distance 0 (its own `to` end is the source)"
        );
        assert_eq!(
            seen[1],
            (0, 1, 1),
            "edge 0->1 must be visited once node 1's own distance to the target (1) is known"
        );
    }

    #[test]
    fn dijkstra_reverse_visit_edges_bounded_respects_max_dist() {
        // Chain 0->1->2->3. Scanning in reverse from 3 with max_dist=1 must not visit edge 0->1
        // (distance 2 to the target), only 2->3 (distance 0) and 1->2 (distance 1).
        let mut g = Graph::new();
        for id in [0u64, 1, 2, 3] {
            g.add_node(id);
        }
        g.add_edge(0, 1, EdgeKind::Basic);
        g.add_edge(1, 2, EdgeKind::Basic);
        g.add_edge(2, 3, EdgeKind::Basic);
        let nav = build_nav_graph_pinned(&g, &pinned(&[0, 1, 2, 3]));
        let target = nav.nav_node_for(3).unwrap();

        let mut seen: Vec<(NodeId, NodeId)> = Vec::new();
        dijkstra_reverse_visit_edges_bounded(
            &nav,
            target,
            |_| true,
            Some(1),
            |edge, _| {
                seen.push((nav.nodes[edge.from].node_id, nav.nodes[edge.to].node_id));
                true
            },
        );

        assert_eq!(
            seen,
            vec![(2, 3), (1, 2)],
            "edge 0->1 (distance 2 to the target) must never be visited when max_dist is 1"
        );
    }

    #[test]
    fn build_outgoing_index_groups_edges_by_source() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3] {
            g.add_node(id);
        }
        g.add_edge(1, 2, EdgeKind::Basic);
        g.add_edge(1, 3, EdgeKind::Basic);
        let nav = build_nav_graph_pinned(&g, &pinned(&[1, 2, 3]));
        let all_edges: Vec<_> = nav.edges().collect();
        let outgoing = build_outgoing_index(&nav, &all_edges);
        let source = nav.nav_node_for(1).unwrap();
        assert_eq!(outgoing[source].len(), 2, "node 1 has 2 outgoing nav edges");
    }
}
