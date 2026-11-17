// Mutating node-removal helper (GitHub issue #248, epic #246) — the `Field`/`Graph` counterpart
// of `edge_ops.rs`'s `try_remove_edge*` family, generic over `T: Tessellation` since removing a
// node (unlike removing an edge) always touches `Field` as well as `Graph`.

use super::debug_state::DebugGenerationState;
use super::preset_state::PresetState;
use crate::graph::Graph;
use crate::ids::{IdGenerator, NodeId};
use crate::repair::command::{SplitNodeEdge, SplitNodeEdgeDirection};
use crate::space::{MultiLevelField, Tessellation};

/// Shared predicate behind `remove_node_feasible` and `replace_point_nodes_feasible`: a node is
/// removable if it isn't preset-protected (locked in/out, or the endpoint of a preset connection)
/// and — unless `allow_last_node` — isn't the only node left at its point. `allow_last_node` lets
/// `replace_point_nodes_feasible` reuse the exact same preset checks for a point's last node too,
/// since `ReplacePointNodes` replaces every node at a point at once, with a guaranteed non-empty
/// replacement set, so the point is never actually left empty — unlike single-node removal
/// (`try_remove_node`), which would leave the point with zero nodes if its last one were removed.
fn node_removal_allowed<T: Tessellation>(
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    node: NodeId,
    allow_last_node: bool,
) -> bool {
    let Some(level) = field.level_of(node) else {
        return false;
    };
    let Some(point) = field.cell_of(node) else {
        return false;
    };
    if !allow_last_node && field.nodes_at(level, point).len() == 1 {
        return false; // node is this point's only remaining node — never removable by this path
    }
    !preset_state.is_node_locked_for_removal(node)
}

/// Feasibility shared by `try_remove_node`/`cmd_remove_node`: a node is only ever removable if
/// it isn't the last node left at its point — a point must always keep at least one node — and
/// isn't itself preset-protected (locked in/out, or the endpoint of a preset connection).
/// Structural existence (`field.cell_of(node).is_some()`) is checked by the caller, since only
/// `try_remove_node` has a `&mut MultiLevelField` to also act on that check's result.
pub(crate) fn remove_node_feasible<T: Tessellation>(
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    node: NodeId,
) -> bool {
    node_removal_allowed(field, preset_state, node, false)
}

/// Removes `node` (and every edge incident to it, both directions) if `remove_node_feasible`
/// allows it — mirrors `Maze::remove_node_at`'s atomic field+graph removal, but preset-aware
/// (`Maze::remove_node_at` itself has no `PresetState` parameter, so repair goes through this
/// instead). Returns `true` if the node was actually removed.
pub(crate) fn try_remove_node<T: Tessellation>(
    field: &mut MultiLevelField<T>,
    graph: &mut Graph,
    node: NodeId,
    preset_state: &PresetState,
) -> bool {
    if !remove_node_feasible(field, preset_state, node) {
        return false;
    }
    graph.remove_node(node);
    field.remove_node_at(node);
    true
}

/// Feasibility shared by `try_replace_point_nodes`/`cmd_replace_point_nodes` (`MutationCommand::
/// ReplacePointNodes`, GitHub issue #247's pattern-mode fix, epic #246): `at`'s point must still
/// exist, every node currently at that point (including its last remaining one —
/// `allow_last_node: true`) must be removable per `node_removal_allowed` (not locked, not a
/// preset-edge endpoint), `nodes` must be non-empty (a point always keeps at least one node —
/// `Field::replace_nodes_at`'s own invariant), and every edge of every new node in `nodes` must be
/// structurally permitted by `preset_state` against its `target` (new nodes are never themselves
/// preset-addressable — they don't exist yet — so only each `target`'s own lock/block state can
/// forbid a direction). All-or-nothing: a single infeasible old node, missing target, or new edge
/// fails the whole check.
///
/// **`target` must still structurally exist** (`field.cell_of(edge.target).is_some()`) — unlike
/// every other command in this crate, `ReplacePointNodes` can itself remove a node an *earlier*
/// command in the same batch already targeted as an edge endpoint (it replaces every node at the
/// point at once, not just adds beside them), so a batch proposing splits at two adjacent points can have the second
/// command's `nodes` reference a `target` the first command already replaced out from under it by
/// the time `apply_commands` gets here. Without this check the edge would silently wire to a
/// vanished id instead of the still-live replacement, losing that connection outright — this
/// mirrors the same "resolve against current state, not proposal-time state" contract every other
/// `*_feasible` check already has, just newly reachable here because this command is the first one
/// that can invalidate another command's edge target mid-batch.
pub(crate) fn replace_point_nodes_feasible<T: Tessellation>(
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
    at: NodeId,
    nodes: &[Vec<SplitNodeEdge>],
) -> bool {
    if nodes.is_empty() {
        return false;
    }
    let Some(level) = field.level_of(at) else {
        return false;
    };
    let Some(point) = field.cell_of(at) else {
        return false;
    };
    if !field
        .nodes_at(level, point)
        .iter()
        .all(|&node| node_removal_allowed(field, preset_state, node, true))
    {
        return false;
    }
    nodes.iter().flatten().all(|edge| {
        if field.cell_of(edge.target).is_none() {
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
                !preset_state.locked_in.contains(&edge.target)
                    && !preset_state.locked_out.contains(&edge.target)
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
    field: &mut MultiLevelField<T>,
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
    let level = field
        .level_of(at)
        .expect("replace_point_nodes_feasible confirmed this node exists");
    let point = field
        .cell_of(at)
        .expect("replace_point_nodes_feasible confirmed this point exists");
    let old_nodes: Vec<NodeId> = field.nodes_at(level, point).to_vec();
    for &old in &old_nodes {
        graph.remove_node(old);
    }
    let mut new_nodes = Vec::with_capacity(nodes.len());
    for _ in nodes {
        let new_id = ids.next_id();
        if let Some(state) = debug_state.as_deref_mut() {
            state.note(new_id, point);
        }
        new_nodes.push(new_id);
    }
    field.replace_nodes_at(level, point, new_nodes.clone());
    for (i, edges) in nodes.iter().enumerate() {
        let node = new_nodes[i];
        graph.add_node(node);
        for edge in edges {
            match edge.direction {
                SplitNodeEdgeDirection::Forward => {
                    graph.add_edge(node, edge.target, edge.kind);
                }
                SplitNodeEdgeDirection::Backward => {
                    graph.add_edge(edge.target, node, edge.kind);
                }
                SplitNodeEdgeDirection::Passage => {
                    graph.add_bidirectional_edge(node, edge.target, edge.kind);
                }
            }
        }
    }
    Some(new_nodes)
}

#[cfg(test)]
#[path = "node_ops_tests.rs"]
mod tests;
