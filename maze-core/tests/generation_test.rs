use maze_core::{Graph, IdGenerator};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationParams, EdgeBasedParams, ElementsConfig, GenerationConfig, GenerationAlgorithm, PresetState};

fn empty_preset() -> PresetState { PresetState::empty() }
use maze_core::validation::is_connected;

fn build(width: usize, height: usize) -> (Graph, Field<SquareTessellation>, u64) {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(width, height), &mut ids).unwrap();
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
        ..GenerationConfig::default()
    }
}

fn config_with_elements(elements: ElementsConfig) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
        elements,
        ..GenerationConfig::default()
    }
}

#[test]
fn same_seed_same_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 42, start1, default_config(), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, default_config(), &empty_preset());
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges1, edges2);
}

#[test]
fn different_seed_different_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 1, start1, default_config(), &empty_preset());
    generate_maze(&mut g2, &f2, 2, start2, default_config(), &empty_preset());
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_ne!(edges1, edges2);
}

#[test]
fn generated_maze_is_connected() {
    let (mut graph, field, start) = build(10, 10);
    generate_maze(&mut graph, &field, 99, start, default_config(), &empty_preset());
    assert!(is_connected(&graph, start));
}

#[test]
fn generated_maze_edges_only_connect_field_neighbors() {
    for seed in [42, 1, 2, 3, 99, 1234, 9999] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, default_config(), &empty_preset());
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
    generate_maze(&mut g1, &f1, 42, start1, config_with_params(all_max), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, config_with_params(all_min), &empty_preset());
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
    generate_maze(&mut g1, &f1, 42, start1, config_with_params(high_branching), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, config_with_params(low_branching), &empty_preset());
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_ne!(edges1, edges2);
}

#[test]
fn generated_maze_is_connected_with_all_one_way_edges() {
    let elements = ElementsConfig { one_way_chance: 1.0 };
    for seed in [1, 42, 99, 1234, 9999] {
        let (mut graph, field, start) = build(8, 8);
        generate_maze(&mut graph, &field, seed, start, config_with_elements(elements.clone()), &empty_preset());
        assert!(
            is_connected(&graph, start),
            "seed={seed}: maze with one_way_chance=1.0 is not connected"
        );
    }
}

fn no_one_way_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0 } }

fn assert_perfect_maze(graph: &maze_core::Graph, node_count: usize) {
    assert_eq!(graph.edges().count(), 2 * (node_count - 1),
        "expected perfect maze: 2*(node_count-1) directed edges");
}

fn assert_deterministic(g1: &maze_core::Graph, g2: &maze_core::Graph) {
    let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    e1.sort();
    e2.sort();
    assert_eq!(e1, e2, "same seed produced different graphs");
}

// --- generate_maze dispatch ---

#[test]
fn generate_maze_dispatches_all_algorithms() {
    let algorithms = vec![
        GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
        GenerationAlgorithm::CustomEdgeBased(EdgeBasedParams::default()),
        GenerationAlgorithm::RecursiveBacktracker,
        GenerationAlgorithm::WilsonAlgorithm,
        GenerationAlgorithm::KruskalAlgorithm,
    ];
    for algo in algorithms {
        let (mut graph, field, start) = build(4, 4);
        let node_count = graph.nodes().count();
        let config = GenerationConfig { algorithm: algo, elements: no_one_way_elements(), ..GenerationConfig::default() };
        generate_maze(&mut graph, &field, 42, start, config, &empty_preset());
        assert_perfect_maze(&graph, node_count);
    }
}

// --- RecursiveBacktracker ---

