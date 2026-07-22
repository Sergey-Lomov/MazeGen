use super::*;
use super::super::test_utils::*;
use super::super::preset_setup_event::PresetSetupEvent;
use crate::space::SquarePoint;
use crate::IdGenerator;
use crate::event_log::EventLog;

fn node_at(field: &Field<crate::space::SquareTessellation>, x: i32, y: i32) -> NodeId {
    field.node_at(SquarePoint { x, y }).unwrap()
}

#[test]
fn build_preset_state_passage_adds_bidirectional_edge_and_marks_connected() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_some());
    assert!(state.preset_connected.contains(&a));
    assert!(state.preset_connected.contains(&b));
}

#[test]
fn build_preset_state_passage_emits_passage_established() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::Passage,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, Some(&mut log));
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let events: Vec<_> = log.finish().iter().copied().collect();
    assert_eq!(events, vec![PresetSetupEvent::PassageEstablished { from: a, to: b }]);
}

#[test]
fn build_preset_state_wall_blocks_both_directions_without_adding_edges() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::Wall,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(a, b).is_none());
    assert!(state.blocked.contains(&(a, b)));
    assert!(state.blocked.contains(&(b, a)));
}

#[test]
fn build_preset_state_wall_emits_no_event() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::Wall,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, Some(&mut log));
    assert!(log.finish().iter().next().is_none());
}

#[test]
fn build_preset_state_one_way_forward_blocks_reverse_only() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::OneWayForward,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_none());
    assert!(state.blocked.contains(&(b, a)));
}

#[test]
fn build_preset_state_one_way_forward_emits_one_way_established_from_a_to_b() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::OneWayForward,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, Some(&mut log));
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let events: Vec<_> = log.finish().iter().copied().collect();
    assert_eq!(events, vec![PresetSetupEvent::OneWayEstablished { from: a, to: b }]);
}

#[test]
fn build_preset_state_one_way_backward_blocks_forward_only() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::OneWayBackward,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
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
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::OneWayBackward,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, Some(&mut log));
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let events: Vec<_> = log.finish().iter().copied().collect();
    assert_eq!(events, vec![PresetSetupEvent::OneWayEstablished { from: b, to: a }]);
}

#[test]
fn build_preset_state_skips_out_of_bounds_points() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (99, 99), to: (1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
    assert!(state.preset_connected.is_empty());
}

#[test]
fn build_preset_state_teleport_forward_adds_single_directed_teleport_edge() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Forward),
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 2, 2);
    let ab = graph.edge_between(a, b).expect("forward teleport edge missing");
    assert_eq!(graph.edge(ab).unwrap().kind, EdgeKind::Teleport);
    assert!(graph.edge_between(b, a).is_none());
    assert!(state.preset_edges.contains(&(a, b)));
    assert!(!state.preset_connected.contains(&a));
    assert!(!state.preset_connected.contains(&b));
    assert_eq!(state.preset_teleports.get(&a), Some(&vec![b]));
    assert!(state.preset_teleports.get(&b).is_none());
}

#[test]
fn build_preset_state_teleport_forward_emits_teleport_established_not_two_way() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Forward),
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, Some(&mut log));
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 2, 2);
    let events: Vec<_> = log.finish().iter().copied().collect();
    assert_eq!(events, vec![PresetSetupEvent::TeleportEstablished { from: a, to: b, two_way: false }]);
}

#[test]
fn build_preset_state_teleport_backward_adds_single_directed_teleport_edge() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Backward),
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 2, 2);
    assert!(graph.edge_between(a, b).is_none());
    let ba = graph.edge_between(b, a).expect("backward teleport edge missing");
    assert_eq!(graph.edge(ba).unwrap().kind, EdgeKind::Teleport);
    assert!(state.preset_edges.contains(&(b, a)));
    assert_eq!(state.preset_teleports.get(&b), Some(&vec![a]));
    assert!(state.preset_teleports.get(&a).is_none());
}

/// Guards the from/to swap at `preset_state.rs`'s `TeleportDirection::Backward` arm, same concern
/// as `OneWayBackward`'s own swap test above.
#[test]
fn build_preset_state_teleport_backward_emits_teleport_established_swapped_not_two_way() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Backward),
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, Some(&mut log));
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 2, 2);
    let events: Vec<_> = log.finish().iter().copied().collect();
    assert_eq!(events, vec![PresetSetupEvent::TeleportEstablished { from: b, to: a, two_way: false }]);
}

#[test]
fn build_preset_state_teleport_two_way_adds_both_directed_teleport_edges() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (2, 2), state: PresetConnectionState::Teleport(TeleportDirection::TwoWay),
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
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
    let (field, mut graph) = make_field_and_graph(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (2, 2), state: PresetConnectionState::Teleport(TeleportDirection::TwoWay),
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, Some(&mut log));
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 2, 2);
    let events: Vec<_> = log.finish().iter().copied().collect();
    assert_eq!(events, vec![PresetSetupEvent::TeleportEstablished { from: a, to: b, two_way: true }]);
}

