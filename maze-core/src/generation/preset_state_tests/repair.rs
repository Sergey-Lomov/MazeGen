use super::*;

#[test]
fn for_repair_returns_empty_when_qc_experiment() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let locks = vec![LockedNode {
        point: original(0, 0),
        kind: NodeLockKind::Both,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[],
        &locks,
        &[],
        None,
    )
    .unwrap();
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
    let locks = vec![LockedNode {
        point: original(0, 0),
        kind: NodeLockKind::Both,
    }];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[],
        &locks,
        &[],
        None,
    )
    .unwrap();
    let a = node_at(&field, 0, 0);
    let repair_state = state.for_repair(false);
    assert!(repair_state.locked_in.contains(&a));
    assert!(repair_state.locked_out.contains(&a));
}

/// A pinned start/finish is the user's explicit choice — repair must never remove its node.
#[test]
fn pinned_endpoints_are_locked_for_removal() {
    let mut state = PresetState::empty();
    state.preset_start = Some(3);
    state.preset_finish = Some(5);
    assert!(state.is_node_locked_for_removal(3));
    assert!(state.is_node_locked_for_removal(5));
    assert!(!state.is_node_locked_for_removal(4));
}
