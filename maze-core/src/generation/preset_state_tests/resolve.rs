use super::*;

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
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[],
        &[],
        &[],
        None,
    )
    .unwrap();
    let original_id = node_at(&field, 0, 0);

    let resolved = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, original(0, 0));
    assert_eq!(resolved, Ok(original_id));
}

#[test]
fn resolve_endpoint_with_a_declared_slot_resolves_to_that_specific_node() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let split_points = vec![((0, 0), 0, 0)];
    let state = build(
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
    .unwrap();
    let point = SquarePoint { x: 0, y: 0 };
    let original_id = field.nodes_at(field.single_level_id(), point)[0];
    let added_id = field.nodes_at(field.single_level_id(), point)[1];

    let resolved_original =
        state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, original(0, 0));
    assert_eq!(resolved_original, Ok(original_id));
    let resolved_slot = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, split(0, 0, 0));
    assert_eq!(resolved_slot, Ok(added_id));
}

#[test]
fn resolve_endpoint_with_an_undeclared_slot_is_an_error() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    // No split_points declared at all -- point (0,0) has only its original node.
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[],
        &[],
        &[],
        None,
    )
    .unwrap();

    let resolved = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, split(0, 0, 0));
    assert_eq!(
        resolved,
        Err("preset endpoint references undeclared slot 0 at [0, 0] on level 0".to_string())
    );
}

#[test]
fn resolve_endpoint_for_an_unknown_point_is_an_error() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let state = build(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[],
        &[],
        &[],
        None,
    )
    .unwrap();

    let resolved = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, original(99, 99));
    assert_eq!(
        resolved,
        Err("preset endpoint references unknown point [99, 99] on level 0".to_string())
    );
}

/// Two different declared slots at the same point resolve to two different `NodeId`s, in
/// declaration-slot order (mirrors `preset_connection_addressing_a_declared_slot_connects_only_that_node`'s
/// single-slot case, extended to two).
#[test]
fn resolve_endpoint_distinguishes_between_two_declared_slots_at_the_same_point() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let split_points = vec![((0, 0), 0, 0), ((0, 0), 1, 0)];
    let state = build(
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
    .unwrap();
    let point = SquarePoint { x: 0, y: 0 };
    let slot0_id = field.nodes_at(field.single_level_id(), point)[1];
    let slot1_id = field.nodes_at(field.single_level_id(), point)[2];

    let resolved0 = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, split(0, 0, 0));
    let resolved1 = state.resolve_endpoint(&field, |x, y| SquarePoint { x, y }, split(0, 0, 1));
    assert_eq!(resolved0, Ok(slot0_id));
    assert_eq!(resolved1, Ok(slot1_id));
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
        PresetConnection {
            from: split(0, 0, 0),
            to: original(1, 0),
            state: PresetConnectionState::Passage,
        },
        PresetConnection {
            from: split(0, 0, 0),
            to: original(2, 2),
            state: PresetConnectionState::Teleport(TeleportDirection::Forward),
        },
    ];
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
    assert!(!state.is_preset_locked_node(a, &graph));
}

/// A declared node with at least one non-preset incident edge is not locked.
#[test]
fn is_preset_locked_node_false_when_not_all_incident_edges_are_preset() {
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let mut ids = IdGenerator::resume_after(&field);
    let split_points = vec![((0, 0), 0, 0)];
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
        &split_points,
        None,
    )
    .unwrap();
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
    let state = build(
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
    .unwrap();
    let point = SquarePoint { x: 0, y: 0 };
    let added_id = field.nodes_at(field.single_level_id(), point)[1];
    assert!(!state.is_preset_locked_node(added_id, &graph));
}
