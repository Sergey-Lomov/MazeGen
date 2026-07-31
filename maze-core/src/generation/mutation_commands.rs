// MutationCommand builders (GitHub issue #118)
//
// Read-only counterparts of the `try_*` helpers in `edge_ops.rs`, for a `RepairStrategy` holding
// only `&Maze` (never `&mut Maze`, see `Specs/repair.md`'s mutation-command contract). Each
// `cmd_*` function checks the same feasibility a strategy would need before proposing a mutation
// and, if feasible, returns the equivalent `MutationCommand`(s) instead of mutating —
// `apply_commands` (see `quality_control::rule`) later calls the matching `try_*` for real, so
// these two paths can never disagree about "was this even worth proposing" vs. "is this still
// valid to apply".
//
// Maintenance rule: every `try_*` in `edge_ops.rs` needs a `cmd_*` counterpart here (see
// `MutationCommand`'s own doc comment) — a strategy cannot reach a mutating helper that has none,
// since it never holds `&mut Graph`.

use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use crate::repair::command::{MutationCommand, SplitNodeEdge};
use super::preset_state::PresetState;
use super::edge_ops::{directed_edge_feasible, bidirectional_edge_feasible, remove_edge_between_feasible};
use super::node_ops::{remove_node_feasible, replace_point_nodes_feasible};

// Step 1 of GitHub issue #118's migration (Specs/repair.md): additive, not yet wired into any
// caller — strategies still mutate `&mut Maze` directly today. `#[allow(dead_code)]` until step 2
// switches `RepairStrategy::apply` to call these instead of the `try_*` helpers above.
// Add-side `cmd_*` builders only ever consult `PresetState`, never `Graph` — every `try_add_*`
// counterpart is completion-aware/idempotent (adds whichever direction is missing, or is a no-op
// if the edge already exists) and so never fails for a *structural* reason, only a preset one
// (see each `try_add_*`'s own doc comment). There is no `can_add_edge`-style dry-run check to
// share here because there is nothing it could catch that preset feasibility doesn't already
// cover — see `Graph::can_add_edge`'s doc comment for where a structural check would matter.

#[allow(dead_code)]
pub(crate) fn cmd_add_directed_edge(from: NodeId, to: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !directed_edge_feasible(preset_state, from, to) { return vec![]; }
    vec![MutationCommand::AddDirectedEdge { from, to }]
}

#[allow(dead_code)]
pub(crate) fn cmd_add_bidirectional_edge(a: NodeId, b: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !bidirectional_edge_feasible(preset_state, a, b) { return vec![]; }
    // One command covers both directions — mirrors try_add_bidirectional_edge's own atomic
    // "complete whichever direction is missing" contract; see MutationCommand's doc comment.
    vec![MutationCommand::AddBidirectionalEdge { a, b }]
}

#[allow(dead_code)]
pub(crate) fn cmd_add_directed_teleport(a: NodeId, b: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !directed_edge_feasible(preset_state, a, b) { return vec![]; }
    vec![MutationCommand::AddDirectedTeleport { from: a, to: b }]
}

#[allow(dead_code)]
pub(crate) fn cmd_add_bidirectional_teleport(a: NodeId, b: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !bidirectional_edge_feasible(preset_state, a, b) { return vec![]; }
    vec![MutationCommand::AddBidirectionalTeleport { a, b }]
}

#[allow(dead_code)]
pub(crate) fn cmd_remove_edge(graph: &Graph, from: NodeId, to: NodeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !remove_edge_between_feasible(preset_state, from, to) { return vec![]; }
    let Some(id) = graph.edge_between(from, to) else { return vec![]; };
    if !graph.can_remove_edge(id) { return vec![]; }
    vec![MutationCommand::RemoveEdgeBetween { from, to }]
}

#[allow(dead_code)]
pub(crate) fn cmd_remove_edge_by_id(graph: &Graph, id: crate::ids::EdgeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !graph.can_remove_edge(id) { return vec![]; }
    let edge = graph.edge(id).expect("can_remove_edge just confirmed this id exists");
    if edge.kind == EdgeKind::Basic && !remove_edge_between_feasible(preset_state, edge.from, edge.to) {
        return vec![];
    }
    vec![MutationCommand::RemoveEdge { id }]
}

#[allow(dead_code)]
pub(crate) fn cmd_remove_teleport_with_reverse(graph: &Graph, id: crate::ids::EdgeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !graph.can_remove_edge(id) { return vec![]; }
    let _ = preset_state; // re-checked for real by try_remove_teleport_with_reverse at apply time
    vec![MutationCommand::RemoveTeleportWithReverse { id }]
}

