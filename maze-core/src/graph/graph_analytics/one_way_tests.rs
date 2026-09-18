use super::super::*;
use crate::graph::nav::build_nav_graph;
use crate::graph::{EdgeKind, Graph};

fn analyze(g: &Graph) -> GraphAnalytics {
    compute_graph_analytics(&build_nav_graph(g))
}

#[test]
fn trim_dead_ends_strips_a_linear_chain_entirely() {
    // 0 - 1 - 2 - 3: a plain path, no cycle anywhere — every node is a dead end.
    let mut g = Graph::new();
    for id in 0..4 {
        g.add_node(id);
    }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 3, EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let survivors = trim_dead_ends(&nav);
    assert!(
        survivors.iter().all(|&s| !s),
        "a tree has no nodes on a cycle"
    );
}

#[test]
fn trim_dead_ends_keeps_a_simple_cycle_intact() {
    // 0 -> 1 -> 2 -> 0: every node has two distinct undirected connections.
    let mut g = Graph::new();
    for id in 0..3 {
        g.add_node(id);
    }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let survivors = trim_dead_ends(&nav);
    assert!(survivors.iter().all(|&s| s), "no dead ends on a pure cycle");
}

#[test]
fn trim_dead_ends_strips_a_tail_hanging_off_a_cycle() {
    // Cycle 0-1-2-0, plus a dangling branch node 3 hanging off 2 (a single edge, not a
    // 2-degree corridor, so it survives nav-graph compression as its own nav-node).
    let mut g = Graph::new();
    for id in 0..4 {
        g.add_node(id);
    }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 3, EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let survivors = trim_dead_ends(&nav);
    assert!(
        survivors[0] && survivors[1] && survivors[2],
        "cycle nodes survive"
    );
    assert!(!survivors[3], "branch node is trimmed");
}

#[test]
fn cycle_through_a_single_one_way_edge_is_pure() {
    // 0 <-> 1 <-> 2 -> 0 (one-way close). Whole ring is a real cycle even though
    // edge 2->0 has no reverse. Each ring node gets a dangling branch (node 3/4/5) so
    // it keeps degree >= 3 and survives nav-graph corridor compression as its own node.
    let mut g = Graph::new();
    for id in 0..6 {
        g.add_node(id);
    }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic); // one-way close
    g.add_bidirectional_edge(0, 3, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 4, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 5, EdgeKind::Basic);
    let analytics = analyze(&g);

    assert_eq!(
        analytics.pure_cycle_nav_nodes.len(),
        3,
        "all 3 ring nodes lie on the cycle"
    );
    assert_eq!(
        analytics.cycle_count, 1,
        "single ring = one independent cycle"
    );
}

#[test]
fn cycle_through_two_one_way_edges_sharing_a_node_is_pure() {
    // 0 -> 1 (one-way), 1 <-> 2, 2 -> 0 (one-way). Two one-way edges meet at node 0
    // (one leaves it, one enters it) but the ring is still a single real cycle.
    let mut g = Graph::new();
    for id in 0..3 {
        g.add_node(id);
    }
    g.add_edge(0, 1, EdgeKind::Basic); // one-way
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic); // one-way
    let analytics = analyze(&g);

    assert_eq!(
        analytics.pure_cycle_nav_nodes.len(),
        3,
        "all 3 nodes lie on the ring"
    );
    assert_eq!(
        analytics.cycle_count, 1,
        "single ring = one independent cycle"
    );
}

#[test]
fn cycle_through_two_nonadjacent_one_way_edges_is_pure() {
    // A1->A2<->A3<->A4->A5<->A1: a 5-node ring where two one-way edges (A1->A2, A4->A5)
    // are not adjacent to each other, separated by bidirectional legs on both sides.
    // Each ring node gets a dangling branch (nodes 5..9) to survive corridor compression.
    let mut g = Graph::new();
    for id in 0..10 {
        g.add_node(id);
    } // A1=0 A2=1 A3=2 A4=3 A5=4, branches=5..9
    g.add_edge(0, 1, EdgeKind::Basic); // A1->A2 one-way
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic); // A2<->A3
    g.add_bidirectional_edge(2, 3, EdgeKind::Basic); // A3<->A4
    g.add_edge(3, 4, EdgeKind::Basic); // A4->A5 one-way
    g.add_bidirectional_edge(4, 0, EdgeKind::Basic); // A5<->A1
    for (ring_node, branch) in (0..5).zip(5..10) {
        g.add_bidirectional_edge(ring_node, branch, EdgeKind::Basic);
    }
    let analytics = analyze(&g);

    assert_eq!(
        analytics.pure_cycle_nav_nodes.len(),
        5,
        "all 5 ring nodes lie on the cycle"
    );
    assert_eq!(
        analytics.cycle_count, 1,
        "single ring = one independent cycle"
    );
}

#[test]
fn opposite_one_ways_converging_on_one_node_form_no_cycle() {
    // A1->A2<-A3-A4-A1: A1<->A4<->A3 bidirectional, plus A1->A2 and A3->A2 one-way.
    // A2 only receives — no edge leaves it — so it's a dead end and no cycle exists.
    let mut g = Graph::new();
    for id in 0..4 {
        g.add_node(id);
    } // A1=0 A2=1 A3=2 A4=3
    g.add_edge(0, 1, EdgeKind::Basic); // A1->A2 one-way
    g.add_edge(2, 1, EdgeKind::Basic); // A3->A2 one-way
    g.add_bidirectional_edge(2, 3, EdgeKind::Basic); // A3<->A4
    g.add_bidirectional_edge(3, 0, EdgeKind::Basic); // A4<->A1
    let analytics = analyze(&g);

    assert!(
        analytics.pure_cycle_nav_nodes.is_empty(),
        "convergent one-ways form no cycle"
    );
    assert_eq!(analytics.cycle_count, 0);
}

