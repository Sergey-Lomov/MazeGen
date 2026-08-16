use super::*;
use crate::graph::{Graph, EdgeKind};
use crate::graph::nav::{build_nav_graph, build_nav_graph_pinned};
use crate::ids::NodeId;

fn analyze(g: &Graph) -> GraphAnalytics {
    compute_graph_analytics(&build_nav_graph(g))
}

fn analyze_pinned(g: &Graph, pinned: &HashSet<NodeId>) -> GraphAnalytics {
    compute_graph_analytics(&build_nav_graph_pinned(g, pinned))
}

/// Two isolated bowtie clusters, each made of two directed triangles sharing one edge.
/// Cluster 1: A=0,B=1,C=2,D=3 — cycle A->B->C->A, cycle B->D->C->B (shared edge B-C).
/// Cluster 2: E=4,F=5,G=6,H=7 — same shape, disconnected from cluster 1.
fn two_bowtie_clusters() -> Graph {
    let mut g = Graph::new();
    for id in 0..8 {
        g.add_node(id);
    }
    // Cluster 1
    g.add_edge(0, 1, EdgeKind::Basic); // A->B
    g.add_edge(1, 2, EdgeKind::Basic); // B->C
    g.add_edge(2, 0, EdgeKind::Basic); // C->A
    g.add_edge(1, 3, EdgeKind::Basic); // B->D
    g.add_edge(3, 2, EdgeKind::Basic); // D->C
    g.add_edge(2, 1, EdgeKind::Basic); // C->B
    // Cluster 2 (mirrors cluster 1, disjoint node ids)
    g.add_edge(4, 5, EdgeKind::Basic);
    g.add_edge(5, 6, EdgeKind::Basic);
    g.add_edge(6, 4, EdgeKind::Basic);
    g.add_edge(5, 7, EdgeKind::Basic);
    g.add_edge(7, 6, EdgeKind::Basic);
    g.add_edge(6, 5, EdgeKind::Basic);
    g
}

#[test]
fn two_disjoint_bowtie_clusters_have_two_cycle_regions() {
    let g = two_bowtie_clusters();
    let analytics = analyze(&g);

    assert_eq!(analytics.node_count, 8, "8 distinct nav-nodes, no compression in two bowties");
    assert_eq!(analytics.edge_count, 10, "6 directed edges per cluster, but B<->C is a paired reverse (counts once) — 5 corridors per cluster");
    assert_eq!(analytics.cycle_count, 4, "two cycles per cluster, two clusters");
    assert_eq!(analytics.cycle_region_count, 2, "clusters are disconnected");
    assert_eq!(analytics.pure_cycle_nav_nodes.len(), 8, "all 8 nodes participate in a cycle");
}

/// GitHub issue #284: `pure_cycle_basis` must contain exactly `cycle_count` cycles (never the
/// composite route through each bowtie), and stay empty on an acyclic/empty graph.
#[test]
fn pure_cycle_basis_matches_cycle_count_on_bowtie_clusters() {
    let g = two_bowtie_clusters();
    let analytics = analyze(&g);
    assert_eq!(analytics.pure_cycle_basis.len(), analytics.cycle_count, "basis size must equal the independent cycle count");
    assert_eq!(analytics.pure_cycle_basis.len(), 4);
}

/// Two triangles on "different floors" bridged by a single bidirectional VerticalPassage — the
/// bridge itself is not part of either cycle and must not be counted as a third independent one.
#[test]
fn two_triangles_bridged_by_vertical_passage_has_two_cycles() {
    let mut g = Graph::new();
    for id in 0..6u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);
    g.add_edge(3, 4, EdgeKind::Basic);
    g.add_edge(4, 5, EdgeKind::Basic);
    g.add_edge(5, 3, EdgeKind::Basic);
    g.add_edge(0, 3, EdgeKind::VerticalPassage);
    g.add_edge(3, 0, EdgeKind::VerticalPassage);

    let analytics = analyze(&g);
    assert_eq!(analytics.cycle_count, 2, "the bridge itself must not count as a third cycle");
    assert_eq!(analytics.pure_cycle_basis.len(), 2);
}

