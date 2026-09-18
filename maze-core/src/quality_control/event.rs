#[path = "event_encode.rs"]
mod event_encode;
#[path = "qc_wire.rs"]
mod qc_wire;

use super::issue::IssueKind;
use super::issue_kinds::RepairLimitKind;
use super::issue_payload::IssuePayload;
use crate::ids::NodeId;
use crate::repair::command::SplitNodeEdge;
pub(crate) use event_encode::{
    write_check_issue, write_details_map, write_issue_kind, write_issue_payload,
    write_repair_limit_kind, write_split_nodes,
};

/// Narration-level events for the quality-control/repair pipeline (GitHub issue #147) — see
/// `Specs/quality_control.md` for `Stage`/`Rule`/`QualityControlEngine`'s own structure and
/// `Specs/event_log.md` for the general event-log narration policy this instrumentation follows.
///
/// Trace events narrate the repair fixpoint loop's own decisions (iteration boundaries, which
/// rule found what, dispatch outcomes). Mutating events are almost entirely a 1:1 mirror of
/// `repair::MutationCommand`'s 10 variants — each command actually applied by `apply_commands`
/// (`quality_control::rule`) gets its own mutating variant here, and each command *declined* by
/// `apply_commands`'s revalidation gets its own trace-only `*Declined` counterpart with the same
/// fields (not one shared payload-less "declined" event) — so narration/tests can say exactly
/// which command failed revalidation, not just that some command did.
#[derive(Debug, Clone, PartialEq, maze_core_macros::WireEvent)]
pub enum QcEvent {
    /// One fixpoint pass of `Stage::run_repair`'s loop has started.
    #[wire(tag = 1, name = "iteration")]
    IterationStarted(u32),
    /// One check within a rule ran this iteration. `check_id` is the check's own *instance* id
    /// (the composite `"{rule_id}:{local_id}"` routing key `IssueMeta::source_checks`/`details`
    /// are keyed by — see `issue.rs`'s doc comment on `new_from_check`), not its type id — matches
    /// `IssueDto.source_checks`/`details`' own keys, so web-side narration can resolve this
    /// check's display label the same way `IssuesBlock` does (via the live rule/check config,
    /// `CheckInstance.typeId`). `issue: None` — the check found nothing. `Some((kind, payload,
    /// details))` — the check found an issue of `kind`; `payload` is `IssuePayload::None` for the
    /// 9 of 11 concrete `Issue` types with no structural edge/node data (see
    /// `quality_control::issue_payload`); `details` is this one check's own raw display values
    /// (`Issue::details().get(check_id)`, GitHub issue #171 — same values `IssueDto.details`
    /// carries for the analytics panel's `IssueBubble`, e.g. `min_loop_length`'s `"threshold"`),
    /// empty for the majority of issue kinds that record no detail. Carries the payload/details
    /// directly (not a separate event) — splitting "issue found" from "here's its data" into
    /// separate wire tags would make their pairing an implicit, easily-broken ordering contract
    /// instead of one atomic event.
    #[wire(tag = 2)]
    CheckRan {
        check_id: String,
        #[wire(custom = "CheckIssueCodec")]
        issue: Option<(
            IssueKind,
            IssuePayload,
            std::collections::HashMap<&'static str, String>,
        )>,
    },
    /// Two or more of a rule's checks each found an issue of the same `kind` this iteration, and
    /// `IssueMerge::merge` folded them into one — emitted once per rule iteration, only when a
    /// merge actually happened (a rule with a single contributing check never emits this).
    /// `payload` is the *merged* issue's own structural data (resolved the same way `CheckRan`'s
    /// per-check payload is, via `resolve_issue_payload`) — lets narration highlight the final,
    /// combined set of flagged cycles/regions rather than only ever showing per-check ones.
    /// `details` (GitHub issue #171) is the merged issue's full `Issue::details()` map, keyed by
    /// every contributing check's own instance id — narration shows one "reason" per contributing
    /// check when there's more than one, mirroring how `IssuesBlock` renders one bubble per
    /// `source_checks` entry for a merged `IssueDto`.
    #[wire(tag = 24)]
    IssuesMerged {
        #[wire(custom = "IssueKindCodec")]
        issue_kind: IssueKind,
        #[wire(custom = "IssuePayloadCodec")]
        payload: IssuePayload,
        #[wire(custom = "DetailsMapMapCodec")]
        details: std::collections::HashMap<String, std::collections::HashMap<&'static str, String>>,
    },
    /// `Stage::run_repair`'s fixpoint loop stopped because the shared `RepairBudget` was
    /// exhausted (see `StageOutcome::LimitReached`).
    #[wire(tag = 5, custom = "RepairLimitKindCodec", name = "limit")]
    IterationLimitReached(RepairLimitKind),
    /// A strategy's `apply()` returned `RepairResult::Failed` this iteration — one shared trace
    /// event for every strategy (not a dedicated variant per strategy type), since "this strategy
    /// gave up" carries the same narration meaning regardless of which strategy it was. Emitted
    /// inside the strategy's own `"strategy <id>"` scope, right alongside its `*Proposed` events —
    /// `strategy_id` is `RepairStrategy::strategy_id()`, the same wire string the scope name itself
    /// already carries, so a caller with only the flat event (no scope context) can still tell
    /// which strategy failed.
    #[wire(tag = 41)]
    StrategyFailed { strategy_id: &'static str },

    // --- proposed: exact mirror of `repair::MutationCommand`'s 10 variants, emitted for every
    // command a strategy's `apply()` returned, in the `"strategy <id>"` scope, before any of them
    // is applied/revalidated — narrates what the strategy *asked for*, independent of whether
    // `apply_commands` (in the separate `"apply requests"` scope right after) actually honors it. ---
    #[wire(tag = 25)]
    DirectedEdgeProposed { from: NodeId, to: NodeId },
    #[wire(tag = 26)]
    BidirectionalEdgeProposed { a: NodeId, b: NodeId },
    #[wire(tag = 27)]
    DirectedTeleportProposed { from: NodeId, to: NodeId },
    #[wire(tag = 28)]
    BidirectionalTeleportProposed { a: NodeId, b: NodeId },
    #[wire(tag = 45)]
    DirectedVerticalPassageProposed { from: NodeId, to: NodeId },
    #[wire(tag = 46)]
    BidirectionalVerticalPassageProposed { a: NodeId, b: NodeId },
    /// See GitHub issue #401. No directed variant — mirrors `try_add_bidirectional_elevator`'s
    /// own no-directed-variant rationale.
    #[wire(tag = 54)]
    BidirectionalElevatorProposed { a: NodeId, b: NodeId },
    /// `from`/`to` (not `EdgeId`, GitHub issue #171's follow-up fix) — resolved from the graph
    /// (still intact at proposal time, before `apply_commands` runs) via `edge_endpoints`, the
    /// same way `EdgeRemoved`/`EdgeRemoveDeclined` resolve theirs. An `EdgeId` is meaningless to
    /// web-side narration (no coordinate to render — `bubbleLabel` mis-rendered it as a `NodeId`
    /// before this fix, crashing once the id exceeded the maze's own node count).
    #[wire(tag = 29)]
    EdgeRemoveProposed { from: NodeId, to: NodeId },
    #[wire(tag = 30)]
    EdgeRemoveBetweenProposed { from: NodeId, to: NodeId },
    /// `from`/`to` of the *primary* `id` only (GitHub issue #185, mirrors `EdgeRemoveProposed`) —
    /// the paired reverse-direction edge (if any) isn't narrated separately, same convention as
    /// `TeleportRemoveWithReverseProposed`.
    #[wire(tag = 37)]
    EdgeRemoveWithReverseProposed { from: NodeId, to: NodeId },
    /// `from`/`to` of the *primary* `id` only (GitHub issue #171's follow-up fix, mirrors
    /// `EdgeRemoveProposed`) — the paired reverse-direction teleport (if any) isn't narrated
    /// separately, same as before this fix.
    #[wire(tag = 31)]
    TeleportRemoveWithReverseProposed { from: NodeId, to: NodeId },
    /// `from`/`to` of the *primary* `id` only — mirrors `TeleportRemoveWithReverseProposed`'s doc
    /// comment. See GitHub issue #343.
    #[wire(tag = 47)]
    VerticalPassageRemoveWithReverseProposed { from: NodeId, to: NodeId },
    #[wire(tag = 32, name = "id")]
    StartSetProposed(NodeId),
    #[wire(tag = 33, name = "id")]
    FinishSetProposed(NodeId),
    /// Mirrors `EdgeRemoveProposed`'s "resolve identity ahead of mutation" rationale — the node's
    /// own id is meaningful on its own (unlike an `EdgeId`), so this just carries `node` directly.
    #[wire(tag = 40, name = "id")]
    NodeRemoveProposed(NodeId),
    /// `MutationCommand::ReplacePointNodes` proposed — narrates `at`'s point, the `old_nodes`
    /// currently there (slot-0 included), and the planned per-new-node edge lists (`nodes[i]` =
    /// the `i`th new node's own edges, `nodes[0]` becoming the new slot-0) before any new node
    /// itself exists (there is no id to carry yet, unlike `NodeRemoveProposed`).
    #[wire(tag = 44)]
    PointNodesReplaceProposed {
        at: NodeId,
        old_nodes: Vec<NodeId>,
        #[wire(custom = "SplitNodeEdgesCodec")]
        nodes: Vec<Vec<SplitNodeEdge>>,
    },

    // --- mutating: exact mirror of `repair::MutationCommand`'s 10 variants, emitted only for
    // commands `apply_commands` actually applied (its `ok == true` branch). ---
    #[wire(tag = 6, mutating)]
    DirectedEdgeAdded { from: NodeId, to: NodeId },
    #[wire(tag = 7, mutating)]
    BidirectionalEdgeAdded { a: NodeId, b: NodeId },
    #[wire(tag = 8, mutating)]
    DirectedTeleportAdded { from: NodeId, to: NodeId },
    #[wire(tag = 9, mutating)]
    BidirectionalTeleportAdded { a: NodeId, b: NodeId },
    #[wire(tag = 48, mutating)]
    DirectedVerticalPassageAdded { from: NodeId, to: NodeId },
    #[wire(tag = 49, mutating)]
    BidirectionalVerticalPassageAdded { a: NodeId, b: NodeId },
    /// See GitHub issue #401. No directed variant, mirrors `BidirectionalElevatorProposed`.
    #[wire(tag = 55, mutating)]
    BidirectionalElevatorAdded { a: NodeId, b: NodeId },
    /// `from`/`to` (not `EdgeId`, GitHub issue #171's follow-up fix) — resolved from the graph via
    /// `edge_endpoints` immediately before the edge is actually removed (`apply_commands`'s own
    /// `try_remove_edge_by_id` call site), since the id alone is meaningless to web-side
    /// narration. See `EdgeRemoveProposed`'s doc comment for the crash this fixes.
    #[wire(tag = 10, mutating)]
    EdgeRemoved { from: NodeId, to: NodeId },
    #[wire(tag = 11, mutating)]
    EdgeRemovedBetween { from: NodeId, to: NodeId },
    /// `from`/`to` of the *primary* `id` only — mirrors `EdgeRemoveWithReverseProposed`'s doc
    /// comment. `reverse_removed` (GitHub issue #185's follow-up fix) is `true` iff the reverse
    /// direction actually existed and was removed too — straight from
    /// `try_remove_edge_with_reverse`'s own `Vec<EdgeId>` length (`> 1`), not assumed from the
    /// command's shape. Without this, a replay consumer folding this event into a `(from,to)` +
    /// `(to,from)` accumulator (e.g. web-side `applyQc`) would have no way to tell "both
    /// directions removed" from "only the primary was, the reverse never existed" — and blindly
    /// clearing `(to,from)` too would fabricate a phantom removed-edge entry when the reverse was
    /// never real.
    #[wire(tag = 35, mutating)]
    EdgeRemovedWithReverse {
        from: NodeId,
        to: NodeId,
        reverse_removed: bool,
    },
    /// `from`/`to` of the *primary* `id` only — mirrors `TeleportRemoveWithReverseProposed`'s doc
    /// comment. `reverse_removed` — see `EdgeRemovedWithReverse`'s own doc comment, same
    /// rationale, sourced from `try_remove_teleport_with_reverse`'s `Vec<EdgeId>` length instead.
    #[wire(tag = 12, mutating)]
    TeleportRemovedWithReverse {
        from: NodeId,
        to: NodeId,
        reverse_removed: bool,
    },
    /// `from`/`to` of the *primary* `id` only — mirrors `TeleportRemovedWithReverse`'s doc comment.
    /// See GitHub issue #343.
    #[wire(tag = 50, mutating)]
    VerticalPassageRemovedWithReverse {
        from: NodeId,
        to: NodeId,
        reverse_removed: bool,
    },
    #[wire(tag = 13, mutating, name = "id")]
    StartSet(NodeId),
    #[wire(tag = 14, mutating, name = "id")]
    FinishSet(NodeId),
    /// `MutationCommand::RemoveNode` actually applied — carries the removed node's own id.
    #[wire(tag = 38, mutating, name = "id")]
    NodeRemoved(NodeId),
    /// `MutationCommand::ReplacePointNodes` actually applied — `old_nodes` are every node that was
    /// at `at`'s point before this command ran (slot-0 included, resolved before the mutation —
    /// see `qc_event_for_command`'s doc comment), `new_nodes` are the freshly minted replacements,
    /// one per `nodes` entry, same order, `new_nodes[0]` the point's new slot-0 (unknowable until
    /// apply time, unlike every other mutating variant's identity, which is always resolved from
    /// state that already existed before the command ran).
    #[wire(tag = 42, mutating)]
    PointNodesReplaced {
        at: NodeId,
        old_nodes: Vec<NodeId>,
        new_nodes: Vec<NodeId>,
        #[wire(custom = "SplitNodeEdgesCodec")]
        nodes: Vec<Vec<SplitNodeEdge>>,
    },

    // --- trace: same fields as the matching mutating variant above, for a command
    // `apply_commands` proposed but whose revalidation rejected it (its `ok == false` branch). ---
    #[wire(tag = 15)]
    DirectedEdgeDeclined { from: NodeId, to: NodeId },
    #[wire(tag = 16)]
    BidirectionalEdgeDeclined { a: NodeId, b: NodeId },
    #[wire(tag = 17)]
    DirectedTeleportDeclined { from: NodeId, to: NodeId },
    #[wire(tag = 18)]
    BidirectionalTeleportDeclined { a: NodeId, b: NodeId },
    #[wire(tag = 51)]
    DirectedVerticalPassageDeclined { from: NodeId, to: NodeId },
    #[wire(tag = 52)]
    BidirectionalVerticalPassageDeclined { a: NodeId, b: NodeId },
    /// See GitHub issue #401. No directed variant, mirrors `BidirectionalElevatorProposed`.
    #[wire(tag = 56)]
    BidirectionalElevatorDeclined { a: NodeId, b: NodeId },
    /// `from`/`to` — mirrors `EdgeRemoved`'s doc comment; resolved before revalidation, since a
    /// declined command means the edge was never actually removed but the id is still
    /// meaningless to web-side narration on its own.
    #[wire(tag = 19)]
    EdgeRemoveDeclined { from: NodeId, to: NodeId },
    #[wire(tag = 20)]
    EdgeRemoveBetweenDeclined { from: NodeId, to: NodeId },
    /// `from`/`to` of the *primary* `id` only — mirrors `EdgeRemoveWithReverseProposed`'s doc
    /// comment. `reverse_removed` is always `false` here — `apply_commands` only takes the
    /// declined branch when `try_remove_edge_with_reverse` removed nothing at all (`ok == false`
    /// means the returned `Vec<EdgeId>` was empty), so the reverse can never have been removed
    /// either. Carried anyway (not omitted) so this variant has the exact same field shape as its
    /// mutating mirror `EdgeRemovedWithReverse` — see that type's own doc comment for why the
    /// field exists at all.
    #[wire(tag = 36)]
    EdgeRemoveWithReverseDeclined {
        from: NodeId,
        to: NodeId,
        reverse_removed: bool,
    },
    /// `from`/`to` of the *primary* `id` only — mirrors `TeleportRemoveWithReverseProposed`'s doc
    /// comment. `reverse_removed` — same "always `false`, carried for field-shape symmetry" note
    /// as `EdgeRemoveWithReverseDeclined`'s own doc comment.
    #[wire(tag = 21)]
    TeleportRemoveWithReverseDeclined {
        from: NodeId,
        to: NodeId,
        reverse_removed: bool,
    },
    /// `from`/`to` of the *primary* `id` only — mirrors `TeleportRemoveWithReverseDeclined`'s doc
    /// comment. See GitHub issue #343.
    #[wire(tag = 53)]
    VerticalPassageRemoveWithReverseDeclined {
        from: NodeId,
        to: NodeId,
        reverse_removed: bool,
    },
    #[wire(tag = 22, name = "id")]
    StartSetDeclined(NodeId),
    #[wire(tag = 23, name = "id")]
    FinishSetDeclined(NodeId),
    /// `MutationCommand::RemoveNode` proposed but revalidation rejected it (node no longer exists,
    /// is slot-0, or is preset-protected by the time `apply_commands` ran).
    #[wire(tag = 39, name = "id")]
    NodeRemoveDeclined(NodeId),
    /// `MutationCommand::ReplacePointNodes` proposed but revalidation rejected it (all-or-nothing —
    /// see `replace_point_nodes_feasible`'s doc comment: `at`'s point no longer exists, one of its
    /// old nodes is no longer removable, or any one edge of any new node in `nodes` no longer
    /// preset-feasible by the time `apply_commands` ran). No node was replaced at all — `old_nodes`
    /// is empty when `at`'s point itself no longer resolves (there was nothing to report).
    #[wire(tag = 43)]
    PointNodesReplaceDeclined {
        at: NodeId,
        old_nodes: Vec<NodeId>,
        #[wire(custom = "SplitNodeEdgesCodec")]
        nodes: Vec<Vec<SplitNodeEdge>>,
    },
}

#[cfg(test)]
#[path = "event_tests.rs"]
mod tests;