#[allow(dead_code)]
pub(crate) fn cmd_remove_edge_with_reverse(graph: &Graph, id: crate::ids::EdgeId, preset_state: &PresetState) -> Vec<MutationCommand> {
    if !graph.can_remove_edge(id) { return vec![]; }
    let _ = preset_state; // re-checked for real by try_remove_edge_with_reverse at apply time
    vec![MutationCommand::RemoveEdgeWithReverse { id }]
}

#[allow(dead_code)]
pub(crate) fn cmd_remove_node<T: Tessellation>(field: &Field<T>, preset_state: &PresetState, node: NodeId) -> Vec<MutationCommand> {
    if !remove_node_feasible(field, preset_state, node) { return vec![]; }
    vec![MutationCommand::RemoveNode { node }]
}

#[allow(dead_code)]
pub(crate) fn cmd_replace_point_nodes<T: Tessellation>(field: &Field<T>, preset_state: &PresetState, at: NodeId, nodes: Vec<Vec<SplitNodeEdge>>) -> Vec<MutationCommand> {
    if !replace_point_nodes_feasible(field, preset_state, at, &nodes) { return vec![]; }
    vec![MutationCommand::ReplacePointNodes { at, nodes }]
}

/// Direct unit tests for the `cmd_*` `MutationCommand` builders and the feasibility predicates
/// they share with their `try_*` mutating counterparts (GitHub issue #118, `Specs/repair.md`).
/// These builders had no direct test coverage before — only exercised transitively (and only
/// while still `#[allow(dead_code)]`, i.e. not exercised at all) — so this module specifically
/// covers: each builder proposing the right command when feasible, and being blocked by the same
/// `PresetState` conditions its `try_*` counterpart is blocked by (the property the shared
/// predicates exist to guarantee).
#[cfg(test)]
mod cmd_builders_tests {
    use super::*;
    use crate::space::{Field, SquareTessellation, square_rect};
    use super::super::edge_ops::{try_add_directed_edge, try_add_bidirectional_edge, try_remove_edge_by_id};

    fn graph_and_nodes(n: usize) -> (Graph, Vec<NodeId>) {
        let mut ids = crate::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(n, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<NodeId> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        (g, nodes)
    }

    /// Field + extra split node at its first point — the shape `cmd_remove_node` needs (a `Field`
    /// to resolve slot-0/point identity against, unlike every other `cmd_*` builder here which
    /// only ever touches `Graph`).
    fn field_with_extra_node() -> (Field<SquareTessellation>, NodeId, NodeId) {
        let mut ids = crate::IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let p = field.all_points().next().unwrap();
        let slot0 = field.node_at(p).unwrap();
        let extra = field.add_node_at(p, &mut ids);
        (field, slot0, extra)
    }

    #[test]
    fn cmd_add_directed_edge_proposes_when_feasible() {
        let (_, nodes) = graph_and_nodes(2);
        let cmds = cmd_add_directed_edge(nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::AddDirectedEdge { from: nodes[0], to: nodes[1] }]);
    }

