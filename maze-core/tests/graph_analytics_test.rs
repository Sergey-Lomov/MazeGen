use maze_core::graph::{Graph, EdgeKind};
use maze_core::graph::nav::build_nav_graph;
use maze_core::graph::scc::build_scc;
use maze_core::graph::graph_analytics::compute_graph_analytics;
use maze_core::ids::IdGenerator;

fn make_graph(n: usize) -> (Graph, Vec<u64>) {
    let mut ids = IdGenerator::new();
    let mut g = Graph::new();
    let mut node_ids = Vec::new();
    for _ in 0..n {
        let id = ids.next_id();
        g.add_node(id);
        node_ids.push(id);
    }
    (g, node_ids)
}

fn bi(g: &mut Graph, a: u64, b: u64) {
    g.add_bidirectional_edge(a, b, EdgeKind::Basic);
}

fn uni(g: &mut Graph, a: u64, b: u64) {
    g.add_edge(a, b, EdgeKind::Basic);
}

// Empty graph returns empty analytics.
#[test]
fn empty_graph() {
    let (g, _) = make_graph(0);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, None, None);
    assert_eq!(analytics.global.node_count, 0);
    assert!(analytics.component_stats.is_empty());
}

// Single isolated node. No edges. One undirected component.
#[test]
fn single_isolated_node() {
    let (g, _ns) = make_graph(1);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, None, None);
    assert_eq!(analytics.global.node_count, 1);
    assert_eq!(analytics.global.directed_edge_count, 0);
    assert_eq!(analytics.global.undirected_edge_count, 0);
    assert_eq!(analytics.global.undirected_component_count, 1);
    assert_eq!(analytics.component_stats.len(), 1);
    let comp = &analytics.component_stats[0];
    assert_eq!(comp.node_count, 1);
    assert_eq!(comp.edge_count, 0);
    assert!(!comp.has_directed_cycles);
}

// Linear bidirectional chain: 0 ⇄ 1 ⇄ 2 ⇄ 3.
// Nav: 2 junction nodes (0 and 3), 2 directed nav-edges (0→3, 3→0).
// Undirected CC: 1 component with 2 nav nodes.
// SCC (from base graph): bidirectional chain → each maze node is its own SCC (no directed cycles
// because the chain is 0→1→2→3 and 3→2→1→0, no back-edges to form a cycle).
// But SCC Tarjan on directed edges: 0⇄1 means 0→1 and 1→0 → they are in one SCC.
// So the linear chain has one big SCC including all maze nodes → has_directed_cycles = true.
// This is expected behavior: bidirectional = directed cycle between every pair.
#[test]
fn linear_chain_global_stats() {
    let (mut g, _) = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 3);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, None, None);

    assert_eq!(analytics.global.undirected_component_count, 1);
    assert_eq!(analytics.global.directed_edge_count, 2); // 0→3 and 3→0
    assert_eq!(analytics.global.undirected_edge_count, 1); // pair (0,3)
    assert_eq!(analytics.component_stats.len(), 1);

    let comp = &analytics.component_stats[0];
    assert_eq!(comp.node_count, 2);
    assert_eq!(comp.edge_count, 1);
    // Bidirectional = every maze node reachable from every other → one big SCC → cycles = true
    assert!(comp.has_directed_cycles);
}

// Fork junction: 0 connected bidirectionally to 1, 2, 3.
// Nav: 4 nodes (junction), 6 directed edges (bi × 3 pairs).
// One undirected component. No cycles in basic graph.
#[test]
fn fork_junction_stats() {
    let (mut g, _) = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 0, 2);
    bi(&mut g, 0, 3);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, None, None);

    assert_eq!(analytics.global.undirected_component_count, 1);
    assert_eq!(analytics.component_stats.len(), 1);
    let comp = &analytics.component_stats[0];
    assert_eq!(comp.node_count, 4);
    assert_eq!(comp.edge_count, 3); // 3 unique undirected pairs
}

