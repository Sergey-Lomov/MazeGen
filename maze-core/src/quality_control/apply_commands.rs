use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::MutationCommand;
use crate::event_log::ScopeGuard;
use super::event::QcEvent;

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use rand::RngCore;
#[cfg(test)]
use crate::repair::{RepairStrategy, RepairResult, NestedStrategyConfig, params::StrategyParams};
#[cfg(test)]
use super::rule::Rule;

/// How many of a strategy's proposed `MutationCommand`s actually applied — see GitHub issue #118,
/// `Specs/repair.md`. Carried on `RuleIterationOutcome::Repaired` back to the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ApplyOutcome {
    pub proposed: usize,
    pub applied: usize,
}

/// Applies `commands` to the real `maze`, revalidating each one right before it's applied and
/// silently dropping it (not an error, doesn't change the caller's `RepairResult`) if it no longer
/// holds — see `Specs/repair.md`'s "Where commands are applied and revalidated". Contains no
/// feasibility logic of its own: every arm calls the same `try_*` helper `generation::mod`'s
/// `cmd_*` builders already use internally, so construction-time and apply-time feasibility can
/// never disagree (see `MutationCommand`'s own doc comment).
///
/// `pub` (not `pub(crate)`) so integration tests (`maze-core/tests/*.rs`, a separate crate) can
/// exercise the same apply-then-commit sequencing `Rule::check_and_repair_typed` uses internally.
///
/// `event_log` (GitHub issue #147) emits one `QcEvent` per command, in the same order commands are
/// applied — the mutating mirror variant when `ok == true`, the matching `*Declined` trace variant
/// (same fields) when `ok == false`. Emitted here, not by the caller, because this function is the
/// only place that knows both the command's real fields (already at hand from the `match`) and its
/// actual revalidation outcome — a caller re-deriving that from `ApplyOutcome`'s aggregate counts
/// couldn't tell *which* command in the batch was declined.
pub fn apply_commands<T: Tessellation>(
    maze: &mut Maze<T>,
    preset_state: &PresetState,
    commands: Vec<MutationCommand>,
    mut event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
    mut debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
) -> ApplyOutcome {
    let proposed = commands.len();
    let mut applied = 0;
    for cmd in commands {
        // `RemoveEdge`/`RemoveEdgeWithReverse`/`RemoveTeleportWithReverse` carry only an opaque
        // `EdgeId` — meaningless to web-side debug narration on its own (GitHub issue #171's
        // follow-up fix: `bubbleLabel` used to mis-render it as a `NodeId`, crashing once the id
        // exceeded the maze's own node count). Resolved to `(from, to)` here, *before* the edge is
        // actually removed below — `graph.edge(id)` returns `None` once removed, so this must
        // happen ahead of the `match`.
        let edge_endpoints = match &cmd {
            MutationCommand::RemoveEdge { id }
            | MutationCommand::RemoveEdgeWithReverse { id }
            | MutationCommand::RemoveTeleportWithReverse { id }
            | MutationCommand::RemoveVerticalPassageWithReverse { id } =>
                maze.graph.edge(*id).map(|e| (e.from, e.to)),
            _ => None,
        };
        // `ReplacePointNodes`'s `old_nodes` (every node currently at `at`'s point) must be resolved
        // before the mutation runs, same "resolve while it's still live" reasoning as
        // `edge_endpoints` above — `field.point_of`/`nodes_at` no longer return the old nodes once
        // `try_replace_point_nodes` has replaced them.
        let old_point_nodes = match &cmd {
            MutationCommand::ReplacePointNodes { at, .. } =>
                maze.field.level_of(*at).zip(maze.field.point_of(*at))
                    .map(|(level, point)| maze.field.nodes_at(level, point).to_vec()),
            _ => None,
        };
        // `reverse_removed` is only meaningful for `RemoveEdgeWithReverse`/
        // `RemoveTeleportWithReverse` (see those two `QcEvent` variants' own doc comments) — both
        // return every `EdgeId` actually removed (one or two), so `len() > 1` means the reverse
        // leg was genuinely there and got removed too, not just assumed from the command shape.
        let mut reverse_removed = false;
        let mut replaced_nodes: Option<Vec<NodeId>> = None;
        let ok = match cmd {
            MutationCommand::AddDirectedEdge { from, to } =>
                crate::generation::try_add_directed_edge(&mut maze.graph, from, to, preset_state),
            MutationCommand::AddBidirectionalEdge { a, b } =>
                crate::generation::try_add_bidirectional_edge(&mut maze.graph, a, b, preset_state),
            MutationCommand::AddDirectedTeleport { from, to } =>
                crate::generation::try_add_directed_teleport(&mut maze.graph, from, to, preset_state),
            MutationCommand::AddBidirectionalTeleport { a, b } =>
                crate::generation::try_add_bidirectional_teleport(&mut maze.graph, a, b, preset_state),
            MutationCommand::AddDirectedVerticalPassage { from, to } =>
                crate::generation::try_add_directed_vertical_passage(&mut maze.graph, from, to, preset_state),
            MutationCommand::AddBidirectionalVerticalPassage { a, b } =>
                crate::generation::try_add_bidirectional_vertical_passage(&mut maze.graph, a, b, preset_state),
            MutationCommand::AddBidirectionalElevator { a, b } =>
                crate::generation::try_add_bidirectional_elevator(&mut maze.graph, a, b, preset_state),
            MutationCommand::RemoveEdge { id } =>
                crate::generation::try_remove_edge_by_id(&mut maze.graph, id, preset_state),
            MutationCommand::RemoveEdgeBetween { from, to } =>
                crate::generation::try_remove_edge(&mut maze.graph, from, to, preset_state),
            MutationCommand::RemoveEdgeWithReverse { id } => {
                let removed = crate::generation::try_remove_edge_with_reverse(&mut maze.graph, id, preset_state);
                reverse_removed = removed.len() > 1;
                !removed.is_empty()
            }
            MutationCommand::RemoveTeleportWithReverse { id } => {
                let removed = crate::generation::try_remove_teleport_with_reverse(&mut maze.graph, id, preset_state);
                reverse_removed = removed.len() > 1;
                !removed.is_empty()
            }
            MutationCommand::RemoveVerticalPassageWithReverse { id } => {
                let removed = crate::generation::try_remove_vertical_passage_with_reverse(&mut maze.graph, id, preset_state);
                reverse_removed = removed.len() > 1;
                !removed.is_empty()
            }
            MutationCommand::SetStart(node) => {
                if maze.meta.start.is_none() { maze.meta.start = Some(node); }
                true
            }
            MutationCommand::SetFinish(node) => {
                if maze.meta.finish.is_none() { maze.meta.finish = Some(node); }
                true
            }
            MutationCommand::RemoveNode { node } => {
                // Note the node's own coordinates into the ledger (GitHub issue #271) *before*
                // removal, same "resolve while it's still live" reasoning as `old_point_nodes`
                // above — `field.point_of` returns `None` once `try_remove_node` has removed it.
                // Needed for a node that was never itself minted mid-run (e.g. the field's own
                // original base nodes), whose coordinates otherwise exist nowhere once gone from
                // both `Field` and the final snapshot.
                if let (Some(state), Some(point)) = (debug_state.as_deref_mut(), maze.field.point_of(node)) {
                    state.note(node, point);
                }
                crate::generation::try_remove_node(&mut maze.field, &mut maze.graph, node, preset_state)
            }
            MutationCommand::ReplacePointNodes { at, ref nodes } => {
                // Note every old node's coordinates into the ledger (GitHub issue #271) *before*
                // replacement — same rationale as `RemoveNode` above. `old_point_nodes` was already
                // resolved while still live; its point is `at`'s own (every old node lives there).
                if let (Some(state), Some(old_nodes)) = (debug_state.as_deref_mut(), old_point_nodes.as_ref()) {
                    if let Some(point) = maze.field.point_of(at) {
                        for &old in old_nodes {
                            state.note(old, point);
                        }
                    }
                }
                let new_nodes = crate::generation::try_replace_point_nodes(&mut maze.field, &mut maze.graph, &mut maze.ids, at, nodes, preset_state, debug_state.as_deref_mut());
                let ok = new_nodes.is_some();
                replaced_nodes = new_nodes;
                ok
            }
        };
        if ok { applied += 1; }
        if let Some(log) = event_log.as_mut() {
            if let Some(event) = qc_event_for_command(&cmd, ok, edge_endpoints, reverse_removed, old_point_nodes, replaced_nodes) {
                log.emit(event);
            }
        }
    }
    ApplyOutcome { proposed, applied }
}

