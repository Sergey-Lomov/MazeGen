use super::*;

#[test]
fn build_preset_state_passage_adds_bidirectional_edge_and_marks_connected() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(1, 0),
        state: PresetConnectionState::Passage,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &[],
        None,
    )
    .unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_some());
    assert!(state.preset_connected.contains(&a));
    assert!(state.preset_connected.contains(&b));
}

#[test]
fn build_preset_state_passage_emits_passage_established() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(1, 0),
        state: PresetConnectionState::Passage,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &[],
        Some(&mut log),
    )
    .unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(
        events,
        vec![PresetSetupEvent::PassageEstablished { from: a, to: b }]
    );
}

#[test]
fn build_preset_state_wall_blocks_both_directions_without_adding_edges() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(1, 0),
        state: PresetConnectionState::Wall,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &[],
        None,
    )
    .unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(a, b).is_none());
    assert!(state.blocked.contains(&(a, b)));
    assert!(state.blocked.contains(&(b, a)));
}

#[test]
fn build_preset_state_wall_emits_no_event() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(1, 0),
        state: PresetConnectionState::Wall,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &[],
        Some(&mut log),
    )
    .unwrap();
    assert!(log.finish().iter().next().is_none());
}

#[test]
fn build_preset_state_one_way_forward_blocks_reverse_only() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(1, 0),
        state: PresetConnectionState::OneWayForward,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &[],
        None,
    )
    .unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_none());
    assert!(state.blocked.contains(&(b, a)));
}

#[test]
fn build_preset_state_one_way_forward_emits_one_way_established_from_a_to_b() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(1, 0),
        state: PresetConnectionState::OneWayForward,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &[],
        Some(&mut log),
    )
    .unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(
        events,
        vec![PresetSetupEvent::OneWayEstablished { from: a, to: b }]
    );
}

#[test]
fn build_preset_state_one_way_backward_blocks_forward_only() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(1, 0),
        state: PresetConnectionState::OneWayBackward,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &[],
        None,
    )
    .unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(b, a).is_some());
    assert!(graph.edge_between(a, b).is_none());
    assert!(state.blocked.contains(&(a, b)));
}

/// Guards the from/to swap at `preset_state.rs`'s `OneWayBackward` arm: the graph edge actually
/// runs `to_id -> from_id` (the preset's own `to` point is where the passage originates), so the
/// narrated event must carry the same already-swapped direction, not the preset's raw `from`/`to`.
#[test]
fn build_preset_state_one_way_backward_emits_one_way_established_from_b_to_a() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(1, 0),
        state: PresetConnectionState::OneWayBackward,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &[],
        Some(&mut log),
    )
    .unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(
        events,
        vec![PresetSetupEvent::OneWayEstablished { from: b, to: a }]
    );
}

#[test]
fn build_preset_state_rejects_out_of_bounds_points() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(99, 99),
        to: original(1, 0),
        state: PresetConnectionState::Passage,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &[],
        None,
    );
    assert_eq!(
        state.err(),
        Some("preset endpoint references unknown point [99, 99] on level 0".to_string())
    );
}
