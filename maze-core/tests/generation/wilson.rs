use maze_core::generation::{generate_maze, GenerationAlgorithm, GenerationConfig};
use super::helpers::*;

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