    #[test]
    fn cmd_add_directed_edge_blocked_by_locked_out() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(nodes[0]);
        assert!(cmd_add_directed_edge(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_add_directed_edge_blocked_by_locked_in() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.locked_in.insert(nodes[1]);
        assert!(cmd_add_directed_edge(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_add_directed_edge_blocked_by_blocked_pair() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        assert!(cmd_add_directed_edge(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_add_bidirectional_edge_proposes_when_feasible() {
        let (_, nodes) = graph_and_nodes(2);
        let cmds = cmd_add_bidirectional_edge(nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::AddBidirectionalEdge { a: nodes[0], b: nodes[1] }]);
    }

    #[test]
    fn cmd_add_bidirectional_edge_blocked_if_either_direction_blocked() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[1], nodes[0])); // only the reverse direction blocked
        assert!(cmd_add_bidirectional_edge(nodes[0], nodes[1], &preset_state).is_empty(),
            "bidirectional add must require BOTH directions free");
    }

    #[test]
    fn cmd_add_directed_teleport_proposes_when_feasible() {
        let (_, nodes) = graph_and_nodes(2);
        let cmds = cmd_add_directed_teleport(nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::AddDirectedTeleport { from: nodes[0], to: nodes[1] }]);
    }

    #[test]
    fn cmd_add_directed_teleport_blocked_by_preset() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((nodes[0], nodes[1]));
        assert!(cmd_add_directed_teleport(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_add_bidirectional_teleport_proposes_when_feasible() {
        let (_, nodes) = graph_and_nodes(2);
        let cmds = cmd_add_bidirectional_teleport(nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::AddBidirectionalTeleport { a: nodes[0], b: nodes[1] }]);
    }

    #[test]
    fn cmd_add_bidirectional_teleport_blocked_if_either_direction_blocked() {
        let (_, nodes) = graph_and_nodes(2);
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(nodes[1]);
        assert!(cmd_add_bidirectional_teleport(nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_remove_edge_proposes_when_edge_exists() {
        let (mut g, nodes) = graph_and_nodes(2);
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let cmds = cmd_remove_edge(&g, nodes[0], nodes[1], &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::RemoveEdgeBetween { from: nodes[0], to: nodes[1] }]);
    }

    #[test]
    fn cmd_remove_edge_empty_when_no_edge_exists() {
        let (g, nodes) = graph_and_nodes(2);
        assert!(cmd_remove_edge(&g, nodes[0], nodes[1], &PresetState::empty()).is_empty(),
            "must not propose removing an edge that structurally doesn't exist");
    }

    #[test]
    fn cmd_remove_edge_blocked_by_preset_protection() {
        let (mut g, nodes) = graph_and_nodes(2);
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((nodes[0], nodes[1]));
        assert!(cmd_remove_edge(&g, nodes[0], nodes[1], &preset_state).is_empty());
    }

    #[test]
    fn cmd_remove_edge_by_id_proposes_when_edge_exists() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let cmds = cmd_remove_edge_by_id(&g, id, &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::RemoveEdge { id }]);
    }

    #[test]
    fn cmd_remove_edge_by_id_empty_when_id_stale() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.remove_initial_edge(id);
        assert!(cmd_remove_edge_by_id(&g, id, &PresetState::empty()).is_empty(),
            "a removed edge's stale id must not be proposed for removal again");
    }

    #[test]
    fn cmd_remove_edge_by_id_blocked_by_preset_protection_for_basic_edge() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((nodes[0], nodes[1]));
        assert!(cmd_remove_edge_by_id(&g, id, &preset_state).is_empty());
    }

    #[test]
    fn cmd_remove_edge_by_id_ignores_preset_edges_for_teleport_kind() {
        // preset_edges only ever protects Basic edges (see try_remove_edge_by_id's own doc
        // comment) — a Teleport sharing the same (from, to) pair must still be removable.
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((nodes[0], nodes[1]));
        assert_eq!(cmd_remove_edge_by_id(&g, id, &preset_state), vec![MutationCommand::RemoveEdge { id }]);
    }

