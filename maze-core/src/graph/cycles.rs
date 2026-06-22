use std::collections::HashSet;
use crate::ids::EdgeId;
use super::Graph;
use super::nav::{NavGraph, NavNodeId, NavEdge};

/// Find ALL simple directed cycles in `nav` (Johnson's algorithm, 1975).
/// Returns each cycle as a list of nav-edge indices, in traversal order (needed to splice
/// tile paths in `resolve_to_edge_ids`). No length bound — callers filter the result
/// themselves (see `MinLoopLengthCheck`).
///
/// Self-loop `NavEdge`s (`from == to`) are first-class cycles here, not a special case
/// bolted on top: a self-loop node forms its own SCC of size 1 *with* a cycle (reachable
/// from itself via that edge), unlike a size-1 SCC with no self-loop (no cycle, skipped).
/// Self-loop `NavEdge`s only ever come from `build_ring` (nav/build.rs) representing a real
/// junction-free ring — never a corridor-compression artifact — so a self-loop found here is
/// always a genuine cycle. In practice a junction-free ring is only ever fully bidirectional
/// (one-way-only segments fail the corridor-node criterion and force a junction), so it always
/// produces a CW+CCW self-loop pair linked via `reverse_edge` — a self-loop with no reverse
/// counterpart is not reachable through the current nav-graph builder.
///
/// Johnson's itself produces no duplicates: each simple directed cycle is visited exactly
/// once (a property of the blocking mechanism, not something to clean up after the fact).
/// If the graph has both directions of a bidirectional corridor (nav-edge u->v and a
/// separate nav-edge v->u, linked via `reverse_edge`), Johnson's correctly returns BOTH as
/// distinct simple cycles ([u->v->u] and [v->u->v]) — that is the directed-correct result,
/// not an error. Collapsing such a pair into "one visual loop" is a deliberate domain-level
/// step applied AFTER this function (see `dedup_bidirectional_pairs`), not part of the
/// algorithm itself.
pub(crate) fn find_all_simple_cycles(nav: &NavGraph) -> Vec<Vec<usize>> {
    let edges: Vec<&NavEdge> = nav.edges().collect();
    let n = nav.nodes.len();
    if n == 0 {
        return Vec::new();
    }

    // adjacency[node] = list of (edge_idx, to)
    let mut adjacency: Vec<Vec<(usize, NavNodeId)>> = vec![Vec::new(); n];
    for (idx, edge) in edges.iter().enumerate() {
        adjacency[edge.from].push((idx, edge.to));
    }

    let mut cycles: Vec<Vec<usize>> = Vec::new();
    let mut remaining: HashSet<NavNodeId> = (0..n).collect();

    while !remaining.is_empty() {
        let sccs = strongly_connected_components(&adjacency, &remaining);

        // Smallest-index nontrivial SCC first (deterministic order); also handles
        // self-loop size-1 SCCs and drops size-1-no-self-loop SCCs from `remaining`.
        let Some(scc) = sccs.iter()
            .filter(|scc| is_nontrivial(scc, &adjacency))
            .min_by_key(|scc| *scc.iter().min().unwrap())
        else {
            break; // no SCC has any cycle left
        };

        let start = *scc.iter().min().unwrap();
        let scc_set: HashSet<NavNodeId> = scc.iter().copied().collect();

        if scc_set.len() == 1 {
            // Self-loop: every edge start->start within this trivial SCC is its own cycle.
            for &(idx, to) in &adjacency[start] {
                if to == start {
                    cycles.push(vec![idx]);
                }
            }
        } else {
            let mut blocked: HashSet<NavNodeId> = HashSet::new();
            let mut block_map: std::collections::HashMap<NavNodeId, HashSet<NavNodeId>> = std::collections::HashMap::new();
            let mut path_nodes: Vec<NavNodeId> = vec![start];
            let mut path_edges: Vec<usize> = Vec::new();
            blocked.insert(start);

            johnson_circuit(
                start, start, &adjacency, &scc_set,
                &mut blocked, &mut block_map, &mut path_nodes, &mut path_edges, &mut cycles,
            );
        }

        remaining.remove(&start);
    }

    cycles
}

/// True if `scc` can contain a cycle: size > 1, or size == 1 with a self-loop edge.
fn is_nontrivial(scc: &[NavNodeId], adjacency: &[Vec<(usize, NavNodeId)>]) -> bool {
    if scc.len() > 1 {
        return true;
    }
    let node = scc[0];
    adjacency[node].iter().any(|&(_, to)| to == node)
}

