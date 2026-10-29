use super::Graph;
use super::gf2_basis::{GF2Basis, set_bit};
use super::nav::{NavEdge, NavGraph, NavNodeId};
use crate::dsu::Dsu;
use crate::ids::EdgeId;
use std::collections::{HashMap, HashSet};

/// Result of `find_all_simple_cycles`: either the full list of simple cycles plus the
/// independent GF(2) basis derived incrementally alongside it (see `GF2Basis`), or a signal
/// that enumeration was aborted because it exceeded `MAX_SIMPLE_CYCLES` — see that constant's
/// doc comment for why this exists.
///
/// `basis` is a subset of `cycles`' own raw traversal-order `Vec<usize>` values (cloned, not
/// indices into `cycles`) — deliberately not index-based, so any later filtering of `cycles`
/// never needs an index remap; `basis` can be filtered independently by the same predicate
/// when needed, or (see GitHub issue #284) simply used as-is where it is already known to be
/// free of what that filter would drop.
pub(crate) enum CycleSearchResult {
    Cycles {
        cycles: Vec<Vec<usize>>,
        basis: Vec<Vec<usize>>,
    },
    TooManyCycles,
}

/// Hard cap on the number of simple cycles `find_all_simple_cycles` will enumerate before
/// aborting. The number of simple cycles in a dense graph grows combinatorially with size —
/// confirmed by measurement: a 5x5 fully-bidirectional grid yields 9349 *deduped* cycles (the
/// raw, pre-dedup count this bound is checked against is higher — CW/CCW reverse-pairs count
/// separately before `dedup_bidirectional_pairs` collapses them), a 6x6 grid yields 2,444,782
/// (in 3.4s, release build), and a 7x7 fully-preset grid was observed to hang outright (issue
/// #22). This is not a realistic maze topology (mazes are sparse by construction) but a
/// fully-preset edit-mode grid can reach it, so enumeration must bail out rather than run
/// unbounded. 20,000 comfortably covers the 5x5 raw count (so that topology still gets full
/// analytics) while aborting well before the 6x6 regime, where a single call already takes
/// seconds.
const MAX_SIMPLE_CYCLES: usize = 20_000;

/// Offers `cycle` to the running GF(2) basis, skipping the check entirely once `*basis_count`
/// has already reached `basis_target` (the early-exit — see `find_all_simple_cycles`'s doc
/// comment for why this is provably safe). On success (`cycle` independent of everything
/// inserted so far), clones `cycle` into `basis` and increments `*basis_count`. Shared by both
/// places `find_all_simple_cycles` pushes a newly found cycle (the self-loop branch and
/// `johnson_circuit`'s cycle-found branch) so the insertion logic exists in exactly one place.
#[allow(clippy::too_many_arguments)]
fn offer_to_basis(
    cycle: &[usize],
    edges: &[&NavEdge],
    words_per_row: usize,
    basis_target: usize,
    basis_gf2: &mut GF2Basis,
    basis_count: &mut usize,
    basis: &mut Vec<Vec<usize>>,
) {
    if *basis_count >= basis_target {
        return;
    }
    let bits = set_bit(
        words_per_row,
        cycle.iter().map(|&i| canonical_index(edges[i], i)),
    );
    if basis_gf2.try_insert(bits) {
        basis.push(cycle.to_vec());
        *basis_count += 1;
    }
}

