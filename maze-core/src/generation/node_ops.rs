// Mutating node-removal helper (GitHub issue #248, epic #246) — the `Field`/`Graph` counterpart
// of `edge_ops.rs`'s `try_remove_edge*` family, generic over `T: Tessellation` since removing a
// node (unlike removing an edge) always touches `Field` as well as `Graph`.

use crate::ids::{NodeId, IdGenerator};
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use super::preset_state::PresetState;
use super::edge_ops::{directed_edge_feasible, bidirectional_edge_feasible};
use super::debug_state::DebugGenerationState;
use crate::repair::command::{SplitNodeEdge, SplitNodeEdgeDirection};

/// Shared predicate behind `remove_node_feasible` and `replace_point_nodes_feasible`: a node is
/// removable if it isn't preset-protected (locked in/out, or the endpoint of a preset connection)
/// and — unless `ignore_slot0` — isn't a point's slot-0 (original) node. `ignore_slot0` lets
/// `replace_point_nodes_feasible` reuse the exact same preset checks for slot-0 too, since
/// `ReplacePointNodes` is allowed to replace slot-0 (epic #246's "slot-0 is not special" rule),
/// unlike single-node removal (`try_remove_node`) which never is.
fn node_removal_allowed<T: Tessellation>(field: &Field<T>, preset_state: &PresetState, node: NodeId, ignore_slot0: bool) -> bool {
    let Some(point) = field.point_of(node) else { return false; };
    if !ignore_slot0 && field.nodes_at(point).first() == Some(&node) {
        return false; // node is this point's slot-0 (original) — never removable by this path
    }
    if preset_state.locked_out.contains(&node) || preset_state.locked_in.contains(&node) {
        return false;
    }
    if preset_state.preset_edges.iter().any(|&(from, to)| from == node || to == node) {
        return false;
    }
    true
}

/// Feasibility shared by `try_remove_node`/`cmd_remove_node`: a node is only ever removable if
/// it's not a point's slot-0 (original) node — the hard constraint every split-QC repair strategy
/// in epic #246 shares — and isn't itself preset-protected (locked in/out, or the endpoint of a
/// preset connection). Structural existence (`field.point_of(node).is_some()`) is checked by the
/// caller, since only `try_remove_node` has a `&mut Field` to also act on that check's result.
pub(crate) fn remove_node_feasible<T: Tessellation>(field: &Field<T>, preset_state: &PresetState, node: NodeId) -> bool {
    node_removal_allowed(field, preset_state, node, false)
}

/// Removes `node` (and every edge incident to it, both directions) if `remove_node_feasible`
/// allows it — mirrors `Maze::remove_node_at`'s atomic field+graph removal, but preset-aware
/// (`Maze::remove_node_at` itself has no `PresetState` parameter, so repair goes through this
/// instead). Returns `true` if the node was actually removed.
pub(crate) fn try_remove_node<T: Tessellation>(
    field: &mut Field<T>,
    graph: &mut Graph,
    node: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !remove_node_feasible(field, preset_state, node) {
        return false;
    }
    let point = field.point_of(node).expect("remove_node_feasible confirmed this node exists");
    let incident: Vec<crate::ids::EdgeId> = graph.outgoing_edges(node).map(|e| e.id)
        .chain(graph.edges().filter(|e| e.to == node).map(|e| e.id))
        .collect();
    for id in incident {
        graph.remove_initial_edge(id);
    }
    field.remove_node_at(point, node);
    true
}

