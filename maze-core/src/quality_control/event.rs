#[path = "qc_wire.rs"]
mod qc_wire;
#[path = "event_encode.rs"]
mod event_encode;

use crate::ids::NodeId;
use crate::repair::command::SplitNodeEdge;
use super::issue::IssueKind;
use super::issue_kinds::RepairLimitKind;
use super::issue_payload::IssuePayload;
pub(crate) use event_encode::{write_check_issue, write_details_map, write_issue_kind, write_issue_payload, write_repair_limit_kind, write_split_nodes};

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
        issue: Option<(IssueKind, IssuePayload, std::collections::HashMap<&'static str, String>)>,
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
    PointNodesReplaceProposed { at: NodeId, old_nodes: Vec<NodeId>, #[wire(custom = "SplitNodeEdgesCodec")] nodes: Vec<Vec<SplitNodeEdge>> },

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
    EdgeRemovedWithReverse { from: NodeId, to: NodeId, reverse_removed: bool },
    /// `from`/`to` of the *primary* `id` only — mirrors `TeleportRemoveWithReverseProposed`'s doc
    /// comment. `reverse_removed` — see `EdgeRemovedWithReverse`'s own doc comment, same
    /// rationale, sourced from `try_remove_teleport_with_reverse`'s `Vec<EdgeId>` length instead.
    #[wire(tag = 12, mutating)]
    TeleportRemovedWithReverse { from: NodeId, to: NodeId, reverse_removed: bool },
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
    PointNodesReplaced { at: NodeId, old_nodes: Vec<NodeId>, new_nodes: Vec<NodeId>, #[wire(custom = "SplitNodeEdgesCodec")] nodes: Vec<Vec<SplitNodeEdge>> },

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
    EdgeRemoveWithReverseDeclined { from: NodeId, to: NodeId, reverse_removed: bool },
    /// `from`/`to` of the *primary* `id` only — mirrors `TeleportRemoveWithReverseProposed`'s doc
    /// comment. `reverse_removed` — same "always `false`, carried for field-shape symmetry" note
    /// as `EdgeRemoveWithReverseDeclined`'s own doc comment.
    #[wire(tag = 21)]
    TeleportRemoveWithReverseDeclined { from: NodeId, to: NodeId, reverse_removed: bool },
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
    PointNodesReplaceDeclined { at: NodeId, old_nodes: Vec<NodeId>, #[wire(custom = "SplitNodeEdgesCodec")] nodes: Vec<Vec<SplitNodeEdge>> },
}

#[cfg(test)]
mod tests {
    use super::*;
    use event_encode::write_str;
    use crate::event_log::{DebugEvent, EncodeEventPayload};
    use std::collections::HashMap;

    #[test]
    fn mutating_split_matches_mutation_mirror_variants() {
        assert!(QcEvent::DirectedEdgeAdded { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::BidirectionalEdgeAdded { a: 1, b: 2 }.is_mutating());
        assert!(QcEvent::DirectedTeleportAdded { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::BidirectionalTeleportAdded { a: 1, b: 2 }.is_mutating());
        assert!(QcEvent::EdgeRemoved { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::EdgeRemovedBetween { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::EdgeRemovedWithReverse { from: 1, to: 2, reverse_removed: true }.is_mutating());
        assert!(QcEvent::TeleportRemovedWithReverse { from: 1, to: 2, reverse_removed: true }.is_mutating());
        assert!(QcEvent::StartSet(1).is_mutating());
        assert!(QcEvent::FinishSet(1).is_mutating());
        assert!(QcEvent::NodeRemoved(1).is_mutating());
    }

    #[test]
    fn trace_events_are_not_mutating() {
        assert!(!QcEvent::IterationStarted(0).is_mutating());
        assert!(!QcEvent::CheckRan { check_id: "c".to_string(), issue: None }.is_mutating());
        assert!(!QcEvent::IssuesMerged {
            issue_kind: IssueKind::from_str("missing_endpoints").unwrap(), payload: IssuePayload::None, details: HashMap::new(),
        }.is_mutating());
        assert!(!QcEvent::IterationLimitReached(RepairLimitKind::MaxIterations).is_mutating());
    }

    #[test]
    fn declined_variants_are_not_mutating() {
        assert!(!QcEvent::DirectedEdgeDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalEdgeDeclined { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::DirectedTeleportDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalTeleportDeclined { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveBetweenDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveWithReverseDeclined { from: 1, to: 2, reverse_removed: false }.is_mutating());
        assert!(!QcEvent::TeleportRemoveWithReverseDeclined { from: 1, to: 2, reverse_removed: false }.is_mutating());
        assert!(!QcEvent::StartSetDeclined(1).is_mutating());
        assert!(!QcEvent::FinishSetDeclined(1).is_mutating());
        assert!(!QcEvent::NodeRemoveDeclined(1).is_mutating());
    }

    #[test]
    fn proposed_variants_are_not_mutating() {
        assert!(!QcEvent::DirectedEdgeProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalEdgeProposed { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::DirectedTeleportProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalTeleportProposed { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveBetweenProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveWithReverseProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::TeleportRemoveWithReverseProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::StartSetProposed(1).is_mutating());
        assert!(!QcEvent::FinishSetProposed(1).is_mutating());
        assert!(!QcEvent::NodeRemoveProposed(1).is_mutating());
    }

    #[test]
    fn every_variant_has_a_unique_nonzero_wire_tag() {
        use std::collections::HashSet;
        let events: Vec<QcEvent> = vec![
            QcEvent::IterationStarted(0),
            QcEvent::CheckRan { check_id: "c".to_string(), issue: None },
            QcEvent::IssuesMerged {
                issue_kind: IssueKind::from_str("missing_endpoints").unwrap(), payload: IssuePayload::None, details: HashMap::new(),
            },
            QcEvent::IterationLimitReached(RepairLimitKind::MaxIterations),
            QcEvent::DirectedEdgeAdded { from: 0, to: 0 },
            QcEvent::BidirectionalEdgeAdded { a: 0, b: 0 },
            QcEvent::DirectedTeleportAdded { from: 0, to: 0 },
            QcEvent::BidirectionalTeleportAdded { a: 0, b: 0 },
            QcEvent::EdgeRemoved { from: 0, to: 0 },
            QcEvent::EdgeRemovedBetween { from: 0, to: 0 },
            QcEvent::EdgeRemovedWithReverse { from: 0, to: 0, reverse_removed: true },
            QcEvent::TeleportRemovedWithReverse { from: 0, to: 0, reverse_removed: true },
            QcEvent::StartSet(0),
            QcEvent::FinishSet(0),
            QcEvent::NodeRemoved(0),
            QcEvent::DirectedEdgeDeclined { from: 0, to: 0 },
            QcEvent::BidirectionalEdgeDeclined { a: 0, b: 0 },
            QcEvent::DirectedTeleportDeclined { from: 0, to: 0 },
            QcEvent::BidirectionalTeleportDeclined { a: 0, b: 0 },
            QcEvent::EdgeRemoveDeclined { from: 0, to: 0 },
            QcEvent::EdgeRemoveBetweenDeclined { from: 0, to: 0 },
            QcEvent::EdgeRemoveWithReverseDeclined { from: 0, to: 0, reverse_removed: false },
            QcEvent::TeleportRemoveWithReverseDeclined { from: 0, to: 0, reverse_removed: false },
            QcEvent::StartSetDeclined(0),
            QcEvent::FinishSetDeclined(0),
            QcEvent::NodeRemoveDeclined(0),
            QcEvent::DirectedEdgeProposed { from: 0, to: 0 },
            QcEvent::BidirectionalEdgeProposed { a: 0, b: 0 },
            QcEvent::DirectedTeleportProposed { from: 0, to: 0 },
            QcEvent::BidirectionalTeleportProposed { a: 0, b: 0 },
            QcEvent::EdgeRemoveProposed { from: 0, to: 0 },
            QcEvent::EdgeRemoveBetweenProposed { from: 0, to: 0 },
            QcEvent::EdgeRemoveWithReverseProposed { from: 0, to: 0 },
            QcEvent::TeleportRemoveWithReverseProposed { from: 0, to: 0 },
            QcEvent::StartSetProposed(0),
            QcEvent::FinishSetProposed(0),
            QcEvent::NodeRemoveProposed(0),
            QcEvent::StrategyFailed { strategy_id: "remove_split" },
        ];
        let mut tags = HashSet::new();
        for event in &events {
            let tag = event.type_id();
            assert_ne!(tag, 0, "TAG_SCOPE (0) must never be used by an event's type_id");
            assert!(tags.insert(tag), "duplicate wire tag {tag} for {event:?}");
        }
    }

    #[test]
    fn declined_variant_encodes_identically_to_its_mutating_mirror_except_the_tag() {
        let added = QcEvent::DirectedEdgeAdded { from: 7, to: 9 };
        let declined = QcEvent::DirectedEdgeDeclined { from: 7, to: 9 };
        let mut added_bytes = Vec::new();
        added.encode_payload(&mut added_bytes);
        let mut declined_bytes = Vec::new();
        declined.encode_payload(&mut declined_bytes);
        assert_eq!(added_bytes, declined_bytes);
        assert_ne!(added.type_id(), declined.type_id());
    }

    #[test]
    fn edge_removed_with_reverse_encodes_from_to_then_reverse_removed_byte() {
        let event = QcEvent::EdgeRemovedWithReverse { from: 5, to: 6, reverse_removed: true };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, vec![5, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn edge_removed_with_reverse_encodes_reverse_removed_false_as_zero_byte() {
        let event = QcEvent::EdgeRemovedWithReverse { from: 5, to: 6, reverse_removed: false };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes[16], 0);
    }

    #[test]
    fn node_removed_declined_and_proposed_all_encode_the_same_node_id_bytes() {
        // GitHub issue #248: NodeRemoved/NodeRemoveDeclined/NodeRemoveProposed share the same
        // single-NodeId payload shape as StartSet/FinishSet, but never had their own direct
        // encode_payload assertion (only indirectly exercised via every_variant_has_a_unique_
        // nonzero_wire_tag's type_id() calls) — pins the actual byte output down explicitly.
        for event in [QcEvent::NodeRemoved(42), QcEvent::NodeRemoveDeclined(42), QcEvent::NodeRemoveProposed(42)] {
            let mut bytes = Vec::new();
            event.encode_payload(&mut bytes);
            assert_eq!(bytes, 42u64.to_le_bytes().to_vec(), "{event:?} must encode its NodeId as 8 little-endian bytes");
        }
    }

    #[test]
    fn strategy_failed_is_not_mutating_and_encodes_its_strategy_id() {
        let event = QcEvent::StrategyFailed { strategy_id: "remove_split" };
        assert!(!event.is_mutating());
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        let mut expected = Vec::new();
        write_str(&mut expected, "remove_split");
        assert_eq!(bytes, expected);
    }

    /// `EdgeRemoveWithReverseDeclined` is always constructed with `reverse_removed: false` in
    /// practice (see its own doc comment — a declined `RemoveEdgeWithReverse` means nothing was
    /// removed at all), but this test pins the doc's "same field shape, same bytes except the tag"
    /// claim at the wire level regardless of which `reverse_removed` value is passed, the same way
    /// `declined_variant_encodes_identically_to_its_mutating_mirror_except_the_tag` does for the
    /// plain `DirectedEdgeAdded`/`DirectedEdgeDeclined` pair above.
    #[test]
    fn edge_remove_with_reverse_declined_encodes_identically_to_its_mutating_mirror_except_the_tag() {
        let added = QcEvent::EdgeRemovedWithReverse { from: 5, to: 6, reverse_removed: true };
        let declined = QcEvent::EdgeRemoveWithReverseDeclined { from: 5, to: 6, reverse_removed: true };
        let mut added_bytes = Vec::new();
        added.encode_payload(&mut added_bytes);
        let mut declined_bytes = Vec::new();
        declined.encode_payload(&mut declined_bytes);
        assert_eq!(added_bytes, declined_bytes);
        assert_ne!(added.type_id(), declined.type_id());
    }

    #[test]
    fn teleport_remove_with_reverse_declined_encodes_identically_to_its_mutating_mirror_except_the_tag() {
        let added = QcEvent::TeleportRemovedWithReverse { from: 3, to: 4, reverse_removed: true };
        let declined = QcEvent::TeleportRemoveWithReverseDeclined { from: 3, to: 4, reverse_removed: true };
        let mut added_bytes = Vec::new();
        added.encode_payload(&mut added_bytes);
        let mut declined_bytes = Vec::new();
        declined.encode_payload(&mut declined_bytes);
        assert_eq!(added_bytes, declined_bytes);
        assert_ne!(added.type_id(), declined.type_id());
    }

    fn read_u32le(bytes: &[u8], offset: &mut usize) -> u32 {
        let v = u32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap());
        *offset += 4;
        v
    }

    fn read_str(bytes: &[u8], offset: &mut usize) -> String {
        let len = read_u32le(bytes, offset) as usize;
        let s = String::from_utf8(bytes[*offset..*offset + len].to_vec()).unwrap();
        *offset += len;
        s
    }

    #[test]
    fn check_ran_with_no_issue_encodes_check_id_then_a_zero_present_byte() {
        let event = QcEvent::CheckRan { check_id: "c1".to_string(), issue: None };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 0);
        assert_eq!(bytes.len(), offset + 1);
    }

    #[test]
    fn check_ran_with_issue_payload_none_encodes_kind_then_a_zero_payload_variant_byte_then_an_empty_details_map() {
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("missing_endpoints").unwrap(), IssuePayload::None, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1);
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "missing_endpoints");
        assert_eq!(bytes[offset], 0);
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_encodes_this_checks_own_details() {
        let mut details = HashMap::new();
        details.insert("threshold", "10".to_string());
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("invalid_loop").unwrap(), IssuePayload::None, details)),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1);
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_loop");
        assert_eq!(bytes[offset], 0);
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // details: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "threshold");
        assert_eq!(read_str(&bytes, &mut offset), "10");
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_invalid_loop_payload_encodes_the_full_str_keyed_edge_pairs_map() {
        let mut edges = std::collections::HashMap::new();
        edges.insert("check1".to_string(), vec![vec![[1u32, 2u32]]]);
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("invalid_loop").unwrap(), IssuePayload::InvalidLoop { edges }, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1); // issue present
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_loop");
        assert_eq!(bytes[offset], 1); // IssuePayload::InvalidLoop variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 cycle
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // cycle has 1 edge pair
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // from
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // to
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_region_needs_expansion_payload_encodes_the_full_str_keyed_node_lists_map() {
        let mut nodes = std::collections::HashMap::new();
        nodes.insert("check1".to_string(), vec![vec![5u32]]);
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("region_needs_expansion").unwrap(), IssuePayload::RegionNeedsExpansion { nodes }, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1); // issue present
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "region_needs_expansion");
        assert_eq!(bytes[offset], 2); // IssuePayload::RegionNeedsExpansion variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 region
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // region has 1 node
        assert_eq!(read_u32le(&bytes, &mut offset), 5); // node id
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_invalid_teleport_payload_encodes_the_full_str_keyed_edge_pairs_map() {
        let mut groups = std::collections::HashMap::new();
        groups.insert("check1".to_string(), vec![vec![[1u32, 2u32]]]);
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("invalid_teleport").unwrap(), IssuePayload::InvalidTeleport { groups }, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1); // issue present
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_teleport");
        assert_eq!(bytes[offset], 4); // IssuePayload::InvalidTeleport variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 group
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // group has 1 edge pair
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // from
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // to
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_invalid_split_route_payload_encodes_the_full_str_keyed_routes_map() {
        let mut routes = std::collections::HashMap::new();
        routes.insert("check1".to_string(), vec![vec![(1u32, 2u32, true), (2u32, 3u32, false)]]);
        let event = QcEvent::CheckRan {
            check_id: "c1".to_string(),
            issue: Some((IssueKind::from_str("invalid_split_route").unwrap(), IssuePayload::InvalidSplitRoute { routes }, HashMap::new())),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1); // issue present
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_split_route");
        assert_eq!(bytes[offset], 7); // IssuePayload::InvalidSplitRoute variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 route
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // route has 2 edges, order preserved
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // edge0 from
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // edge0 to
        assert_eq!(bytes[offset], 1); // edge0 is_split_edge
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // edge1 from
        assert_eq!(read_u32le(&bytes, &mut offset), 3); // edge1 to
        assert_eq!(bytes[offset], 0); // edge1 is_split_edge
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn issues_merged_encodes_the_kind_string_then_a_zero_payload_variant_byte_then_an_empty_details_map() {
        let event = QcEvent::IssuesMerged {
            issue_kind: IssueKind::from_str("invalid_loop").unwrap(), payload: IssuePayload::None, details: HashMap::new(),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_loop");
        assert_eq!(bytes[offset], 0);
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 0); // empty details map
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn issues_merged_encodes_the_merged_invalid_loop_payload_and_details() {
        let mut edges = std::collections::HashMap::new();
        edges.insert("check1".to_string(), vec![vec![[1u32, 2u32]]]);
        let mut check1_details = HashMap::new();
        check1_details.insert("threshold", "10".to_string());
        let mut details = HashMap::new();
        details.insert("r1:check1".to_string(), check1_details);
        let event = QcEvent::IssuesMerged {
            issue_kind: IssueKind::from_str("invalid_loop").unwrap(),
            payload: IssuePayload::InvalidLoop { edges },
            details,
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_loop");
        assert_eq!(bytes[offset], 1); // IssuePayload::InvalidLoop variant tag
        offset += 1;
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // map: 1 entry
        assert_eq!(read_str(&bytes, &mut offset), "check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 cycle
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // cycle has 1 edge pair
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // from
        assert_eq!(read_u32le(&bytes, &mut offset), 2); // to
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // details map: 1 contributing check
        assert_eq!(read_str(&bytes, &mut offset), "r1:check1");
        assert_eq!(read_u32le(&bytes, &mut offset), 1); // 1 detail entry
        assert_eq!(read_str(&bytes, &mut offset), "threshold");
        assert_eq!(read_str(&bytes, &mut offset), "10");
        assert_eq!(bytes.len(), offset);
    }
}
