use super::*;
use crate::graph::{Graph, EdgeKind};
use crate::graph::nav::build_nav_graph;

fn triangle(a: u64, b: u64, c: u64) -> Graph {
    let mut g = Graph::new();
    for id in [a, b, c] { g.add_node(id); }
    g.add_edge(a, b, EdgeKind::Basic);
    g.add_edge(b, c, EdgeKind::Basic);
    g.add_edge(c, a, EdgeKind::Basic);
    g
}

fn all_cycles(g: &Graph) -> Vec<Vec<usize>> {
    let nav = build_nav_graph(g);
    let CycleSearchResult::Cycles { cycles, .. } = find_all_simple_cycles(&nav) else {
        panic!("test fixture unexpectedly exceeded MAX_SIMPLE_CYCLES");
    };
    dedup_bidirectional_pairs(&nav, cycles)
}

/// Basis-only counterpart of `all_cycles` — reads the `basis` field directly, no dedup applied
/// (basis is already free of trivial reverse-pairs and CW/CCW duplicates by construction, see
/// `find_all_simple_cycles`'s doc comment).
fn basis_cycles(g: &Graph) -> Vec<Vec<usize>> {
    let nav = build_nav_graph(g);
    let CycleSearchResult::Cycles { basis, .. } = find_all_simple_cycles(&nav) else {
        panic!("test fixture unexpectedly exceeded MAX_SIMPLE_CYCLES");
    };
    basis
}

#[test]
fn finds_simple_cycle() {
    let g = triangle(0, 1, 2);
    let nav = build_nav_graph(&g);
    let cycles = all_cycles(&g);
    assert_eq!(cycles.len(), 1);

    let edge_ids = resolve_to_edge_ids(&nav, &cycles, &g);
    assert_eq!(edge_ids.len(), 1);
    assert_eq!(edge_ids[0].len(), 3);
    let unique: HashSet<_> = edge_ids[0].iter().collect();
    assert_eq!(unique.len(), 3, "no duplicate EdgeId within one cycle");
}

#[test]
fn same_cycle_found_from_different_starting_edges_dedups_to_one() {
    // Square cycle 0->1->2->3->0 — Johnson's naturally finds it once regardless of which
    // node ends up as the SCC's chosen start.
    let mut g = Graph::new();
    for id in 0..4u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 3, EdgeKind::Basic);
    g.add_edge(3, 0, EdgeKind::Basic);

    let cycles = all_cycles(&g);
    assert_eq!(cycles.len(), 1);
    assert_eq!(cycles[0].len(), 4);
}

#[test]
fn two_independent_cycles_both_found_without_duplicates() {
    let mut g = Graph::new();
    for id in 0..6u64 { g.add_node(id); }
    for &(a, b) in &[(0,1),(1,2),(2,0)] { g.add_edge(a, b, EdgeKind::Basic); }
    for &(a, b) in &[(3,4),(4,5),(5,3)] { g.add_edge(a, b, EdgeKind::Basic); }

    let cycles = all_cycles(&g);
    assert_eq!(cycles.len(), 2);
}

#[test]
fn bowtie_graph_finds_all_distinct_simple_cycles() {
    // Bowtie: A->B->C->A and B->D->C->B, sharing the B<->C reverse pair.
    let mut g = Graph::new();
    for id in 0..4u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic); // A->B
    g.add_edge(1, 2, EdgeKind::Basic); // B->C
    g.add_edge(2, 0, EdgeKind::Basic); // C->A
    g.add_edge(1, 3, EdgeKind::Basic); // B->D
    g.add_edge(3, 2, EdgeKind::Basic); // D->C
    g.add_edge(2, 1, EdgeKind::Basic); // C->B

    let nav = build_nav_graph(&g);
    let cycles = all_cycles(&g);
    // 3 real loops exist in this bowtie: A->B->C->A, B->D->C->B, and the longer
    // A->B->D->C->A route. The B<->C reverse pair on its own is just walking the
    // same corridor back and forth, not a real loop — excluded by dedup.
    assert_eq!(cycles.len(), 3);

    let edge_ids = resolve_to_edge_ids(&nav, &cycles, &g);
    for cycle in &edge_ids {
        let unique: HashSet<_> = cycle.iter().collect();
        assert_eq!(unique.len(), cycle.len(), "no duplicate EdgeId within one cycle");
    }
}

