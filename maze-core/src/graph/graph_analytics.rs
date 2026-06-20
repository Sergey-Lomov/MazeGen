use std::collections::{HashMap, HashSet, VecDeque};
use super::nav::{NavEdge, NavGraph, NavNodeId};
use crate::dsu::Dsu;

/// Iterate distinct *undirected* nav-edges: an edge and its `reverse_edge` are the same
/// physical corridor and are yielded once (via the lower edge index); edges with no reverse
/// (one-way corridors) are yielded individually. Self-loops are skipped. `filter` restricts
/// to a subset of edge indices (e.g. the pure-cycle core) — pass `|_| true` for no restriction.
fn distinct_undirected_edges<'a>(
    nav: &'a NavGraph,
    filter: impl Fn(usize) -> bool + 'a,
) -> impl Iterator<Item = (usize, &'a NavEdge)> {
    let mut seen: HashSet<usize> = HashSet::new();
    nav.edges().enumerate().filter_map(move |(idx, edge)| {
        if edge.from == edge.to || !filter(idx) || seen.contains(&idx) {
            return None;
        }
        seen.insert(idx);
        if let Some(rev) = edge.reverse_edge {
            seen.insert(rev);
        }
        Some((idx, edge))
    })
}

/// Iteratively trim dead-end nav-nodes: a node with at most one *distinct undirected
/// connection* — counting an edge and its `reverse_edge` as one, but counting parallel
/// edges to the same neighbor (e.g. a direct corridor plus a longer detour between the
/// same two junctions) as separate connections, since each is a potential cycle leg —
/// cannot lie on any directed cycle. Walking out and back along the single connection is
/// the only option, forbidden by the no-edge-reuse rule. Removing it can turn its neighbor
/// into a new dead end, so this repeats until stable (leaf-pruning a tree, but direction-
/// and multi-edge-safe: it only ever strips nodes topologically incapable of being on a
/// cycle, regardless of edge direction or one-way edges).
/// Returns, per nav-node id, whether it survives trimming — candidates for `build_cyclic_core`.
fn trim_dead_ends(nav: &NavGraph) -> Vec<bool> {
    let n = nav.nodes.len();

    // Undirected adjacency: each distinct nav-edge counts once (its reverse_edge, if any,
    // is the same physical connection and must not be double-counted), but two different
    // edge indices to the same neighbor (parallel corridors) each count separately.
    let mut adj: Vec<Vec<NavNodeId>> = vec![Vec::new(); n];
    for (_, edge) in distinct_undirected_edges(nav, |_| true) {
        adj[edge.from].push(edge.to);
        adj[edge.to].push(edge.from);
    }
    let mut degree: Vec<usize> = adj.iter().map(|v| v.len()).collect();

    let mut removed = vec![false; n];
    let mut queue: VecDeque<NavNodeId> = VecDeque::new();
    for nid in 0..n {
        if degree[nid] <= 1 { queue.push_back(nid); }
    }
    while let Some(nid) = queue.pop_front() {
        if removed[nid] { continue; }
        removed[nid] = true;
        for &nb in &adj[nid] {
            if removed[nb] { continue; }
            degree[nb] = degree[nb].saturating_sub(1);
            if degree[nb] <= 1 { queue.push_back(nb); }
        }
    }

    removed.into_iter().map(|r| !r).collect()
}

/// Find nav-nodes and nav-edges participating in real directed cycles.
/// An edge (u -> v) lies on a real cycle iff there is a directed path from v back to u
/// that does not reuse this edge or its reverse (reusing the reverse would just be
/// walking the same corridor back and forth, not a real cycle).
/// Returns (cyclic nav-node ids, cyclic nav-edge indices).
fn build_cyclic_core(nav: &NavGraph) -> (HashSet<NavNodeId>, HashSet<usize>) {
    let n = nav.nodes.len();
    let edges: Vec<&NavEdge> = nav.edges().collect();

    // Dead-end nodes can never be on a cycle — exclude them before the expensive BFS pass.
    let survivors = trim_dead_ends(nav);

    // Adjacency: node -> list of (edge_idx, to). Restricted to surviving nodes.
    let mut adj: Vec<Vec<(usize, NavNodeId)>> = vec![Vec::new(); n];
    for (idx, edge) in edges.iter().enumerate() {
        if edge.from == edge.to { continue; } // self-loop, skip
        if !survivors[edge.from] || !survivors[edge.to] { continue; }
        adj[edge.from].push((idx, edge.to));
    }

    let mut cyclic_nodes: HashSet<NavNodeId> = HashSet::new();
    let mut cyclic_edges: HashSet<usize> = HashSet::new();

    for (idx, edge) in edges.iter().enumerate() {
        if edge.from == edge.to { continue; }
        if !survivors[edge.from] || !survivors[edge.to] { continue; }
        if cyclic_edges.contains(&idx) { continue; } // already proven cyclic
        let u = edge.from;
        let v = edge.to;
        let excluded_reverse = edge.reverse_edge;

        // BFS from v to u, forbidding this edge and its reverse.
        let mut visited = vec![false; n];
        let mut parent_edge: Vec<Option<usize>> = vec![None; n];
        visited[v] = true;
        let mut queue: VecDeque<NavNodeId> = VecDeque::new();
        queue.push_back(v);
        let mut found = v == u;

        while let Some(node) = queue.pop_front() {
            if node == u { found = true; break; }
            for &(e_idx, to) in &adj[node] {
                if e_idx == idx || Some(e_idx) == excluded_reverse { continue; }
                if visited[to] { continue; }
                visited[to] = true;
                parent_edge[to] = Some(e_idx);
                queue.push_back(to);
            }
        }

        if !found { continue; }

        // Reconstruct the path v -> u and mark all its edges + this edge as cyclic.
        cyclic_edges.insert(idx);
        cyclic_nodes.insert(u);
        cyclic_nodes.insert(v);
        let mut cur = u;
        while cur != v {
            let e_idx = parent_edge[cur].expect("BFS path must have a parent edge");
            cyclic_edges.insert(e_idx);
            let e = edges[e_idx];
            cyclic_nodes.insert(e.from);
            cyclic_nodes.insert(e.to);
            cur = e.from;
        }
    }

    (cyclic_nodes, cyclic_edges)
}

