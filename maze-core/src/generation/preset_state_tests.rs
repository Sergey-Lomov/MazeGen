use super::*;
use super::super::test_utils::*;
use super::super::preset_setup_event::PresetSetupEvent;
use crate::space::SquarePoint;
use crate::IdGenerator;
use crate::event_log::EventLog;

fn node_at(field: &MultiLevelField<crate::space::SquareTessellation>, x: i32, y: i32) -> NodeId {
    let level = field.single_level_id();
    field.node_at(level, SquarePoint { x, y }).unwrap()
}

fn original(x: i32, y: i32) -> PresetEndpoint {
    PresetEndpoint::original((x, y))
}

fn split(x: i32, y: i32, slot: u32) -> PresetEndpoint {
    PresetEndpoint { point: (x, y), slot: Some(slot), level: None }
}

#[test]
fn build_preset_state_passage_adds_bidirectional_edge_and_marks_connected() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
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
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::Passage,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(events, vec![PresetSetupEvent::PassageEstablished { from: a, to: b }]);
}

#[test]
fn build_preset_state_wall_blocks_both_directions_without_adding_edges() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::Wall,
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
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
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::Wall,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    assert!(log.finish().iter().next().is_none());
}

#[test]
fn build_preset_state_one_way_forward_blocks_reverse_only() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::OneWayForward,
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
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
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::OneWayForward,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(events, vec![PresetSetupEvent::OneWayEstablished { from: a, to: b }]);
}

#[test]
fn build_preset_state_one_way_backward_blocks_forward_only() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::OneWayBackward,
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
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
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::OneWayBackward,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(events, vec![PresetSetupEvent::OneWayEstablished { from: b, to: a }]);
}

#[test]
fn build_preset_state_skips_out_of_bounds_points() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(99, 99), to: original(1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    assert!(state.preset_connected.is_empty());
}

#[test]
fn build_preset_state_teleport_forward_adds_single_directed_teleport_edge() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Forward),
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
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
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Forward),
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 2, 2);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(events, vec![PresetSetupEvent::TeleportEstablished { from: a, to: b, two_way: false }]);
}

#[test]
fn build_preset_state_teleport_backward_adds_single_directed_teleport_edge() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Backward),
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
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
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Backward),
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 2, 2);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(events, vec![PresetSetupEvent::TeleportEstablished { from: b, to: a, two_way: false }]);
}

#[test]
fn build_preset_state_teleport_two_way_adds_both_directed_teleport_edges() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(2, 2), state: PresetConnectionState::Teleport(TeleportDirection::TwoWay),
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
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
        from: original(0, 0), to: original(2, 2), state: PresetConnectionState::Teleport(TeleportDirection::TwoWay),
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 2, 2);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(events, vec![PresetSetupEvent::TeleportEstablished { from: a, to: b, two_way: true }]);
}

#[test]
fn build_preset_state_locked_node_both_sets_in_and_out() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let locks = vec![LockedNode { point: original(0, 0), kind: NodeLockKind::Both }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &locks, &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let a = node_at(&field, 0, 0);
    assert!(state.locked_in.contains(&a));
    assert!(state.locked_out.contains(&a));
}

#[test]
fn build_preset_state_locked_node_in_only_sets_locked_in_not_locked_out() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let locks = vec![LockedNode { point: original(0, 0), kind: NodeLockKind::In }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &locks, &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let a = node_at(&field, 0, 0);
    assert!(state.locked_in.contains(&a));
    assert!(!state.locked_out.contains(&a));
}

#[test]
fn build_preset_state_locked_node_out_only_sets_locked_out_not_locked_in() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let locks = vec![LockedNode { point: original(0, 0), kind: NodeLockKind::Out }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &locks, &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let a = node_at(&field, 0, 0);
    assert!(state.locked_out.contains(&a));
    assert!(!state.locked_in.contains(&a));
}

#[test]
fn for_repair_returns_empty_when_qc_experiment() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let locks = vec![LockedNode { point: original(0, 0), kind: NodeLockKind::Both }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &locks, &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let repair_state = state.for_repair(true);
    assert!(repair_state.locked_in.is_empty());
    assert!(repair_state.locked_out.is_empty());
    assert!(repair_state.blocked.is_empty());
    assert!(repair_state.preset_edges.is_empty());
}

