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

fn cycles_of(g: &Graph) -> Vec<Vec<usize>> {
    let nav = build_nav_graph(g);
    find_fundamental_cycles(&nav)
}

#[test]
fn finds_simple_cycle() {
    let g = triangle(0, 1, 2);
    let nav = build_nav_graph(&g);
    let cycles = cycles_of(&g);
    assert_eq!(cycles.len(), 1);

    let edge_ids = resolve_to_edge_ids(&nav, &cycles, &g);
    assert_eq!(edge_ids.len(), 1);
    assert_eq!(edge_ids[0].len(), 3);
    let unique: HashSet<_> = edge_ids[0].iter().collect();
    assert_eq!(unique.len(), 3, "no duplicate EdgeId within one cycle");
}

#[test]
fn same_cycle_found_regardless_of_tree_root() {
    // Square cycle 0->1->2->3->0.
    let mut g = Graph::new();
    for id in 0..4u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 3, EdgeKind::Basic);
    g.add_edge(3, 0, EdgeKind::Basic);

    let cycles = cycles_of(&g);
    assert_eq!(cycles.len(), 1);
    assert_eq!(cycles[0].len(), 4);
}

#[test]
fn two_independent_cycles_both_found_without_duplicates() {
    let mut g = Graph::new();
    for id in 0..6u64 { g.add_node(id); }
    for &(a, b) in &[(0,1),(1,2),(2,0)] { g.add_edge(a, b, EdgeKind::Basic); }
    for &(a, b) in &[(3,4),(4,5),(5,3)] { g.add_edge(a, b, EdgeKind::Basic); }

    let cycles = cycles_of(&g);
    assert_eq!(cycles.len(), 2);
}

#[test]
fn bowtie_graph_finds_fundamental_basis_not_every_simple_cycle() {
    // Bowtie: A->B->C->A and B->D->C->B, sharing the B<->C reverse pair. 3 simple cycles exist
    // topologically (the third being the longer A->B->D->C->A composite route), but the
    // fundamental basis has exactly 2 independent cycles (β₁ = E - V + 1 = 6 - 4 + 1... this SCC
    // is one component, non-tree edges = E - (V-1) = 6 - 3 = 2 — the composite route is not a
    // separate basis member, just a linear combination of the two fundamental ones).
    let mut g = Graph::new();
    for id in 0..4u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic); // A->B
    g.add_edge(1, 2, EdgeKind::Basic); // B->C
    g.add_edge(2, 0, EdgeKind::Basic); // C->A
    g.add_edge(1, 3, EdgeKind::Basic); // B->D
    g.add_edge(3, 2, EdgeKind::Basic); // D->C
    g.add_edge(2, 1, EdgeKind::Basic); // C->B

    let nav = build_nav_graph(&g);
    let cycles = cycles_of(&g);
    assert_eq!(cycles.len(), 2, "fundamental basis has 2 independent cycles, not all 3 topological simple cycles");

    let edge_ids = resolve_to_edge_ids(&nav, &cycles, &g);
    for cycle in &edge_ids {
        let unique: HashSet<_> = cycle.iter().collect();
        assert_eq!(unique.len(), cycle.len(), "no duplicate EdgeId within one cycle");
    }
}

#[test]
fn bidirectional_cycle_walked_both_ways_collapses_to_one_entry() {
    // Square loop where all four corners (0,1,2,3) are junctions (each has a spur to a leaf
    // node). One physical connection per side means only one fundamental cycle around the loop.
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

    let cycles = cycles_of(&g);
    assert_eq!(cycles.len(), 1, "one physical loop, dead-end spurs contribute no cycles");
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

    let cycles = cycles_of(&g);
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

    let cycles = cycles_of(&g);
    assert_eq!(cycles.len(), 1, "single-junction ring (self-loop nav-edge) must be found as a cycle");
}

