use maze_core::{Graph, IdGenerator};
use maze_core::space::{SquareField, SquareRect, ShapedField, Field};
use maze_core::generation::generate_maze;
use maze_core::generation::elements::{VertexWeights, GenerationConfig};
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
    generate_maze(&mut g1, &f1, 42, start1, &GenerationConfig::new(VertexWeights::uniform(4), 0.0, 4), &[]);
    generate_maze(&mut g2, &f2, 42, start2, &GenerationConfig::new(VertexWeights::uniform(4), 0.0, 4), &[]);
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges1, edges2);
}

#[test]
fn different_seed_different_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 1, start1, &GenerationConfig::new(VertexWeights::uniform(4), 0.0, 4), &[]);
    generate_maze(&mut g2, &f2, 2, start2, &GenerationConfig::new(VertexWeights::uniform(4), 0.0, 4), &[]);
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_ne!(edges1, edges2);
}

#[test]
fn degree4_graph_is_connected() {
    // With uniform max-degree weights all nodes can reach each other.
    let (mut graph, field, start) = build(10, 10);
    let cfg = GenerationConfig::new(VertexWeights { weights: vec![0.0, 0.0, 0.0, 0.0, 1.0] }, 0.0, 4);
    generate_maze(&mut graph, &field, 99, start, &cfg, &[]);
    assert!(is_connected(&graph, start));
}

#[test]
fn degree1_graph_may_be_disconnected() {
    // With target=1 for all nodes the generator produces isolated pairs/chains.
    // Connectivity is not guaranteed — that is intentional.
    let (mut graph, field, start) = build(5, 5);
    let cfg = GenerationConfig::new(VertexWeights { weights: vec![0.0, 1.0, 0.0, 0.0, 0.0] }, 0.0, 4);
    generate_maze(&mut graph, &field, 42, start, &cfg, &[]);
    // Just check it doesn't panic and produces some edges.
    let edge_count = graph.edges().count();
    assert!(edge_count > 0);
}

#[test]
fn all_degree4_weights_produces_dense_graph() {
    // 5x5 grid, 100% weight on degree=4. Interior nodes should have degree 4.
    // Edge count must be much higher than spanning tree (N*N - 1 = 24).
    let (mut graph, field, start) = build(5, 5);
    let cfg = GenerationConfig::new(VertexWeights { weights: vec![0.0, 0.0, 0.0, 0.0, 1.0] }, 0.0, 4);
    generate_maze(&mut graph, &field, 42, start, &cfg, &[]);

    // count bidirectional pairs
    let node_ids: Vec<_> = graph.nodes().map(|n| n.id).collect();
    let mut pair_count = 0usize;
    for &a in &node_ids {
        for b in graph.outgoing_neighbors(a).collect::<Vec<_>>() {
            if b > a && graph.edge_between(b, a).is_some() {
                pair_count += 1;
            }
        }
    }
    eprintln!("bidirectional pairs: {pair_count} (spanning tree would be 24)");

    // interior nodes (not on border) should all have degree 4
    let inner_degrees: Vec<usize> = node_ids.iter()
        .map(|&n| graph.bidirectional_degree(n))
        .filter(|&d| d == 4)
        .collect();
    eprintln!("nodes with degree 4: {}", inner_degrees.len());

    // at minimum, far more edges than spanning tree
    assert!(pair_count > 24, "expected dense graph, got only {pair_count} pairs");
}