#[test]
fn for_repair_returns_self_unchanged_when_not_qc_experiment() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let locks = vec![LockedNode { point: original(0, 0), kind: NodeLockKind::Both }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &locks, &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let a = node_at(&field, 0, 0);
    let repair_state = state.for_repair(false);
    assert!(repair_state.locked_in.contains(&a));
    assert!(repair_state.locked_out.contains(&a));
}

/// GitHub issue #219 — a locked node's point may resolve to more than one NodeId. Locking without
/// a `slot` (the original node, GitHub issue #231's decision) now locks only that one node — the
/// added extra node is untouched, unlike the old broadcast-to-every-node behavior.
#[test]
fn locked_node_on_a_multi_node_point_without_slot_locks_only_the_original_node() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let level = field.single_level_id();
    let point = SquarePoint { x: 0, y: 0 };
    let original_id = field.nodes_at(level, point)[0];
    let added = field.add_node_at(level, point, &mut ids);
    graph.add_node(added);

    let locks = vec![LockedNode { point: original(0, 0), kind: NodeLockKind::Both }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &locks, &[], |x, y| SquarePoint { x, y }, None, None).unwrap();

    assert!(state.locked_in.contains(&original_id));
    assert!(state.locked_out.contains(&original_id));
    assert!(!state.locked_in.contains(&added));
    assert!(!state.locked_out.contains(&added));
}

/// GitHub issue #231 — a lock explicitly addressing a declared split slot locks only that node.
#[test]
fn locked_node_addressing_a_declared_slot_locks_only_that_node() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);

    let locks = vec![LockedNode { point: split(0, 0, 0), kind: NodeLockKind::Both }];
    let split_points = vec![((0, 0), 0, 0)];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &locks, &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap();

    let point = SquarePoint { x: 0, y: 0 };
    let original_id = field.nodes_at(field.single_level_id(), point)[0];
    let added_id = field.nodes_at(field.single_level_id(), point)[1];
    assert!(!state.locked_in.contains(&original_id));
    assert!(state.locked_in.contains(&added_id));
    assert!(state.locked_out.contains(&added_id));
}

/// GitHub issue #231 — a preset connection without a `slot` resolves to exactly one node (the
/// original), not a broadcast across every node at the point. This replaces #220's old
/// broadcast-to-every-combination test now that presets can address a specific split node.
#[test]
fn preset_connection_without_slot_connects_only_the_original_node() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let level = field.single_level_id();
    let point = SquarePoint { x: 0, y: 0 };
    let original_id = field.nodes_at(level, point)[0];
    let added = field.add_node_at(level, point, &mut ids);
    graph.add_node(added);

    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();

    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(original_id, b).is_some());
    assert!(graph.edge_between(b, original_id).is_some());
    assert!(graph.edge_between(added, b).is_none());
    assert!(graph.edge_between(b, added).is_none());
    assert!(state.preset_connected.contains(&original_id));
    assert!(!state.preset_connected.contains(&added));
}

/// GitHub issue #231 — a preset connection explicitly addressing a declared split slot connects
/// only that node, leaving the original node untouched.
#[test]
fn preset_connection_addressing_a_declared_slot_connects_only_that_node() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);

    let presets = vec![PresetConnection {
        from: split(0, 0, 0), to: original(1, 0), state: PresetConnectionState::Passage,
    }];
    let split_points = vec![((0, 0), 0, 0)];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap();

    let point = SquarePoint { x: 0, y: 0 };
    let original_id = field.nodes_at(field.single_level_id(), point)[0];
    let added_id = field.nodes_at(field.single_level_id(), point)[1];
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(original_id, b).is_none());
    assert!(graph.edge_between(added_id, b).is_some());
    assert!(state.preset_connected.contains(&added_id));
    assert!(!state.preset_connected.contains(&original_id));
}

