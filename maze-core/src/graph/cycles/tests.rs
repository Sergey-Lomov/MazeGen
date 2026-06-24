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
    let CycleSearchResult::Cycles(cycles) = find_all_simple_cycles(&nav) else {
        panic!("test fixture unexpectedly exceeded MAX_SIMPLE_CYCLES");
    };
    dedup_bidirectional_pairs(&nav, cycles)
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

    let CycleSearchResult::Cycles(cycles) = find_all_simple_cycles(&nav) else {
        panic!("test fixture unexpectedly exceeded MAX_SIMPLE_CYCLES");
    };
    assert_eq!(cycles.len(), 2, "Johnson's correctly finds both CW and CCW self-loops as distinct directed cycles");

    let deduped = dedup_bidirectional_pairs(&nav, cycles);
    assert_eq!(deduped.len(), 1, "CW/CCW self-loop pair on the same ring is one visual loop");
}

#[test]
fn is_trivial_reverse_pair_true_for_an_edge_immediately_followed_by_its_own_reverse() {
    // A<->B bidirectional corridor with junctions at both ends — each of A, B gets a second
    // spur so they have 3 distinct neighbors (not the symmetric 2-in/2-out a passage node
    // needs), forcing A->B/B->A to stay as their own direct nav-edges instead of being
    // absorbed into a longer corridor through the spurs.
    let mut g = Graph::new();
    for id in 0..6u64 { g.add_node(id); }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic); // A<->B
    g.add_bidirectional_edge(0, 2, EdgeKind::Basic); // spur at A
    g.add_bidirectional_edge(0, 3, EdgeKind::Basic); // second spur at A
    g.add_bidirectional_edge(1, 4, EdgeKind::Basic); // spur at B
    g.add_bidirectional_edge(1, 5, EdgeKind::Basic); // second spur at B

    let nav = build_nav_graph(&g);
    let edges: Vec<_> = nav.edges().collect();
    let a_to_b = edges.iter().position(|e| e.path == vec![0, 1]).expect("A->B nav-edge");
    let b_to_a = edges.iter().position(|e| e.path == vec![1, 0]).expect("B->A nav-edge");

    assert!(is_trivial_reverse_pair(&edges, &[a_to_b, b_to_a]), "A->B->A is just walking the corridor back and forth");
    assert!(is_trivial_reverse_pair(&edges, &[b_to_a, a_to_b]), "B->A->B is the same kind of walk-back, the other direction");
}

#[test]
fn is_trivial_reverse_pair_false_for_a_self_loop() {
    // Pure ring, no junctions — compresses to one nav-node with two self-loop nav-edges
    // (CW/CCW), linked via reverse_edge. A self-loop is a length-1 cycle, never length-2,
    // so it must never be misclassified as a trivial reverse pair.
    let mut g = Graph::new();
    for id in 0..3u64 { g.add_node(id); }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 0, EdgeKind::Basic);

    let nav = build_nav_graph(&g);
    let edges: Vec<_> = nav.edges().collect();
    assert_eq!(edges.len(), 2, "CW + CCW self-loops");

    assert!(!is_trivial_reverse_pair(&edges, &[0]), "length-1 cycle (self-loop) is never a trivial reverse pair");
}

#[test]
fn is_trivial_reverse_pair_false_for_a_genuine_longer_cycle() {
    // A->B->C->A triangle: a 3-edge cycle, length != 2, must never be flagged trivial
    // regardless of any reverse_edge linkage among its edges.
    let g = triangle(0, 1, 2);
    let nav = build_nav_graph(&g);
    let edges: Vec<_> = nav.edges().collect();
    assert_eq!(edges.len(), 3);

    assert!(!is_trivial_reverse_pair(&edges, &[0, 1, 2]), "length-3 cycle is never a trivial reverse pair");
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