/// GitHub issue #369 follow-up: a dangling bidirectional VerticalPassage off a real triangle
/// must not be counted as its own cycle — it's a dead-end spur (walk up, walk back down), not a
/// loop; `cycle_count`/`pure_cycle_nav_nodes`/`pure_cycle_edge_indices` must all exclude it.
#[test]
fn dangling_vertical_passage_off_a_triangle_is_not_a_cycle() {
    let mut g = Graph::new();
    for id in 0..4u64 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);
    g.add_edge(0, 3, EdgeKind::VerticalPassage);
    g.add_edge(3, 0, EdgeKind::VerticalPassage);

    let nav = build_nav_graph(&g);
    let dead_end_nav_id = nav.nav_node_for(3);
    let analytics = analyze(&g);
    assert_eq!(analytics.cycle_count, 1, "only the triangle is a real cycle");
    assert_eq!(analytics.pure_cycle_basis.len(), 1);
    if let Some(dead_end) = dead_end_nav_id {
        assert!(!analytics.pure_cycle_nav_nodes.contains(&dead_end), "the vertical passage's dead-end node must not be in the cycle core");
    }
}

/// GitHub issue #284: `simple_cycle_count` must be the fully deduped simple-cycle count (each
/// bowtie contributes 3 distinct simple cycles: 2 triangles + 1 composite route, so 6 across two
/// clusters), never the raw pre-dedup count (which would double-count every cycle as its CW and
/// CCW directed walk) and never the independent `cycle_count` (4).
#[test]
fn simple_cycle_count_is_fully_deduped_not_double_counted() {
    let g = two_bowtie_clusters();
    let analytics = analyze(&g);
    assert_eq!(analytics.simple_cycle_count, 6, "3 simple cycles per bowtie (2 triangles + composite) times 2 clusters");
    assert!(analytics.simple_cycle_count > analytics.cycle_count, "composite-inclusive count must exceed the independent count");
}

#[test]
fn pure_cycle_basis_empty_on_acyclic_graph() {
    let mut g = Graph::new();
    for id in 0..3 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    let analytics = analyze(&g);
    assert_eq!(analytics.cycle_count, 0);
    assert!(analytics.pure_cycle_basis.is_empty());
}

#[test]
fn pure_cycle_basis_empty_on_empty_graph() {
    let g = Graph::new();
    let analytics = analyze(&g);
    assert!(analytics.pure_cycle_basis.is_empty());
}

/// Real post-edit graph from a 6x6 maze: two disjoint simple cycles
/// (no shared edge), connected to each other only by non-cyclic corridors.
/// Cycle A: 1-7-8-14-13-12-6-0-1. Cycle B: 34-28-22-21-20-26-27-33-34.
fn user_reported_two_cycle_graph() -> (Graph, HashSet<NodeId>) {
    let bidir: &[(NodeId, NodeId)] = &[
        (21,20),(20,26),(26,27),(21,22),(22,16),(22,23),(22,28),(28,34),(34,33),
        (26,25),(23,29),(29,35),(33,27),(33,32),(32,31),(31,30),(30,24),(24,18),
        (18,12),(12,13),(13,14),(14,8),(25,19),(12,6),(8,7),(7,1),(8,9),(16,15),
        (16,10),(10,11),(11,17),(1,2),(2,3),(6,0),(10,4),(4,5),(0,1),
    ];
    let mut g = Graph::new();
    for id in 0..36 {
        g.add_node(id);
    }
    for &(a, b) in bidir {
        g.add_bidirectional_edge(a, b, EdgeKind::Basic);
    }
    let mut pinned = HashSet::new();
    pinned.insert(22);
    pinned.insert(14);
    (g, pinned)
}

/// Same 6x6 maze as `user_reported_two_cycle_graph`, but with an extra edge (34-35)
/// instead of (0-1) that merges the two cycles into one connected cyclic region
/// (they now share nodes 22,23,29,35,34) while still being two independent cycles.
fn user_reported_merged_two_cycle_graph() -> (Graph, HashSet<NodeId>) {
    let bidir: &[(NodeId, NodeId)] = &[
        (21,20),(20,26),(26,27),(21,22),(22,16),(22,23),(22,28),(28,34),(34,33),
        (26,25),(23,29),(29,35),(33,27),(33,32),(32,31),(31,30),(30,24),(24,18),
        (18,12),(12,13),(13,14),(14,8),(25,19),(12,6),(8,7),(7,1),(8,9),(16,15),
        (16,10),(10,11),(11,17),(1,2),(2,3),(6,0),(10,4),(4,5),(34,35),
    ];
    let mut g = Graph::new();
    for id in 0..36 {
        g.add_node(id);
    }
    for &(a, b) in bidir {
        g.add_bidirectional_edge(a, b, EdgeKind::Basic);
    }
    let mut pinned = HashSet::new();
    pinned.insert(22);
    pinned.insert(14);
    (g, pinned)
}