/// A preset addressing a slot that was never declared in `split_points` resolves to nothing and
/// is silently skipped — same "unresolvable endpoint" handling as an out-of-bounds point.
#[test]
fn preset_connection_addressing_an_undeclared_slot_is_skipped() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);

    let presets = vec![PresetConnection {
        from: split(0, 0, 0), to: original(1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    assert!(state.preset_connected.is_empty());
}

/// GitHub issue #231 — `split_points` is applied via `add_node_at` in `(point, slot)`-sorted
/// order regardless of the order entries appear in the input slice, so the resulting `NodeId` for
/// a given `(point, slot)` pair doesn't depend on payload transport order.
#[test]
fn split_points_creates_identical_nodes_regardless_of_input_order() {
    let (mut field1, mut graph1) = make_field_and_graph(3, 3);
    let mut ids1 = IdGenerator::resume_after(&field1);
    let split_points_a = vec![((0, 0), 2, 0), ((0, 0), 0, 0), ((0, 0), 1, 0)];
    build_preset_state(&mut graph1, &mut field1, &mut ids1, &[], &[], &[], &[], &split_points_a, |x, y| SquarePoint { x, y }, None, None).unwrap();

    let (mut field2, mut graph2) = make_field_and_graph(3, 3);
    let mut ids2 = IdGenerator::resume_after(&field2);
    let split_points_b = vec![((0, 0), 0, 0), ((0, 0), 1, 0), ((0, 0), 2, 0)];
    build_preset_state(&mut graph2, &mut field2, &mut ids2, &[], &[], &[], &[], &split_points_b, |x, y| SquarePoint { x, y }, None, None).unwrap();

    let point = SquarePoint { x: 0, y: 0 };
    assert_eq!(
        field1.nodes_at(field1.single_level_id(), point),
        field2.nodes_at(field2.single_level_id(), point)
    );
}

/// `split_points` referencing an unknown point surfaces as an `Err`, not a panic
/// (`Field::add_node_at` panics on an unknown point — `apply_split_points` guards against it).
#[test]
fn split_points_referencing_unknown_point_returns_err_not_panic() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let split_points = vec![((99, 99), 0, 0)];
    let err = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &[], &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap_err();
    assert!(err.contains("(99, 99)"), "error should mention the offending point, got: {err}");
}

// --- PresetState::resolve_endpoint (GitHub issue #231) ---
//
// `resolve_endpoint` is the public entry point `maze-wasm`/`maze-runner` use to resolve
// `preset_start`/`preset_finish`/`preset_gen_source` after `build_preset_state` has already
// applied `split_points` — unlike `preset_connections`/`locked_nodes`, these three markers live
// outside `GenerationConfig` and are resolved by the caller, separately, against the returned
// `PresetState`. Covers each of `resolve_preset_endpoint`'s branches directly through the public
// method, not just indirectly via `build_preset_state`'s own internal `resolve` closure.

#[test]
fn resolve_endpoint_with_no_slot_resolves_to_the_original_node() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let original_id = node_at(&field, 0, 0);

    let resolved = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, original(0, 0));
    assert_eq!(resolved, Some(original_id));
}

#[test]
fn resolve_endpoint_with_a_declared_slot_resolves_to_that_specific_node() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let split_points = vec![((0, 0), 0, 0)];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &[], &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap();
    let point = SquarePoint { x: 0, y: 0 };
    let original_id = field.nodes_at(field.single_level_id(), point)[0];
    let added_id = field.nodes_at(field.single_level_id(), point)[1];

    let resolved_original = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, original(0, 0));
    assert_eq!(resolved_original, Some(original_id));
    let resolved_slot = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, split(0, 0, 0));
    assert_eq!(resolved_slot, Some(added_id));
}

#[test]
fn resolve_endpoint_with_an_undeclared_slot_returns_none() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    // No split_points declared at all -- point (0,0) has only its original node.
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();

    let resolved = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, split(0, 0, 0));
    assert_eq!(resolved, None);
}

#[test]
fn resolve_endpoint_for_an_unknown_point_returns_none() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();

    let resolved = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, original(99, 99));
    assert_eq!(resolved, None);
}

