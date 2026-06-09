use maze_core::{Graph, IdGenerator};
use maze_core::space::{SquareField, SquareRect, SquarePoint, ShapedField, Field};
use maze_core::generation::{generate_maze, GenerationParams, ElementsConfig, GenerationConfig, GenerationAlgorithm};
use maze_core::validation::is_connected;

fn build(width: usize, height: usize) -> (Graph, SquareField, u64) {
    let mut ids = IdGenerator::new();
    let field = ShapedField::new(SquareRect { width, height }, &mut ids);
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    (graph, field, start)
}

fn default_config() -> GenerationConfig {
    GenerationConfig::default()
}

fn config_with_params(params: GenerationParams) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomVertexBased(params),
        elements: ElementsConfig { one_way_chance: 0.0 },
    }
}

fn config_with_elements(elements: ElementsConfig) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
        elements,
    }
}

#[test]
fn same_seed_same_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 42, start1, default_config());
    generate_maze(&mut g2, &f2, 42, start2, default_config());
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges1, edges2);
}

#[test]
fn different_seed_different_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 1, start1, default_config());
    generate_maze(&mut g2, &f2, 2, start2, default_config());
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_ne!(edges1, edges2);
}

#[test]
fn generated_maze_is_connected() {
    let (mut graph, field, start) = build(10, 10);
    generate_maze(&mut graph, &field, 99, start, default_config());
    assert!(is_connected(&graph, start));
}

#[test]
fn generated_maze_edges_only_connect_field_neighbors() {
    for seed in [42, 1, 2, 3, 99, 1234, 9999] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, default_config());
        for edge in graph.edges() {
            let neighbors = field.neighbors(edge.from);
            assert!(
                neighbors.contains(&edge.to),
                "seed={seed}: edge connects non-adjacent nodes: {} -> {} (not field neighbors)",
                edge.from, edge.to
            );
        }
    }
}

#[test]
fn generate_maze_with_extreme_params_is_connected() {
    let all_max = GenerationParams {
        depth_first:     1.0,
        corridor_chance: 1.0,
        branching:       1.0,
        directionality:  1.0,
    };
    let all_min = GenerationParams {
        depth_first:     0.0,
        corridor_chance: 0.0,
        branching:       0.0,
        directionality:  0.0,
    };
    let (mut g1, f1, start1) = build(10, 10);
    let (mut g2, f2, start2) = build(10, 10);
    generate_maze(&mut g1, &f1, 42, start1, config_with_params(all_max));
    generate_maze(&mut g2, &f2, 42, start2, config_with_params(all_min));
    assert!(is_connected(&g1, start1));
    assert!(is_connected(&g2, start2));
}

#[test]
fn generate_maze_params_affect_structure() {
    let high_branching = GenerationParams {
        depth_first:     0.0,
        corridor_chance: 0.0,
        branching:       1.0,
        directionality:  0.0,
    };
    let low_branching = GenerationParams {
        depth_first:     0.0,
        corridor_chance: 1.0,
        branching:       0.0,
        directionality:  0.0,
    };
    let (mut g1, f1, start1) = build(10, 10);
    let (mut g2, f2, start2) = build(10, 10);
    generate_maze(&mut g1, &f1, 42, start1, config_with_params(high_branching));
    generate_maze(&mut g2, &f2, 42, start2, config_with_params(low_branching));
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_ne!(edges1, edges2);
}

#[test]
fn generated_maze_is_connected_with_all_one_way_edges() {
    let elements = ElementsConfig { one_way_chance: 1.0 };
    for seed in [1, 42, 99, 1234, 9999] {
        let (mut graph, field, start) = build(8, 8);
        generate_maze(&mut graph, &field, seed, start, config_with_elements(elements.clone()));
        assert!(
            is_connected(&graph, start),
            "seed={seed}: maze with one_way_chance=1.0 is not connected"
        );
    }
}

fn kruskal_config() -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::KruskalAlgorithm,
        elements: ElementsConfig { one_way_chance: 0.0 },
    }
}

#[test]
fn kruskal_is_connected() {
    for seed in [1, 42, 99, 1234, 9999] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, kruskal_config());
        assert!(is_connected(&graph, start), "seed={seed}: kruskal maze is not connected");
    }
}

#[test]
fn kruskal_edges_only_connect_field_neighbors() {
    for seed in [42, 1, 99] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, kruskal_config());
        for edge in graph.edges() {
            let neighbors = field.neighbors(edge.from);
            assert!(
                neighbors.contains(&edge.to),
                "seed={seed}: kruskal edge connects non-adjacent nodes: {} -> {}",
                edge.from, edge.to
            );
        }
    }
}

#[test]
fn kruskal_same_seed_same_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 42, start1, kruskal_config());
    generate_maze(&mut g2, &f2, 42, start2, kruskal_config());
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges1, edges2);
}
