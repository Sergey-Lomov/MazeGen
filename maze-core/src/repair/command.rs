use crate::graph::EdgeKind;
use crate::ids::{EdgeId, NodeId};

/// A proposed mutation a `RepairStrategy::apply` returns instead of mutating `Maze` in place —
/// see GitHub issue #118 and `Specs/repair.md`'s mutation-command contract. One variant per
/// existing `generation::mod` mutating helper (not lower-level graph primitives), so each
/// variant preserves that helper's own all-or-nothing atomicity as a single revalidatable unit —
/// e.g. `AddBidirectionalEdge` is one command, not two independent `AddDirectedEdge`s, because
/// `try_add_bidirectional_edge`'s "both directions free, or skip the pair" guarantee would
/// otherwise not survive independent per-direction revalidation.
///
/// **Maintenance rule**: every new public mutating helper added to `generation::mod` must gain
/// its own `MutationCommand` variant and paired `cmd_*` builder function in the same commit —
/// otherwise that helper is unreachable from a `RepairStrategy` under this contract at all (a
/// strategy only ever holds `&Maze`, never `&mut Maze`, so it cannot call a mutating helper
/// directly). There is no compiler enforcement for this; keep it in mind on review.
///
/// **Atomicity**: each variant is a self-contained, independently revalidated unit (see
/// `Specs/repair.md`'s "Where commands are applied and revalidated"). A strategy must not expect
/// atomicity across *multiple* commands in its own returned batch — if two mutations must both
/// apply or neither, that must be one variant, not two.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MutationCommand {
    AddDirectedEdge {
        from: NodeId,
        to: NodeId,
    },
    AddBidirectionalEdge {
        a: NodeId,
        b: NodeId,
    },
    AddDirectedTeleport {
        from: NodeId,
        to: NodeId,
    },
    AddBidirectionalTeleport {
        a: NodeId,
        b: NodeId,
    },
    AddDirectedVerticalPassage {
        from: NodeId,
        to: NodeId,
    },
    AddBidirectionalVerticalPassage {
        a: NodeId,
        b: NodeId,
    },
    /// Adds a two-way `Elevator` edge between one pair of an elevator's stops — see GitHub issue
    /// #401. No directed variant, mirrors `try_add_bidirectional_elevator`'s own no-directed-
    /// variant rationale.
    AddBidirectionalElevator {
        a: NodeId,
        b: NodeId,
    },
    /// By `EdgeId` — mirrors `try_remove_edge_by_id`'s contract (never ambiguous between a
    /// `Basic`/`Teleport` edge coexisting in the same direction).
    RemoveEdge {
        id: EdgeId,
    },
    /// By node pair — mirrors `try_remove_edge`'s contract (removes whatever single edge exists
    /// between the pair, regardless of kind).
    RemoveEdgeBetween {
        from: NodeId,
        to: NodeId,
    },
    /// Removes an edge and, if it's one direction of a two-way connection between the same pair,
    /// its reverse — mirrors `try_remove_edge_with_reverse`. Used by loop-cutting strategies
    /// (GitHub issue #185) so cutting a bidirectional passage is one atomic command, not two
    /// independently revalidated `RemoveEdge`s.
    RemoveEdgeWithReverse {
        id: EdgeId,
    },
    /// Removes a `Teleport` edge and, if it's one direction of a two-way teleport, its reverse —
    /// mirrors `try_remove_teleport_with_reverse`.
    RemoveTeleportWithReverse {
        id: EdgeId,
    },
    /// Removes a `VerticalPassage` edge and, if it's one direction of a two-way vertical passage,
    /// its reverse — mirrors `try_remove_vertical_passage_with_reverse`. See GitHub issue #343.
    RemoveVerticalPassageWithReverse {
        id: EdgeId,
    },
    /// Idempotent — applied only if `meta.start` is still unset at apply time. Deliberately has
    /// no paired `cmd_*`/`try_*` helper: it mutates `MazeMeta`, not `Graph`, so there is no
    /// edge-feasibility check to share.
    SetStart(NodeId),
    /// Idempotent — applied only if `meta.finish` is still unset at apply time. Same rationale
    /// as `SetStart` for having no paired helper.
    SetFinish(NodeId),
    /// Removes a split node (`Field::add_node_at`'s minted node, or a point's original slot-0 —
    /// issue #281: no node has special standing here) and every edge incident to it — mirrors
    /// `Maze::remove_node_at`'s atomic field+graph removal (GitHub issue #221). Never valid for a
    /// point's *last remaining* node — `try_remove_node` refuses that case, the same hard
    /// constraint every split-QC repair strategy shares (see GitHub epic #246). A strategy wanting
    /// to preserve the removed node's connections (e.g. `RemoveSplitNodeStrategy`'s `redistribute`
    /// param) must propose the replacement `AddDirectedEdge`/`AddBidirectionalEdge` commands
    /// itself, ahead of this one in its own returned batch — this command only ever deletes, it
    /// never redirects.
    RemoveNode {
        node: NodeId,
    },
    /// Replaces every node currently at `at`'s point (all of them — slot-0 included, not just
    /// extra siblings) with a brand-new set of nodes, wiring each one's own edges in one atomic
    /// step — see GitHub issue #247, `AddSplitStrategy`. `at` only identifies which point is
    /// affected (resolved via `field.cell_of(at)`), not a node that survives the command — every
    /// node previously at that point is removed, and `nodes.len()` new nodes are minted in its
    /// place, `nodes[i]` describing the `i`th new node's own edges to already-existing neighbors
    /// elsewhere on the field.
    ///
    /// **`nodes[0]` becomes the point's new slot-0** (`Field::add_node_at`'s own minting order
    /// always makes the first-minted node at a point its slot-0 — same rule generation itself
    /// relies on) — there is no other special meaning to index 0 beyond "minted first, therefore
    /// slot-0 by `Field`'s own convention." Every caller building `nodes` (e.g. `AddSplitStrategy`)
    /// is expected to put whichever resolved node it means to be the tile's slot-0 at index 0.
    ///
    /// Declined outright (no removal, no mint) if `field.cell_of(at)` is `None` at apply time —
    /// e.g. `at` itself was already removed by an earlier command in the same batch, or the point
    /// was otherwise invalidated since this command was proposed. Same "stale command, silently
    /// declined" contract every other variant already has.
    ///
    /// All or nothing beyond that: if any single edge anywhere in `nodes` is no longer feasible by
    /// apply time, the whole command is declined and nothing about the point changes at all — no
    /// removal, no mint.
    ///
    /// Deliberately does not special-case a "slot-0" survivor — see epic #246's own convention that
    /// a point's original node is just another member of its tile everywhere except explicit
    /// removal-eligibility, which no longer applies here since this command always replaces the
    /// whole set. A caller whose replaced point happened to be `meta.start`/`meta.finish` leaves
    /// `meta` pointing at a stale `NodeId` — the same accepted, pre-existing gap
    /// `RemoveNode`/`RemoveSplitStrategy` already has (neither checks meta before removing a node
    /// either).
    ReplacePointNodes {
        at: NodeId,
        nodes: Vec<Vec<SplitNodeEdge>>,
    },
}