#[test]
fn real_maze_merged_cycles_have_two_cycles_in_one_region() {
    let (g, pinned) = user_reported_merged_two_cycle_graph();
    let analytics = analyze_pinned(&g, &pinned);

    assert_eq!(analytics.cycle_region_count, 1, "the two cycles now share nodes — one region");
    assert_eq!(analytics.cycle_count, 2, "still two independent cycles (beta_1 = E - V + C)");
}

#[test]
fn real_maze_two_disjoint_simple_cycles_have_two_cycle_regions() {
    let (g, pinned) = user_reported_two_cycle_graph();
    let analytics = analyze_pinned(&g, &pinned);

    assert_eq!(analytics.cycle_count, 2, "two independent simple cycles");
    assert_eq!(analytics.cycle_region_count, 2, "the two cycles share no node — must be 2 regions");
}

#[test]
fn two_disjoint_bowtie_clusters_have_nonempty_pure_cycle_core() {
    let g = two_bowtie_clusters();
    let analytics = analyze(&g);

    // No bridges: every node has degree >= 2 inside its bowtie, shared edge is on two cycles.
    assert_eq!(analytics.pure_cycle_nav_nodes.len(), 8, "no bridges in a bowtie — all nodes are pure-cycle");
    assert!(!analytics.pure_cycle_edge_indices.is_empty());
}

#[test]
fn trim_dead_ends_strips_a_linear_chain_entirely() {
    // 0 - 1 - 2 - 3: a plain path, no cycle anywhere — every node is a dead end.
    let mut g = Graph::new();
    for id in 0..4 { g.add_node(id); }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 3, EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let survivors = trim_dead_ends(&nav);
    assert!(survivors.iter().all(|&s| !s), "a tree has no nodes on a cycle");
}

#[test]
fn trim_dead_ends_keeps_a_simple_cycle_intact() {
    // 0 -> 1 -> 2 -> 0: every node has two distinct undirected connections.
    let mut g = Graph::new();
    for id in 0..3 { g.add_node(id); }
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
    for id in 0..4 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 3, EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let survivors = trim_dead_ends(&nav);
    assert!(survivors[0] && survivors[1] && survivors[2], "cycle nodes survive");
    assert!(!survivors[3], "branch node is trimmed");
}

#[test]
fn cycle_through_a_single_one_way_edge_is_pure() {
    // 0 <-> 1 <-> 2 -> 0 (one-way close). Whole ring is a real cycle even though
    // edge 2->0 has no reverse. Each ring node gets a dangling branch (node 3/4/5) so
    // it keeps degree >= 3 and survives nav-graph corridor compression as its own node.
    let mut g = Graph::new();
    for id in 0..6 { g.add_node(id); }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic); // one-way close
    g.add_bidirectional_edge(0, 3, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 4, EdgeKind::Basic);
    g.add_bidirectional_edge(2, 5, EdgeKind::Basic);
    let analytics = analyze(&g);

    assert_eq!(analytics.pure_cycle_nav_nodes.len(), 3, "all 3 ring nodes lie on the cycle");
    assert_eq!(analytics.cycle_count, 1, "single ring = one independent cycle");
}

#[test]
fn cycle_through_two_one_way_edges_sharing_a_node_is_pure() {
    // 0 -> 1 (one-way), 1 <-> 2, 2 -> 0 (one-way). Two one-way edges meet at node 0
    // (one leaves it, one enters it) but the ring is still a single real cycle.
    let mut g = Graph::new();
    for id in 0..3 { g.add_node(id); }
    g.add_edge(0, 1, EdgeKind::Basic); // one-way
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic); // one-way
    let analytics = analyze(&g);

    assert_eq!(analytics.pure_cycle_nav_nodes.len(), 3, "all 3 nodes lie on the ring");
    assert_eq!(analytics.cycle_count, 1, "single ring = one independent cycle");
}

#[test]
fn cycle_through_two_nonadjacent_one_way_edges_is_pure() {
    // A1->A2<->A3<->A4->A5<->A1: a 5-node ring where two one-way edges (A1->A2, A4->A5)
    // are not adjacent to each other, separated by bidirectional legs on both sides.
    // Each ring node gets a dangling branch (nodes 5..9) to survive corridor compression.
    let mut g = Graph::new();
    for id in 0..10 { g.add_node(id); } // A1=0 A2=1 A3=2 A4=3 A5=4, branches=5..9
    g.add_edge(0, 1, EdgeKind::Basic); // A1->A2 one-way
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic); // A2<->A3
    g.add_bidirectional_edge(2, 3, EdgeKind::Basic); // A3<->A4
    g.add_edge(3, 4, EdgeKind::Basic); // A4->A5 one-way
    g.add_bidirectional_edge(4, 0, EdgeKind::Basic); // A5<->A1
    for (ring_node, branch) in (0..5).zip(5..10) {
        g.add_bidirectional_edge(ring_node, branch, EdgeKind::Basic);
    }
    let analytics = analyze(&g);

    assert_eq!(analytics.pure_cycle_nav_nodes.len(), 5, "all 5 ring nodes lie on the cycle");
    assert_eq!(analytics.cycle_count, 1, "single ring = one independent cycle");
}

