use super::*;
use crate::IdGenerator;
use crate::graph::EdgeKind;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use std::sync::Arc;

fn field_with_extra_node() -> (MultiLevelField<SquareTessellation>, Graph, NodeId, NodeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p0 = SquarePoint { x: 0, y: 0 };
    let slot0 = field.node_at(level, p0).unwrap();
    let extra = field.add_node_at(level, p0, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    (field, g, slot0, extra)
}

#[test]
fn try_remove_node_removes_an_extra_node_and_its_edges() {
    let (mut field, mut g, slot0, extra) = field_with_extra_node();
    g.build_initial_edge(slot0, extra, EdgeKind::Basic);
    g.build_initial_edge(extra, slot0, EdgeKind::Basic);

    assert!(try_remove_node(
        &mut field,
        &mut g,
        extra,
        &PresetState::empty()
    ));

    let level = field.single_level_id();
    assert!(
        !field
            .nodes_at(level, SquarePoint { x: 0, y: 0 })
            .contains(&extra)
    );
    assert!(g.edge_between(slot0, extra).is_none());
    assert!(g.edge_between(extra, slot0).is_none());
}

#[test]
fn try_remove_node_removes_slot0_when_a_sibling_remains() {
    // Slot-0 is no longer special: with a sibling still at the point, slot0 is just as
    // removable as any other node.
    let (mut field, mut g, slot0, _extra) = field_with_extra_node();
    assert!(
        try_remove_node(&mut field, &mut g, slot0, &PresetState::empty()),
        "slot0 must be removed since it isn't the point's last remaining node"
    );
}

#[test]
fn try_remove_node_refuses_to_remove_a_points_last_remaining_node() {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p0 = SquarePoint { x: 0, y: 0 };
    let slot0 = field.node_at(level, p0).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    assert!(
        !try_remove_node(&mut field, &mut g, slot0, &PresetState::empty()),
        "a point's last remaining node must never be removable"
    );
}

#[test]
fn try_remove_node_refuses_a_stale_node_id() {
    let (mut field, mut g, _slot0, extra) = field_with_extra_node();
    assert!(try_remove_node(
        &mut field,
        &mut g,
        extra,
        &PresetState::empty()
    ));
    assert!(
        !try_remove_node(&mut field, &mut g, extra, &PresetState::empty()),
        "already-removed node must not be removable again"
    );
}

#[test]
fn try_remove_node_refuses_a_locked_out_node() {
    let (mut field, mut g, _slot0, extra) = field_with_extra_node();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(extra);
    assert!(!try_remove_node(&mut field, &mut g, extra, &preset_state));
}

#[test]
fn try_remove_node_refuses_a_locked_in_node() {
    let (mut field, mut g, _slot0, extra) = field_with_extra_node();
    let mut preset_state = PresetState::empty();
    preset_state.locked_in.insert(extra);
    assert!(!try_remove_node(&mut field, &mut g, extra, &preset_state));
}

#[test]
fn try_remove_node_refuses_a_node_that_is_a_preset_edge_endpoint() {
    let (mut field, mut g, slot0, extra) = field_with_extra_node();
    g.build_initial_edge(slot0, extra, EdgeKind::Basic);
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((slot0, extra));
    assert!(!try_remove_node(&mut field, &mut g, extra, &preset_state));
}

fn field_for_add_split(
    width: usize,
) -> (
    MultiLevelField<SquareTessellation>,
    Graph,
    IdGenerator,
    NodeId,
) {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(width, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let level = field.single_level_id();
    let slot0 = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
    (field, g, ids, slot0)
}

#[test]
fn try_replace_point_nodes_mints_a_new_slot0_at_the_same_point() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
    let level = field.single_level_id();
    let new_nodes = try_replace_point_nodes(
        &mut field,
        &mut g,
        &mut ids,
        slot0,
        &[vec![]],
        &PresetState::empty(),
        None,
    );
    let new_nodes = new_nodes.expect("an unlocked unsplit point must be replaceable");
    assert_eq!(new_nodes.len(), 1);
    assert_ne!(
        new_nodes[0], slot0,
        "replacement mints a brand-new id for the new slot-0"
    );
    let at_point = field.nodes_at(level, SquarePoint { x: 0, y: 0 });
    assert_eq!(at_point, &[new_nodes[0]]);
    assert!(
        field.cell_of(slot0).is_none(),
        "old slot-0 id must be gone from the field"
    );
}

#[test]
fn try_replace_point_nodes_mints_multiple_nodes_in_one_atomic_call() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
    let level = field.single_level_id();
    let new_nodes = try_replace_point_nodes(
        &mut field,
        &mut g,
        &mut ids,
        slot0,
        &[vec![], vec![]],
        &PresetState::empty(),
        None,
    )
    .unwrap();
    assert_eq!(new_nodes.len(), 2);
    assert_ne!(new_nodes[0], new_nodes[1]);
    let at_point = field.nodes_at(level, SquarePoint { x: 0, y: 0 });
    assert_eq!(
        at_point,
        &[new_nodes[0], new_nodes[1]],
        "new_nodes[0] is the new slot-0, in order"
    );
}

