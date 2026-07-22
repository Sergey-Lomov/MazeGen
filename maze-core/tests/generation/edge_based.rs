use maze_core::generation::{generate_maze, EdgeBasedParams};
use maze_core::validation::is_connected;
use super::helpers::*;

#[test]
fn edge_based_same_seed_same_maze() {
    let params = EdgeBasedParams::default();
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 42, start1, edge_based_config(params.clone()), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, edge_based_config(params), &empty_preset());
    assert_eq!(collect_edges(&g1), collect_edges(&g2));
}

#[test]
fn edge_based_traverses_preset_teleport_into_visited() {
    // GitHub issue #226: a preset teleport bridging two otherwise-disconnected halves must be
    // followed by the algorithm, not treated as a dead end.
    let (mut graph, field, start, preset_state, _node_count) = build_with_preset_teleport_bridge();
    generate_maze(&mut graph, &field, 42, start, edge_based_config(EdgeBasedParams::default()), &preset_state);
    assert!(is_connected(&graph, start));
}

#[test]
fn edge_based_traverses_one_way_preset_teleport_into_visited() {
    // GitHub issue #226: a one-way preset teleport must also be traversed, not just the two-way case.
    let (mut graph, field, start, preset_state, _node_count) = build_with_one_way_preset_teleport_bridge();
    generate_maze(&mut graph, &field, 42, start, edge_based_config(EdgeBasedParams::default()), &preset_state);
    assert!(is_connected(&graph, start));
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
    let high_corridor = EdgeBasedParams { corridor_length: 1.0, branching: 0.0, depth_first: 0.0, directionality: 0.0, cyclicity: 0.0 };
    let low_corridor  = EdgeBasedParams { corridor_length: 0.0, branching: 0.0, depth_first: 0.0, directionality: 0.0, cyclicity: 0.0 };
    let (mut g1, f1, start1) = build(10, 10);
    let (mut g2, f2, start2) = build(10, 10);
    generate_maze(&mut g1, &f1, 42, start1, edge_based_config(high_corridor), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, edge_based_config(low_corridor), &empty_preset());
    assert_ne!(collect_edges(&g1), collect_edges(&g2));
}

#[test]
fn edge_based_extreme_params_is_connected() {
    let all_max = EdgeBasedParams {
        corridor_length: 1.0,
        branching:       1.0,
        depth_first:        1.0,
        directionality:  1.0,
        cyclicity:       1.0,
    };
    let all_min = EdgeBasedParams {
        corridor_length: 0.0,
        branching:       0.0,
        depth_first:        0.0,
        directionality:  0.0,
        cyclicity:       0.0,
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

#[test]
fn edge_based_cyclicity_creates_extra_edges() {
    let (mut graph, field, start) = build(6, 6);
    let node_count = graph.nodes().count();
    let params = EdgeBasedParams { cyclicity: 1.0, ..EdgeBasedParams::default() };
    generate_maze(&mut graph, &field, 42, start, edge_based_config(params), &empty_preset());
    assert!(
        graph.edges().count() > 2 * (node_count - 1),
        "cyclicity=1.0 produced no extra edges: edge_count={}",
        graph.edges().count()
    );
}
