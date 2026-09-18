use maze_core::graph::EdgeKind;
use maze_core::{Graph, IdGenerator};

fn setup() -> (Graph, u64, u64, u64) {
    let mut ids = IdGenerator::new();
    let a = ids.next_id();
    let b = ids.next_id();
    let c = ids.next_id();
    let mut graph = Graph::new();
    graph.add_node(a);
    graph.add_node(b);
    graph.add_node(c);
    (graph, a, b, c)
}

#[test]
fn add_node_increases_count() {
    let (graph, _, _, _) = setup();
    assert_eq!(graph.node_count(), 3);
}

#[test]
fn add_edge_connects_nodes_directed() {
    let (mut graph, a, b, _) = setup();
    graph.build_initial_edge(a, b, EdgeKind::Basic);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_none());
}

#[test]
fn add_bidirectional_edge_creates_two_edges() {
    let (mut graph, a, b, _) = setup();
    graph.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_some());
    assert_eq!(graph.edges().count(), 2);
    let out_a: Vec<_> = graph.outgoing_neighbors(a).collect();
    let out_b: Vec<_> = graph.outgoing_neighbors(b).collect();
    assert_eq!(out_a, vec![b]);
    assert_eq!(out_b, vec![a]);
}

#[test]
fn neighbors_after_add_edge() {
    let (mut graph, a, b, _) = setup();
    graph.build_initial_edge(a, b, EdgeKind::Basic);
    let out_a: Vec<_> = graph.outgoing_neighbors(a).collect();
    let out_b: Vec<_> = graph.outgoing_neighbors(b).collect();
    assert_eq!(out_a, vec![b]);
    assert!(out_b.is_empty());
}

#[test]
fn incoming_neighbors_after_add_edge() {
    let (mut graph, a, b, _) = setup();
    graph.build_initial_edge(a, b, EdgeKind::Basic);
    let inc_b: Vec<_> = graph.incoming_neighbors(b).collect();
    assert_eq!(inc_b, vec![a]);
    let inc_a: Vec<_> = graph.incoming_neighbors(a).collect();
    assert!(inc_a.is_empty());
}

#[test]
fn remove_edge_tombstone() {
    let (mut graph, a, b, _) = setup();
    let eid = graph.build_initial_edge(a, b, EdgeKind::Basic);
    graph.remove_initial_edge(eid);
    assert!(graph.edge_between(a, b).is_none());
    assert!(graph.outgoing_neighbors(a).next().is_none());
    assert!(graph.incoming_neighbors(b).next().is_none());
}

#[test]
fn remove_edge_does_not_affect_other_edges() {
    let (mut graph, a, b, c) = setup();
    let eid_ab = graph.build_initial_edge(a, b, EdgeKind::Basic);
    graph.build_initial_edge(b, c, EdgeKind::Basic);
    graph.remove_initial_edge(eid_ab);
    assert!(graph.edge_between(b, c).is_some());
}

#[test]
fn edge_between_unconnected_nodes_is_none() {
    let (graph, a, _, c) = setup();
    assert!(graph.edge_between(a, c).is_none());
}

#[test]
fn edges_filters_tombstones() {
    let (mut graph, a, b, c) = setup();
    let eid_ab = graph.build_initial_edge(a, b, EdgeKind::Basic);
    graph.build_initial_edge(b, c, EdgeKind::Basic);
    graph.remove_initial_edge(eid_ab);
    assert_eq!(graph.edges().count(), 1);
}

#[test]
fn reachable_from_follows_outgoing_only() {
    let (mut graph, a, b, c) = setup();
    graph.build_initial_edge(a, b, EdgeKind::Basic);
    graph.build_initial_edge(b, c, EdgeKind::Basic);
    // a → b → c, no reverse edges
    let reachable = graph.reachable_from(a);
    assert!(reachable.contains(&a));
    assert!(reachable.contains(&b));
    assert!(reachable.contains(&c));
    // from c: only c itself (no outgoing)
    let from_c = graph.reachable_from(c);
    assert_eq!(from_c.len(), 1);
    assert!(from_c.contains(&c));
}

#[test]
fn reachable_from_unknown_node_is_empty() {
    let (graph, _, _, _) = setup();
    let unknown: u64 = 9999;
    let reachable = graph.reachable_from(unknown);
    assert!(reachable.is_empty());
}

#[test]
fn reachable_to_follows_incoming_only() {
    let (mut graph, a, b, c) = setup();
    graph.build_initial_edge(a, b, EdgeKind::Basic);
    graph.build_initial_edge(b, c, EdgeKind::Basic);
    // a → b → c: reachable_to(c) = {a, b, c}
    let to_c = graph.reachable_to(c);
    assert!(to_c.contains(&a));
    assert!(to_c.contains(&b));
    assert!(to_c.contains(&c));
    // reachable_to(a) = {a} only (nothing points to a)
    let to_a = graph.reachable_to(a);
    assert_eq!(to_a.len(), 1);
    assert!(to_a.contains(&a));
}

#[test]
fn reachable_to_unknown_node_is_empty() {
    let (graph, _, _, _) = setup();
    let unknown: u64 = 9999;
    let reachable = graph.reachable_to(unknown);
    assert!(reachable.is_empty());
}
