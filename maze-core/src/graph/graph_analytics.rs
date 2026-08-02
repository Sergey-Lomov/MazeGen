use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::collections::VecDeque;
use super::nav::{NavEdge, NavGraph, NavNodeId};
use super::cycles::{find_all_simple_cycles, drop_trivial_reverse_pairs, dedup_bidirectional_pairs, CycleSearchResult};
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
/// Union of every nav-node/nav-edge appearing in any cycle found by `find_all_simple_cycles`
/// (the single source of truth shared with overlay, metrics, and `MinLoopLengthCheck`) —
/// not a separate BFS pass. Self-loops are included: they are first-class cycles there.
///
/// Returns `None` if enumeration aborted as `TooManyCycles` (see `find_all_simple_cycles`'s
/// `MAX_SIMPLE_CYCLES` doc comment) — `compute_graph_analytics` has no toggle to disable this
/// path, so a dense, fully-preset graph must surface as "analysis unavailable" rather than
/// hang (see issue #22).
///
/// Two deliberate departures from a plain "union the deduped cycle list" approach, both
/// needed for `compute_cycle_metrics`'s Euler formula (`E - V + C`) to produce correct
/// results — confirmed by regressions when either was skipped:
///
/// 1. **Drops only trivial reverse-pair 2-cycles** (`drop_trivial_reverse_pairs`), not the
///    full canonical-index dedup (`dedup_bidirectional_pairs`). A dead-end spur (a single
///    bidirectional edge to a leaf with no other connection) only ever appears in the cycle
///    list as its own trivial walk-out-and-back pair — dropping trivial pairs correctly
///    excludes it from the core (it's not on any real cycle). But two genuinely different
///    routes between the same junction pair (e.g. a direct corridor plus a detour) also
///    produce trivial pairs (each route walked back on itself) ALONGSIDE the real cycle
///    (route A forward + route B backward) — only the trivial pairs are dropped, the real
///    cycle's edges remain.
/// 2. **Keeps both directions of every surviving cycle's edges**, not just the one walking
///    direction recorded in the cycle (which `dedup_bidirectional_pairs` would reduce to).
///    `count_core_edges`/`count_core_regions` pair an edge with its `reverse_edge` to count
///    one physical corridor once — if only one direction is present in `core_edges`, the
///    pairing fails and miscounts E, producing a wrong cycle_count (confirmed on the
///    parallel-corridors fixture: cycle_count came out 0 instead of 1 without this).
/// Also returns the independent GF(2) basis (GitHub issue #284) as nav-edge-index cycles, used
/// as-is by `compute_graph_analytics` for `pure_cycle_basis` — `basis` is already free of
/// trivial reverse-pairs by construction (see `find_all_simple_cycles`'s doc comment), so unlike
/// `cycles` it does not need to go through `drop_trivial_reverse_pairs`. Also returns the fully
/// deduped (`dedup_bidirectional_pairs`, not just `drop_trivial_reverse_pairs`) simple-cycle
/// count, for `GraphAnalytics.simple_cycle_count` — the composite-inclusive count shown to the
/// user alongside the independent `cycle_count`, so the UI can surface how much of the full
/// enumeration is composite noise (see `Specs/graph-analytics.md`'s "Independent Cycle Basis"
/// section). Must use the full dedup, not `drop_trivial_reverse_pairs` alone — the latter keeps
/// a CW and CCW walk of the same physical loop as two separate entries (needed for the
/// Euler-formula core below, point 2), which would double-count every bidirectional cycle in
/// this UI-facing count.
fn cycle_core(nav: &NavGraph) -> Option<(HashSet<NavNodeId>, HashSet<usize>, Vec<Vec<usize>>, usize)> {
    let edges: Vec<&NavEdge> = nav.edges().collect();
    let (cycles, basis) = match find_all_simple_cycles(nav) {
        CycleSearchResult::Cycles { cycles, basis } => (cycles, basis),
        CycleSearchResult::TooManyCycles => return None,
    };
    // Full canonical-key dedup (not just `drop_trivial_reverse_pairs`) — a CW and CCW walk of
    // the same physical loop are two distinct entries in the raw Johnson's output but the same
    // visual loop; `simple_cycle_count` must not double-count them. Computed from a clone before
    // `drop_trivial_reverse_pairs` below, which intentionally keeps both directions of every
    // surviving cycle's edges for the Euler-formula core (see this function's doc comment,
    // point 2) — that's a different list shape than the one this count needs.
    let simple_cycle_count = dedup_bidirectional_pairs(nav, cycles.clone()).len();
    let cycles = drop_trivial_reverse_pairs(nav, cycles);

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

    Some((cyclic_nodes, cyclic_edges, basis, simple_cycle_count))
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
    /// Independent GF(2) cycle basis (GitHub issue #284) — each entry is one basis cycle's
    /// nav-edge indices, in traversal order (same shape as `find_all_simple_cycles`'s `basis`).
    /// `pure_cycle_edge_indices`/`pure_cycle_nav_nodes` stay the full pure-cycle core (every
    /// node/edge on any real cycle) — this field is additive, for consumers that specifically
    /// need concrete independent representatives, not a replacement for the core union.
    /// `cycle_count` (below) is `pure_cycle_basis.len()` by construction, but is kept computed
    /// via the cheaper Euler formula rather than derived from this field — see `compute_cycle_metrics`.
    pub pure_cycle_basis: Vec<Vec<usize>>,
    /// Raw count of all simple cycles found by `find_all_simple_cycles` (post-
    /// `drop_trivial_reverse_pairs`), including every composite cycle — a much larger, less
    /// stable number than `cycle_count` (GitHub issue #284). Surfaced to the UI as "complex
    /// cycles" alongside `cycle_count`'s independent count, so composite noise is visible
    /// rather than silently folded into one number.
    pub simple_cycle_count: usize,
    /// True if cycle enumeration aborted because the graph has too many simple cycles to
    /// enumerate (see `find_all_simple_cycles`'s `MAX_SIMPLE_CYCLES`) — a dense, heavily
    /// preset-connected graph (see issue #22) can exceed this. When `true`, `cycle_count`,
    /// `cycle_region_count`, `pure_cycle_nav_nodes`, `pure_cycle_edge_indices`,
    /// `pure_cycle_basis`, and `simple_cycle_count` are all empty/zero placeholders, not real
    /// results — callers must check this flag before trusting those fields, not infer "no
    /// cycles" from them being empty.
    pub cycle_analysis_overflowed: bool,
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
            pure_cycle_basis: Vec::new(),
            simple_cycle_count: 0,
            cycle_analysis_overflowed: false,
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
/// Cycle metrics are based on the pure-cycle core (see `cycle_core`), not raw SCCs.
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
    // `None` means cycle enumeration overflowed (see `cycle_core`'s doc comment) — surface
    // empty placeholders plus the overflow flag rather than propagating a hang.
    let Some((pure_cycle_nav_nodes, pure_cycle_edge_indices, pure_cycle_basis, simple_cycle_count)) = cycle_core(nav) else {
        return GraphAnalytics {
            node_count: n,
            edge_count,
            cycle_count: 0,
            cycle_region_count: 0,
            pure_cycle_nav_nodes: HashSet::new(),
            pure_cycle_edge_indices: HashSet::new(),
            pure_cycle_basis: Vec::new(),
            simple_cycle_count: 0,
            cycle_analysis_overflowed: true,
        };
    };
    let (cycle_count, cycle_region_count) =
        compute_cycle_metrics(nav, &pure_cycle_nav_nodes, &pure_cycle_edge_indices);

    GraphAnalytics {
        node_count: n,
        edge_count,
        cycle_count,
        cycle_region_count,
        pure_cycle_nav_nodes,
        pure_cycle_edge_indices,
        simple_cycle_count,
        pure_cycle_basis,
        cycle_analysis_overflowed: false,
    }
}

#[cfg(test)]
#[path = "graph_analytics/tests.rs"]
mod tests;