/// Two different declared slots at the same point resolve to two different `NodeId`s, in
/// declaration-slot order (mirrors `preset_connection_addressing_a_declared_slot_connects_only_that_node`'s
/// single-slot case, extended to two).
#[test]
fn resolve_endpoint_distinguishes_between_two_declared_slots_at_the_same_point() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let split_points = vec![((0, 0), 0, 0), ((0, 0), 1, 0)];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &[], &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap();
    let point = SquarePoint { x: 0, y: 0 };
    let slot0_id = field.nodes_at(field.single_level_id(), point)[1];
    let slot1_id = field.nodes_at(field.single_level_id(), point)[2];

    let resolved0 = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, split(0, 0, 0));
    let resolved1 = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, split(0, 0, 1));
    assert_eq!(resolved0, Some(slot0_id));
    assert_eq!(resolved1, Some(slot1_id));
    assert_ne!(resolved0, resolved1);
}

// --- PresetState::is_preset_locked_node (split node preset-locked support) ---

/// A node minted by `split_points` whose incident edges (a mix of Basic and Teleport — no
/// `EdgeKind` filtering) are all preset-protected is locked.
#[test]
fn is_preset_locked_node_true_when_declared_and_all_incident_edges_are_preset() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let split_points = vec![((0, 0), 0, 0)];
    let presets = vec![
        PresetConnection { from: split(0, 0, 0), to: original(1, 0), state: PresetConnectionState::Passage },
        PresetConnection { from: split(0, 0, 0), to: original(2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Forward) },
    ];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap();
    let point = SquarePoint { x: 0, y: 0 };
    let added_id = field.nodes_at(field.single_level_id(), point)[1];
    assert!(state.is_preset_locked_node(added_id, &graph));
}

/// A node that already existed at the point (not minted by `split_points`) is never locked, even
/// if all its edges happen to be preset-protected.
#[test]
fn is_preset_locked_node_false_when_node_not_declared_by_preset() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let presets = vec![PresetConnection {
        from: original(0, 0), to: original(1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let a = node_at(&field, 0, 0);
    assert!(!state.is_preset_locked_node(a, &graph));
}

/// A declared node with at least one non-preset incident edge is not locked.
#[test]
fn is_preset_locked_node_false_when_not_all_incident_edges_are_preset() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let split_points = vec![((0, 0), 0, 0)];
    let presets = vec![PresetConnection {
        from: split(0, 0, 0), to: original(1, 0), state: PresetConnectionState::Passage,
    }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &presets, &[], &[], &[], &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap();
    let point = SquarePoint { x: 0, y: 0 };
    let added_id = field.nodes_at(field.single_level_id(), point)[1];
    let other = node_at(&field, 2, 2);
    graph.build_initial_edge(added_id, other, EdgeKind::Basic);
    assert!(!state.is_preset_locked_node(added_id, &graph));
}

/// A declared node with no incident edges is not locked (vacuous-truth guard).
#[test]
fn is_preset_locked_node_false_when_declared_node_has_no_edges() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let split_points = vec![((0, 0), 0, 0)];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], &[], &split_points, |x, y| SquarePoint { x, y }, None, None).unwrap();
    let point = SquarePoint { x: 0, y: 0 };
    let added_id = field.nodes_at(field.single_level_id(), point)[1];
    assert!(!state.is_preset_locked_node(added_id, &graph));
}

// --- Preset VerticalPassage/Elevator (GitHub issue #357) ---

fn multi_floor_field(w: usize, h: usize, floors: usize) -> (MultiLevelField<crate::space::SquareTessellation>, Graph, IdGenerator) {
    use crate::space::Field;
    let mut ids = IdGenerator::new();
    let fields: Vec<Field<crate::space::SquareTessellation>> = (0..floors)
        .map(|_| Field::new(crate::space::square_rect(w, h), &mut ids).unwrap())
        .collect();
    let mf = MultiLevelField::new(fields);
    let mut graph = Graph::new();
    for node in mf.all_node_ids() { graph.add_node(node); }
    (mf, graph, ids)
}

fn node_at_level(field: &MultiLevelField<crate::space::SquareTessellation>, level_idx: usize, x: i32, y: i32) -> NodeId {
    let level = field.levels_ordered().nth(level_idx).unwrap();
    field.node_at(level, SquarePoint { x, y }).unwrap()
}