#[test]
fn try_replace_point_nodes_wires_forward_backward_and_passage_edges() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
    let level = field.single_level_id();
    let right = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
    let edges = vec![SplitNodeEdge {
        target: right,
        direction: SplitNodeEdgeDirection::Passage,
        kind: EdgeKind::Basic,
    }];
    let new_nodes = try_replace_point_nodes(
        &mut field,
        &mut g,
        &mut ids,
        slot0,
        &[edges],
        &PresetState::empty(),
        None,
    )
    .unwrap();
    let new_node = new_nodes[0];
    assert!(g.edge_between(new_node, right).is_some());
    assert!(g.edge_between(right, new_node).is_some());
}

#[test]
fn try_replace_point_nodes_forward_direction_is_one_way_from_new_node() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
    let level = field.single_level_id();
    let right = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
    let edges = vec![SplitNodeEdge {
        target: right,
        direction: SplitNodeEdgeDirection::Forward,
        kind: EdgeKind::Basic,
    }];
    let new_nodes = try_replace_point_nodes(
        &mut field,
        &mut g,
        &mut ids,
        slot0,
        &[edges],
        &PresetState::empty(),
        None,
    )
    .unwrap();
    let new_node = new_nodes[0];
    assert!(g.edge_between(new_node, right).is_some());
    assert!(g.edge_between(right, new_node).is_none());
}

#[test]
fn try_replace_point_nodes_backward_direction_is_one_way_into_new_node() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
    let level = field.single_level_id();
    let right = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
    let edges = vec![SplitNodeEdge {
        target: right,
        direction: SplitNodeEdgeDirection::Backward,
        kind: EdgeKind::Basic,
    }];
    let new_nodes = try_replace_point_nodes(
        &mut field,
        &mut g,
        &mut ids,
        slot0,
        &[edges],
        &PresetState::empty(),
        None,
    )
    .unwrap();
    let new_node = new_nodes[0];
    assert!(g.edge_between(right, new_node).is_some());
    assert!(g.edge_between(new_node, right).is_none());
}

#[test]
fn try_replace_point_nodes_replaces_an_already_split_points_extra_node_too() {
    // Unlike the old add-only command, ReplacePointNodes is allowed to target a point that
    // already has extra nodes — every one of them (slot-0 included) is among the old nodes
    // removed, not just an addition alongside them.
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
    let level = field.single_level_id();
    let extra = field.add_node_at(level, SquarePoint { x: 0, y: 0 }, &mut ids);
    g.add_node(extra);
    let new_nodes = try_replace_point_nodes(
        &mut field,
        &mut g,
        &mut ids,
        slot0,
        &[vec![]],
        &PresetState::empty(),
        None,
    );
    let new_nodes = new_nodes.expect("a point with an extra node must still be replaceable");
    let at_point = field.nodes_at(level, SquarePoint { x: 0, y: 0 });
    assert_eq!(
        at_point,
        &[new_nodes[0]],
        "both old nodes gone, only the new one remains"
    );
    assert!(field.cell_of(slot0).is_none());
    assert!(field.cell_of(extra).is_none());
}