/// Feasibility shared by `try_replace_point_nodes`/`cmd_replace_point_nodes` (`MutationCommand::
/// ReplacePointNodes`, GitHub issue #247's pattern-mode fix, epic #246): `at`'s point must still
/// exist, every node currently at that point (slot-0 included — `ignore_slot0: true`) must be
/// removable per `node_removal_allowed` (not locked, not a preset-edge endpoint), `nodes` must be
/// non-empty (a point always keeps at least one node — `Field::replace_nodes_at`'s own invariant),
/// and every edge of every new node in `nodes` must be structurally permitted by `preset_state`
/// against its `target` (new nodes are never themselves preset-addressable — they don't exist yet
/// — so only each `target`'s own lock/block state can forbid a direction). All-or-nothing: a
/// single infeasible old node, missing target, or new edge fails the whole check.
///
/// **`target` must still structurally exist** (`field.point_of(edge.target).is_some()`) — unlike
/// every other command in this crate, `ReplacePointNodes` can itself remove a node an *earlier*
/// command in the same batch already targeted as an edge endpoint (it replaces slot-0 too, not
/// just adds beside it), so a batch proposing splits at two adjacent points can have the second
/// command's `nodes` reference a `target` the first command already replaced out from under it by
/// the time `apply_commands` gets here. Without this check the edge would silently wire to a
/// vanished id instead of the still-live replacement, losing that connection outright — this
/// mirrors the same "resolve against current state, not proposal-time state" contract every other
/// `*_feasible` check already has, just newly reachable here because this command is the first one
/// that can invalidate another command's edge target mid-batch.
pub(crate) fn replace_point_nodes_feasible<T: Tessellation>(
    field: &Field<T>,
    preset_state: &PresetState,
    at: NodeId,
    nodes: &[Vec<SplitNodeEdge>],
) -> bool {
    if nodes.is_empty() {
        return false;
    }
    let Some(point) = field.point_of(at) else { return false; };
    if !field.nodes_at(point).iter().all(|&node| node_removal_allowed(field, preset_state, node, true)) {
        return false;
    }
    nodes.iter().flatten().all(|edge| {
        if field.point_of(edge.target).is_none() {
            return false;
        }
        match edge.direction {
            // The new node doesn't exist yet, so it's never itself locked/blocked — only
            // `target`'s side of the pair can forbid a direction. A placeholder id isn't needed:
            // both feasibility predicates only ever consult `preset_state` by NodeId, and every
            // predicate call below passes `target` in the slot preset_state could actually know
            // about.
            SplitNodeEdgeDirection::Forward => !preset_state.locked_in.contains(&edge.target),
            SplitNodeEdgeDirection::Backward => !preset_state.locked_out.contains(&edge.target),
            SplitNodeEdgeDirection::Passage => {
                !preset_state.locked_in.contains(&edge.target) && !preset_state.locked_out.contains(&edge.target)
            }
        }
    })
}