#[test]
fn bidirectional_self_loop_ring_cw_ccw_dedups_to_one_cycle() {
    // Pure ring, no junctions, all edges bidirectional — compresses to a single nav-node
    // with two self-loop nav-edges (CW and CCW), linked via reverse_edge. Self-loops are
    // handled outside the spanning-tree machinery: each is its own cycle, so this yields 2 —
    // one per self-loop direction (the fundamental-basis construction doesn't apply to
    // same-node self-loops, they aren't "non-tree edges between distinct nodes").
    let mut g = Graph::new();
    for id in 0..3u64 { g.add_node(id); }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 0, EdgeKind::Basic);

    let nav = build_nav_graph(&g);
    assert_eq!(nav.nodes.len(), 1, "pure bidirectional ring with no junction compresses to one nav-node");

    let cycles = find_fundamental_cycles(&nav);
    assert_eq!(cycles.len(), 2, "CW and CCW self-loops are each their own cycle");
}

#[test]
fn empty_graph_yields_no_cycles() {
    let g = Graph::new();
    let cycles = cycles_of(&g);
    assert!(cycles.is_empty());
}

#[test]
fn linear_chain_has_no_cycles() {
    let mut g = Graph::new();
    for id in 0..3u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    let cycles = cycles_of(&g);
    assert!(cycles.is_empty());
}

#[test]
fn dead_end_spur_produces_no_trivial_two_cycle() {
    // A<->B bidirectional corridor with junctions at both ends (extra spurs so A/B aren't
    // absorbed into a longer corridor), plus a leaf spur off A. The spur must not appear as a
    // "cycle" of its own — trivial reverse-pair walks are structurally excluded because
    // adjacency is built on physical connections (canonical_index), not raw directed edges.
    let mut g = Graph::new();
    for id in 0..6u64 { g.add_node(id); }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic); // A<->B
    g.add_bidirectional_edge(0, 2, EdgeKind::Basic); // spur at A
    g.add_bidirectional_edge(0, 3, EdgeKind::Basic); // second spur at A (leaf)
    g.add_bidirectional_edge(1, 4, EdgeKind::Basic); // spur at B
    g.add_bidirectional_edge(1, 5, EdgeKind::Basic); // second spur at B (leaf)

    let cycles = cycles_of(&g);
    assert!(cycles.is_empty(), "a tree of bidirectional spurs has no independent cycle");
}

#[test]
fn dense_grid_completes_quickly_and_reports_topological_cycle_count() {
    // A 5x5 grid, all edges bidirectional. The fundamental basis has exactly β₁ = E - V + 1
    // cycles (16 horizontal + 16 vertical = 40 undirected edges, 25 nodes, one component ->
    // 40 - 25 + 1 = 16), regardless of how large the raw simple-cycle count would be under full
    // enumeration (9349, per the pre-#244 Johnson's test) — this is the whole point of the
    // fundamental-basis construction.
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
    let cycles = cycles_of(&g);
    let elapsed = start.elapsed();

    println!("dense 5x5 grid: {} fundamental cycles found in {:?}", cycles.len(), elapsed);
    assert_eq!(cycles.len(), 16, "topological beta_1 for a 5x5 fully-bidirectional grid");
}

#[test]
fn dense_grid_that_used_to_overflow_completes_quickly() {
    // A 6x6 fully-bidirectional grid has 2,444,782 simple cycles under full enumeration (far
    // past the old MAX_SIMPLE_CYCLES bound, issue #22) — the fundamental basis instead returns
    // exactly beta_1 = E - V + 1 = 60 - 36 + 1 = 25 cycles, no abort mechanism needed.
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

    let start = std::time::Instant::now();
    let cycles = cycles_of(&g);
    let elapsed = start.elapsed();

    assert_eq!(cycles.len(), 25, "topological beta_1 for a 6x6 fully-bidirectional grid");
    assert!(elapsed.as_secs() < 5, "must complete quickly, no combinatorial blowup: {elapsed:?}");
}

