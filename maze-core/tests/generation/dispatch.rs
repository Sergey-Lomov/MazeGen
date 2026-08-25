use maze_core::generation::{generate_maze, GenerationAlgorithm, GenerationConfig, GenerationParams};
use super::helpers::*;

#[test]
fn generate_maze_dispatches_all_algorithms() {
    let algorithms = vec![
        GenerationAlgorithm::CustomVertexBased(GenerationParams::default()),
        GenerationAlgorithm::RecursiveBacktracker,
        GenerationAlgorithm::WilsonAlgorithm,
        GenerationAlgorithm::KruskalAlgorithm,
    ];
    for algo in algorithms {
        let (mut graph, mut field, start, mut ids) = build_with_ids(4, 4);
        let node_count = graph.nodes().count();
        let config = GenerationConfig { algorithm: algo, elements: no_one_way_elements(), ..GenerationConfig::default() };
        generate_maze(&mut graph, &mut field, &mut ids, 42, start, config, &empty_preset());
        assert_perfect_maze(&graph, node_count);
    }
}
