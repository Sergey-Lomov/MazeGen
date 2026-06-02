use maze_core::{Graph, IdGenerator};
use maze_core::graph::EdgeKind;

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
fn add_edge_connects_nodes() {
    let (mut graph, a, b, _) = setup();
    graph.add_edge(a, b, EdgeKind::Basic);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_some());
}

#[test]
fn neighbors_after_add_edge() {
    let (mut graph, a, b, _) = setup();
    graph.add_edge(a, b, EdgeKind::Basic);
    let neighbors_a: Vec<_> = graph.neighbors(a).collect();
    let neighbors_b: Vec<_> = graph.neighbors(b).collect();
    assert_eq!(neighbors_a, vec![b]);
    assert_eq!(neighbors_b, vec![a]);
}

#[test]
fn remove_edge_tombstone() {
    let (mut graph, a, b, _) = setup();
    let eid = graph.add_edge(a, b, EdgeKind::Basic);
    graph.remove_edge(eid);
    assert!(graph.edge_between(a, b).is_none());
    assert!(graph.neighbors(a).next().is_none());
    assert!(graph.neighbors(b).next().is_none());
}

#[test]
fn remove_edge_does_not_affect_other_edges() {
    let (mut graph, a, b, c) = setup();
    let eid_ab = graph.add_edge(a, b, EdgeKind::Basic);
    graph.add_edge(b, c, EdgeKind::Basic);
    graph.remove_edge(eid_ab);
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
    let eid_ab = graph.add_edge(a, b, EdgeKind::Basic);
    graph.add_edge(b, c, EdgeKind::Basic);
    graph.remove_edge(eid_ab);
    assert_eq!(graph.edges().count(), 1);
}
