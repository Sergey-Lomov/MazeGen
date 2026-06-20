use maze_core::generation::{generate_maze, GenerationAlgorithm, GenerationConfig, GenerationParams, EdgeBasedParams};
use super::helpers::*;

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
