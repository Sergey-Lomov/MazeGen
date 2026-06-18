use maze_core::graph::{Graph, EdgeKind};
use maze_core::graph::nav::build_nav_graph;
use maze_core::graph::undirected_cc::build_undirected_cc;
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

// Empty nav-graph.
#[test]
fn empty_nav_graph() {
    let (g, _) = make_graph(0);
    let nav = build_nav_graph(&g);
    let cc = build_undirected_cc(&nav);
    assert_eq!(cc.component_count, 0);
    assert_eq!(cc.largest_component_size, 0);
    assert!(cc.node_component.is_empty());
}

// Single junction node, no edges.
#[test]
fn single_node() {
    let (g, _) = make_graph(1);
    let nav = build_nav_graph(&g);
    // Single isolated node becomes a nav node.
    let cc = build_undirected_cc(&nav);
    assert_eq!(cc.component_count, 1);
    assert_eq!(cc.largest_component_size, 1);
}

// Two isolated nodes: two components.
#[test]
fn two_isolated_nodes() {
    let (g, _) = make_graph(2);
    let nav = build_nav_graph(&g);
    let cc = build_undirected_cc(&nav);
    assert_eq!(cc.component_count, 2);
    assert_eq!(cc.largest_component_size, 1);
}

// Bidirectional chain 0 ⇄ 1 ⇄ 2 ⇄ 3: corridor nodes compressed.
// Nav nodes: 0 and 3 (endpoints). One undirected component.
#[test]
fn linear_corridor_one_component() {
    let (mut g, _) = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 1, 2);
    bi(&mut g, 2, 3);
    let nav = build_nav_graph(&g);
    let cc = build_undirected_cc(&nav);
    assert_eq!(cc.component_count, 1);
    assert_eq!(cc.largest_component_size, nav.nodes.len());
}

// Two disconnected chains: two components.
#[test]
fn two_disconnected_chains() {
    let (mut g, _) = make_graph(6);
    bi(&mut g, 0, 1);
    bi(&mut g, 2, 3);
    bi(&mut g, 4, 5);
    let nav = build_nav_graph(&g);
    // Each pair becomes a single nav-edge with 2 nav nodes.
    // Three pairs → three components (no corridors — all are junctions).
    let cc = build_undirected_cc(&nav);
    assert_eq!(cc.component_count, 3);
}

// One-way edge: 0→1. Directed graph, but undirected CC treats it as bidirectional.
// Both nodes in one undirected component.
#[test]
fn one_way_edge_still_one_undirected_component() {
    let (mut g, _) = make_graph(2);
    uni(&mut g, 0, 1);
    let nav = build_nav_graph(&g);
    let cc = build_undirected_cc(&nav);
    // Both nodes are nav-junctions (degree != symmetric 2+2).
    assert_eq!(cc.component_count, 1);
    // Both in same component.
    let comp_0 = cc.node_component[&0];
    let comp_1 = cc.node_component[&1];
    assert_eq!(comp_0, comp_1);
}

// Fork: junction with 3 branches. All in one component.
#[test]
fn fork_one_component() {
    let (mut g, _) = make_graph(4);
    bi(&mut g, 0, 1);
    bi(&mut g, 0, 2);
    bi(&mut g, 0, 3);
    let nav = build_nav_graph(&g);
    let cc = build_undirected_cc(&nav);
    assert_eq!(cc.component_count, 1);
    assert_eq!(cc.largest_component_size, nav.nodes.len());
}