/// Find ALL simple directed cycles in `nav` (Johnson's algorithm, 1975), or `TooManyCycles` if
/// enumeration exceeds `MAX_SIMPLE_CYCLES` (see its doc comment) — callers must handle both
/// outcomes; there is no length bound or per-consumer variant otherwise. Returns each cycle as
/// a list of nav-edge indices, in traversal order (needed to splice tile paths in
/// `resolve_to_edge_ids`). No length bound on individual cycles — callers filter the result
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
pub(crate) fn find_all_simple_cycles(nav: &NavGraph) -> CycleSearchResult {
    let edges: Vec<&NavEdge> = nav.edges().collect();
    let n = nav.nodes.len();
    if n == 0 {
        return CycleSearchResult::Cycles {
            cycles: Vec::new(),
            basis: Vec::new(),
        };
    }

    // adjacency[node] = list of (edge_idx, to)
    let mut adjacency: Vec<Vec<(usize, NavNodeId)>> = vec![Vec::new(); n];
    for (idx, edge) in edges.iter().enumerate() {
        adjacency[edge.from].push((idx, edge.to));
    }

    let (elevator_groups, elevator_group_count) = elevator_edge_groups(&edges, n);

    let mut cycles: Vec<Vec<usize>> = Vec::new();
    let mut basis: Vec<Vec<usize>> = Vec::new();
    let words_per_row = edges.len().div_ceil(64).max(1);
    let mut remaining: HashSet<NavNodeId> = (0..n).collect();

    // Reused across every `strongly_connected_components` call in this function (GitHub issue
    // #415 perf follow-up) — same rationale as `scc_mask`/`blocked`/`block_map` below: the outer
    // loop calls it up to O(n) times, and fresh n-sized `Vec`s every call was O(n^2) total.
    let mut scc_scratch = SccScratch::new(n);

    // Maintained incrementally across iterations instead of a full Tarjan rerun on every
    // outer-loop step (see issue #25 / `Specs/graph-analytics.md` complexity section).
    // Removing a single vertex can only split the SCC it belonged to — every other SCC is
    // unaffected, since a path between two nodes in different SCCs never routes through a
    // third SCC's interior (otherwise they'd already be one SCC) — so only the affected
    // SCC's subgraph needs re-running through Tarjan, not the whole remaining graph.
    let mut sccs = strongly_connected_components(&adjacency, &remaining, &mut scc_scratch);

    // GF(2) basis over the canonical (undirected) edge universe (see `canonical_index`) — ONE
    // instance for the whole call, with a target rank computed ONCE up front from the initial
    // SCC decomposition (before the outer loop consumes any vertex). Critical: when the outer
    // loop consumes a start vertex, the remaining SCC(s) it splits into still share the *same*
    // underlying cycle space as the original (pre-split) SCC — a fragment's own Euler-formula
    // rank, computed from ITS OWN (already-shrunk) vertex/edge counts, is not additively
    // meaningful on top of what was already found in the parent SCC before the split: the
    // fragment excludes `start` and every edge incident to it, but a cycle already recorded in
    // the parent may have used those same excluded edges — so the fragment's local rank
    // double-counts dimensions the parent's cycles already spanned (confirmed by a
    // bowtie-graph regression: summing 2 + 1 fragment targets falsely allowed a 3rd, dependent
    // cycle into a true rank-2 space). The only correct target is the WHOLE graph's rank,
    // known in full before any vertex is consumed — computed here from the initial `sccs`.
    let global_basis_target: usize = sccs
        .iter()
        .filter(|scc| is_nontrivial(scc, &adjacency))
        .map(|scc| {
            let scc_set: HashSet<NavNodeId> = scc.iter().copied().collect();
            let mut e_canonical: HashSet<usize> = HashSet::new();
            for &node in &scc_set {
                for &(idx, to) in &adjacency[node] {
                    if scc_set.contains(&to) {
                        e_canonical.insert(canonical_index(edges[idx], idx));
                    }
                }
            }
            (e_canonical.len() + 1).saturating_sub(scc_set.len())
        })
        .sum();
    let mut global_basis = GF2Basis::new(edges.len());
    let mut global_basis_count = 0usize;

    // Reused across outer-loop iterations instead of `vec![false; n]`/`vec![HashSet::new(); n]`
    // per iteration (GitHub issue #415 perf follow-up): the outer loop can run up to O(n)
    // iterations (one per consumed start vertex, per the SCC-splitting comment above), and each
    // iteration's `johnson_circuit` call only ever touches nodes inside the current (often much
    // smaller than n) SCC — allocating fresh n-sized buffers every iteration was O(n) work per
    // iteration (O(n^2) total) even though `HashSet`/`HashMap` versions cost O(1) to create.
    // Cleared after use by walking just `scc_set` (`O(|scc|)`), not the full `n`-sized buffer.
    let mut scc_mask: Vec<bool> = vec![false; n];
    let mut blocked: Vec<bool> = vec![false; n];
    let mut block_map: Vec<HashSet<NavNodeId>> = vec![HashSet::new(); n];
    let mut path_elevator_groups: Vec<bool> = vec![false; elevator_group_count];

    while !remaining.is_empty() {
        // Smallest-index nontrivial SCC first (deterministic order); also handles
        // self-loop size-1 SCCs and drops size-1-no-self-loop SCCs from `remaining`.
        let Some((scc_pos, _)) = sccs
            .iter()
            .enumerate()
            .filter(|(_, scc)| is_nontrivial(scc, &adjacency))
            .min_by_key(|(_, scc)| *scc.iter().min().unwrap())
        else {
            break; // no SCC has any cycle left
        };

        let scc = &sccs[scc_pos];
        let start = *scc.iter().min().unwrap();
        let scc_set: HashSet<NavNodeId> = scc.iter().copied().collect();

        if scc_set.len() == 1 {
            // Self-loop: every edge start->start within this trivial SCC is its own cycle.
            for &(idx, to) in &adjacency[start] {
                if to == start {
                    let cycle = vec![idx];
                    offer_to_basis(
                        &cycle,
                        &edges,
                        words_per_row,
                        global_basis_target,
                        &mut global_basis,
                        &mut global_basis_count,
                        &mut basis,
                    );
                    cycles.push(cycle);
                }
            }
        } else {
            for &node in &scc_set {
                scc_mask[node] = true;
            }
            let mut path_nodes: Vec<NavNodeId> = vec![start];
            let mut path_edges: Vec<usize> = Vec::new();
            blocked[start] = true;

            // Return value (`None` on abort) is intentionally not consumed here: the
            // `cycles.len() > MAX_SIMPLE_CYCLES` check right below catches the same abort
            // condition (johnson_circuit only ever returns `None` after pushing past that
            // bound), so re-checking it from the return value would be redundant.
            johnson_circuit(
                start,
                start,
                &adjacency,
                &scc_mask,
                &mut blocked,
                &mut block_map,
                &mut path_nodes,
                &mut path_edges,
                &mut cycles,
                &edges,
                words_per_row,
                global_basis_target,
                &mut global_basis,
                &mut global_basis_count,
                &mut basis,
                &elevator_groups,
                &mut path_elevator_groups,
            );

            // Reset just the touched entries (`O(|scc|)`) instead of reallocating the buffers
            // next iteration — `johnson_circuit` never touches a node outside `scc_set` (see
            // `scc_mask`'s eligibility check), so this fully restores the "fresh" invariant the
            // next SCC's call relies on. Explicit reset is required, not optional: Johnson's own
            // blocking invariant deliberately leaves a node `blocked` when no cycle was ever
            // found through it (see `johnson_circuit`'s doc comment) — `unblock` only clears
            // nodes that led to a found cycle, so a dead-end branch of this SCC can still be
            // `blocked`/have stale `block_map` entries when the top-level call returns.
            for &node in &scc_set {
                scc_mask[node] = false;
                blocked[node] = false;
                block_map[node].clear();
            }
            // `path_elevator_groups` is already fully unwound by `johnson_circuit`'s own
            // recursion (every `path_elevator_groups[g] = true` it sets is paired with `= false`
            // on the way back out, per `group_newly_inserted`), so this reset is defensive only,
            // not load-bearing — but cheap and keeps the invariant obvious without relying on
            // that recursive symmetry never changing.
            for &node in &scc_set {
                for &(edge_idx, _) in &adjacency[node] {
                    if let Some(group) = elevator_groups[edge_idx] {
                        path_elevator_groups[group] = false;
                    }
                }
            }
        }

        if cycles.len() > MAX_SIMPLE_CYCLES {
            return CycleSearchResult::TooManyCycles;
        }

        remaining.remove(&start);

        // Replace just the consumed SCC with the (possibly several) SCCs it splits into
        // after removing `start` — every other entry in `sccs` is left untouched, since
        // removing `start` cannot affect a node outside its own SCC.
        let mut remainder_set = scc_set;
        remainder_set.remove(&start);
        let split_sccs =
            strongly_connected_components(&adjacency, &remainder_set, &mut scc_scratch);
        sccs.swap_remove(scc_pos);
        sccs.extend(split_sccs);
    }

    CycleSearchResult::Cycles { cycles, basis }
}