#[test]
fn recursive_backtracker_visits_all_nodes() {
    let (mut graph, field, start) = build(5, 5);
    let node_count = graph.nodes().count();
    generate_maze(&mut graph, &field, 42, start, GenerationConfig {
        algorithm: GenerationAlgorithm::RecursiveBacktracker,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn recursive_backtracker_is_deterministic() {
    let (mut g1, f1, s1) = build(4, 4);
    let (mut g2, f2, s2) = build(4, 4);
    let config = || GenerationConfig { algorithm: GenerationAlgorithm::RecursiveBacktracker, elements: no_one_way_elements(), ..GenerationConfig::default() };
    generate_maze(&mut g1, &f1, 7, s1, config(), &empty_preset());
    generate_maze(&mut g2, &f2, 7, s2, config(), &empty_preset());
    assert_deterministic(&g1, &g2);
}

// --- Wilson ---

#[test]
fn wilson_visits_all_nodes() {
    let (mut graph, field, start) = build(5, 5);
    let node_count = graph.nodes().count();
    generate_maze(&mut graph, &field, 42, start, GenerationConfig {
        algorithm: GenerationAlgorithm::WilsonAlgorithm,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn wilson_is_deterministic() {
    let (mut g1, f1, s1) = build(4, 4);
    let (mut g2, f2, s2) = build(4, 4);
    let config = || GenerationConfig { algorithm: GenerationAlgorithm::WilsonAlgorithm, elements: no_one_way_elements(), ..GenerationConfig::default() };
    generate_maze(&mut g1, &f1, 7, s1, config(), &empty_preset());
    generate_maze(&mut g2, &f2, 7, s2, config(), &empty_preset());
    assert_deterministic(&g1, &g2);
}

// --- Kruskal ---

fn kruskal_config() -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::KruskalAlgorithm,
        elements: ElementsConfig { one_way_chance: 0.0 },
        ..GenerationConfig::default()
    }
}

#[test]
fn kruskal_visits_all_nodes() {
    let (mut graph, field, start) = build(5, 5);
    let node_count = graph.nodes().count();
    generate_maze(&mut graph, &field, 42, start, kruskal_config(), &empty_preset());
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn kruskal_is_connected() {
    for seed in [1, 42, 99, 1234, 9999] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, kruskal_config(), &empty_preset());
        assert!(is_connected(&graph, start), "seed={seed}: kruskal maze is not connected");
    }
}

#[test]
fn kruskal_edges_only_connect_field_neighbors() {
    for seed in [42, 1, 99] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, kruskal_config(), &empty_preset());
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
    generate_maze(&mut g1, &f1, 42, start1, kruskal_config(), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, kruskal_config(), &empty_preset());
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges1, edges2);
}

fn edge_based_config(params: EdgeBasedParams) -> GenerationConfig {
    GenerationConfig {
        algorithm: GenerationAlgorithm::CustomEdgeBased(params),
        elements: ElementsConfig { one_way_chance: 0.0 },
        ..GenerationConfig::default()
    }
}

#[test]
fn edge_based_same_seed_same_maze() {
    let params = EdgeBasedParams::default();
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 42, start1, edge_based_config(params.clone()), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, edge_based_config(params), &empty_preset());
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges1, edges2);
}

#[test]
fn edge_based_is_connected() {
    for seed in [1, 42, 99, 1234, 9999] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, edge_based_config(EdgeBasedParams::default()), &empty_preset());
        assert!(is_connected(&graph, start), "seed={seed}: edge_based maze not connected");
    }
}

#[test]
fn edge_based_params_affect_structure() {
    let high_corridor = EdgeBasedParams { corridor_length: 1.0, branching: 0.0, depth_first: 0.0, directionality: 0.0 };
    let low_corridor  = EdgeBasedParams { corridor_length: 0.0, branching: 0.0, depth_first: 0.0, directionality: 0.0 };
    let (mut g1, f1, start1) = build(10, 10);
    let (mut g2, f2, start2) = build(10, 10);
    generate_maze(&mut g1, &f1, 42, start1, edge_based_config(high_corridor), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, edge_based_config(low_corridor), &empty_preset());
    let edges1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let edges2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    assert_ne!(edges1, edges2);
}

#[test]
fn edge_based_extreme_params_is_connected() {
    let all_max = EdgeBasedParams {
        corridor_length: 1.0,
        branching:       1.0,
        depth_first:        1.0,
        directionality:  1.0,
    };
    let all_min = EdgeBasedParams {
        corridor_length: 0.0,
        branching:       0.0,
        depth_first:        0.0,
        directionality:  0.0,
    };
    for seed in [1, 42, 99] {
        let (mut g1, f1, start1) = build(10, 10);
        let (mut g2, f2, start2) = build(10, 10);
        generate_maze(&mut g1, &f1, seed, start1, edge_based_config(all_max.clone()), &empty_preset());
        generate_maze(&mut g2, &f2, seed, start2, edge_based_config(all_min.clone()), &empty_preset());
        assert!(is_connected(&g1, start1), "seed={seed}: all_max not connected");
        assert!(is_connected(&g2, start2), "seed={seed}: all_min not connected");
    }
}