#[test]
fn try_replace_point_nodes_drops_slot0s_old_edges_not_reproduced_by_the_new_set() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
    let level = field.single_level_id();
    let right = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
    g.build_initial_edge(slot0, right, EdgeKind::Basic);
    g.build_initial_edge(right, slot0, EdgeKind::Basic);
    // New slot-0 has no edges at all — the old passage to `right` must vanish, not survive.
    let new_nodes = try_replace_point_nodes(
        &mut field,
        &mut g,
        &mut ids,
        slot0,
        &[vec![]],
        &PresetState::empty(),
        None,
    )
    .unwrap();
    let new_node = new_nodes[0];
    assert!(g.edge_between(slot0, right).is_none());
    assert!(g.edge_between(right, slot0).is_none());
    assert!(g.edge_between(new_node, right).is_none());
    assert!(g.edge_between(right, new_node).is_none());
}

#[test]
fn try_replace_point_nodes_refuses_when_slot0_is_locked() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(slot0);
    assert!(
        try_replace_point_nodes(
            &mut field,
            &mut g,
            &mut ids,
            slot0,
            &[vec![]],
            &preset_state,
            None
        )
        .is_none()
    );
}

#[test]
fn try_replace_point_nodes_refuses_when_an_extra_node_is_locked() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
    let level = field.single_level_id();
    let extra = field.add_node_at(level, SquarePoint { x: 0, y: 0 }, &mut ids);
    g.add_node(extra);
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(extra);
    assert!(
        try_replace_point_nodes(
            &mut field,
            &mut g,
            &mut ids,
            slot0,
            &[vec![]],
            &preset_state,
            None
        )
        .is_none(),
        "a locked extra node must block the whole replacement, even though the command targets slot-0"
    );
}

#[test]
fn try_replace_point_nodes_refuses_empty_nodes() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
    assert!(
        try_replace_point_nodes(
            &mut field,
            &mut g,
            &mut ids,
            slot0,
            &[],
            &PresetState::empty(),
            None
        )
        .is_none(),
        "an empty replacement set must be declined, never panic in Field::replace_nodes_at"
    );
}

#[test]
fn try_replace_point_nodes_refuses_a_stale_at() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
    try_replace_point_nodes(
        &mut field,
        &mut g,
        &mut ids,
        slot0,
        &[vec![]],
        &PresetState::empty(),
        None,
    )
    .unwrap();
    assert!(
        try_replace_point_nodes(
            &mut field,
            &mut g,
            &mut ids,
            slot0,
            &[vec![]],
            &PresetState::empty(),
            None
        )
        .is_none(),
        "the old slot0 id no longer resolves to a point after being replaced"
    );
}

#[test]
fn try_replace_point_nodes_all_or_nothing_when_one_edge_is_infeasible() {
    let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
    let level = field.single_level_id();
    let right = field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_in.insert(right); // forbids Forward into `right`
    let edges = vec![SplitNodeEdge {
        target: right,
        direction: SplitNodeEdgeDirection::Forward,
        kind: EdgeKind::Basic,
    }];
    assert!(
        try_replace_point_nodes(
            &mut field,
            &mut g,
            &mut ids,
            slot0,
            &[edges],
            &preset_state,
            None
        )
        .is_none(),
        "a single infeasible edge must fail the whole command, replacing nothing at all"
    );
    assert_eq!(
        field.nodes_at(level, SquarePoint { x: 0, y: 0 }),
        &[slot0],
        "old slot0 must survive a declined command"
    );
}
