use maze_core::{Graph, IdGenerator};
use maze_core::graph::EdgeKind;
use maze_core::validation::is_connected;

fn make_graph(n: usize) -> (Graph, Vec<u64>) {
    let mut ids = IdGenerator::new();
    let node_ids: Vec<u64> = (0..n).map(|_| ids.next_id()).collect();
    let mut graph = Graph::new();
    for &id in &node_ids {
        graph.add_node(id);
    }
    (graph, node_ids)
}

#[test]
fn connected_bidirectional_graph() {
    let (mut graph, ids) = make_graph(3);
    graph.add_bidirectional_edge(ids[0], ids[1], EdgeKind::Basic);
    graph.add_bidirectional_edge(ids[1], ids[2], EdgeKind::Basic);
    assert!(is_connected(&graph, ids[0]));
}

#[test]
fn disconnected_graph_returns_false() {
    let (mut graph, ids) = make_graph(3);
    graph.add_bidirectional_edge(ids[0], ids[1], EdgeKind::Basic);
    // ids[2] isolated
    assert!(!is_connected(&graph, ids[0]));
}

#[test]
fn connected_via_incoming_only() {
    // ids[0] → ids[1] → ids[2] (one-way chain)
    // BFS from ids[2] must still reach ids[0] via incoming edges
    let (mut graph, ids) = make_graph(3);
    graph.add_edge(ids[0], ids[1], EdgeKind::Basic);
    graph.add_edge(ids[1], ids[2], EdgeKind::Basic);
    assert!(is_connected(&graph, ids[2]));
}

#[test]
fn empty_graph_is_connected() {
    let graph = Graph::new();
    let mut ids = IdGenerator::new();
    let start = ids.next_id();
    // node not even in graph — total == 0, returns true
    assert!(is_connected(&graph, start));
}

#[test]
fn single_node_is_connected() {
    let (graph, ids) = make_graph(1);
    assert!(is_connected(&graph, ids[0]));
}