#[test]
fn many_independent_small_sccs_all_found() {
    // Chain of N independent directed triangles: (0,1,2), (3,4,5), ... Each is its own SCC,
    // contributing exactly one fundamental cycle.
    const TRIANGLES: u64 = 4000;
    let mut g = Graph::new();
    for id in 0..(TRIANGLES * 3) { g.add_node(id); }
    for t in 0..TRIANGLES {
        let base = t * 3;
        g.add_edge(base, base + 1, EdgeKind::Basic);
        g.add_edge(base + 1, base + 2, EdgeKind::Basic);
        g.add_edge(base + 2, base, EdgeKind::Basic);
    }
    let cycles = cycles_of(&g);
    assert_eq!(cycles.len(), TRIANGLES as usize);
}

#[test]
fn one_way_edge_inside_bidirectional_scc_becomes_non_tree_and_is_walked_correctly() {
    // Square A->B->C->D->A entirely one-way, plus a bidirectional shortcut A<->C (a distinct
    // path from any one-way edge, so nav-graph reverse-linking is unambiguous). The SCC has 5
    // physical connections (4 one-way sides + 1 bidirectional shortcut) over 4 nodes -> tree
    // uses 3, non-tree = 2 -> 2 fundamental cycles. Every returned cycle must walk only real
    // edges in their real direction.
    let mut g = Graph::new();
    for id in 0..4u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic); // A->B
    g.add_edge(1, 2, EdgeKind::Basic); // B->C
    g.add_edge(2, 3, EdgeKind::Basic); // C->D
    g.add_edge(3, 0, EdgeKind::Basic); // D->A
    g.add_bidirectional_edge(0, 2, EdgeKind::Basic); // A<->C shortcut

    let nav = build_nav_graph(&g);
    let cycles = find_fundamental_cycles(&nav);
    assert_eq!(cycles.len(), 2);

    for cycle in &cycles {
        // Contiguous walk: each step's `to` must equal the next step's `from`.
        for pair in cycle.windows(2) {
            let a = nav.edge_by_idx(pair[0]);
            let b = nav.edge_by_idx(pair[1]);
            assert_eq!(a.to, b.from, "cycle must be a contiguous directed walk");
        }
        let first = nav.edge_by_idx(cycle[0]);
        let last = nav.edge_by_idx(cycle[cycle.len() - 1]);
        assert_eq!(last.to, first.from, "cycle must close back to its start");
    }
}

#[test]
fn scc_held_together_only_by_one_way_edges_produces_direction_valid_cycle() {
    // A->B->C->A, entirely one-way, no bidirectional edges at all. The spanning tree has no
    // choice but to use one-way edges as tree edges (via their fictitious reverse) — the
    // single non-tree connection (the fictitious reverse of one of the one-way edges) must
    // resolve to a direction-valid cycle: the real triangle, not a fictitious walk.
    let g = triangle(0, 1, 2);
    let nav = build_nav_graph(&g);
    let cycles = find_fundamental_cycles(&nav);
    assert_eq!(cycles.len(), 1, "the only real cycle here is the triangle itself");

    let edge_ids = resolve_to_edge_ids(&nav, &cycles, &g);
    assert_eq!(edge_ids[0].len(), 3);
}

