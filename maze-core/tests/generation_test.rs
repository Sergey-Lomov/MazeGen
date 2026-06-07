use maze_core::{Graph, IdGenerator};
use maze_core::space::{SquareField, SquareRect, ShapedField, Field};
use maze_core::generation::generate_maze;
use maze_core::validation::is_connected;

fn build(width: usize, height: usize) -> (Graph, SquareField, u64) {
    let mut ids = IdGenerator::new();
    let field = ShapedField::new(SquareRect { width, height }, &mut ids);
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let start = field.node_at(maze_core::space::SquarePoint { x: 0, y: 0 }).unwrap();
    (graph, field, start)
}

#[test]
fn same_seed_same_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 42, start1);
    generate_maze(&mut g2, &f2, 42, start2);
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges1, edges2);
}

#[test]
fn different_seed_different_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 1, start1);
    generate_maze(&mut g2, &f2, 2, start2);
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_ne!(edges1, edges2);
}

#[test]
fn generated_maze_is_connected() {
    let (mut graph, field, start) = build(10, 10);
    generate_maze(&mut graph, &field, 99, start);
    // BFS via outgoing edges is valid here because generate_maze uses
    // add_bidirectional_edge exclusively, so all corridors have both directions.
    assert!(is_connected(&graph, start));
}
