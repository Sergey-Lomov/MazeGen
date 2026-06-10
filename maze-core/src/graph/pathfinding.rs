use std::collections::BinaryHeap;
use std::cmp::Reverse;
use super::nav::NavGraph;

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
    let n = nav.nodes.len();
    let mut dist = vec![usize::MAX; n];
    let mut heap: BinaryHeap<Reverse<(usize, NavNodeId)>> = BinaryHeap::new();

    dist[source] = 0;
    heap.push(Reverse((0, source)));

    while let Some(Reverse((cost, u))) = heap.pop() {
        if dist[u] < cost { continue; }
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