/// Replaces every node at `at`'s point with a brand-new set, wiring each one's own edge list, if
/// `replace_point_nodes_feasible` allows it. All-or-nothing: returns `None` (no removal, no mint)
/// if infeasible, otherwise `Some(new_nodes)` — one `NodeId` per entry in `nodes`, same order,
/// `new_nodes[0]` the point's new slot-0. See `MutationCommand::ReplacePointNodes`'s doc comment
/// for the full contract (GitHub issue #247, epic #246).
pub(crate) fn try_replace_point_nodes<T: Tessellation>(
    field: &mut Field<T>,
    graph: &mut Graph,
    ids: &mut IdGenerator,
    at: NodeId,
    nodes: &[Vec<SplitNodeEdge>],
    preset_state: &PresetState,
    mut debug_state: Option<&mut DebugGenerationState<T>>,
) -> Option<Vec<NodeId>> {
    if !replace_point_nodes_feasible(field, preset_state, at, nodes) {
        return None;
    }
    let point = field.point_of(at).expect("replace_point_nodes_feasible confirmed this point exists");
    let old_nodes: Vec<NodeId> = field.nodes_at(point).to_vec();
    for &old in &old_nodes {
        let incident: Vec<crate::ids::EdgeId> = graph.outgoing_edges(old).map(|e| e.id)
            .chain(graph.edges().filter(|e| e.to == old).map(|e| e.id))
            .collect();
        for id in incident {
            graph.remove_initial_edge(id);
        }
    }
    let mut new_nodes = Vec::with_capacity(nodes.len());
    for _ in nodes {
        let new_id = ids.next_id();
        if let Some(state) = debug_state.as_deref_mut() {
            state.note(new_id, point);
        }
        new_nodes.push(new_id);
    }
    field.replace_nodes_at(point, new_nodes.clone());
    for (i, edges) in nodes.iter().enumerate() {
        let node = new_nodes[i];
        graph.add_node(node);
        for edge in edges {
            match edge.direction {
                SplitNodeEdgeDirection::Forward => { graph.add_edge(node, edge.target, EdgeKind::Basic); }
                SplitNodeEdgeDirection::Backward => { graph.add_edge(edge.target, node, EdgeKind::Basic); }
                SplitNodeEdgeDirection::Passage => { graph.add_bidirectional_edge(node, edge.target, EdgeKind::Basic); }
            }
        }
    }
    Some(new_nodes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{SquareTessellation, SquarePoint, square_rect};
    use crate::graph::EdgeKind;
    use crate::IdGenerator;

    fn field_with_extra_node() -> (Field<SquareTessellation>, Graph, NodeId, NodeId) {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let p0 = SquarePoint { x: 0, y: 0 };
        let slot0 = field.node_at(p0).unwrap();
        let extra = field.add_node_at(p0, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        (field, g, slot0, extra)
    }

    #[test]
    fn try_remove_node_removes_an_extra_node_and_its_edges() {
        let (mut field, mut g, slot0, extra) = field_with_extra_node();
        g.build_initial_edge(slot0, extra, EdgeKind::Basic);
        g.build_initial_edge(extra, slot0, EdgeKind::Basic);

        assert!(try_remove_node(&mut field, &mut g, extra, &PresetState::empty()));

        assert!(!field.nodes_at(SquarePoint { x: 0, y: 0 }).contains(&extra));
        assert!(g.edge_between(slot0, extra).is_none());
        assert!(g.edge_between(extra, slot0).is_none());
    }

    #[test]
    fn try_remove_node_refuses_to_remove_slot0() {
        let (mut field, mut g, slot0, _extra) = field_with_extra_node();
        assert!(!try_remove_node(&mut field, &mut g, slot0, &PresetState::empty()),
            "slot-0 (the point's original node) must never be removable");
    }

    #[test]
    fn try_remove_node_refuses_a_stale_node_id() {
        let (mut field, mut g, _slot0, extra) = field_with_extra_node();
        assert!(try_remove_node(&mut field, &mut g, extra, &PresetState::empty()));
        assert!(!try_remove_node(&mut field, &mut g, extra, &PresetState::empty()),
            "already-removed node must not be removable again");
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

    fn field_for_add_split(width: usize) -> (Field<SquareTessellation>, Graph, IdGenerator, NodeId) {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(width, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let slot0 = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        (field, g, ids, slot0)
    }

    #[test]
    fn try_replace_point_nodes_mints_a_new_slot0_at_the_same_point() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
        let new_nodes = try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[vec![]], &PresetState::empty(), None);
        let new_nodes = new_nodes.expect("an unlocked unsplit point must be replaceable");
        assert_eq!(new_nodes.len(), 1);
        assert_ne!(new_nodes[0], slot0, "replacement mints a brand-new id for the new slot-0");
        let at_point = field.nodes_at(SquarePoint { x: 0, y: 0 });
        assert_eq!(at_point, &[new_nodes[0]]);
        assert!(field.point_of(slot0).is_none(), "old slot-0 id must be gone from the field");
    }

    #[test]
    fn try_replace_point_nodes_mints_multiple_nodes_in_one_atomic_call() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
        let new_nodes = try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[vec![], vec![]], &PresetState::empty(), None).unwrap();
        assert_eq!(new_nodes.len(), 2);
        assert_ne!(new_nodes[0], new_nodes[1]);
        let at_point = field.nodes_at(SquarePoint { x: 0, y: 0 });
        assert_eq!(at_point, &[new_nodes[0], new_nodes[1]], "new_nodes[0] is the new slot-0, in order");
    }

    #[test]
    fn try_replace_point_nodes_wires_forward_backward_and_passage_edges() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
        let right = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let edges = vec![SplitNodeEdge { target: right, direction: SplitNodeEdgeDirection::Passage }];
        let new_nodes = try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[edges], &PresetState::empty(), None).unwrap();
        let new_node = new_nodes[0];
        assert!(g.edge_between(new_node, right).is_some());
        assert!(g.edge_between(right, new_node).is_some());
    }

    #[test]
    fn try_replace_point_nodes_forward_direction_is_one_way_from_new_node() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
        let right = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let edges = vec![SplitNodeEdge { target: right, direction: SplitNodeEdgeDirection::Forward }];
        let new_nodes = try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[edges], &PresetState::empty(), None).unwrap();
        let new_node = new_nodes[0];
        assert!(g.edge_between(new_node, right).is_some());
        assert!(g.edge_between(right, new_node).is_none());
    }

    #[test]
    fn try_replace_point_nodes_backward_direction_is_one_way_into_new_node() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
        let right = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let edges = vec![SplitNodeEdge { target: right, direction: SplitNodeEdgeDirection::Backward }];
        let new_nodes = try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[edges], &PresetState::empty(), None).unwrap();
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
        let extra = field.add_node_at(SquarePoint { x: 0, y: 0 }, &mut ids);
        g.add_node(extra);
        let new_nodes = try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[vec![]], &PresetState::empty(), None);
        let new_nodes = new_nodes.expect("a point with an extra node must still be replaceable");
        let at_point = field.nodes_at(SquarePoint { x: 0, y: 0 });
        assert_eq!(at_point, &[new_nodes[0]], "both old nodes gone, only the new one remains");
        assert!(field.point_of(slot0).is_none());
        assert!(field.point_of(extra).is_none());
    }

    #[test]
    fn try_replace_point_nodes_drops_slot0s_old_edges_not_reproduced_by_the_new_set() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
        let right = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        g.build_initial_edge(slot0, right, EdgeKind::Basic);
        g.build_initial_edge(right, slot0, EdgeKind::Basic);
        // New slot-0 has no edges at all — the old passage to `right` must vanish, not survive.
        let new_nodes = try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[vec![]], &PresetState::empty(), None).unwrap();
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
        assert!(try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[vec![]], &preset_state, None).is_none());
    }

    #[test]
    fn try_replace_point_nodes_refuses_when_an_extra_node_is_locked() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
        let extra = field.add_node_at(SquarePoint { x: 0, y: 0 }, &mut ids);
        g.add_node(extra);
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(extra);
        assert!(try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[vec![]], &preset_state, None).is_none(),
            "a locked extra node must block the whole replacement, even though the command targets slot-0");
    }

    #[test]
    fn try_replace_point_nodes_refuses_empty_nodes() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
        assert!(try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[], &PresetState::empty(), None).is_none(),
            "an empty replacement set must be declined, never panic in Field::replace_nodes_at");
    }

    #[test]
    fn try_replace_point_nodes_refuses_a_stale_at() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
        try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[vec![]], &PresetState::empty(), None).unwrap();
        assert!(try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[vec![]], &PresetState::empty(), None).is_none(),
            "the old slot0 id no longer resolves to a point after being replaced");
    }

    #[test]
    fn try_replace_point_nodes_all_or_nothing_when_one_edge_is_infeasible() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
        let right = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_in.insert(right); // forbids Forward into `right`
        let edges = vec![
            SplitNodeEdge { target: right, direction: SplitNodeEdgeDirection::Forward },
        ];
        assert!(try_replace_point_nodes(&mut field, &mut g, &mut ids, slot0, &[edges], &preset_state, None).is_none(),
            "a single infeasible edge must fail the whole command, replacing nothing at all");
        assert_eq!(field.nodes_at(SquarePoint { x: 0, y: 0 }), &[slot0], "old slot0 must survive a declined command");
    }
}
