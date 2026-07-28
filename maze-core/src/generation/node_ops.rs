// Mutating node-removal helper (GitHub issue #248, epic #246) — the `Field`/`Graph` counterpart
// of `edge_ops.rs`'s `try_remove_edge*` family, generic over `T: Tessellation` since removing a
// node (unlike removing an edge) always touches `Field` as well as `Graph`.

use crate::ids::{NodeId, IdGenerator};
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use super::preset_state::PresetState;
use super::split_logic::split_is_eligible;
use super::edge_ops::{directed_edge_feasible, bidirectional_edge_feasible};
use crate::repair::command::{SplitNodeEdge, SplitNodeEdgeDirection};

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

/// Feasibility shared by `try_add_split_node`/`cmd_add_split_node`: `at` must be a point's slot-0
/// (original) node currently eligible for splitting at all (`split_is_eligible` — not locked,
/// point not already multi-node), and every edge of every sibling in `nodes` must be structurally
/// permitted by `preset_state` against its `target` (the new nodes are never themselves
/// preset-addressable — they don't exist yet — so only each `target`'s own lock/block state can
/// forbid a direction). All-or-nothing: a single infeasible edge, on any sibling, fails the whole
/// check, mirroring `MutationCommand::AddSplitNode`'s own atomic contract.
pub(crate) fn add_split_node_feasible<T: Tessellation>(
    field: &Field<T>,
    preset_state: &PresetState,
    at: NodeId,
    nodes: &[Vec<SplitNodeEdge>],
) -> bool {
    if !split_is_eligible(field, preset_state, at) {
        return false;
    }
    nodes.iter().flatten().all(|edge| match edge.direction {
        // The new node doesn't exist yet, so it's never itself locked/blocked — only `target`'s
        // side of the pair can forbid a direction. A placeholder id isn't needed: both
        // feasibility predicates only ever consult `preset_state` by NodeId, and every predicate
        // call below passes `target` in the slot preset_state could actually know about.
        SplitNodeEdgeDirection::Forward => !preset_state.locked_in.contains(&edge.target),
        SplitNodeEdgeDirection::Backward => !preset_state.locked_out.contains(&edge.target),
        SplitNodeEdgeDirection::Passage => {
            !preset_state.locked_in.contains(&edge.target) && !preset_state.locked_out.contains(&edge.target)
        }
    })
}