/// Builds the `QcEvent` mirroring `cmd` — the mutating variant when `applied`, the matching
/// `*Declined` trace variant (same fields) otherwise. See `apply_commands`'s doc comment.
/// `edge_endpoints` is `Some((from, to))` for `RemoveEdge`/`RemoveEdgeWithReverse`/
/// `RemoveTeleportWithReverse` (resolved by the caller before the edge was removed — GitHub issue
/// #171's follow-up fix), `None` for every other command (ignored). Returns `None` (nothing to
/// emit) for those three specifically when `edge_endpoints` is `None` — the id was already gone by
/// the time it was resolved — rather than fabricating a `(0, 0)` self-loop via `unwrap_or_default`:
/// node id `0` is a real, valid id in this codebase, so a fabricated pair would be
/// indistinguishable from a genuine edge. `reverse_removed` (GitHub issue #185's follow-up fix) is
/// only read for the two `*WithReverse` commands — `true` iff the reverse leg actually existed and
/// was removed too, straight from `try_remove_edge_with_reverse`/`try_remove_teleport_with_reverse`'s
/// own `Vec<EdgeId>` length, not assumed from the command's shape; lets web-side replay
/// (`applyQc` in `qc.ts`) know whether to also clear the reverse `(to, from)` pair from its own
/// accumulator instead of guessing and risking a phantom removed-edge entry for a direction that
/// was never actually there.
fn qc_event_for_command(cmd: &MutationCommand, applied: bool, edge_endpoints: Option<(NodeId, NodeId)>, reverse_removed: bool, old_point_nodes: Option<Vec<NodeId>>, replaced_nodes: Option<Vec<NodeId>>) -> Option<QcEvent> {
    Some(match (cmd, applied) {
        (MutationCommand::AddDirectedEdge { from, to }, true) => QcEvent::DirectedEdgeAdded { from: *from, to: *to },
        (MutationCommand::AddDirectedEdge { from, to }, false) => QcEvent::DirectedEdgeDeclined { from: *from, to: *to },
        (MutationCommand::AddBidirectionalEdge { a, b }, true) => QcEvent::BidirectionalEdgeAdded { a: *a, b: *b },
        (MutationCommand::AddBidirectionalEdge { a, b }, false) => QcEvent::BidirectionalEdgeDeclined { a: *a, b: *b },
        (MutationCommand::AddDirectedTeleport { from, to }, true) => QcEvent::DirectedTeleportAdded { from: *from, to: *to },
        (MutationCommand::AddDirectedTeleport { from, to }, false) => QcEvent::DirectedTeleportDeclined { from: *from, to: *to },
        (MutationCommand::AddBidirectionalTeleport { a, b }, true) => QcEvent::BidirectionalTeleportAdded { a: *a, b: *b },
        (MutationCommand::AddBidirectionalTeleport { a, b }, false) => QcEvent::BidirectionalTeleportDeclined { a: *a, b: *b },
        (MutationCommand::AddDirectedVerticalPassage { from, to }, true) => QcEvent::DirectedVerticalPassageAdded { from: *from, to: *to },
        (MutationCommand::AddDirectedVerticalPassage { from, to }, false) => QcEvent::DirectedVerticalPassageDeclined { from: *from, to: *to },
        (MutationCommand::AddBidirectionalVerticalPassage { a, b }, true) => QcEvent::BidirectionalVerticalPassageAdded { a: *a, b: *b },
        (MutationCommand::AddBidirectionalVerticalPassage { a, b }, false) => QcEvent::BidirectionalVerticalPassageDeclined { a: *a, b: *b },
        (MutationCommand::AddBidirectionalElevator { a, b }, true) => QcEvent::BidirectionalElevatorAdded { a: *a, b: *b },
        (MutationCommand::AddBidirectionalElevator { a, b }, false) => QcEvent::BidirectionalElevatorDeclined { a: *a, b: *b },
        (MutationCommand::RemoveEdge { .. }, true) => { let (from, to) = edge_endpoints?; QcEvent::EdgeRemoved { from, to } }
        (MutationCommand::RemoveEdge { .. }, false) => { let (from, to) = edge_endpoints?; QcEvent::EdgeRemoveDeclined { from, to } }
        (MutationCommand::RemoveEdgeBetween { from, to }, true) => QcEvent::EdgeRemovedBetween { from: *from, to: *to },
        (MutationCommand::RemoveEdgeBetween { from, to }, false) => QcEvent::EdgeRemoveBetweenDeclined { from: *from, to: *to },
        (MutationCommand::RemoveEdgeWithReverse { .. }, true) => { let (from, to) = edge_endpoints?; QcEvent::EdgeRemovedWithReverse { from, to, reverse_removed } }
        (MutationCommand::RemoveEdgeWithReverse { .. }, false) => { let (from, to) = edge_endpoints?; QcEvent::EdgeRemoveWithReverseDeclined { from, to, reverse_removed } }
        (MutationCommand::RemoveTeleportWithReverse { .. }, true) => { let (from, to) = edge_endpoints?; QcEvent::TeleportRemovedWithReverse { from, to, reverse_removed } }
        (MutationCommand::RemoveTeleportWithReverse { .. }, false) => { let (from, to) = edge_endpoints?; QcEvent::TeleportRemoveWithReverseDeclined { from, to, reverse_removed } }
        (MutationCommand::RemoveVerticalPassageWithReverse { .. }, true) => { let (from, to) = edge_endpoints?; QcEvent::VerticalPassageRemovedWithReverse { from, to, reverse_removed } }
        (MutationCommand::RemoveVerticalPassageWithReverse { .. }, false) => { let (from, to) = edge_endpoints?; QcEvent::VerticalPassageRemoveWithReverseDeclined { from, to, reverse_removed } }
        (MutationCommand::SetStart(node), true) => QcEvent::StartSet(*node),
        (MutationCommand::SetStart(node), false) => QcEvent::StartSetDeclined(*node),
        (MutationCommand::SetFinish(node), true) => QcEvent::FinishSet(*node),
        (MutationCommand::SetFinish(node), false) => QcEvent::FinishSetDeclined(*node),
        (MutationCommand::RemoveNode { node }, true) => QcEvent::NodeRemoved(*node),
        (MutationCommand::RemoveNode { node }, false) => QcEvent::NodeRemoveDeclined(*node),
        (MutationCommand::ReplacePointNodes { at, nodes }, true) => {
            let new_nodes = replaced_nodes?;
            let old_nodes = old_point_nodes?;
            QcEvent::PointNodesReplaced { at: *at, old_nodes, new_nodes, nodes: nodes.clone() }
        }
        (MutationCommand::ReplacePointNodes { at, nodes }, false) => {
            let old_nodes = old_point_nodes.unwrap_or_default();
            QcEvent::PointNodesReplaceDeclined { at: *at, old_nodes, nodes: nodes.clone() }
        }
    })
}