#[test]
fn bidirectional_cycle_walked_both_ways_collapses_to_one_entry() {
    // Square loop where all four corners (0,1,2,3) are junctions (each has a spur
    // to a leaf node). Forward and backward traversal of the loop are the same visual
    // loop and must not be reported as two separate cycles.
    let mut g = Graph::new();
    for id in 0..8u64 { g.add_node(id); }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 3, EdgeKind::Basic);
    g.add_bidirectional_edge(3, 0, EdgeKind::Basic);
    g.add_bidirectional_edge(0, 4, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 5, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 6, EdgeKind::Basic);
    g.add_bidirectional_edge(3, 7, EdgeKind::Basic);

    let cycles = all_cycles(&g);
    assert_eq!(cycles.len(), 1, "forward and backward traversal of an all-bidirectional loop must dedup to one entry");
}

#[test]
fn finds_cycle_of_length_8_with_junction() {
    // Reproduces the original bug report shape: octagon loop with two junctions
    // (spurs at node 0 and node 4) splitting it into two 4-tile corridor segments.
    let mut g = Graph::new();
    for id in 0..10u64 { g.add_node(id); }
    for i in 0..8u64 {
        g.add_bidirectional_edge(i, (i + 1) % 8, EdgeKind::Basic);
    }
    g.add_bidirectional_edge(0, 8, EdgeKind::Basic);
    g.add_bidirectional_edge(4, 9, EdgeKind::Basic);

    let cycles = all_cycles(&g);
    assert_eq!(cycles.len(), 1);
}

#[test]
fn finds_cycle_of_length_8_with_single_junction_self_loop_ring() {
    // Same octagon, but with only ONE junction (spur at node 0) — the whole ring
    // compresses into a single self-loop NavEdge. This is the original bug: such
    // rings used to be invisible to cycle detection entirely.
    let mut g = Graph::new();
    for id in 0..9u64 { g.add_node(id); }
    for i in 0..8u64 {
        g.add_bidirectional_edge(i, (i + 1) % 8, EdgeKind::Basic);
    }
    g.add_bidirectional_edge(0, 8, EdgeKind::Basic);

    let cycles = all_cycles(&g);
    assert_eq!(cycles.len(), 1, "single-junction ring (self-loop nav-edge) must be found as a cycle");
}

#[test]
fn bidirectional_self_loop_ring_cw_ccw_dedups_to_one_cycle() {
    // Pure ring, no junctions, all edges bidirectional — compresses to a single nav-node
    // with two self-loop nav-edges (CW and CCW), linked via reverse_edge. Must dedup to 1.
    let mut g = Graph::new();
    for id in 0..3u64 { g.add_node(id); }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 0, EdgeKind::Basic);

    let nav = build_nav_graph(&g);
    assert_eq!(nav.nodes.len(), 1, "pure bidirectional ring with no junction compresses to one nav-node");

    let CycleSearchResult::Cycles { cycles, basis } = find_all_simple_cycles(&nav) else {
        panic!("test fixture unexpectedly exceeded MAX_SIMPLE_CYCLES");
    };
    assert_eq!(cycles.len(), 2, "Johnson's correctly finds both CW and CCW self-loops as distinct directed cycles");
    assert_eq!(basis.len(), 1, "CW/CCW self-loop pair is one canonical edge — GF(2) basis must not double-count it");

    let deduped = dedup_bidirectional_pairs(&nav, cycles);
    assert_eq!(deduped.len(), 1, "CW/CCW self-loop pair on the same ring is one visual loop");
}

#[test]
fn empty_graph_yields_no_cycles() {
    let g = Graph::new();
    let cycles = all_cycles(&g);
    assert!(cycles.is_empty());
}

#[test]
fn linear_chain_has_no_cycles() {
    let mut g = Graph::new();
    for id in 0..3u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    let cycles = all_cycles(&g);
    assert!(cycles.is_empty());
}

