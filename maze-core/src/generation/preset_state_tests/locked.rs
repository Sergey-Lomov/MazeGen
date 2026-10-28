use super::*;

#[test]
fn build_preset_state_locked_node_both_sets_in_and_out() {
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
    assert!(state.locked_in.contains(&a));
    assert!(state.locked_out.contains(&a));
}

#[test]
fn build_preset_state_locked_node_in_only_sets_locked_in_not_locked_out() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let locks = vec![LockedNode {
        point: original(0, 0),
        kind: NodeLockKind::In,
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
    assert!(state.locked_in.contains(&a));
    assert!(!state.locked_out.contains(&a));
}

#[test]
fn build_preset_state_locked_node_out_only_sets_locked_out_not_locked_in() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let locks = vec![LockedNode {
        point: original(0, 0),
        kind: NodeLockKind::Out,
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
    assert!(state.locked_out.contains(&a));
    assert!(!state.locked_in.contains(&a));
}