#[test]
fn opposite_one_ways_into_a_connected_pair_form_no_cycle() {
    // A1->A2-A3-A4<-A5-A1: A1<->A5 and A2<->A3 bidirectional, A1->A2 and A5->A4 one-way.
    // A2 and A4 each only receive from their one-way edge with no way back to A1/A5 — no cycle.
    let mut g = Graph::new();
    for id in 0..5 {
        g.add_node(id);
    } // A1=0 A2=1 A3=2 A4=3 A5=4
    g.add_edge(0, 1, EdgeKind::Basic); // A1->A2 one-way
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic); // A2<->A3
    g.add_edge(4, 3, EdgeKind::Basic); // A5->A4 one-way
    g.add_bidirectional_edge(0, 4, EdgeKind::Basic); // A1<->A5
    let analytics = analyze(&g);

    assert!(
        analytics.pure_cycle_nav_nodes.is_empty(),
        "convergent one-ways form no cycle"
    );
    assert_eq!(analytics.cycle_count, 0);
}

#[test]
fn parallel_corridors_between_same_junction_pair_compress_to_two_nav_edges() {
    // Two junctions A=0, B=1 (each also has an extra branch to stay degree>=3 and
    // avoid being corridor-compressed themselves). Two distinct bidirectional corridor
    // chains connect A and B: a direct edge, and a detour through 4,5 (degree-2,
    // symmetric in/out — true corridor nodes, collapse into a single nav-edge).
    // Net result: 2 junctions, 2 parallel nav-edges between them — exactly the "direct
    // path plus a longer detour" shape called out in the e_core hybrid-counting comment.
    let mut g = Graph::new();
    for id in 0..6 {
        g.add_node(id);
    } // A=0 B=1 branchA=2 branchB=3 detour=4,5
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic); // A<->B direct
    g.add_bidirectional_edge(0, 4, EdgeKind::Basic);
    g.add_bidirectional_edge(4, 5, EdgeKind::Basic);
    g.add_bidirectional_edge(5, 1, EdgeKind::Basic); // A<->B via detour 4,5
    g.add_bidirectional_edge(0, 2, EdgeKind::Basic); // branch off A
    g.add_bidirectional_edge(1, 3, EdgeKind::Basic); // branch off B
    let analytics = analyze(&g);

    assert_eq!(
        analytics.node_count, 4,
        "detour nodes 4,5 compress away, A,B,branchA,branchB survive"
    );
    assert_eq!(
        analytics.edge_count, 4,
        "A-B direct, A-B detour, A-branchA, B-branchB are 4 distinct corridors"
    );
    assert_eq!(
        analytics.pure_cycle_nav_nodes.len(),
        2,
        "detour nodes 4,5 compress away, only A,B survive as junctions"
    );
    assert_eq!(
        analytics.cycle_count, 1,
        "direct edge + detour = one independent cycle"
    );
}

#[test]
fn distinct_undirected_edges_dedups_reverse_pair_but_keeps_parallel_edges_separate() {
    // Same shape as `parallel_corridors_between_same_junction_pair_compress_to_two_nav_edges`:
    // a direct A<->B corridor plus a detour A<->B through 4,5 — two distinct nav-edge pairs
    // between the same junctions, each pair internally reverse-deduped to one. Branch nodes
    // 2,3 keep A,B at degree >= 3 so they survive as junctions instead of corridor-compressing.
    let mut g = Graph::new();
    for id in 0..6 {
        g.add_node(id);
    }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(0, 4, EdgeKind::Basic);
    g.add_bidirectional_edge(4, 5, EdgeKind::Basic);
    g.add_bidirectional_edge(5, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(0, 2, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 3, EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let count = distinct_undirected_edges(&nav, |_| true).count();
    assert_eq!(
        count, 4,
        "A-B direct, A-B detour, A-branch, B-branch — 4 distinct corridors, no reverse double-count"
    );
}

#[test]
fn distinct_undirected_edges_respects_filter() {
    let mut g = Graph::new();
    for id in 0..2 {
        g.add_node(id);
    }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_edge(0, 1, EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let count = distinct_undirected_edges(&nav, |_| false).count();
    assert_eq!(count, 0, "filter rejecting everything yields no edges");
}

#[test]
fn two_independent_return_paths_from_a_junction_count_as_two_cycles() {
    // Junctions A=0, B=1, plus branch nodes C=2, D=3 (no compression here — every node
    // already has degree >= 3 or is on a one-way leg, none are symmetric corridor nodes).
    // A->B direct, then two independent one-way return legs B->C->A and B->D->A sharing
    // only the A->B edge. Two distinct return paths from a shared fork = two independent
    // cycles, not one (must not be deduped into a single ring or double-counted as 3).
    let mut g = Graph::new();
    for id in 0..4 {
        g.add_node(id);
    } // A=0 B=1 C=2 D=3
    g.add_edge(0, 1, EdgeKind::Basic); // A->B direct, one-way
    g.add_edge(1, 2, EdgeKind::Basic); // B->C
    g.add_edge(2, 0, EdgeKind::Basic); // C->A
    g.add_edge(1, 3, EdgeKind::Basic); // B->D
    g.add_edge(3, 0, EdgeKind::Basic); // D->A
    let analytics = analyze(&g);

    assert_eq!(
        analytics.cycle_count, 2,
        "two distinct return corridors = two independent cycles"
    );
}