#[test]
fn dense_grid_completes_quickly_and_reports_observed_cycle_count() {
    // A 5x5 grid, all edges bidirectional — every junction has up to 4 neighbors. Dense
    // enough that the number of simple cycles grows quickly with grid size; this test
    // exists to observe the actual magnitude on a realistic-ish maze topology before it
    // surfaces as a surprise on a real dense maze config, not to assert a specific count.
    const SIDE: u64 = 5;
    let mut g = Graph::new();
    for id in 0..(SIDE * SIDE) { g.add_node(id); }
    for row in 0..SIDE {
        for col in 0..SIDE {
            let id = row * SIDE + col;
            if col + 1 < SIDE {
                g.add_bidirectional_edge(id, id + 1, EdgeKind::Basic);
            }
            if row + 1 < SIDE {
                g.add_bidirectional_edge(id, id + SIDE, EdgeKind::Basic);
            }
        }
    }

    let start = std::time::Instant::now();
    let cycles = all_cycles(&g);
    let elapsed = start.elapsed();

    println!(
        "dense 5x5 grid: {} distinct simple cycles found in {:?}",
        cycles.len(), elapsed
    );
    // Exact count, not a wall-clock budget: a wall-clock assertion is flaky on slow CI and
    // insensitive to a moderate regression (e.g. a 2x slowdown wouldn't trip a 5s timeout on
    // this small a grid). The cycle count is deterministic for this fixed graph — any change
    // signals either a correctness regression or a deliberate algorithm change, either of
    // which should be investigated explicitly rather than silently passing under a timeout.
    assert_eq!(cycles.len(), 9349, "deterministic count for this fixed 5x5 grid — investigate any change");
}

#[test]
fn dense_grid_exceeding_max_simple_cycles_aborts_instead_of_hanging() {
    // A 6x6 fully-bidirectional grid has 2,444,782 simple cycles (measured) — far past
    // MAX_SIMPLE_CYCLES (20_000). This is the regression test for issue #22 (full hang on a
    // 7x7 fully-preset grid): enumeration must abort with TooManyCycles well before exhausting
    // the search, not run to completion or hang. Using 6x6 here, not 7x7, keeps the test itself
    // fast — the abort path is hit quickly regardless of how astronomically large the
    // unbounded count would eventually be.
    const SIDE: u64 = 6;
    let mut g = Graph::new();
    for id in 0..(SIDE * SIDE) { g.add_node(id); }
    for row in 0..SIDE {
        for col in 0..SIDE {
            let id = row * SIDE + col;
            if col + 1 < SIDE { g.add_bidirectional_edge(id, id + 1, EdgeKind::Basic); }
            if row + 1 < SIDE { g.add_bidirectional_edge(id, id + SIDE, EdgeKind::Basic); }
        }
    }
    let nav = build_nav_graph(&g);

    let start = std::time::Instant::now();
    let result = find_all_simple_cycles(&nav);
    let elapsed = start.elapsed();

    assert!(matches!(result, CycleSearchResult::TooManyCycles), "must abort, not enumerate all 2.4M cycles");
    assert!(elapsed.as_secs() < 5, "abort must happen quickly, not after a near-complete enumeration: {elapsed:?}");
}

#[test]
fn many_independent_small_sccs_all_found() {
    // Chain of N independent directed triangles: (0,1,2), (3,4,5), ... Each is its own SCC,
    // consumed one per outer-loop iteration -> N outer-loop iterations. Regression guard for
    // issue #25 (incremental SCC update): this shape is the worst case for the old
    // full-graph-Tarjan-per-iteration approach (N full O(V+E) reruns over a shrinking V) and
    // was measured at 12.8s before the fix vs ~0.2s after (release build) — not asserted here
    // as a wall-clock bound (flaky on slow CI), just the correctness of the result under the
    // new incremental-SCC outer loop.
    const TRIANGLES: u64 = 4000;
    let mut g = Graph::new();
    for id in 0..(TRIANGLES * 3) { g.add_node(id); }
    for t in 0..TRIANGLES {
        let base = t * 3;
        g.add_edge(base, base + 1, EdgeKind::Basic);
        g.add_edge(base + 1, base + 2, EdgeKind::Basic);
        g.add_edge(base + 2, base, EdgeKind::Basic);
    }
    let cycles = all_cycles(&g);
    assert_eq!(cycles.len(), TRIANGLES as usize);
}

// GitHub issue #284: GF(2) independent cycle basis, built incrementally alongside Johnson's.