#[test]
fn opposite_one_ways_converging_on_one_node_form_no_cycle() {
    // A1->A2<-A3-A4-A1: A1<->A4<->A3 bidirectional, plus A1->A2 and A3->A2 one-way.
    // A2 only receives — no edge leaves it — so it's a dead end and no cycle exists.
    let mut g = Graph::new();
    for id in 0..4 { g.add_node(id); } // A1=0 A2=1 A3=2 A4=3
    g.add_edge(0, 1, EdgeKind::Basic); // A1->A2 one-way
    g.add_edge(2, 1, EdgeKind::Basic); // A3->A2 one-way
    g.add_bidirectional_edge(2, 3, EdgeKind::Basic); // A3<->A4
    g.add_bidirectional_edge(3, 0, EdgeKind::Basic); // A4<->A1
    let analytics = analyze(&g);

    assert!(analytics.pure_cycle_nav_nodes.is_empty(), "convergent one-ways form no cycle");
    assert_eq!(analytics.cycle_count, 0);
}

#[test]
fn opposite_one_ways_into_a_connected_pair_form_no_cycle() {
    // A1->A2-A3-A4<-A5-A1: A1<->A5 and A2<->A3 bidirectional, A1->A2 and A5->A4 one-way.
    // A2 and A4 each only receive from their one-way edge with no way back to A1/A5 — no cycle.
    let mut g = Graph::new();
    for id in 0..5 { g.add_node(id); } // A1=0 A2=1 A3=2 A4=3 A5=4
    g.add_edge(0, 1, EdgeKind::Basic); // A1->A2 one-way
    g.add_bidirectional_edge(1, 2, EdgeKind::Basic); // A2<->A3
    g.add_edge(4, 3, EdgeKind::Basic); // A5->A4 one-way
    g.add_bidirectional_edge(0, 4, EdgeKind::Basic); // A1<->A5
    let analytics = analyze(&g);

    assert!(analytics.pure_cycle_nav_nodes.is_empty(), "convergent one-ways form no cycle");
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
    for id in 0..6 { g.add_node(id); } // A=0 B=1 branchA=2 branchB=3 detour=4,5
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic); // A<->B direct
    g.add_bidirectional_edge(0, 4, EdgeKind::Basic);
    g.add_bidirectional_edge(4, 5, EdgeKind::Basic);
    g.add_bidirectional_edge(5, 1, EdgeKind::Basic); // A<->B via detour 4,5
    g.add_bidirectional_edge(0, 2, EdgeKind::Basic); // branch off A
    g.add_bidirectional_edge(1, 3, EdgeKind::Basic); // branch off B
    let analytics = analyze(&g);

    assert_eq!(analytics.node_count, 4, "detour nodes 4,5 compress away, A,B,branchA,branchB survive");
    assert_eq!(analytics.edge_count, 4, "A-B direct, A-B detour, A-branchA, B-branchB are 4 distinct corridors");
    assert_eq!(analytics.pure_cycle_nav_nodes.len(), 2, "detour nodes 4,5 compress away, only A,B survive as junctions");
    assert_eq!(analytics.cycle_count, 1, "direct edge + detour = one independent cycle");
}

#[test]
fn empty_graph_yields_empty_analytics() {
    let g = Graph::new();
    let analytics = analyze(&g);

    assert_eq!(analytics.node_count, 0);
    assert_eq!(analytics.edge_count, 0);
    assert_eq!(analytics.cycle_count, 0);
    assert_eq!(analytics.cycle_region_count, 0);
    assert!(analytics.pure_cycle_nav_nodes.is_empty());
    assert!(analytics.pure_cycle_edge_indices.is_empty());
}

