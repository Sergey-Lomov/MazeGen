use super::*;

#[test]
fn build_preset_state_teleport_forward_adds_single_directed_teleport_edge() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(2, 2),
        state: PresetConnectionState::Teleport(TeleportDirection::Forward),
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
    let b = node_at(&field, 2, 2);
    let ab = graph
        .edge_between(a, b)
        .expect("forward teleport edge missing");
    assert_eq!(graph.edge(ab).unwrap().kind, EdgeKind::Teleport);
    assert!(graph.edge_between(b, a).is_none());
    assert!(state.preset_edges.contains(&(a, b)));
    assert!(!state.preset_connected.contains(&a));
    assert!(!state.preset_connected.contains(&b));
    assert_eq!(state.preset_teleports.get(&a), Some(&vec![b]));
    assert!(!state.preset_teleports.contains_key(&b));
}

#[test]
fn build_preset_state_teleport_forward_emits_teleport_established_not_two_way() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(2, 2),
        state: PresetConnectionState::Teleport(TeleportDirection::Forward),
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
    let b = node_at(&field, 2, 2);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(
        events,
        vec![PresetSetupEvent::TeleportEstablished {
            from: a,
            to: b,
            two_way: false
        }]
    );
}

#[test]
fn build_preset_state_teleport_backward_adds_single_directed_teleport_edge() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(2, 2),
        state: PresetConnectionState::Teleport(TeleportDirection::Backward),
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
    let b = node_at(&field, 2, 2);
    assert!(graph.edge_between(a, b).is_none());
    let ba = graph
        .edge_between(b, a)
        .expect("backward teleport edge missing");
    assert_eq!(graph.edge(ba).unwrap().kind, EdgeKind::Teleport);
    assert!(state.preset_edges.contains(&(b, a)));
    assert_eq!(state.preset_teleports.get(&b), Some(&vec![a]));
    assert!(!state.preset_teleports.contains_key(&a));
}

/// Guards the from/to swap at `preset_state.rs`'s `TeleportDirection::Backward` arm, same concern
/// as `OneWayBackward`'s own swap test above.
#[test]
fn build_preset_state_teleport_backward_emits_teleport_established_swapped_not_two_way() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(2, 2),
        state: PresetConnectionState::Teleport(TeleportDirection::Backward),
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
    let b = node_at(&field, 2, 2);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(
        events,
        vec![PresetSetupEvent::TeleportEstablished {
            from: b,
            to: a,
            two_way: false
        }]
    );
}

#[test]
fn build_preset_state_teleport_two_way_adds_both_directed_teleport_edges() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(2, 2),
        state: PresetConnectionState::Teleport(TeleportDirection::TwoWay),
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
    let b = node_at(&field, 2, 2);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_some());
    assert!(state.preset_edges.contains(&(a, b)));
    assert!(state.preset_edges.contains(&(b, a)));
    assert_eq!(state.preset_teleports.get(&a), Some(&vec![b]));
    assert_eq!(state.preset_teleports.get(&b), Some(&vec![a]));
}

#[test]
fn build_preset_state_teleport_two_way_emits_one_event_with_two_way_true() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0),
        to: original(2, 2),
        state: PresetConnectionState::Teleport(TeleportDirection::TwoWay),
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
    let b = node_at(&field, 2, 2);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(
        events,
        vec![PresetSetupEvent::TeleportEstablished {
            from: a,
            to: b,
            two_way: true
        }]
    );
}