#[test]
fn basis_of_single_triangle_is_the_one_cycle() {
    let g = triangle(0, 1, 2);
    let basis = basis_cycles(&g);
    assert_eq!(basis.len(), 1);
}

#[test]
fn basis_of_triangle_with_dangling_bidirectional_vertical_passage_is_the_one_cycle() {
    // Triangle 0-1-2 (real cycle) plus a bidirectional VerticalPassage dangling off vertex 0 to
    // an otherwise-isolated node 3 — a there-and-back dead end must contribute zero rank, same as
    // a dangling Basic edge would (GitHub issue #369 follow-up: vertical passages were observed
    // each counting as their own independent cycle).
    let g = triangle(0, 1, 2);
    let mut g = g;
    g.add_node(3);
    g.add_edge(0, 3, EdgeKind::VerticalPassage);
    g.add_edge(3, 0, EdgeKind::VerticalPassage);

    let basis = basis_cycles(&g);
    assert_eq!(basis.len(), 1, "dangling bidirectional VerticalPassage must not count as an independent cycle");
}

#[test]
fn basis_of_triangle_plus_vertical_corridor_chain_is_the_one_cycle() {
    // Triangle 0-1-2 (real cycle) plus a 3-floor vertical corridor hanging off vertex 0:
    // 0 <-> 3 <-> 4 (bidirectional VerticalPassage each hop). Node 3 has exactly 2 in/2 out
    // (one pair to 0, one pair to 4) so it is corridor-compressible, folding 0->3->4 and
    // 4->3->0 into two multi-hop nav edges spanning floors -- must still cost zero rank.
    let g = triangle(0, 1, 2);
    let mut g = g;
    g.add_node(3);
    g.add_node(4);
    g.add_edge(0, 3, EdgeKind::VerticalPassage);
    g.add_edge(3, 0, EdgeKind::VerticalPassage);
    g.add_edge(3, 4, EdgeKind::VerticalPassage);
    g.add_edge(4, 3, EdgeKind::VerticalPassage);

    let basis = basis_cycles(&g);
    assert_eq!(basis.len(), 1, "dangling bidirectional vertical corridor chain must not count as an independent cycle");
}

#[test]
fn basis_of_two_disjoint_triangles_is_both() {
    let mut g = Graph::new();
    for id in 0..6u64 { g.add_node(id); }
    for &(a, b) in &[(0,1),(1,2),(2,0)] { g.add_edge(a, b, EdgeKind::Basic); }
    for &(a, b) in &[(3,4),(4,5),(5,3)] { g.add_edge(a, b, EdgeKind::Basic); }

    let basis = basis_cycles(&g);
    assert_eq!(basis.len(), 2, "two independent SCCs, each contributing its own 1-cycle basis");
}

/// Two triangles sharing one vertex, each walked in a consistent rotational direction through
/// the shared vertex (0->1->2->0 and 2->3->4->2) — both directed 3-cycles route through node 2
/// in the SAME direction (arriving via 1->2, leaving via 2->3/2->0), so Johnson's can also walk
/// them as one 6-edge composite directed cycle: 0->1->2->3->4->2->0 is NOT simple (node 2
/// repeats) — but 0->1->2->3->4->... only closes back to 0 by reusing 2, so no simple composite
/// exists in this exact wiring. Bowtie composites need the shared vertex only once per simple
/// cycle; see `bowtie_graph_finds_all_distinct_simple_cycles` for a topology where a genuine
/// longer composite route does exist (via a bidirectional shared edge, not a shared vertex).
fn shared_vertex_triangles() -> Graph {
    let mut g = Graph::new();
    for id in 0..5u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);
    g.add_edge(2, 3, EdgeKind::Basic);
    g.add_edge(3, 4, EdgeKind::Basic);
    g.add_edge(4, 2, EdgeKind::Basic);
    g
}

#[test]
fn basis_of_shared_vertex_triangles_is_both_triangles() {
    let g = shared_vertex_triangles();
    let basis = basis_cycles(&g);
    assert_eq!(basis.len(), 2, "two independent triangles sharing one vertex, no linear dependence between them");
    assert!(basis.iter().all(|c| c.len() == 3), "each basis member is a 3-edge triangle");
}