/// Global graph analytics computed on the nav-graph.
#[derive(Debug, Clone)]
pub struct GraphAnalytics {
    pub node_count: usize,
    pub edge_count: usize,
    /// Number of independent cycles (E - V + C on the pure-cycle core).
    pub cycle_count: usize,
    /// Number of connected cyclic regions (WCC on the pure-cycle core subgraph).
    pub cycle_region_count: usize,
    /// Nav-node ids in the pure-cycle core (real cycles only, no bridges).
    pub pure_cycle_nav_nodes: HashSet<NavNodeId>,
    /// Nav-edge indices in the pure-cycle core (real cycles only, no bridges).
    pub pure_cycle_edge_indices: HashSet<usize>,
}

impl GraphAnalytics {
    pub fn empty() -> Self {
        GraphAnalytics {
            node_count: 0,
            edge_count: 0,
            cycle_count: 0,
            cycle_region_count: 0,
            pure_cycle_nav_nodes: HashSet::new(),
            pure_cycle_edge_indices: HashSet::new(),
        }
    }
}

/// Count undirected edges within the pure-cycle core. An edge and its `reverse_edge` are the
/// same physical corridor and count once; edges with no reverse_edge in the core (one-way, or
/// a corridor whose reverse direction simply isn't in the core) count via plain undirected-pair
/// dedup. Distinct parallel corridors between the same node pair (e.g. a direct path plus a
/// longer detour, each compressed from a different chain of corridor nodes) must each count
/// separately — they're genuinely different cycle legs.
fn count_core_edges(nav: &NavGraph, core_edges: &HashSet<usize>) -> usize {
    let mut paired_count = 0usize;
    let mut unpaired_pairs: HashSet<(NavNodeId, NavNodeId)> = HashSet::new();
    for (_, edge) in distinct_undirected_edges(nav, |idx| core_edges.contains(&idx)) {
        match edge.reverse_edge {
            Some(rev) if core_edges.contains(&rev) => paired_count += 1,
            _ => { unpaired_pairs.insert((edge.from.min(edge.to), edge.from.max(edge.to))); }
        }
    }
    paired_count + unpaired_pairs.len()
}

/// Number of connected components (WCC) of the pure-cycle core subgraph, via DSU.
fn count_core_regions(core_nodes: &[NavNodeId], nav: &NavGraph, core_edges: &HashSet<usize>) -> usize {
    let node_to_idx: HashMap<NavNodeId, usize> = core_nodes.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    let mut dsu = Dsu::new(core_nodes.len());
    for (_, edge) in distinct_undirected_edges(nav, |idx| core_edges.contains(&idx)) {
        let a = node_to_idx[&edge.from];
        let b = node_to_idx[&edge.to];
        dsu.union_by_size(a, b);
    }
    let roots: HashSet<usize> = (0..core_nodes.len()).map(|i| dsu.find(i)).collect();
    roots.len()
}

/// Cycle metrics on the pure-cycle core. Bridges never participate, so they never affect
/// the cycle count or region count.
/// cycle_count = E_core - V_core + C_core (number of independent cycles).
/// cycle_region_count = number of connected components in the pure-cycle core (undirected).
fn compute_cycle_metrics(nav: &NavGraph, core_nodes: &HashSet<NavNodeId>, core_edges: &HashSet<usize>) -> (usize, usize) {
    if core_nodes.is_empty() {
        return (0, 0);
    }
    let core_nodes: Vec<NavNodeId> = core_nodes.iter().copied().collect();
    let v_core = core_nodes.len();
    let e_core = count_core_edges(nav, core_edges);
    let c_core = count_core_regions(&core_nodes, nav, core_edges);
    let cycle_count = (e_core + c_core).saturating_sub(v_core);
    (cycle_count, c_core)
}

/// Compute graph analytics on the nav-graph.
/// Cycle metrics are based on the pure-cycle core (see `build_cyclic_core`), not raw SCCs.
pub fn compute_graph_analytics(nav: &NavGraph) -> GraphAnalytics {
    let n = nav.nodes.len();
    if n == 0 {
        return GraphAnalytics::empty();
    }
    // Unique undirected nav-edges (no self-loops). An edge and its `reverse_edge` are the
    // same physical corridor and count once; edges without a reverse (one-way) count
    // individually by edge index, NOT deduped by node-pair — two distinct one-way edges
    // between the same pair (e.g. a direct path plus a detour) are genuinely separate
    // corridors and must both be counted.
    let edge_count = distinct_undirected_edges(nav, |_| true).count();

    // Pure-cycle core — nodes/edges participating in real directed cycles (no bridges).
    let (pure_cycle_nav_nodes, pure_cycle_edge_indices) = build_cyclic_core(nav);
    let (cycle_count, cycle_region_count) =
        compute_cycle_metrics(nav, &pure_cycle_nav_nodes, &pure_cycle_edge_indices);

    GraphAnalytics {
        node_count: n,
        edge_count,
        cycle_count,
        cycle_region_count,
        pure_cycle_nav_nodes,
        pure_cycle_edge_indices,
    }
}

#[cfg(test)]
#[path = "graph_analytics/tests.rs"]
mod tests;