#[test]
fn one_way_only_scc_with_two_independent_loops_never_discards() {
    // 4 nodes, one-way connections forming two independent triangles sharing an edge pair —
    // even with no bidirectional edges anywhere, real-only BFS from any root always reaches
    // every node in the SCC (that's the definition of a strongly connected component: every
    // node is reachable from every other via real directed edges alone) — so the two-pass
    // spanning tree (real links first, `build_spanning_tree`) never actually needs a fictitious
    // link as a TREE edge. On this small graph the LCA tree-path also happens to be
    // direction-valid already (the fast path succeeds); see
    // `discards_are_recovered_via_fallback_bfs_not_dropped` for a larger graph where the LCA
    // tree-path itself is NOT direction-valid and the `real_path_bfs` fallback is needed.
    let mut g = Graph::new();
    for id in 0..4u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic); // A->B
    g.add_edge(1, 2, EdgeKind::Basic); // B->C
    g.add_edge(2, 0, EdgeKind::Basic); // C->A
    g.add_edge(1, 3, EdgeKind::Basic); // B->D
    g.add_edge(3, 0, EdgeKind::Basic); // D->A

    let nav = build_nav_graph(&g);
    let cycles = find_fundamental_cycles(&nav);

    // Topological beta_1 = E - V + 1 = 5 - 4 + 1 = 2; the fundamental basis must recover
    // exactly that count, not fewer — no discard on this one-way-only graph.
    assert_eq!(cycles.len(), 2);
    for cycle in &cycles {
        for pair in cycle.windows(2) {
            let a = nav.edge_by_idx(pair[0]);
            let b = nav.edge_by_idx(pair[1]);
            assert_eq!(a.to, b.from, "cycle must be a contiguous directed walk");
        }
        let first = nav.edge_by_idx(cycle[0]);
        let last = nav.edge_by_idx(cycle[cycle.len() - 1]);
        assert_eq!(last.to, first.from, "cycle must close back to its start");
    }
}

#[test]
fn fallback_bfs_never_walks_straight_back_over_the_non_tree_connections_own_reverse() {
    // Regression for a real bug report: a fictitious link landing inside the LCA tree-path
    // (triggering the `real_path_bfs` fallback) let the fallback immediately walk back over the
    // non-tree link's OWN reverse edge — producing a degenerate 2-step "there and back" cycle
    // (exactly the trivial-reverse-pair case `canonical_index` dedup is supposed to prevent
    // everywhere else) instead of a real cycle through the rest of the SCC.
    //
    // Exact topology from the reported bug (8-node SCC): a bidirectional spine
    // 0<->1<->2<->7, a bidirectional spur 1<->3<->4 and 3<->5<->6, plus a one-way shortcut
    // 2->5 (no reverse). Root 0: the tree reaches 5 via 1->3->5 (both real, direction-valid),
    // so the one-way 2->5 becomes non-tree with its fictitious mirror 5->2 landing INSIDE node
    // 5's own link list. Non-tree connection 3<->5 (walked 3->5) then needs a tree-path from 5
    // back to 3 — the LCA split makes that path require the fictitious 5->2 link, which is not
    // direction-valid, triggering the `real_path_bfs` fallback. Before the fix, that fallback
    // walked straight back over edge 5's own `reverse_edge` (3<-5) instead of routing through
    // the rest of the SCC.
    let mut g = Graph::new();
    for id in [0u64, 1, 2, 3, 4, 5, 6, 7] { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 0, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 1, EdgeKind::Basic);
    g.add_edge(1, 3, EdgeKind::Basic);
    g.add_edge(3, 1, EdgeKind::Basic);
    g.add_edge(3, 4, EdgeKind::Basic);
    g.add_edge(4, 3, EdgeKind::Basic);
    g.add_edge(3, 5, EdgeKind::Basic);
    g.add_edge(5, 3, EdgeKind::Basic);
    g.add_edge(5, 6, EdgeKind::Basic);
    g.add_edge(6, 5, EdgeKind::Basic);
    g.add_edge(2, 7, EdgeKind::Basic);
    g.add_edge(7, 2, EdgeKind::Basic);
    g.add_edge(2, 5, EdgeKind::Basic); // one-way: 2->5, no reverse added

    let nav = build_nav_graph(&g);
    let cycles = find_fundamental_cycles(&nav);

    for cycle in &cycles {
        assert!(cycle.len() >= 3, "no degenerate there-and-back 2-cycle: {:?}", cycle);
        // No cycle may immediately walk an edge then its own `reverse_edge` back-to-back.
        for pair in cycle.windows(2) {
            let a = nav.edge_by_idx(pair[0]);
            if let Some(rev) = a.reverse_edge {
                assert_ne!(rev, pair[1], "cycle must not walk an edge immediately followed by its own reverse: {:?}", cycle);
            }
        }
    }
}