// Two disconnected pairs: 0⇄1 and 2⇄3. Two undirected components.
#[test]
fn two_disconnected_components() {
    let (mut g, _) = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 2, 3);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, None, None);

    assert_eq!(analytics.global.undirected_component_count, 2);
    assert_eq!(analytics.component_stats.len(), 2);
    // Each component: 2 nodes, 1 edge.
    for comp in &analytics.component_stats {
        assert_eq!(comp.node_count, 2);
        assert_eq!(comp.edge_count, 1);
    }
}

// Directed cycle via one-way edges: 0→1→2→0.
// SCC: all 3 in one SCC. has_directed_cycles = true.
#[test]
fn directed_cycle_detected() {
    let (mut g, ns) = make_graph(3);
    uni(&mut g, ns[0], ns[1]);
    uni(&mut g, ns[1], ns[2]);
    uni(&mut g, ns[2], ns[0]);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, None, None);

    // One undirected component.
    assert_eq!(analytics.global.undirected_component_count, 1);
    let comp = &analytics.component_stats[0];
    assert!(comp.has_directed_cycles, "directed ring must have cycles");
}

// Distances: linear chain 0⇄1⇄2, start=0, finish=2 (maze node ids).
// Nav nodes: 0 and 2 (endpoints of corridor). Optimal = path len.
#[test]
fn distances_linear_with_start_finish() {
    let (mut g, ns) = make_graph(3);
    bi(&mut g, ns[0], ns[1]);
    bi(&mut g, ns[1], ns[2]);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, Some(ns[0]), Some(ns[2]));

    assert!(analytics.navigation.start_finish_connected);
    // Hard bottleneck: start and finish nodes themselves (or corridor nodes on path).
    // In compressed nav: only 2 nav nodes (start and finish). Hard = nodes on optimal path
    // excluding finish itself. So start nav node should be hard.
    assert!(!analytics.navigation.hard_bottleneck_nav_nodes.is_empty()
        || !analytics.navigation.soft_bottleneck_nav_nodes.is_empty(),
        "should find bottlenecks on direct path");
}

// No start/finish: all distance-dependent metrics are None.
#[test]
fn no_start_finish_distances_none() {
    let (mut g, _) = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 3);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, None, None);

    assert!(!analytics.navigation.start_finish_connected);
    assert!(analytics.navigation.hard_bottleneck_nav_nodes.is_empty());
    assert!(analytics.navigation.soft_bottleneck_nav_nodes.is_empty());
    for comp in &analytics.component_stats {
        assert!(comp.avg_dist_to_start.is_none());
        assert!(comp.avg_dist_to_finish.is_none());
    }
}

// Start and finish in different undirected components.
#[test]
fn start_finish_disconnected() {
    let (mut g, ns) = make_graph(4);
    bi(&mut g, ns[0], ns[1]);
    bi(&mut g, ns[2], ns[3]);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, Some(ns[0]), Some(ns[2]));

    assert!(!analytics.navigation.start_finish_connected);
    assert!(analytics.navigation.hard_bottleneck_nav_nodes.is_empty());
}

// Bidirectional ring: 0⇄1⇄2⇄0.
// NavGraph compresses all corridor nodes into 1 ring anchor nav node with 2 self-edges.
// Undirected: 1 nav node, 1 self-loop pair → edge_count = 1.
// SCC: all maze nodes reachable bidirectionally → has_directed_cycles = true.
#[test]
fn bidirectional_ring_has_cycles() {
    let (mut g, _) = make_graph(3);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 0);
    let nav = build_nav_graph(&g);
    let scc = build_scc(&g);
    let analytics = compute_graph_analytics(&nav, &scc, None, None);

    assert_eq!(analytics.global.undirected_component_count, 1);
    let comp = &analytics.component_stats[0];
    assert!(comp.has_directed_cycles);
    // Nav: 1 ring anchor node, 2 self-edges directed → 1 unique undirected pair (anchor, anchor)
    assert_eq!(comp.node_count, 1);
    assert_eq!(comp.edge_count, 1); // self-loop counts as 1 undirected edge
}
