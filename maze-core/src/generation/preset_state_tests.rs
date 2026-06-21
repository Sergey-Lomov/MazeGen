use super::*;
use super::super::test_utils::*;
use crate::space::SquarePoint;

fn node_at(field: &Field<crate::space::SquareTessellation>, x: i32, y: i32) -> NodeId {
    field.node_at(SquarePoint { x, y }).unwrap()
}

#[test]
fn build_preset_state_passage_adds_bidirectional_edge_and_marks_connected() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y });
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_some());
    assert!(state.preset_connected.contains(&a));
    assert!(state.preset_connected.contains(&b));
}

#[test]
fn build_preset_state_wall_blocks_both_directions_without_adding_edges() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::Wall,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y });
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(a, b).is_none());
    assert!(state.blocked.contains(&(a, b)));
    assert!(state.blocked.contains(&(b, a)));
}

#[test]
fn build_preset_state_one_way_forward_blocks_reverse_only() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::OneWayForward,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y });
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_none());
    assert!(state.blocked.contains(&(b, a)));
}

#[test]
fn build_preset_state_skips_out_of_bounds_points() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (99, 99), to: (1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y });
    assert!(state.preset_connected.is_empty());
}

#[test]
fn build_preset_state_locked_node_both_sets_in_and_out() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let locks = vec![LockedNode { point: (0, 0), kind: NodeLockKind::Both }];
    let state = build_preset_state(&mut graph, &field, &[], &locks, |x, y| SquarePoint { x, y });
    let a = node_at(&field, 0, 0);
    assert!(state.locked_in.contains(&a));
    assert!(state.locked_out.contains(&a));
}