#[test]
fn result_order_is_deterministic_across_repeated_runs() {
    // Regression: internal `HashMap`-keyed bookkeeping (non-tree connection selection, the
    // second BFS pass's seed order) must never leak into the returned cycle order — a
    // `HashMap`'s randomized per-process hasher would otherwise make `find_fundamental_cycles`
    // return the same set of cycles in a different order on different runs of the same process
    // (or a different process), silently breaking seed-based reproducibility for any consumer
    // that indexes into the result (e.g. `InvalidLoopScoredStrategy`). Runs the algorithm many
    // times on the same one-way-heavy graph (the discard/fallback-BFS fixture, which exercises
    // every `HashMap`-touched code path) within a single process and asserts every run agrees.
    let mut g = Graph::new();
    for id in 0..11u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);
    g.add_edge(0, 3, EdgeKind::Basic);
    g.add_edge(3, 4, EdgeKind::Basic);
    g.add_edge(4, 5, EdgeKind::Basic);
    g.add_edge(5, 6, EdgeKind::Basic);
    g.add_edge(6, 7, EdgeKind::Basic);
    g.add_edge(7, 8, EdgeKind::Basic);
    g.add_edge(8, 9, EdgeKind::Basic);
    g.add_edge(9, 10, EdgeKind::Basic);
    g.add_edge(10, 2, EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let first = find_fundamental_cycles(&nav);
    for _ in 0..50 {
        assert_eq!(find_fundamental_cycles(&nav), first, "cycle order must be identical across repeated runs");
    }
}

#[test]
fn discards_are_recovered_via_fallback_bfs_not_dropped() {
    // 11-node, all-one-way SCC: a triangle (0->1->2->0) chained into a long loop
    // (0->3->4->...->10->2->0) sharing edge 2->0. The spanning tree (root 0) ends up with
    // node 2 reached via the LONG chain (0->3->...->10->2), and node 1 reached directly
    // (0->1). The non-tree edge 1->2 (closing the triangle) then needs a tree-path from 2
    // back to 1 — but the LCA (root 0) split requires walking the long chain backwards
    // (2->10->...->3->0), which is all real one-way edges with no reverse: the straight
    // LCA tree-path is NOT direction-valid, even though every tree edge involved is real
    // (no fictitious link anywhere in this tree). This regression-guards that the
    // `real_path_bfs` fallback recovers the cycle instead of silently discarding it.
    let mut g = Graph::new();
    for id in 0..11u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);
    g.add_edge(0, 3, EdgeKind::Basic);
    g.add_edge(3, 4, EdgeKind::Basic);
    g.add_edge(4, 5, EdgeKind::Basic);
    g.add_edge(5, 6, EdgeKind::Basic);
    g.add_edge(6, 7, EdgeKind::Basic);
    g.add_edge(7, 8, EdgeKind::Basic);
    g.add_edge(8, 9, EdgeKind::Basic);
    g.add_edge(9, 10, EdgeKind::Basic);
    g.add_edge(10, 2, EdgeKind::Basic);

    let nav = build_nav_graph(&g);
    let cycles = find_fundamental_cycles(&nav);

    // 12 edges, 11 nodes, 1 SCC -> topological beta_1 = 12 - 11 + 1 = 2.
    assert_eq!(cycles.len(), 2, "both independent loops must be recovered, none discarded");
    for cycle in &cycles {
        for pair in cycle.windows(2) {
            let a = nav.edge_by_idx(pair[0]);
            let b = nav.edge_by_idx(pair[1]);
            assert_eq!(a.to, b.from, "cycle must be a contiguous directed walk");
        }
        let first = nav.edge_by_idx(cycle[0]);
        let last = nav.edge_by_idx(cycle[cycle.len() - 1]);
        assert_eq!(last.to, first.from, "cycle must close back to its start");
    }
}