/// Bowtie fixture (see `bowtie_graph_finds_all_distinct_simple_cycles`) has 3 simple cycles —
/// A->B->C->A, B->D->C->B, and A->B->D->C->A (the longer composite route) — spanning a rank-2
/// GF(2) space (any 2 are a linear combination of the third: their canonical edge-sets XOR to
/// zero). The basis is exactly 2 of these 3 — which 2 depends on traversal order, not
/// necessarily the two 3-edge triangles specifically (greedy insertion is order-dependent by
/// design, see `find_all_simple_cycles`'s doc comment) — but it must never contain all 3.
#[test]
fn basis_of_bowtie_is_exactly_two_of_the_three_cycles() {
    let mut g = Graph::new();
    for id in 0..4u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic); // A->B
    g.add_edge(1, 2, EdgeKind::Basic); // B->C
    g.add_edge(2, 0, EdgeKind::Basic); // C->A
    g.add_edge(1, 3, EdgeKind::Basic); // B->D
    g.add_edge(3, 2, EdgeKind::Basic); // D->C
    g.add_edge(2, 1, EdgeKind::Basic); // C->B

    let all = all_cycles(&g);
    assert_eq!(all.len(), 3, "sanity check: 2 short loops + 1 longer composite route (see bowtie test above)");

    let basis = basis_cycles(&g);
    assert_eq!(basis.len(), 2, "rank-2 space (Euler: E_canonical=5, V=4, C=1 -> 5-4+1=2) — basis must never contain all 3 linearly-dependent cycles");
}

#[test]
fn basis_early_exit_does_not_shrink_the_full_cycle_list() {
    // A 5x5 fully-bidirectional grid has thousands of simple cycles but a small Euler-formula
    // independent count — this fixture is dense enough to trigger the per-SCC early-exit
    // (basis target reached well before all simple cycles are enumerated). `cycles` must still
    // contain every simple cycle Johnson's finds — early-exit only skips elimination bookkeeping,
    // never the search itself (see `find_all_simple_cycles`'s doc comment).
    const SIDE: u64 = 5;
    let mut g = Graph::new();
    for id in 0..(SIDE * SIDE) { g.add_node(id); }
    for row in 0..SIDE {
        for col in 0..SIDE {
            let id = row * SIDE + col;
            if col + 1 < SIDE { g.add_bidirectional_edge(id, id + 1, EdgeKind::Basic); }
            if row + 1 < SIDE { g.add_bidirectional_edge(id, id + SIDE, EdgeKind::Basic); }
        }
    }
    let nav = build_nav_graph(&g);
    let CycleSearchResult::Cycles { cycles, basis } = find_all_simple_cycles(&nav) else {
        panic!("test fixture unexpectedly exceeded MAX_SIMPLE_CYCLES");
    };
    // Deterministic pinning for this fixed 5x5 grid — mirrors
    // `dense_grid_completes_quickly_and_reports_observed_cycle_count`'s own pinned constant
    // (9349, post-dedup); this is the raw pre-dedup count basis construction runs alongside.
    // 18698, not 18734: `johnson_circuit` no longer records a trivial "walk out and back"
    // 2-cycle (one per bidirectional edge — 40 of them here) as its own `cycles` entry (GitHub
    // issue #369 follow-up) — a post-hoc filter used to discard these downstream, so this is the
    // same real cycle set, just without ever materializing the trivial ones as a side effect of
    // early-exit no longer being their only reason to survive.
    // Any further change signals either a correctness regression or a deliberate algorithm change.
    assert_eq!(cycles.len(), 18698, "raw pre-dedup cycle count (minus trivial reverse-pairs, never materialized) must be unaffected by early-exit — investigate any change");
    // Euler formula for this single-SCC grid: E - V + 1, E counting each bidirectional
    // corridor once (undirected pairs, matching the basis' own canonical-index bit universe).
    let e_canonical = 2 * SIDE as usize * (SIDE as usize - 1);
    let expected_basis_size = e_canonical + 1 - (SIDE * SIDE) as usize;
    assert_eq!(basis.len(), expected_basis_size, "basis size must equal the exact Euler-formula independent count");
}