/// Per nav-edge, the elevator group it belongs to (`Dsu` root over nav-node ids reached via
/// `is_elevator` edges), or `None` for a non-elevator edge. `Elevator` fans are wired as fully-
/// connected two-way stop clusters (`AddElevatorStrategy`, `elevator_core`'s own convention), so
/// this is a plain connected-components pass over `is_elevator` edges — same idea as
/// `elevator_core::elevator_groups`, but keyed on `NavNodeId`/nav-edge index rather than the base
/// graph's `NodeId`/`EdgeId`, since that's the id space `find_all_simple_cycles` searches in.
/// Used by `johnson_circuit` to forbid a simple cycle from using more than one edge of the same
/// elevator fan (GitHub issue #410) — a fan's combinatorial K_N cycle count is cut at the source
/// (a fan can contribute at most one hop per cycle) instead of being enumerated and filtered out
/// afterward by `cycle_core`'s all-elevator-edges check.
///
/// Group ids returned here are densely packed (`0..group_count`, the second return value), not
/// raw `Dsu` roots (which are themselves `NavNodeId`s and therefore sparse over the group space)
/// — `johnson_circuit`'s `path_elevator_groups` indexes a `Vec<bool>` by this id, so it needs a
/// compact range, not sparse root values.
fn elevator_edge_groups(edges: &[&NavEdge], n: usize) -> (Vec<Option<usize>>, usize) {
    let mut dsu = Dsu::new(n);
    for edge in edges {
        if edge.is_elevator {
            dsu.union_by_size(edge.from, edge.to);
        }
    }
    let mut dense_id: HashMap<NavNodeId, usize> = HashMap::new();
    let groups = edges
        .iter()
        .map(|edge| {
            edge.is_elevator.then(|| {
                let root = dsu.find(edge.from);
                let next_id = dense_id.len();
                *dense_id.entry(root).or_insert(next_id)
            })
        })
        .collect();
    (groups, dense_id.len())
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
/// to nodes in `scc_set` (the current SCC), updating `cycles` directly. Returns `None` if the
/// search was aborted because `cycles.len()` exceeded `MAX_SIMPLE_CYCLES`, otherwise
/// `Some(found_cycle)` — `find_all_simple_cycles` checks the same bound after each SCC and
/// converts to `TooManyCycles`, but that outer check alone would let a single pathologically
/// dense SCC run unbounded before control ever returns to it; checking here too bounds the
/// worst case to "a bit over the limit," not "however long this one SCC takes."
///
/// Abort (`None`) is kept structurally distinct from "no cycle found through this branch"
/// (`Some(false)`): on abort, every still-open stack frame propagates `None` immediately
/// without touching `block_map`, instead of folding the abort into `found_cycle` and letting
/// callers wrongly record "no cycle, stay blocked" for a branch that was never actually
/// resolved. That distinction is moot today — the whole `cycles` result is discarded on
/// `TooManyCycles` regardless of `block_map`'s state — but keeping it means that stays true
/// even if a future caller ever wants a partial result instead of discarding everything.
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
/// `edges`/`words_per_row`/`basis_target`/`scc_basis`/`scc_basis_count`/`basis` thread through
/// the incremental GF(2) basis construction (GitHub issue #284) — every cycle this function
/// pushes to `cycles` is also offered to `scc_basis` (via a canonical-index bit-vector, see
/// `GF2Basis`) until `scc_basis_count` reaches `basis_target`, after which insertion is skipped
/// for the rest of this SCC (see `find_all_simple_cycles`'s early-exit comment — provably safe,
/// not an approximation).
///
/// `elevator_groups`/`path_elevator_groups` forbid a simple cycle from using more than one edge
/// of the same elevator fan (GitHub issue #410): an `Elevator` fan is wired fully-connected (every
/// stop pair gets a two-way edge), so it is combinatorially rich in simple cycles on its own even
/// though every hop through it is the same instantaneous elevator jump — only a cycle mixing an
/// elevator hop with other edge kinds is a real detour. Skipping a neighbor whose edge belongs to
/// an elevator group already used earlier in `path_edges` cuts that blowup at the source, before
/// Johnson's even walks into it, rather than enumerating it and filtering afterward (`cycle_core`).
/// Applied as a plain eligibility filter on candidate edges (like the existing `scc_set` check
/// right below), not a change to blocking/unblocking bookkeeping — `found_cycle`/`blocked`/
/// `block_map` are untouched by it, so it cannot desync Johnson's own invariant the way forbidding
/// a `reverse_edge` step would (see this function's doc comment above).
#[allow(clippy::too_many_arguments)]
fn johnson_circuit(
    start: NavNodeId,
    v: NavNodeId,
    adjacency: &[Vec<(usize, NavNodeId)>],
    scc_mask: &[bool],
    blocked: &mut [bool],
    block_map: &mut [HashSet<NavNodeId>],
    path_nodes: &mut Vec<NavNodeId>,
    path_edges: &mut Vec<usize>,
    cycles: &mut Vec<Vec<usize>>,
    edges: &[&NavEdge],
    words_per_row: usize,
    basis_target: usize,
    scc_basis: &mut GF2Basis,
    scc_basis_count: &mut usize,
    basis: &mut Vec<Vec<usize>>,
    elevator_groups: &[Option<usize>],
    path_elevator_groups: &mut [bool],
) -> Option<bool> {
    let mut found_cycle = false;
    // The trivial "walk out and back" 2-cycle (an edge immediately followed by its own
    // `reverse_edge` — not a real loop, just stepping into a corridor and immediately returning
    // the way you came) closes over `path_edges`'s FIRST edge specifically (`v == start` on this
    // call), not the most recently used one — Johnson's would otherwise find exactly one such
    // pair per bidirectional edge in the graph, ballooning `cycles` toward `MAX_SIMPLE_CYCLES` on
    // any reasonably sized maze. Skipping only this one case (rather than any `reverse_edge` step
    // anywhere in the path) is provably safe and cannot perturb Johnson's own blocking/unblocking
    // bookkeeping for any OTHER edge, since it only ever discards this exact 2-edge cycle — every
    // longer route, including ones that reuse a `reverse_edge` pair mid-path (e.g. the bowtie's
    // B->D->C->B), is unaffected.
    let first_edge = path_edges.first().copied();

    for &(edge_idx, w) in &adjacency[v] {
        if cycles.len() > MAX_SIMPLE_CYCLES {
            return None;
        }
        if !scc_mask[w] {
            continue;
        }
        // A second edge of an already-used elevator fan is never eligible for this path,
        // regardless of where in `path_edges` the fan's first edge sits — not just the most
        // recent one — since a cycle mixing two hops through the same fan is still just that
        // one fan's instantaneous jump, not a genuine detour (see this function's doc comment).
        if let Some(group) = elevator_groups[edge_idx]
            && path_elevator_groups[group]
        {
            continue;
        }
        if w == start {
            // Still a real closing move for Johnson's own blocking bookkeeping (`found_cycle`
            // must reflect it, or `v`/`w`'s block state desyncs and hides later genuine cycles —
            // see this function's doc comment on the bowtie regression), just never recorded in
            // `cycles`/offered to the basis: a trivial "walk out and back" 2-cycle is not a real
            // loop and would otherwise flood `cycles` with one entry per bidirectional edge in
            // the graph.
            let is_trivial = path_edges.len() == 1
                && first_edge.and_then(|e| edges[e].reverse_edge) == Some(edge_idx);
            if !is_trivial {
                path_edges.push(edge_idx);
                offer_to_basis(
                    path_edges,
                    edges,
                    words_per_row,
                    basis_target,
                    scc_basis,
                    scc_basis_count,
                    basis,
                );
                cycles.push(path_edges.clone());
                path_edges.pop();
            }
            found_cycle = true;
        } else if !blocked[w] {
            blocked[w] = true;
            path_nodes.push(w);
            path_edges.push(edge_idx);
            let group = elevator_groups[edge_idx];
            let group_newly_inserted = group.is_some_and(|g| {
                let was_unused = !path_elevator_groups[g];
                path_elevator_groups[g] = true;
                was_unused
            });

            let result = johnson_circuit(
                start,
                w,
                adjacency,
                scc_mask,
                blocked,
                block_map,
                path_nodes,
                path_edges,
                cycles,
                edges,
                words_per_row,
                basis_target,
                scc_basis,
                scc_basis_count,
                basis,
                elevator_groups,
                path_elevator_groups,
            );

            if group_newly_inserted {
                path_elevator_groups[group.unwrap()] = false;
            }
            path_edges.pop();
            path_nodes.pop();

            let got_cycle = result?;
            found_cycle |= got_cycle;

            if got_cycle {
                unblock(w, blocked, block_map);
            } else {
                block_map[v].insert(w);
            }
        }
    }

    if found_cycle {
        unblock(v, blocked, block_map);
    }

    Some(found_cycle)
}

/// Recursive, unlike `strongly_connected_components` (explicitly iterative to avoid stack
/// overflow). Recursion depth here is bounded by the length of the `block_map` dependency
/// chain, which cannot exceed `V` (nav-node count) — on realistic maze sizes (hundreds to a
/// few thousand nav-nodes) this is far below Rust's default stack limit. `johnson_circuit`'s
/// own recursion is bounded the same way, by simple-cycle length (also `<= V`). Left
/// recursive rather than rewritten iteratively to avoid risking the blocking invariant on a
/// theoretical-only risk — see issue #24 if pathologically deep graphs ever become a concern.
fn unblock(node: NavNodeId, blocked: &mut [bool], block_map: &mut [HashSet<NavNodeId>]) {
    blocked[node] = false;
    let dependents = std::mem::take(&mut block_map[node]);
    for dep in dependents {
        if blocked[dep] {
            unblock(dep, blocked, block_map);
        }
    }
}

/// Per-node scratch buffers for `strongly_connected_components`, owned by `find_all_simple_cycles`
/// and reused across its repeated calls (GitHub issue #415 perf follow-up) — without this, each
/// call allocated fresh `n`-sized (whole nav-graph) vectors even though it is invoked once per
/// outer-loop iteration (up to O(n) times) on a `nodes` subset that shrinks as vertices are
/// consumed, making allocation alone O(n^2) across a call. `state`/`on_stack`/`neighbor_cache`
/// are `Vec`s indexed directly by the dense `NavNodeId` (0..n) space, not `HashMap`/`HashSet`, to
/// avoid hashing on the hottest per-node lookups (same rationale as `blocked`/`block_map` in
/// `johnson_circuit`). Reset to empty by `strongly_connected_components` itself before returning,
/// touching only the nodes it actually visited (`O(|nodes|)`), not the full `n`-sized buffer.
struct SccScratch {
    on_stack: Vec<bool>,
    state: Vec<Option<TarjanState>>,
    neighbor_cache: Vec<Option<Vec<NavNodeId>>>,
}

struct TarjanState {
    index: usize,
    lowlink: usize,
}

impl SccScratch {
    fn new(n: usize) -> Self {
        Self {
            on_stack: vec![false; n],
            state: (0..n).map(|_| None).collect(),
            neighbor_cache: (0..n).map(|_| None).collect(),
        }
    }
}

/// Tarjan's SCC, restricted to `nodes` (a subset of the full nav-graph, shrinking as
/// `find_all_simple_cycles` consumes start vertices). Iterative to avoid stack overflow.
fn strongly_connected_components(
    adjacency: &[Vec<(usize, NavNodeId)>],
    nodes: &HashSet<NavNodeId>,
    scratch: &mut SccScratch,
) -> Vec<Vec<NavNodeId>> {
    let SccScratch {
        on_stack,
        state,
        neighbor_cache,
    } = scratch;

    let mut index_counter = 0usize;
    let mut stack: Vec<NavNodeId> = Vec::new();
    let mut components: Vec<Vec<NavNodeId>> = Vec::new();
    // work frame: (node, next neighbor index)
    let mut work: Vec<(NavNodeId, usize)> = Vec::new();

    let mut sorted_nodes: Vec<NavNodeId> = nodes.iter().copied().collect();
    sorted_nodes.sort_unstable();

    for &root in &sorted_nodes {
        if state[root].is_some() {
            continue;
        }
        state[root] = Some(TarjanState {
            index: index_counter,
            lowlink: index_counter,
        });
        index_counter += 1;
        stack.push(root);
        on_stack[root] = true;
        work.push((root, 0));

        while !work.is_empty() {
            let (v, ni) = *work.last().unwrap();
            let neighbors = neighbor_cache[v].get_or_insert_with(|| {
                adjacency[v]
                    .iter()
                    .map(|&(_, to)| to)
                    .filter(|to| nodes.contains(to))
                    .collect()
            });

            if ni < neighbors.len() {
                work.last_mut().unwrap().1 += 1;
                let w = neighbors[ni];
                if state[w].is_none() {
                    state[w] = Some(TarjanState {
                        index: index_counter,
                        lowlink: index_counter,
                    });
                    index_counter += 1;
                    stack.push(w);
                    on_stack[w] = true;
                    work.push((w, 0));
                } else if on_stack[w] {
                    let idx_w = state[w].as_ref().unwrap().index;
                    let s_v = state[v].as_mut().unwrap();
                    s_v.lowlink = s_v.lowlink.min(idx_w);
                }
            } else {
                let is_root = {
                    let s_v = state[v].as_ref().unwrap();
                    s_v.lowlink == s_v.index
                };
                if is_root {
                    let mut component = Vec::new();
                    loop {
                        let w = stack.pop().unwrap();
                        on_stack[w] = false;
                        component.push(w);
                        if w == v {
                            break;
                        }
                    }
                    components.push(component);
                }
                work.pop();
                if let Some(&(parent, _)) = work.last() {
                    let ll_v = state[v].as_ref().unwrap().lowlink;
                    let s_parent = state[parent].as_mut().unwrap();
                    s_parent.lowlink = s_parent.lowlink.min(ll_v);
                }
            }
        }
    }

    // Reset just the visited nodes (`O(|nodes|)`) so `scratch` is fresh for the caller's next
    // `strongly_connected_components` call — every node in `nodes` is guaranteed visited above
    // (the outer `for &root in &sorted_nodes` loop starts a fresh Tarjan walk from any node not
    // already visited, covering disconnected components too), and `on_stack` is already back to
    // all-`false` by construction (every push is matched by a pop before `work` empties).
    for &node in &sorted_nodes {
        state[node] = None;
        neighbor_cache[node] = None;
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

/// Combines `find_all_simple_cycles` + `dedup_bidirectional_pairs`, the pair every loop-based
/// QC check (`MinLoopsCountCheck`, `MinLoopLengthCheck`, `MaxLoopLengthCheck`, etc.) needs
/// before doing its own filtering. Returns `None` on `CycleSearchResult::TooManyCycles` — callers
/// must silently skip (no issue raised) rather than fail, same rationale as `MinLoopLengthCheck`
/// (issue #22); `CYCLE_ANALYSIS_OVERFLOWED` (raised independently by `build_analytics_snapshot`)
/// already surfaces the overflow to the UI, so skipping here does not hide it.
pub(crate) fn find_deduped_simple_cycles(nav: &NavGraph) -> Option<Vec<Vec<usize>>> {
    match find_all_simple_cycles(nav) {
        CycleSearchResult::Cycles { cycles, .. } => Some(dedup_bidirectional_pairs(nav, cycles)),
        CycleSearchResult::TooManyCycles => None,
    }
}

/// Collapse cycles that are the same physical loop walked in opposite directions via
/// `reverse_edge` pairs (ordinary bidirectional corridors, or a self-loop CW/CCW pair on
/// the same nav-node) into one entry. A cycle using at least one one-way edge keeps its own
/// distinct key (no reverse to fold into) — genuinely different directed cycles stay separate.
pub(crate) fn dedup_bidirectional_pairs(
    nav: &NavGraph,
    cycles: Vec<Vec<usize>>,
) -> Vec<Vec<usize>> {
    let edges: Vec<&NavEdge> = nav.edges().collect();
    let mut seen: HashSet<Vec<usize>> = HashSet::new();
    let mut result: Vec<Vec<usize>> = Vec::new();

    for cycle in cycles {
        let mut key: Vec<usize> = cycle
            .iter()
            .map(|&i| canonical_index(edges[i], i))
            .collect();
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
    nav_cycles
        .iter()
        .map(|nav_cycle| {
            let mut tiles: Vec<u64> = Vec::new();
            for &e_idx in nav_cycle {
                let edge = nav.edge_by_idx(e_idx);
                if tiles.is_empty() {
                    tiles.extend(edge.path.iter().copied());
                } else {
                    tiles.extend(edge.path[1..].iter().copied());
                }
            }
            tiles
                .windows(2)
                .filter_map(|pair| graph.edge_between(pair[0], pair[1]))
                .collect()
        })
        .collect()
}

/// True (unrounded) density per 100 field cells — GitHub issue #265: density/ratio thresholds are
/// `f64` now, so the metric itself compares exactly against a fractional threshold instead of
/// rounding to the nearest integer first (the old integer version silently passed a threshold a
/// true density was actually fractionally past, e.g. 30.9% rounding to 30 and clearing a maximum
/// of 30). Shared by every `*_density`/`*_ratio` check.
pub(crate) fn density_per_100(cells: usize, field_cells: usize) -> f64 {
    cells as f64 * 100.0 / field_cells as f64
}

/// Count over the allowed share of one region (whole maze or one floor): `count` minus the
/// `max_density` (per 100 cells) target rounded to the nearest whole count; `0` when the density
/// is within `max_density`. Rounding can push the target above `count` on a small field, so the
/// subtraction saturates at `0`. Shared by `MaxElevatorDensityCheck`, `MaxSplitDensityCheck` and
/// `MaxTeleportDensityCheck`.
pub(crate) fn rounded_excess_over_density(
    count: usize,
    field_cells: usize,
    max_density: f64,
) -> u32 {
    if field_cells == 0 || density_per_100(count, field_cells) <= max_density {
        return 0;
    }
    let target_count = (max_density * field_cells as f64 / 100.0).round() as usize;
    count.saturating_sub(target_count) as u32
}

#[cfg(test)]
#[path = "cycles/tests.rs"]
mod tests;
