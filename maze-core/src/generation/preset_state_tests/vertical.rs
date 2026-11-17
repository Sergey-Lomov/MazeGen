use super::*;
use std::sync::Arc;

// --- Preset VerticalPassage/Elevator (GitHub issue #357) ---

fn multi_floor_field(
    w: usize,
    h: usize,
    floors: usize,
) -> (
    MultiLevelField<crate::space::SquareTessellation>,
    Graph,
    IdGenerator,
) {
    use crate::space::Field;
    let mut ids = IdGenerator::new();
    let fields: Vec<Field<crate::space::SquareTessellation>> = (0..floors)
        .map(|_| Field::new(Arc::default(), crate::space::square_rect(w, h), &mut ids).unwrap())
        .collect();
    let mf = MultiLevelField::new(Arc::default(), fields);
    let mut graph = Graph::new();
    for node in mf.all_node_ids() {
        graph.add_node(node);
    }
    (mf, graph, ids)
}

fn node_at_level(
    field: &MultiLevelField<crate::space::SquareTessellation>,
    level_idx: usize,
    x: i32,
    y: i32,
) -> NodeId {
    let level = field.levels_ordered().nth(level_idx).unwrap();
    field.node_at(level, SquarePoint { x, y }).unwrap()
}

fn at_level(x: i32, y: i32, level: u32) -> PresetEndpoint {
    PresetEndpoint {
        point: (x, y),
        slot: None,
        level: Some(level),
    }
}

#[test]
fn build_preset_state_two_way_vertical_passage_adds_bidirectional_edge_and_marks_connected() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage {
        from: original(0, 0),
        to: at_level(0, 0, 1),
        one_way: None,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &passages,
        &[],
        &[],
        &[],
        None,
    )
    .unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    assert!(
        graph
            .edge_between_kind(a, b, &EdgeKind::VerticalPassage)
            .is_some()
    );
    assert!(
        graph
            .edge_between_kind(b, a, &EdgeKind::VerticalPassage)
            .is_some()
    );
    assert!(state.preset_connected.contains(&a));
    assert!(state.preset_connected.contains(&b));
    assert!(state.is_preset_edge(a, b));
    assert!(state.is_preset_edge(b, a));
}

#[test]
fn build_preset_state_two_way_vertical_passage_emits_two_way_event() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage {
        from: original(0, 0),
        to: at_level(0, 0, 1),
        one_way: None,
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &passages,
        &[],
        &[],
        &[],
        Some(&mut log),
    )
    .unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(
        events,
        vec![PresetSetupEvent::VerticalPassageEstablished {
            from: a,
            to: b,
            two_way: true
        }]
    );
}

#[test]
fn build_preset_state_one_way_forward_vertical_passage_blocks_reverse() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage {
        from: original(0, 0),
        to: at_level(0, 0, 1),
        one_way: Some(VerticalPassageDirection::Forward),
    }];
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &passages,
        &[],
        &[],
        &[],
        Some(&mut log),
    )
    .unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    assert!(
        graph
            .edge_between_kind(a, b, &EdgeKind::VerticalPassage)
            .is_some()
    );
    assert!(graph.edge_between(b, a).is_none());
    assert!(state.is_preset_edge(a, b));
    assert!(!state.is_preset_edge(b, a));
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(
        events,
        vec![PresetSetupEvent::VerticalPassageEstablished {
            from: a,
            to: b,
            two_way: false
        }]
    );
}

#[test]
fn build_preset_state_one_way_backward_vertical_passage_blocks_forward() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage {
        from: original(0, 0),
        to: at_level(0, 0, 1),
        one_way: Some(VerticalPassageDirection::Backward),
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &passages,
        &[],
        &[],
        &[],
        None,
    )
    .unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    assert!(
        graph
            .edge_between_kind(b, a, &EdgeKind::VerticalPassage)
            .is_some()
    );
    assert!(graph.edge_between(a, b).is_none());
    assert!(state.is_preset_edge(b, a));
    assert!(!state.is_preset_edge(a, b));
}

#[test]
fn build_preset_state_vertical_passage_with_unresolvable_endpoint_is_an_error() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let passages = vec![PresetVerticalPassage {
        from: original(0, 0),
        to: at_level(99, 99, 1),
        one_way: None,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &passages,
        &[],
        &[],
        &[],
        None,
    );
    assert_eq!(
        state.err(),
        Some("preset endpoint references unknown point [99, 99] on level 1".to_string())
    );
}

#[test]
fn build_preset_state_elevator_with_unresolvable_floor_is_an_error() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let elevator = PresetElevator {
        floors: vec![original(0, 0), at_level(0, 0, 5)],
    };
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[elevator],
        &[],
        &[],
        None,
    );
    assert_eq!(
        state.err(),
        Some("preset endpoint references unknown level 5".to_string())
    );
}

#[test]
fn build_preset_state_locked_node_with_unresolvable_point_is_an_error() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let locked = vec![LockedNode {
        point: original(99, 99),
        kind: NodeLockKind::Both,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[],
        &locked,
        &[],
        None,
    );
    assert_eq!(
        state.err(),
        Some("preset endpoint references unknown point [99, 99] on level 0".to_string())
    );
}

#[test]
fn build_preset_state_elevator_connects_every_pair_of_floors() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 3);
    let elevator = PresetElevator {
        floors: vec![original(0, 0), at_level(0, 0, 1), at_level(0, 0, 2)],
    };
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[elevator],
        &[],
        &[],
        None,
    )
    .unwrap();
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
    let elevator = PresetElevator {
        floors: vec![original(0, 0), at_level(0, 0, 1), at_level(0, 0, 2)],
    };
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[elevator],
        &[],
        &[],
        Some(&mut log),
    )
    .unwrap();
    let a = node_at_level(&field, 0, 0, 0);
    let b = node_at_level(&field, 1, 0, 0);
    let c = node_at_level(&field, 2, 0, 0);
    let events: Vec<_> = log.finish().iter().cloned().collect();
    assert_eq!(
        events,
        vec![PresetSetupEvent::ElevatorEstablished {
            nodes: vec![a, b, c]
        }]
    );
}

#[test]
fn build_preset_state_elevator_with_a_single_floor_connects_nothing() {
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let elevator = PresetElevator {
        floors: vec![original(0, 0)],
    };
    let mut log: EventLog<PresetSetupEvent> = EventLog::new();
    build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[elevator],
        &[],
        &[],
        Some(&mut log),
    )
    .unwrap();
    assert!(graph.edges().next().is_none());
    assert!(log.finish().iter().next().is_none());
}
