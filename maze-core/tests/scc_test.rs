use maze_core::graph::Graph;
use maze_core::graph::scc::build_scc;
use maze_core::graph::EdgeKind;
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

// Single node: one SCC of size 1.
#[test]
fn single_node() {
    let (g, ns) = make_graph(1);
    let scc = build_scc(&g);
    assert_eq!(scc.components.len(), 1);
    assert_eq!(scc.components[0], vec![ns[0]]);
    assert_eq!(scc.component_of(ns[0]), Some(0));
}

// Bidirectional chain: 0 ⇄ 1 ⇄ 2 — all in one SCC.
#[test]
fn bidirectional_chain_one_scc() {
    let (mut g, ns) = make_graph(3);
    bi(&mut g, ns[0], ns[1]);
    bi(&mut g, ns[1], ns[2]);
    let scc = build_scc(&g);
    assert_eq!(scc.components.len(), 1);
    let c0 = scc.component_of(ns[0]).unwrap();
    let c1 = scc.component_of(ns[1]).unwrap();
    let c2 = scc.component_of(ns[2]).unwrap();
    assert_eq!(c0, c1);
    assert_eq!(c1, c2);
    assert_eq!(scc.components[c0].len(), 3);
}

// Two isolated nodes: two SCCs.
#[test]
fn two_isolated_nodes() {
    let (g, ns) = make_graph(2);
    let scc = build_scc(&g);
    assert_eq!(scc.components.len(), 2);
    let c0 = scc.component_of(ns[0]).unwrap();
    let c1 = scc.component_of(ns[1]).unwrap();
    assert_ne!(c0, c1);
}

// One-way edge A→B: two SCCs even though B is reachable from A.
// This matches the described scenario: regions are separate if no mutual reachability.
#[test]
fn one_way_edge_two_sccs() {
    let (mut g, ns) = make_graph(2);
    uni(&mut g, ns[0], ns[1]);
    let scc = build_scc(&g);
    assert_eq!(scc.components.len(), 2);
    let c0 = scc.component_of(ns[0]).unwrap();
    let c1 = scc.component_of(ns[1]).unwrap();
    assert_ne!(c0, c1);
}

// A/B scenario from the spec: group A (0,1) ⇄ internally, group B (2,3) ⇄ internally,
// one-way A→B edge (0→2) only — B is reachable from A but A is not reachable from B.
// 0 ⇄ 1, 2 ⇄ 3, 0→2
// Every node in B is reachable from A, but A and B are still different SCCs.
#[test]
fn two_groups_one_way_two_sccs() {
    let (mut g, ns) = make_graph(4);
    bi(&mut g, ns[0], ns[1]);
    bi(&mut g, ns[2], ns[3]);
    uni(&mut g, ns[0], ns[2]);
    let scc = build_scc(&g);
    // Exactly 2 SCCs: {0,1} and {2,3}
    assert_eq!(scc.components.len(), 2);
    let c0 = scc.component_of(ns[0]).unwrap();
    let c1 = scc.component_of(ns[1]).unwrap();
    let c2 = scc.component_of(ns[2]).unwrap();
    let c3 = scc.component_of(ns[3]).unwrap();
    assert_eq!(c0, c1, "nodes 0 and 1 must be in same SCC");
    assert_eq!(c2, c3, "nodes 2 and 3 must be in same SCC");
    assert_ne!(c0, c2, "group A and group B must be different SCCs");
    assert_eq!(scc.components[c0].len(), 2);
    assert_eq!(scc.components[c2].len(), 2);
}

// Directed ring: 0→1→2→0 — one SCC of size 3.
#[test]
fn directed_ring_one_scc() {
    let (mut g, ns) = make_graph(3);
    uni(&mut g, ns[0], ns[1]);
    uni(&mut g, ns[1], ns[2]);
    uni(&mut g, ns[2], ns[0]);
    let scc = build_scc(&g);
    assert_eq!(scc.components.len(), 1);
    assert_eq!(scc.components[0].len(), 3);
}

// DAG: 0→1→2, no back edges — three SCCs.
#[test]
fn dag_three_sccs() {
    let (mut g, ns) = make_graph(3);
    uni(&mut g, ns[0], ns[1]);
    uni(&mut g, ns[1], ns[2]);
    let scc = build_scc(&g);
    assert_eq!(scc.components.len(), 3);
    let c0 = scc.component_of(ns[0]).unwrap();
    let c1 = scc.component_of(ns[1]).unwrap();
    let c2 = scc.component_of(ns[2]).unwrap();
    assert_ne!(c0, c1);
    assert_ne!(c1, c2);
    assert_ne!(c0, c2);
}
