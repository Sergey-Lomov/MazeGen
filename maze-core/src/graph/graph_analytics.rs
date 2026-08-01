use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::collections::VecDeque;
use super::nav::{NavEdge, NavGraph, NavNodeId};
use super::cycles::find_fundamental_cycles;
use crate::dsu::Dsu;

/// Iterate distinct *undirected* nav-edges: an edge and its `reverse_edge` are the same
/// physical corridor and are yielded once (via the lower edge index); edges with no reverse
/// (one-way corridors) are yielded individually. Self-loop edges count too — a self-loop's
/// `reverse_edge` (if any, e.g. a CW/CCW ring pair) dedups via the same mechanism as ordinary
/// corridors. `filter` restricts to a subset of edge indices (e.g. the pure-cycle core) —
/// pass `|_| true` for no restriction.
fn distinct_undirected_edges<'a>(
    nav: &'a NavGraph,
    filter: impl Fn(usize) -> bool + 'a,
) -> impl Iterator<Item = (usize, &'a NavEdge)> {
    let mut seen: HashSet<usize> = HashSet::new();
    nav.edges().enumerate().filter_map(move |(idx, edge)| {
        if !filter(idx) || seen.contains(&idx) {
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
/// Returns, per nav-node id, whether it survives trimming.
#[cfg(test)]
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
/// Union of every nav-node/nav-edge appearing in any cycle found by `find_fundamental_cycles`
/// (GitHub issue #244) — the fundamental cycle basis, not a separate BFS pass. Self-loops are
/// included: they are first-class cycles there. Both directions of a cycle's edges are kept
/// (an edge and its `reverse_edge`), matching `count_core_regions`'s pairing-based counting.
/// Exactly covers the SCC's topological cycle structure — `find_fundamental_cycles` always
/// recovers the full topological β₁ per SCC (see its doc comment), so this core is not
/// narrower than the full cycle set.
fn cycle_core(nav: &NavGraph) -> (HashSet<NavNodeId>, HashSet<usize>) {
    let edges: Vec<&NavEdge> = nav.edges().collect();
    let cycles = find_fundamental_cycles(nav);

    let mut cyclic_nodes: HashSet<NavNodeId> = HashSet::new();
    let mut cyclic_edges: HashSet<usize> = HashSet::new();

    for cycle in &cycles {
        for &idx in cycle {
            cyclic_edges.insert(idx);
            cyclic_nodes.insert(edges[idx].from);
            cyclic_nodes.insert(edges[idx].to);
            if let Some(rev) = edges[idx].reverse_edge {
                cyclic_edges.insert(rev);
            }
        }
    }

    (cyclic_nodes, cyclic_edges)
}

/// Global graph analytics computed on the nav-graph.
#[derive(Debug, Clone)]
pub struct GraphAnalytics {
    pub node_count: usize,
    pub edge_count: usize,
    /// Number of independent cycles: `find_fundamental_cycles`'s output length (GitHub issue
    /// #244) — equal to the topological β₁ on the pure-cycle core (that function always
    /// recovers the full count, see its doc comment), computed via the fundamental cycle basis
    /// rather than the Euler formula.
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

/// Compute graph analytics on the nav-graph.
/// `cycle_count` is the fundamental cycle basis's length (`find_fundamental_cycles`, GitHub
/// issue #244), the same topological β₁ the Euler formula used to compute — see
/// `cycle_core`'s doc comment.
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

    let cycle_count = find_fundamental_cycles(nav).len();

    // Pure-cycle core — nodes/edges participating in the fundamental cycle basis (no bridges).
    let (pure_cycle_nav_nodes, pure_cycle_edge_indices) = cycle_core(nav);
    let cycle_region_count = if pure_cycle_nav_nodes.is_empty() {
        0
    } else {
        let core_nodes: Vec<NavNodeId> = pure_cycle_nav_nodes.iter().copied().collect();
        count_core_regions(&core_nodes, nav, &pure_cycle_edge_indices)
    };

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