/// Mints one new split node per entry in `nodes` at `at`'s point (`at` must be the point's
/// slot-0/original node), wiring each one's own edge list, if `add_split_node_feasible` allows it.
/// All-or-nothing: returns `None` (no node minted, no edge added) if infeasible, otherwise
/// `Some(new_nodes)` — one `NodeId` per entry in `nodes`, same order. Never touches `at` itself
/// beyond using it to resolve the point — mirrors `AddSplitStrategy`'s hard "never alter slot-0"
/// constraint (GitHub issue #247, epic #246).
pub(crate) fn try_add_split_node<T: Tessellation>(
    field: &mut Field<T>,
    graph: &mut Graph,
    ids: &mut IdGenerator,
    at: NodeId,
    nodes: &[Vec<SplitNodeEdge>],
    preset_state: &PresetState,
) -> Option<Vec<NodeId>> {
    if !add_split_node_feasible(field, preset_state, at, nodes) {
        return None;
    }
    let point = field.point_of(at).expect("add_split_node_feasible confirmed this node exists");
    let mut new_nodes = Vec::with_capacity(nodes.len());
    for edges in nodes {
        let node = field.add_node_at(point, ids);
        graph.add_node(node);
        for edge in edges {
            match edge.direction {
                SplitNodeEdgeDirection::Forward => { graph.add_edge(node, edge.target, EdgeKind::Basic); }
                SplitNodeEdgeDirection::Backward => { graph.add_edge(edge.target, node, EdgeKind::Basic); }
                SplitNodeEdgeDirection::Passage => { graph.add_bidirectional_edge(node, edge.target, EdgeKind::Basic); }
            }
        }
        new_nodes.push(node);
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
    fn try_add_split_node_mints_a_new_node_at_the_same_point() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
        let new_nodes = try_add_split_node(&mut field, &mut g, &mut ids, slot0, &[vec![]], &PresetState::empty());
        let new_nodes = new_nodes.expect("split_is_eligible must allow an unsplit point");
        assert_eq!(new_nodes.len(), 1);
        assert_ne!(new_nodes[0], slot0);
        assert!(field.nodes_at(SquarePoint { x: 0, y: 0 }).contains(&new_nodes[0]));
    }

    #[test]
    fn try_add_split_node_mints_multiple_siblings_in_one_atomic_call() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
        let new_nodes = try_add_split_node(&mut field, &mut g, &mut ids, slot0, &[vec![], vec![]], &PresetState::empty()).unwrap();
        assert_eq!(new_nodes.len(), 2);
        assert_ne!(new_nodes[0], new_nodes[1]);
        let at_point = field.nodes_at(SquarePoint { x: 0, y: 0 });
        assert!(at_point.contains(&new_nodes[0]));
        assert!(at_point.contains(&new_nodes[1]));
        assert_eq!(at_point.len(), 3, "slot0 plus both new siblings");
    }

    #[test]
    fn try_add_split_node_wires_forward_backward_and_passage_edges() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
        let right = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let edges = vec![SplitNodeEdge { target: right, direction: SplitNodeEdgeDirection::Passage }];
        let new_nodes = try_add_split_node(&mut field, &mut g, &mut ids, slot0, &[edges], &PresetState::empty()).unwrap();
        let new_node = new_nodes[0];
        assert!(g.edge_between(new_node, right).is_some());
        assert!(g.edge_between(right, new_node).is_some());
    }

    #[test]
    fn try_add_split_node_forward_direction_is_one_way_from_new_node() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
        let right = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let edges = vec![SplitNodeEdge { target: right, direction: SplitNodeEdgeDirection::Forward }];
        let new_nodes = try_add_split_node(&mut field, &mut g, &mut ids, slot0, &[edges], &PresetState::empty()).unwrap();
        let new_node = new_nodes[0];
        assert!(g.edge_between(new_node, right).is_some());
        assert!(g.edge_between(right, new_node).is_none());
    }

    #[test]
    fn try_add_split_node_backward_direction_is_one_way_into_new_node() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
        let right = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let edges = vec![SplitNodeEdge { target: right, direction: SplitNodeEdgeDirection::Backward }];
        let new_nodes = try_add_split_node(&mut field, &mut g, &mut ids, slot0, &[edges], &PresetState::empty()).unwrap();
        let new_node = new_nodes[0];
        assert!(g.edge_between(right, new_node).is_some());
        assert!(g.edge_between(new_node, right).is_none());
    }

    #[test]
    fn try_add_split_node_refuses_when_point_already_split() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
        field.add_node_at(SquarePoint { x: 0, y: 0 }, &mut ids);
        assert!(try_add_split_node(&mut field, &mut g, &mut ids, slot0, &[vec![]], &PresetState::empty()).is_none(),
            "a point that's already multi-node must never be split again");
    }

    #[test]
    fn try_add_split_node_refuses_when_slot0_is_locked() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(1);
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(slot0);
        assert!(try_add_split_node(&mut field, &mut g, &mut ids, slot0, &[vec![]], &preset_state).is_none());
    }

    #[test]
    fn try_add_split_node_all_or_nothing_when_one_edge_is_infeasible() {
        let (mut field, mut g, mut ids, slot0) = field_for_add_split(4);
        let right = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_in.insert(right); // forbids Forward into `right`
        let edges = vec![
            SplitNodeEdge { target: right, direction: SplitNodeEdgeDirection::Forward },
        ];
        assert!(try_add_split_node(&mut field, &mut g, &mut ids, slot0, &[edges], &preset_state).is_none(),
            "a single infeasible edge must fail the whole command, minting no node at all");
        assert_eq!(field.nodes_at(SquarePoint { x: 0, y: 0 }).len(), 1, "no node must be minted on a declined command");
    }
}