    #[test]
    fn cmd_remove_teleport_with_reverse_proposes_when_edge_exists() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        let cmds = cmd_remove_teleport_with_reverse(&g, id, &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::RemoveTeleportWithReverse { id }]);
    }

    #[test]
    fn cmd_remove_teleport_with_reverse_empty_when_id_stale() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Teleport);
        g.remove_initial_edge(id);
        assert!(cmd_remove_teleport_with_reverse(&g, id, &PresetState::empty()).is_empty());
    }

    #[test]
    fn cmd_remove_edge_with_reverse_proposes_when_edge_exists() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let cmds = cmd_remove_edge_with_reverse(&g, id, &PresetState::empty());
        assert_eq!(cmds, vec![MutationCommand::RemoveEdgeWithReverse { id }]);
    }

    #[test]
    fn cmd_remove_edge_with_reverse_empty_when_id_stale() {
        let (mut g, nodes) = graph_and_nodes(2);
        let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.remove_initial_edge(id);
        assert!(cmd_remove_edge_with_reverse(&g, id, &PresetState::empty()).is_empty());
    }

    /// Cross-checks a `cmd_*` builder's verdict against its `try_*` counterpart's actual result
    /// for every corner of the shared feasibility predicate — the exact property the refactor to
    /// shared predicates (`directed_edge_feasible`/`bidirectional_edge_feasible`/
    /// `remove_edge_between_feasible`) exists to guarantee can never regress silently.
    #[test]
    fn cmd_and_try_agree_on_every_preset_lock_combination_for_directed_edge() {
        for (lock_out, lock_in, blocked) in [
            (false, false, false), (true, false, false), (false, true, false), (false, false, true),
        ] {
            let (mut g, nodes) = graph_and_nodes(2);
            let mut preset_state = PresetState::empty();
            if lock_out { preset_state.locked_out.insert(nodes[0]); }
            if lock_in { preset_state.locked_in.insert(nodes[1]); }
            if blocked { preset_state.blocked.insert((nodes[0], nodes[1])); }

            let proposed = !cmd_add_directed_edge(nodes[0], nodes[1], &preset_state).is_empty();
            let applied = try_add_directed_edge(&mut g, nodes[0], nodes[1], &preset_state);
            assert_eq!(proposed, applied,
                "cmd_add_directed_edge and try_add_directed_edge disagreed for locks ({lock_out}, {lock_in}, {blocked})");
        }
    }

    #[test]
    fn cmd_and_try_agree_on_every_preset_lock_combination_for_bidirectional_edge() {
        for (lock_out_a, lock_in_b, blocked_fwd) in [
            (false, false, false), (true, false, false), (false, true, false), (false, false, true),
        ] {
            let (mut g, nodes) = graph_and_nodes(2);
            let mut preset_state = PresetState::empty();
            if lock_out_a { preset_state.locked_out.insert(nodes[0]); }
            if lock_in_b { preset_state.locked_in.insert(nodes[1]); }
            if blocked_fwd { preset_state.blocked.insert((nodes[0], nodes[1])); }

            let proposed = !cmd_add_bidirectional_edge(nodes[0], nodes[1], &preset_state).is_empty();
            let applied = try_add_bidirectional_edge(&mut g, nodes[0], nodes[1], &preset_state);
            assert_eq!(proposed, applied,
                "cmd_add_bidirectional_edge and try_add_bidirectional_edge disagreed for locks ({lock_out_a}, {lock_in_b}, {blocked_fwd})");
        }
    }

    #[test]
    fn cmd_and_try_agree_on_preset_protection_for_remove_edge_by_id() {
        for protected in [false, true] {
            let (mut g, nodes) = graph_and_nodes(2);
            let id = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
            let mut preset_state = PresetState::empty();
            if protected { preset_state.preset_edges.insert((nodes[0], nodes[1])); }

            let proposed = !cmd_remove_edge_by_id(&g, id, &preset_state).is_empty();
            let applied = try_remove_edge_by_id(&mut g, id, &preset_state);
            assert_eq!(proposed, applied,
                "cmd_remove_edge_by_id and try_remove_edge_by_id disagreed for protected={protected}");
        }
    }

    #[test]
    fn cmd_remove_node_proposes_when_feasible() {
        let (field, _slot0, extra) = field_with_extra_node();
        let cmds = cmd_remove_node(&field, &PresetState::empty(), extra);
        assert_eq!(cmds, vec![MutationCommand::RemoveNode { node: extra }]);
    }

    #[test]
    fn cmd_remove_node_proposes_slot0_when_a_sibling_remains() {
        // Slot-0 is no longer special: with a sibling still at the point, slot0 is just as
        // proposable for removal as any other node.
        let (field, slot0, _extra) = field_with_extra_node();
        assert_eq!(cmd_remove_node(&field, &PresetState::empty(), slot0), vec![MutationCommand::RemoveNode { node: slot0 }]);
    }

    #[test]
    fn cmd_remove_node_empty_for_a_points_last_remaining_node() {
        let mut ids = crate::IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let p = field.all_points().next().unwrap();
        let slot0 = field.node_at(p).unwrap();
        assert!(cmd_remove_node(&field, &PresetState::empty(), slot0).is_empty(),
            "a point's last remaining node must never be proposed for removal");
    }

    #[test]
    fn cmd_remove_node_empty_for_a_locked_out_node() {
        let (field, _slot0, extra) = field_with_extra_node();
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(extra);
        assert!(cmd_remove_node(&field, &preset_state, extra).is_empty());
    }

    #[test]
    fn cmd_remove_node_empty_for_a_preset_edge_endpoint() {
        let (field, slot0, extra) = field_with_extra_node();
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((slot0, extra));
        assert!(cmd_remove_node(&field, &preset_state, extra).is_empty());
    }

    /// Cross-checks `cmd_remove_node`'s verdict against `try_remove_node`'s actual result, same
    /// "the two paths can never disagree" property `cmd_and_try_agree_on_*` above guarantees for
    /// the edge-addressed builders.
    #[test]
    fn cmd_and_try_agree_on_every_preset_lock_combination_for_remove_node() {
        for (locked_out, locked_in, preset_edge) in [
            (false, false, false), (true, false, false), (false, true, false), (false, false, true),
        ] {
            let (mut field, slot0, extra) = field_with_extra_node();
            let mut g = Graph::new();
            field.build_nodes(&mut g);
            g.add_node(extra);
            let mut preset_state = PresetState::empty();
            if locked_out { preset_state.locked_out.insert(extra); }
            if locked_in { preset_state.locked_in.insert(extra); }
            if preset_edge { preset_state.preset_edges.insert((slot0, extra)); }

            let proposed = !cmd_remove_node(&field, &preset_state, extra).is_empty();
            let applied = super::super::node_ops::try_remove_node(&mut field, &mut g, extra, &preset_state);
            assert_eq!(proposed, applied,
                "cmd_remove_node and try_remove_node disagreed for locks ({locked_out}, {locked_in}, {preset_edge})");
        }
    }
}