fn at_level(x: i32, y: i32, level: u32) -> PresetEndpoint {
    PresetEndpoint { point: (x, y), slot: None, level: Some(level) }
}

#[test]
fn build_preset_state_two_way_vertical_passage_adds_bidirectional_edge_and_marks_connected() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage { from: original(0, 0), to: at_level(0, 0, 1), one_way: None }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &passages, &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    assert!(graph.edge_between_kind(a, b, &EdgeKind::VerticalPassage).is_some());
    assert!(graph.edge_between_kind(b, a, &EdgeKind::VerticalPassage).is_some());
    assert!(state.preset_connected.contains(&a));
    assert!(state.preset_connected.contains(&b));
    assert!(state.is_preset_edge(a, b));
    assert!(state.is_preset_edge(b, a));
}

#[test]
fn build_preset_state_two_way_vertical_passage_emits_two_way_event() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage { from: original(0, 0), to: at_level(0, 0, 1), one_way: None }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &[], &passages, &[], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(events, vec![PresetSetupEvent::VerticalPassageEstablished { from: a, to: b, two_way: true }]);
}

#[test]
fn build_preset_state_one_way_forward_vertical_passage_blocks_reverse() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage { from: original(0, 0), to: at_level(0, 0, 1), one_way: Some(VerticalPassageDirection::Forward) }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &passages, &[], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    assert!(graph.edge_between_kind(a, b, &EdgeKind::VerticalPassage).is_some());
    assert!(graph.edge_between(b, a).is_none());
    assert!(state.is_preset_edge(a, b));
    assert!(!state.is_preset_edge(b, a));
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(events, vec![PresetSetupEvent::VerticalPassageEstablished { from: a, to: b, two_way: false }]);
}

#[test]
fn build_preset_state_one_way_backward_vertical_passage_blocks_forward() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage { from: original(0, 0), to: at_level(0, 0, 1), one_way: Some(VerticalPassageDirection::Backward) }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &passages, &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    assert!(graph.edge_between_kind(b, a, &EdgeKind::VerticalPassage).is_some());
    assert!(graph.edge_between(a, b).is_none());
    assert!(state.is_preset_edge(b, a));
    assert!(!state.is_preset_edge(a, b));
}

#[test]
fn build_preset_state_vertical_passage_with_unresolvable_endpoint_is_silently_skipped() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage { from: original(0, 0), to: at_level(99, 99, 1), one_way: None }];
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &passages, &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    assert!(!state.preset_connected.contains(&a));
    assert!(graph.edges().next().is_none());
}

#[test]
fn build_preset_state_elevator_connects_every_pair_of_floors() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 3);
    let elevator = PresetElevator { floors: vec![original(0, 0), at_level(0, 0, 1), at_level(0, 0, 2)] };
    let state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[elevator], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    let c = node_at_level(&field, 2, 0, 0);
    for &(x, y) in &[(a, b), (b, a), (a, c), (c, a), (b, c), (c, b)] {
        assert!(graph.edge_between_kind(x, y, &EdgeKind::Elevator).is_some());
        assert!(state.is_preset_edge(x, y));
    }
    assert!(state.preset_connected.contains(&a));
    assert!(state.preset_connected.contains(&b));
    assert!(state.preset_connected.contains(&c));
}

#[test]
fn build_preset_state_elevator_emits_one_event_with_every_node() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 3);
    let elevator = PresetElevator { floors: vec![original(0, 0), at_level(0, 0, 1), at_level(0, 0, 2)] };
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[elevator], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    let c = node_at_level(&field, 2, 0, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(events, vec![PresetSetupEvent::ElevatorEstablished { nodes: vec![a, b, c] }]);
}

#[test]
fn build_preset_state_elevator_with_fewer_than_two_resolved_endpoints_connects_nothing() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let elevator = PresetElevator { floors: vec![original(0, 0), at_level(99, 99, 1)] };
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[elevator], &[], &[], |x, y| SquarePoint { x, y }, Some(&mut log), None).unwrap();
    assert!(graph.edges().next().is_none());
    assert!(log.finish().iter().next().is_none());
}
