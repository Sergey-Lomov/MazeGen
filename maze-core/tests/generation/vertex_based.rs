use maze_core::generation::{generate_maze, GenerationParams, ElementsConfig};
use maze_core::validation::is_connected;
use super::helpers::*;

#[test]
fn same_seed_same_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 42, start1, default_config(), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, default_config(), &empty_preset());
    assert_eq!(collect_edges(&g1), collect_edges(&g2));
}

#[test]
fn different_seed_different_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 1, start1, default_config(), &empty_preset());
    generate_maze(&mut g2, &f2, 2, start2, default_config(), &empty_preset());
    assert_ne!(collect_edges(&g1), collect_edges(&g2));
}

#[test]
fn traverses_preset_teleport_into_visited() {
    // GitHub issue #226: a preset teleport bridging two otherwise-disconnected halves must be
    // followed by the algorithm, not treated as a dead end.
    let (mut graph, field, start, preset_state, _node_count) = build_with_preset_teleport_bridge();
    generate_maze(&mut graph, &field, 42, start, default_config(), &preset_state);
    assert!(is_connected(&graph, start));
}

#[test]
fn traverses_one_way_preset_teleport_into_visited() {
    // GitHub issue #226: a one-way preset teleport must also be traversed, not just the two-way case.
    let (mut graph, field, start, preset_state, _node_count) = build_with_one_way_preset_teleport_bridge();
    generate_maze(&mut graph, &field, 42, start, default_config(), &preset_state);
    assert!(is_connected(&graph, start));
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
        cyclicity:       1.0,
    };
    let all_min = GenerationParams {
        depth_first:     0.0,
        corridor_chance: 0.0,
        branching:       0.0,
        directionality:  0.0,
        cyclicity:       0.0,
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
        cyclicity:       0.0,
    };
    let low_branching = GenerationParams {
        depth_first:     0.0,
        corridor_chance: 1.0,
        branching:       0.0,
        directionality:  0.0,
        cyclicity:       0.0,
    };
    let (mut g1, f1, start1) = build(10, 10);
    let (mut g2, f2, start2) = build(10, 10);
    generate_maze(&mut g1, &f1, 42, start1, config_with_params(high_branching), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, config_with_params(low_branching), &empty_preset());
    assert_ne!(collect_edges(&g1), collect_edges(&g2));
}

#[test]
fn generated_maze_is_connected_with_all_one_way_edges() {
    let elements = ElementsConfig { one_way_chance: 1.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 };
    for seed in [1, 42, 99, 1234, 9999] {
        let (mut graph, field, start) = build(8, 8);
        generate_maze(&mut graph, &field, seed, start, config_with_elements(elements.clone()), &empty_preset());
        assert!(
            is_connected(&graph, start),
            "seed={seed}: maze with one_way_chance=1.0 is not connected"
        );
    }
}

#[test]
fn vertex_based_cyclicity_creates_extra_edges() {
    let (mut graph, field, start) = build(6, 6);
    let node_count = graph.nodes().count();
    let params = GenerationParams { cyclicity: 1.0, ..GenerationParams::default() };
    generate_maze(&mut graph, &field, 42, start, config_with_params(params), &empty_preset());
    assert!(
        graph.edges().count() > 2 * (node_count - 1),
        "cyclicity=1.0 produced no extra edges: edge_count={}",
        graph.edges().count()
    );
}