/// Builds the `QcEvent::*Proposed` variant mirroring `cmd`, narrating what a strategy's `apply()`
/// asked for before `apply_commands` has revalidated/applied any of it — see
/// `check_and_repair_typed`'s doc comment for where this is emitted (the `"strategy <id>"` scope,
/// ahead of the separate `"apply requests"` scope `apply_commands` itself emits into). `maze` is
/// only used to resolve `RemoveEdge`/`RemoveTeleportWithReverse`'s `EdgeId` to `(from, to)` (GitHub
/// issue #171's follow-up fix) — the graph is still fully intact here (nothing has been mutated
/// yet), so `graph.edge(id)` is always a hit unless the strategy proposed a stale id. Returns `None`
/// (nothing to emit) in that stale-id case rather than fabricating a `(0, 0)` self-loop via
/// `unwrap_or_default` — node id `0` is a real, valid id, so a fabricated pair would be
/// indistinguishable from a genuine edge; `apply_commands`'s own revalidation declines the stale
/// command anyway, so skipping the proposal narration here loses nothing meaningful.
pub(super) fn qc_event_proposed_for_command<T: Tessellation>(cmd: &MutationCommand, maze: &Maze<T>) -> Option<QcEvent> {
    Some(match cmd {
        MutationCommand::AddDirectedEdge { from, to } => QcEvent::DirectedEdgeProposed { from: *from, to: *to },
        MutationCommand::AddBidirectionalEdge { a, b } => QcEvent::BidirectionalEdgeProposed { a: *a, b: *b },
        MutationCommand::AddDirectedTeleport { from, to } => QcEvent::DirectedTeleportProposed { from: *from, to: *to },
        MutationCommand::AddBidirectionalTeleport { a, b } => QcEvent::BidirectionalTeleportProposed { a: *a, b: *b },
        MutationCommand::AddDirectedVerticalPassage { from, to } => QcEvent::DirectedVerticalPassageProposed { from: *from, to: *to },
        MutationCommand::AddBidirectionalVerticalPassage { a, b } => QcEvent::BidirectionalVerticalPassageProposed { a: *a, b: *b },
        MutationCommand::AddBidirectionalElevator { a, b } => QcEvent::BidirectionalElevatorProposed { a: *a, b: *b },
        MutationCommand::RemoveEdge { id } => {
            let (from, to) = maze.graph.edge(*id).map(|e| (e.from, e.to))?;
            QcEvent::EdgeRemoveProposed { from, to }
        }
        MutationCommand::RemoveEdgeBetween { from, to } => QcEvent::EdgeRemoveBetweenProposed { from: *from, to: *to },
        MutationCommand::RemoveEdgeWithReverse { id } => {
            let (from, to) = maze.graph.edge(*id).map(|e| (e.from, e.to))?;
            QcEvent::EdgeRemoveWithReverseProposed { from, to }
        }
        MutationCommand::RemoveTeleportWithReverse { id } => {
            let (from, to) = maze.graph.edge(*id).map(|e| (e.from, e.to))?;
            QcEvent::TeleportRemoveWithReverseProposed { from, to }
        }
        MutationCommand::RemoveVerticalPassageWithReverse { id } => {
            let (from, to) = maze.graph.edge(*id).map(|e| (e.from, e.to))?;
            QcEvent::VerticalPassageRemoveWithReverseProposed { from, to }
        }
        MutationCommand::SetStart(node) => QcEvent::StartSetProposed(*node),
        MutationCommand::SetFinish(node) => QcEvent::FinishSetProposed(*node),
        MutationCommand::RemoveNode { node } => QcEvent::NodeRemoveProposed(*node),
        MutationCommand::ReplacePointNodes { at, nodes } => {
            let old_nodes = maze.field.level_of(*at).zip(maze.field.point_of(*at))
                .map(|(level, point)| maze.field.nodes_at(level, point).to_vec()).unwrap_or_default();
            QcEvent::PointNodesReplaceProposed { at: *at, old_nodes, nodes: nodes.clone() }
        }
    })
}

/// Direct unit tests for `apply_commands` — one revalidation arm per `MutationCommand` variant,
/// plus the revalidate-and-drop mechanism itself (GitHub issue #118, `Specs/repair.md`'s
/// mutation-command contract): a command built against an earlier snapshot that no longer holds
/// by commit time must be silently dropped, not panic or corrupt the graph, and must not prevent
/// the rest of the batch from applying.
#[cfg(test)]
#[path = "apply_commands_tests.rs"]
mod apply_commands_tests;
