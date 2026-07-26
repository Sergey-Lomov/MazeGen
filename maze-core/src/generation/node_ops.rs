// Mutating node-removal helper (GitHub issue #248, epic #246) — the `Field`/`Graph` counterpart
// of `edge_ops.rs`'s `try_remove_edge*` family, generic over `T: Tessellation` since removing a
// node (unlike removing an edge) always touches `Field` as well as `Graph`.

use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use super::preset_state::PresetState;

/// Feasibility shared by `try_remove_node`/`cmd_remove_node`: a node is only ever removable if
/// it's not a point's slot-0 (original) node — the hard constraint every split-QC repair strategy
/// in epic #246 shares — and isn't itself preset-protected (locked in/out, or the endpoint of a
/// preset connection). Structural existence (`field.point_of(node).is_some()`) is checked by the
/// caller, since only `try_remove_node` has a `&mut Field` to also act on that check's result.
pub(crate) fn remove_node_feasible<T: Tessellation>(field: &Field<T>, preset_state: &PresetState, node: NodeId) -> bool {
    let Some(point) = field.point_of(node) else { return false; };
    if field.nodes_at(point).first() == Some(&node) {
        return false; // node is this point's slot-0 (original) — never removable
    }
    if preset_state.locked_out.contains(&node) || preset_state.locked_in.contains(&node) {
        return false;
    }
    if preset_state.preset_edges.iter().any(|&(from, to)| from == node || to == node) {
        return false;
    }
    true
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
}