/// Johnson's blocking DFS: find all simple cycles from `start` back to `start`, restricted
/// to nodes in `scc_set` (the current SCC), updating `cycles` directly.
///
/// Deliberately does NOT forbid walking straight back via an edge's own `reverse_edge`
/// (e.g. B->C->B through a corridor's forward+reverse edge pair) — doing that inside this
/// DFS breaks the blocking invariant: a node whose only path back to `start` happens to be
/// the forbidden reverse edge gets marked "no cycle found" and stays blocked, which then
/// hides genuinely different longer cycles through that same node (confirmed by a bowtie
/// fixture regression: B->D->C->B disappeared because C got blocked while only resolving
/// the trivial B->C->B case). Johnson's itself is correct and complete only when every
/// directed edge is eligible; trivial reverse-pair 2-cycles are filtered separately, after
/// the full correct result is in hand (see `find_all_simple_cycles` doc comment).
#[allow(clippy::too_many_arguments)]
fn johnson_circuit(
    start: NavNodeId,
    v: NavNodeId,
    adjacency: &[Vec<(usize, NavNodeId)>],
    scc_set: &HashSet<NavNodeId>,
    blocked: &mut HashSet<NavNodeId>,
    block_map: &mut std::collections::HashMap<NavNodeId, HashSet<NavNodeId>>,
    path_nodes: &mut Vec<NavNodeId>,
    path_edges: &mut Vec<usize>,
    cycles: &mut Vec<Vec<usize>>,
) -> bool {
    let mut found_cycle = false;

    for &(edge_idx, w) in &adjacency[v] {
        if !scc_set.contains(&w) {
            continue;
        }
        if w == start {
            path_edges.push(edge_idx);
            cycles.push(path_edges.clone());
            path_edges.pop();
            found_cycle = true;
        } else if !blocked.contains(&w) {
            blocked.insert(w);
            path_nodes.push(w);
            path_edges.push(edge_idx);

            let got_cycle = johnson_circuit(
                start, w, adjacency, scc_set, blocked, block_map, path_nodes, path_edges, cycles,
            );
            found_cycle |= got_cycle;

            path_edges.pop();
            path_nodes.pop();

            if got_cycle {
                unblock(w, blocked, block_map);
            } else {
                block_map.entry(v).or_default().insert(w);
            }
        }
    }

    if found_cycle {
        unblock(v, blocked, block_map);
    }

    found_cycle
}

fn unblock(
    node: NavNodeId,
    blocked: &mut HashSet<NavNodeId>,
    block_map: &mut std::collections::HashMap<NavNodeId, HashSet<NavNodeId>>,
) {
    blocked.remove(&node);
    if let Some(dependents) = block_map.remove(&node) {
        for dep in dependents {
            if blocked.contains(&dep) {
                unblock(dep, blocked, block_map);
            }
        }
    }
}

/// Tarjan's SCC, restricted to `nodes` (a subset of the full nav-graph, shrinking as
/// `find_all_simple_cycles` consumes start vertices). Iterative to avoid stack overflow.
fn strongly_connected_components(
    adjacency: &[Vec<(usize, NavNodeId)>],
    nodes: &HashSet<NavNodeId>,
) -> Vec<Vec<NavNodeId>> {
    struct State {
        index: usize,
        lowlink: usize,
    }

    let mut index_counter = 0usize;
    let mut stack: Vec<NavNodeId> = Vec::new();
    let mut on_stack: HashSet<NavNodeId> = HashSet::new();
    let mut state: std::collections::HashMap<NavNodeId, State> = std::collections::HashMap::new();
    let mut components: Vec<Vec<NavNodeId>> = Vec::new();
    // work frame: (node, next neighbor index)
    let mut work: Vec<(NavNodeId, usize)> = Vec::new();

    let mut sorted_nodes: Vec<NavNodeId> = nodes.iter().copied().collect();
    sorted_nodes.sort_unstable();

    for &root in &sorted_nodes {
        if state.contains_key(&root) {
            continue;
        }
        state.insert(root, State { index: index_counter, lowlink: index_counter });
        index_counter += 1;
        stack.push(root);
        on_stack.insert(root);
        work.push((root, 0));

        while !work.is_empty() {
            let (v, ni) = *work.last().unwrap();
            let neighbors: Vec<NavNodeId> = adjacency[v].iter()
                .map(|&(_, to)| to)
                .filter(|to| nodes.contains(to))
                .collect();

            if ni < neighbors.len() {
                work.last_mut().unwrap().1 += 1;
                let w = neighbors[ni];
                if !state.contains_key(&w) {
                    state.insert(w, State { index: index_counter, lowlink: index_counter });
                    index_counter += 1;
                    stack.push(w);
                    on_stack.insert(w);
                    work.push((w, 0));
                } else if on_stack.contains(&w) {
                    let idx_w = state[&w].index;
                    let s_v = state.get_mut(&v).unwrap();
                    s_v.lowlink = s_v.lowlink.min(idx_w);
                }
            } else {
                let is_root = state[&v].lowlink == state[&v].index;
                if is_root {
                    let mut component = Vec::new();
                    loop {
                        let w = stack.pop().unwrap();
                        on_stack.remove(&w);
                        component.push(w);
                        if w == v {
                            break;
                        }
                    }
                    components.push(component);
                }
                work.pop();
                if let Some(&(parent, _)) = work.last() {
                    let ll_v = state[&v].lowlink;
                    let s_parent = state.get_mut(&parent).unwrap();
                    s_parent.lowlink = s_parent.lowlink.min(ll_v);
                }
            }
        }
    }

    components
}