#[test]
fn graph_analytics_empty_constructor_yields_all_zero_defaults() {
    let analytics = GraphAnalytics::empty();

    assert_eq!(analytics.node_count, 0);
    assert_eq!(analytics.edge_count, 0);
    assert_eq!(analytics.cycle_count, 0);
    assert_eq!(analytics.cycle_region_count, 0);
    assert!(analytics.pure_cycle_nav_nodes.is_empty());
    assert!(analytics.pure_cycle_edge_indices.is_empty());
}

#[test]
fn single_isolated_node_has_no_edges_and_no_cycle() {
    let mut g = Graph::new();
    g.add_node(0);
    let analytics = analyze(&g);

    assert_eq!(analytics.node_count, 1);
    assert_eq!(analytics.edge_count, 0);
    assert_eq!(analytics.cycle_count, 0);
    assert_eq!(analytics.cycle_region_count, 0);
    assert!(analytics.pure_cycle_nav_nodes.is_empty());
}

#[test]
fn self_loop_counts_as_its_own_cycle() {
    // 0 -> 0 self-loop, plus a real cycle 0->1->2->0. The self-loop is now a first-class
    // cycle: it adds 1 to edge_count and 1 to cycle_count (β1) on top of the 0->1->2->0 ring.
    let mut g = Graph::new();
    for id in 0..3 { g.add_node(id); }
    g.add_edge(0, 0, EdgeKind::Basic); // self-loop
    g.add_edge(0, 1, EdgeKind::Basic);
    g.add_edge(1, 2, EdgeKind::Basic);
    g.add_edge(2, 0, EdgeKind::Basic);
    let analytics = analyze(&g);

    assert_eq!(analytics.edge_count, 4, "self-loop counts as its own corridor");
    assert_eq!(analytics.cycle_count, 2, "self-loop ring + 0->1->2->0 ring = two independent cycles");
    assert_eq!(analytics.pure_cycle_nav_nodes.len(), 3, "self-loop node is also on the real cycle — no extra cyclic node");
}

#[test]
fn three_disjoint_simple_cycles_have_three_cycle_regions() {
    // Three disjoint triangles, no shared nodes or edges between them.
    let mut g = Graph::new();
    for id in 0..9 { g.add_node(id); }
    for &base in &[0, 3, 6] {
        g.add_edge(base, base + 1, EdgeKind::Basic);
        g.add_edge(base + 1, base + 2, EdgeKind::Basic);
        g.add_edge(base + 2, base, EdgeKind::Basic);
    }
    let analytics = analyze(&g);

    assert_eq!(analytics.cycle_count, 3, "three independent simple cycles");
    assert_eq!(analytics.cycle_region_count, 3, "three disjoint regions, no shared nodes");
}

#[test]
fn distinct_undirected_edges_dedups_reverse_pair_but_keeps_parallel_edges_separate() {
    // Same shape as `parallel_corridors_between_same_junction_pair_compress_to_two_nav_edges`:
    // a direct A<->B corridor plus a detour A<->B through 4,5 — two distinct nav-edge pairs
    // between the same junctions, each pair internally reverse-deduped to one. Branch nodes
    // 2,3 keep A,B at degree >= 3 so they survive as junctions instead of corridor-compressing.
    let mut g = Graph::new();
    for id in 0..6 { g.add_node(id); }
    g.add_bidirectional_edge(0, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(0, 4, EdgeKind::Basic);
    g.add_bidirectional_edge(4, 5, EdgeKind::Basic);
    g.add_bidirectional_edge(5, 1, EdgeKind::Basic);
    g.add_bidirectional_edge(0, 2, EdgeKind::Basic);
    g.add_bidirectional_edge(1, 3, EdgeKind::Basic);
    let nav = build_nav_graph(&g);

    let count = distinct_undirected_edges(&nav, |_| true).count();
    assert_eq!(count, 4, "A-B direct, A-B detour, A-branch, B-branch — 4 distinct corridors, no reverse double-count");
}

#[test]
fn distinct_undirected_edges_respects_filter() {
    let mut g = Graph::new();
    for id in 0..2 { g.add_node(id); }
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
    for id in 0..4 { g.add_node(id); } // A=0 B=1 C=2 D=3
    g.add_edge(0, 1, EdgeKind::Basic); // A->B direct, one-way
    g.add_edge(1, 2, EdgeKind::Basic); // B->C
    g.add_edge(2, 0, EdgeKind::Basic); // C->A
    g.add_edge(1, 3, EdgeKind::Basic); // B->D
    g.add_edge(3, 0, EdgeKind::Basic); // D->A
    let analytics = analyze(&g);

    assert_eq!(analytics.cycle_count, 2, "two distinct return corridors = two independent cycles");
}