#[test]
fn build_preset_state_locked_node_both_sets_in_and_out() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let locks = vec![LockedNode { point: (0, 0), kind: NodeLockKind::Both }];
    let state = build_preset_state(&mut graph, &field, &[], &locks, |x, y| SquarePoint { x, y }, None);
    let a = node_at(&field, 0, 0);
    assert!(state.locked_in.contains(&a));
    assert!(state.locked_out.contains(&a));
}

#[test]
fn build_preset_state_locked_node_in_only_sets_locked_in_not_locked_out() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let locks = vec![LockedNode { point: (0, 0), kind: NodeLockKind::In }];
    let state = build_preset_state(&mut graph, &field, &[], &locks, |x, y| SquarePoint { x, y }, None);
    let a = node_at(&field, 0, 0);
    assert!(state.locked_in.contains(&a));
    assert!(!state.locked_out.contains(&a));
}

#[test]
fn build_preset_state_locked_node_out_only_sets_locked_out_not_locked_in() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let locks = vec![LockedNode { point: (0, 0), kind: NodeLockKind::Out }];
    let state = build_preset_state(&mut graph, &field, &[], &locks, |x, y| SquarePoint { x, y }, None);
    let a = node_at(&field, 0, 0);
    assert!(state.locked_out.contains(&a));
    assert!(!state.locked_in.contains(&a));
}

#[test]
fn for_repair_returns_empty_when_qc_experiment() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let locks = vec![LockedNode { point: (0, 0), kind: NodeLockKind::Both }];
    let state = build_preset_state(&mut graph, &field, &[], &locks, |x, y| SquarePoint { x, y }, None);
    let repair_state = state.for_repair(true);
    assert!(repair_state.locked_in.is_empty());
    assert!(repair_state.locked_out.is_empty());
    assert!(repair_state.blocked.is_empty());
    assert!(repair_state.preset_edges.is_empty());
}

#[test]
fn for_repair_returns_self_unchanged_when_not_qc_experiment() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let locks = vec![LockedNode { point: (0, 0), kind: NodeLockKind::Both }];
    let state = build_preset_state(&mut graph, &field, &[], &locks, |x, y| SquarePoint { x, y }, None);
    let a = node_at(&field, 0, 0);
    let repair_state = state.for_repair(false);
    assert!(repair_state.locked_in.contains(&a));
    assert!(repair_state.locked_out.contains(&a));
}

/// GitHub issue #219 — a locked node's point may resolve to more than one NodeId.
#[test]
fn locked_node_on_a_multi_node_point_locks_every_node_at_that_point() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let point = SquarePoint { x: 0, y: 0 };
    let original = field.nodes_at(point)[0];
    let added = field.add_node_at(point, &mut ids);
    graph.add_node(added);

    let locks = vec![LockedNode { point: (0, 0), kind: NodeLockKind::Both }];
    let state = build_preset_state(&mut graph, &field, &[], &locks, |x, y| SquarePoint { x, y }, None);

    assert!(state.locked_in.contains(&original));
    assert!(state.locked_out.contains(&original));
    assert!(state.locked_in.contains(&added));
    assert!(state.locked_out.contains(&added));
}

/// GitHub issue #220 — a preset connection on a multi-node point applies to every node at that
/// point, not just the first (creation-order) one. `Field` has no face/group ownership (GitHub
/// issue #219), so there's no way to pick "the right" node — every node participates.
#[test]
fn preset_connection_on_a_multi_node_point_connects_every_node_at_that_point() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let point = SquarePoint { x: 0, y: 0 };
    let original = field.nodes_at(point)[0];
    let added = field.add_node_at(point, &mut ids);
    graph.add_node(added);

    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);

    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(original, b).is_some());
    assert!(graph.edge_between(b, original).is_some());
    assert!(graph.edge_between(added, b).is_some());
    assert!(graph.edge_between(b, added).is_some());
    assert!(state.preset_connected.contains(&original));
    assert!(state.preset_connected.contains(&added));
    assert!(state.preset_connected.contains(&b));
}

/// GitHub issue #220 — when both endpoints of a preset connection are multi-node points, every
/// (from_id, to_id) combination gets the edge, not just the first node of each side.
#[test]
fn preset_connection_between_two_multi_node_points_connects_every_combination() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let from_point = SquarePoint { x: 0, y: 0 };
    let to_point = SquarePoint { x: 1, y: 0 };
    let from_original = field.nodes_at(from_point)[0];
    let from_added = field.add_node_at(from_point, &mut ids);
    graph.add_node(from_added);
    let to_original = field.nodes_at(to_point)[0];
    let to_added = field.add_node_at(to_point, &mut ids);
    graph.add_node(to_added);

    let presets = vec![PresetConnection {
        from: (0, 0), to: (1, 0), state: PresetConnectionState::Passage,
    }];
    build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);

    for &f in &[from_original, from_added] {
        for &t in &[to_original, to_added] {
            assert!(graph.edge_between(f, t).is_some());
            assert!(graph.edge_between(t, f).is_some());
        }
    }
}