/// Canonical undirected index for dedup: the lower of an edge's own index and its
/// `reverse_edge`'s, so a bidirectional corridor's forward and backward edge always
/// map to the same value regardless of which one a cycle happened to use. Applies equally
/// to self-loop CW/CCW pairs (linked via `reverse_edge` by the same path-reversal mechanism
/// `link_reverse_edges` uses for ordinary corridors — no special case needed).
fn canonical_index(edge: &NavEdge, idx: usize) -> usize {
    match edge.reverse_edge {
        Some(rev) => idx.min(rev),
        None => idx,
    }
}

/// True for a 2-edge cycle that is just an edge immediately followed by its own
/// `reverse_edge` (e.g. B->C->B via a bidirectional corridor's forward+reverse pair). Not a
/// real loop — just stepping into a corridor and immediately returning the way you came.
/// Johnson's correctly finds this as a valid simple cycle (no repeated vertex), so it is
/// excluded here as a deliberate domain-level rule, not an algorithm bug — see the
/// `johnson_circuit` doc comment for why this can't be forbidden inside the DFS itself.
fn is_trivial_reverse_pair(edges: &[&NavEdge], cycle: &[usize]) -> bool {
    cycle.len() == 2 && edges[cycle[0]].reverse_edge == Some(cycle[1])
}

/// Drop only the trivial reverse-pair 2-cycles (see `is_trivial_reverse_pair`) — no
/// canonical-index dedup. Used by `cycle_core` (`graph_analytics.rs`), which needs BOTH
/// directions of every edge in a genuine cycle (for the Euler formula) but must still
/// exclude a dead-end spur's "walk out and back" turn-around from counting as a cycle.
pub(crate) fn drop_trivial_reverse_pairs(nav: &NavGraph, cycles: Vec<Vec<usize>>) -> Vec<Vec<usize>> {
    let edges: Vec<&NavEdge> = nav.edges().collect();
    cycles.into_iter().filter(|cycle| !is_trivial_reverse_pair(&edges, cycle)).collect()
}

/// Collapse cycles that are the same physical loop walked in opposite directions via
/// `reverse_edge` pairs (ordinary bidirectional corridors, or a self-loop CW/CCW pair on
/// the same nav-node) into one entry. A cycle using at least one one-way edge keeps its own
/// distinct key (no reverse to fold into) — genuinely different directed cycles stay separate.
/// Also drops trivial reverse-pair 2-cycles (see `is_trivial_reverse_pair`).
pub(crate) fn dedup_bidirectional_pairs(nav: &NavGraph, cycles: Vec<Vec<usize>>) -> Vec<Vec<usize>> {
    let edges: Vec<&NavEdge> = nav.edges().collect();
    let mut seen: HashSet<Vec<usize>> = HashSet::new();
    let mut result: Vec<Vec<usize>> = Vec::new();

    for cycle in cycles {
        if is_trivial_reverse_pair(&edges, &cycle) {
            continue;
        }
        let mut key: Vec<usize> = cycle.iter().map(|&i| canonical_index(edges[i], i)).collect();
        key.sort_unstable();
        if seen.insert(key) {
            result.push(cycle);
        }
    }

    result
}

/// Expand each cycle's nav-edge indices into the full tile-path, splice consecutive
/// segments without duplicating junction tiles, and resolve each tile-hop to a base
/// Graph::EdgeId via `graph.edge_between`. One entry per input cycle; a tile-hop with
/// no matching base edge is skipped (should not happen for a valid nav graph — defensive only).
pub(crate) fn resolve_to_edge_ids(
    nav: &NavGraph,
    nav_cycles: &[Vec<usize>],
    graph: &Graph,
) -> Vec<Vec<EdgeId>> {
    nav_cycles.iter().map(|nav_cycle| {
        let mut tiles: Vec<u64> = Vec::new();
        for &e_idx in nav_cycle {
            let edge = nav.edge_by_idx(e_idx);
            if tiles.is_empty() {
                tiles.extend(edge.path.iter().copied());
            } else {
                tiles.extend(edge.path[1..].iter().copied());
            }
        }
        tiles.windows(2)
            .filter_map(|pair| graph.edge_between(pair[0], pair[1]))
            .collect()
    }).collect()
}

#[cfg(test)]
#[path = "cycles/tests.rs"]
mod tests;
