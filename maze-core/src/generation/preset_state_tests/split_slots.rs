use super::*;

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

    let locks = vec![LockedNode {
        point: split(0, 0, 0),
        kind: NodeLockKind::Both,
    }];
    let split_points = vec![((0, 0), 0, 0)];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[],
        &locks,
        &split_points,
        None,
    )
    .unwrap();

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
        from: split(0, 0, 0),
        to: original(1, 0),
        state: PresetConnectionState::Passage,
    }];
    let split_points = vec![((0, 0), 0, 0)];
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &presets,
        &[],
        &[],
        &[],
        &split_points,
        None,
    )
    .unwrap();

    let point = SquarePoint { x: 0, y: 0 };
    let original_id = field.nodes_at(field.single_level_id(), point)[0];
    let added_id = field.nodes_at(field.single_level_id(), point)[1];
    let b = node_at(&field, 1, 0);
    assert!(graph.edge_between(original_id, b).is_none());
    assert!(graph.edge_between(added_id, b).is_some());
    assert!(state.preset_connected.contains(&added_id));
    assert!(!state.preset_connected.contains(&original_id));
}

/// A preset addressing a slot that was never declared in `split_points` is an error naming the
/// endpoint — same "unresolvable endpoint" handling as an out-of-bounds point.
#[test]
fn preset_connection_addressing_an_undeclared_slot_is_an_error() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);

    let presets = vec![PresetConnection {
        from: split(0, 0, 0),
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
        Some("preset endpoint references undeclared slot 0 at [0, 0] on level 0".to_string())
    );
}

/// GitHub issue #231 — `split_points` is applied via `add_node_at` in `(point, slot)`-sorted
/// order regardless of the order entries appear in the input slice, so the resulting `NodeId` for
/// a given `(point, slot)` pair doesn't depend on payload transport order.
#[test]
fn split_points_creates_identical_nodes_regardless_of_input_order() {
    let (mut field1, mut graph1) = make_field_and_graph(3, 3);
    let mut ids1 = IdGenerator::resume_after(&field1);
    let split_points_a = vec![((0, 0), 2, 0), ((0, 0), 0, 0), ((0, 0), 1, 0)];
    build_preset_state(
        &mut graph1,
        &mut field1,
        &mut ids1,
        &[],
        &[],
        &[],
        &[],
        &split_points_a,
        |x, y| SquarePoint { x, y },
        None,
        None,
    )
    .unwrap();

    let (mut field2, mut graph2) = make_field_and_graph(3, 3);
    let mut ids2 = IdGenerator::resume_after(&field2);
    let split_points_b = vec![((0, 0), 0, 0), ((0, 0), 1, 0), ((0, 0), 2, 0)];
    build_preset_state(
        &mut graph2,
        &mut field2,
        &mut ids2,
        &[],
        &[],
        &[],
        &[],
        &split_points_b,
        |x, y| SquarePoint { x, y },
        None,
        None,
    )
    .unwrap();

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
    let err = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[],
        &[],
        &split_points,
        None,
    )
    .unwrap_err();
    assert!(
        err.contains("(99, 99)"),
        "error should mention the offending point, got: {err}"
    );
}
