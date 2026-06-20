use maze_core::{Graph, IdGenerator, NodeId};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{generate_maze_steps, EdgeBasedParams, GenerationConfig, PresetState, PresetConnection, PresetConnectionState, build_preset_state};
use super::helpers::*;

fn make_preset_state_with_center_cluster(field: &Field<SquareTessellation>, graph: &mut Graph) -> (PresetState, NodeId) {
    // Build a cross: center (0,0) connected to all 4 neighbors via preset passages.
    // start = center (0,0), which is inside preset_connected.
    let presets = vec![
        PresetConnection { from: (0, 0), to: (1, 0), state: PresetConnectionState::Passage },
        PresetConnection { from: (0, 0), to: (-1, 0), state: PresetConnectionState::Passage },
        PresetConnection { from: (0, 0), to: (0, 1), state: PresetConnectionState::Passage },
        PresetConnection { from: (0, 0), to: (0, -1), state: PresetConnectionState::Passage },
    ];
    let preset_state = build_preset_state(graph, field, &presets, &[], |x, y| SquarePoint { x, y });
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    (preset_state, start)
}

#[test]
fn edge_based_start_in_preset_cluster_produces_debug_steps() {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(7, 7), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let (preset_state, start) = make_preset_state_with_center_cluster(&field, &mut graph);
    let config = edge_based_config(EdgeBasedParams::default());
    let steps = generate_maze_steps(&mut graph, &field, 42, start, config, &preset_state);
    assert!(!steps.is_empty(), "no debug steps produced when start is inside preset cluster");
}

#[test]
fn vertex_based_start_in_preset_cluster_produces_debug_steps() {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(7, 7), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let (preset_state, start) = make_preset_state_with_center_cluster(&field, &mut graph);
    let config = GenerationConfig { elements: no_one_way_elements(), ..GenerationConfig::default() };
    let steps = generate_maze_steps(&mut graph, &field, 42, start, config, &preset_state);
    assert!(!steps.is_empty(), "no debug steps produced when start is inside preset cluster");
}