/// One edge a newly minted split node (`MutationCommand::ReplacePointNodes`) gets wired with —
/// `target` is the existing node on the other end, `direction` which way the edge points
/// relative to the new node, `kind` whether it's a `Basic` passage or a `Teleport` (needed by
/// callers redistributing a removed node's own edges regardless of kind, e.g.
/// `RemoveSplitStrategy`; `AddSplitStrategy`'s pattern-adaptation edges are always `Basic`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitNodeEdge {
    pub target: NodeId,
    pub direction: SplitNodeEdgeDirection,
    pub kind: EdgeKind,
}

/// `Forward`/`Backward` mirror `OneWayDirection`'s naming (relative to the new node); `Passage`
/// is a single entry producing both directions atomically (not two separate `SplitNodeEdge`s) —
/// same "one edge, one atomic unit" rationale `MutationCommand`'s own doc comment gives for
/// `AddBidirectionalEdge` vs. two `AddDirectedEdge`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitNodeEdgeDirection {
    Forward,
    Backward,
    Passage,
}

/// Every `EdgeId` a batch of commands proposes removing — a strategy building on another
/// strategy's returned commands (e.g. `InvalidLoopGroupSelectStrategy` dropping cycles that
/// share a now-cut edge from its own pending queue) needs this to know what just got cut, without
/// caring which specific removal variant did it.
///
/// **Maintenance risk, deliberately accepted**: covers only the `EdgeId`-addressed variants
/// (`RemoveEdge`, `RemoveEdgeWithReverse`, `RemoveTeleportWithReverse`) — `RemoveEdgeBetween`
/// addresses by node pair, not `EdgeId`, so it cannot be included without resolving it against a
/// `Graph` first (which this function, taking only `&[MutationCommand]`, has no access to). A
/// future removal variant could likewise go unnoticed here. Treat any use of this as a heuristic,
/// not a guarantee — safe to miss (a caller acting on a stale/already-cut cycle just wastes a bit
/// of work re-discovering it's gone, e.g. via `candidate_edges`'s own already-removed filtering),
/// never unsafe to miss.
///
/// Note this only returns the *primary* `id` for `RemoveEdgeWithReverse`/
/// `RemoveTeleportWithReverse`, not the reverse `EdgeId` also removed when present — same
/// limitation these two variants' own `Vec<EdgeId>` return isn't surfaced here, consistent with
/// this function's existing "primary id only" contract for `RemoveTeleportWithReverse`. This was
/// already a known, accepted gap for `RemoveTeleportWithReverse` (GitHub issue #171) — a cycle
/// sharing only a cut edge's *reverse* leg wasn't recognized as already-broken by this dedup — but
/// `RemoveEdgeWithReverse` (GitHub issue #185) now routes the much more common bidirectional-Basic-
/// passage case through the same primary-id-only path, so the gap is hit far more often in
/// practice than it was for teleports alone. Still safe per the paragraph above (the missed cycle
/// is simply re-offered and discovered already-cut later), just worth knowing it's no longer a
/// teleport-only corner case.
pub fn removed_edge_ids(commands: &[MutationCommand]) -> Vec<EdgeId> {
    commands
        .iter()
        .filter_map(|cmd| match cmd {
            MutationCommand::RemoveEdge { id } => Some(*id),
            MutationCommand::RemoveEdgeWithReverse { id } => Some(*id),
            MutationCommand::RemoveTeleportWithReverse { id } => Some(*id),
            MutationCommand::RemoveVerticalPassageWithReverse { id } => Some(*id),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removed_edge_ids_collects_remove_edge_and_remove_teleport_variants() {
        let commands = vec![
            MutationCommand::RemoveEdge { id: 1 },
            MutationCommand::RemoveTeleportWithReverse { id: 2 },
            MutationCommand::AddDirectedEdge { from: 3, to: 4 },
            MutationCommand::RemoveEdgeBetween { from: 5, to: 6 },
            MutationCommand::RemoveEdgeWithReverse { id: 7 },
        ];
        assert_eq!(removed_edge_ids(&commands), vec![1, 2, 7]);
    }

    #[test]
    fn removed_edge_ids_empty_for_no_removal_commands() {
        let commands = vec![
            MutationCommand::SetStart(1),
            MutationCommand::AddBidirectionalEdge { a: 1, b: 2 },
        ];
        assert!(removed_edge_ids(&commands).is_empty());
    }
}