// GitHub issue #410: elevator fans are wired fully-connected (every stop pair gets a two-way
// edge), which is combinatorially rich in simple cycles on its own even though every hop through
// it is the same instantaneous jump. `johnson_circuit` now forbids using more than one edge of the
// same elevator fan per simple cycle, cutting that blowup before enumeration instead of filtering
// it out afterward.

#[test]
fn elevator_fan_alone_contributes_no_simple_cycles() {
    // 4-stop fully-connected elevator fan (K_4, all edges Elevator-kind) and nothing else --
    // every fan-internal cycle must be excluded now, not just filtered post-hoc.
    let mut g = Graph::new();
    for id in 0..4u64 { g.add_node(id); }
    for a in 0..4u64 {
        for b in 0..4u64 {
            if a != b {
                g.add_edge(a, b, EdgeKind::Elevator);
            }
        }
    }
    let cycles = all_cycles(&g);
    assert!(cycles.is_empty(), "a fan on its own must contribute zero simple cycles");
}

#[test]
fn mixed_cycle_using_two_edges_of_the_same_elevator_fan_is_excluded() {
    // Triangle-shaped detour that would need TWO edges of the same 3-stop elevator fan to close
    // (0->1 via elevator, 1->2 via a Basic detour edge, 2->0 via elevator again) -- forbidden:
    // both elevator hops belong to the same fan, so this is not a genuine mixed detour.
    let mut g = Graph::new();
    for id in 0..3u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Elevator);
    g.add_edge(1, 0, EdgeKind::Elevator);
    g.add_edge(1, 2, EdgeKind::Elevator);
    g.add_edge(2, 1, EdgeKind::Elevator);
    g.add_edge(2, 0, EdgeKind::Elevator);
    g.add_edge(0, 2, EdgeKind::Elevator);
    g.add_edge(1, 2, EdgeKind::Basic); // parallel Basic detour edge alongside the elevator one

    let cycles = all_cycles(&g);
    for cycle in &cycles {
        let nav = build_nav_graph(&g);
        let elevator_hops = cycle.iter().filter(|&&idx| nav.edge_by_idx(idx).is_elevator).count();
        assert!(elevator_hops <= 1, "no simple cycle may use more than one edge of the same elevator fan");
    }
}

#[test]
fn mixed_detour_through_two_different_stops_of_the_same_elevator_is_still_found() {
    // A genuine detour: enter the fan via one elevator hop (0->1), leave via a non-elevator edge
    // (1->2), and return to 0 via another non-elevator edge (2->0) -- only ONE elevator edge is
    // used, so this must still be found as a real cycle, not swept away by the same-fan filter.
    let mut g = Graph::new();
    for id in 0..3u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Elevator);
    g.add_edge(1, 0, EdgeKind::Elevator);
    g.add_edge(1, 2, EdgeKind::Elevator);
    g.add_edge(2, 1, EdgeKind::Elevator);
    g.add_edge(0, 2, EdgeKind::Elevator);
    g.add_edge(2, 0, EdgeKind::Elevator);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);

    let cycles = all_cycles(&g);
    let nav = build_nav_graph(&g);
    let has_mixed_detour = cycles.iter().any(|cycle| {
        let elevator_hops = cycle.iter().filter(|&&idx| nav.edge_by_idx(idx).is_elevator).count();
        let basic_hops = cycle.iter().filter(|&&idx| !nav.edge_by_idx(idx).is_elevator).count();
        elevator_hops == 1 && basic_hops > 0
    });
    assert!(has_mixed_detour, "a detour using exactly one elevator hop plus other edge kinds must still be found");
}

#[test]
fn too_many_cycles_yields_no_partial_basis() {
    const SIDE: u64 = 6;
    let mut g = Graph::new();
    for id in 0..(SIDE * SIDE) { g.add_node(id); }
    for row in 0..SIDE {
        for col in 0..SIDE {
            let id = row * SIDE + col;
            if col + 1 < SIDE { g.add_bidirectional_edge(id, id + 1, EdgeKind::Basic); }
            if row + 1 < SIDE { g.add_bidirectional_edge(id, id + SIDE, EdgeKind::Basic); }
        }
    }
    let nav = build_nav_graph(&g);
    assert!(matches!(find_all_simple_cycles(&nav), CycleSearchResult::TooManyCycles));
}
