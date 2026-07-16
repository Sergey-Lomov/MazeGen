use crate::ids::{EdgeId, NodeId};
use crate::event_log::{DebugEvent, EncodeEventPayload};
use super::issue::IssueKind;
use super::issue_kinds::RepairLimitKind;
use super::issue_payload::IssuePayload;

/// Stable wire tags for [`QcEvent`] (see `Specs/event_log.md`'s #124 binary encoding, extended by
/// #169's source-index namespacing — this module only ever assigns plain local tags, `merge_tapes`
/// applies the source-index prefix on top, same contract every other instrumented algorithm's own
/// `wire_tags` module already follows). `0` is reserved for scope nodes (`event_log::TAG_SCOPE`)
/// and must never be assigned here.
mod wire_tags {
    pub const ITERATION_STARTED: u16 = 1;
    pub const CHECK_RAN: u16 = 2;
    pub const ITERATION_LIMIT_REACHED: u16 = 5;
    pub const ISSUES_MERGED: u16 = 24;

    pub const DIRECTED_EDGE_ADDED: u16 = 6;
    pub const BIDIRECTIONAL_EDGE_ADDED: u16 = 7;
    pub const DIRECTED_TELEPORT_ADDED: u16 = 8;
    pub const BIDIRECTIONAL_TELEPORT_ADDED: u16 = 9;
    pub const EDGE_REMOVED: u16 = 10;
    pub const EDGE_REMOVED_BETWEEN: u16 = 11;
    pub const TELEPORT_REMOVED_WITH_REVERSE: u16 = 12;
    pub const START_SET: u16 = 13;
    pub const FINISH_SET: u16 = 14;

    pub const DIRECTED_EDGE_DECLINED: u16 = 15;
    pub const BIDIRECTIONAL_EDGE_DECLINED: u16 = 16;
    pub const DIRECTED_TELEPORT_DECLINED: u16 = 17;
    pub const BIDIRECTIONAL_TELEPORT_DECLINED: u16 = 18;
    pub const EDGE_REMOVE_DECLINED: u16 = 19;
    pub const EDGE_REMOVE_BETWEEN_DECLINED: u16 = 20;
    pub const TELEPORT_REMOVE_WITH_REVERSE_DECLINED: u16 = 21;
    pub const START_SET_DECLINED: u16 = 22;
    pub const FINISH_SET_DECLINED: u16 = 23;

    pub const DIRECTED_EDGE_PROPOSED: u16 = 25;
    pub const BIDIRECTIONAL_EDGE_PROPOSED: u16 = 26;
    pub const DIRECTED_TELEPORT_PROPOSED: u16 = 27;
    pub const BIDIRECTIONAL_TELEPORT_PROPOSED: u16 = 28;
    pub const EDGE_REMOVE_PROPOSED: u16 = 29;
    pub const EDGE_REMOVE_BETWEEN_PROPOSED: u16 = 30;
    pub const TELEPORT_REMOVE_WITH_REVERSE_PROPOSED: u16 = 31;
    pub const START_SET_PROPOSED: u16 = 32;
    pub const FINISH_SET_PROPOSED: u16 = 33;
}

/// Narration-level events for the quality-control/repair pipeline (GitHub issue #147) — see
/// `Specs/quality_control.md` for `Stage`/`Rule`/`QualityControlEngine`'s own structure and
/// `Specs/event_log.md` for the general event-log narration policy this instrumentation follows.
///
/// Trace events narrate the repair fixpoint loop's own decisions (iteration boundaries, which
/// rule found what, dispatch outcomes). Mutating events are an exact 1:1 mirror of
/// `repair::MutationCommand`'s 9 variants — each command actually applied by `apply_commands`
/// (`quality_control::rule`) gets its own mutating variant here, and each command *declined* by
/// `apply_commands`'s revalidation gets its own trace-only `*Declined` counterpart with the same
/// fields (not one shared payload-less "declined" event) — so narration/tests can say exactly
/// which command failed revalidation, not just that some command did.
#[derive(Debug, Clone, PartialEq)]
pub enum QcEvent {
    /// One fixpoint pass of `Stage::run_repair`'s loop has started.
    IterationStarted(u32),
    /// One check within a rule ran this iteration. `issue: None` — the check found nothing.
    /// `Some((kind, payload))` — the check found an issue of `kind`; `payload` is `IssuePayload::None`
    /// for the 9 of 11 concrete `Issue` types with no structural edge/node data (see
    /// `quality_control::issue_payload`). Carries the payload directly (not a separate event) —
    /// splitting "issue found" and "here's its payload" into two wire tags would make their
    /// pairing an implicit, easily-broken ordering contract instead of one atomic event.
    CheckRan { check_id: &'static str, issue: Option<(IssueKind, IssuePayload)> },
    /// Two or more of a rule's checks each found an issue of the same `kind` this iteration, and
    /// `IssueMerge::merge` folded them into one — emitted once per rule iteration, only when a
    /// merge actually happened (a rule with a single contributing check never emits this).
    IssuesMerged { kind: IssueKind },
    /// `Stage::run_repair`'s fixpoint loop stopped because the shared `RepairBudget` was
    /// exhausted (see `StageOutcome::LimitReached`).
    IterationLimitReached(RepairLimitKind),

    // --- proposed: exact mirror of `repair::MutationCommand`'s 9 variants, emitted for every
    // command a strategy's `apply()` returned, in the `"strategy <id>"` scope, before any of them
    // is applied/revalidated — narrates what the strategy *asked for*, independent of whether
    // `apply_commands` (in the separate `"apply requests"` scope right after) actually honors it. ---
    DirectedEdgeProposed { from: NodeId, to: NodeId },
    BidirectionalEdgeProposed { a: NodeId, b: NodeId },
    DirectedTeleportProposed { from: NodeId, to: NodeId },
    BidirectionalTeleportProposed { a: NodeId, b: NodeId },
    EdgeRemoveProposed { id: EdgeId },
    EdgeRemoveBetweenProposed { from: NodeId, to: NodeId },
    TeleportRemoveWithReverseProposed { id: EdgeId },
    StartSetProposed(NodeId),
    FinishSetProposed(NodeId),

    // --- mutating: exact mirror of `repair::MutationCommand`'s 9 variants, emitted only for
    // commands `apply_commands` actually applied (its `ok == true` branch). ---
    DirectedEdgeAdded { from: NodeId, to: NodeId },
    BidirectionalEdgeAdded { a: NodeId, b: NodeId },
    DirectedTeleportAdded { from: NodeId, to: NodeId },
    BidirectionalTeleportAdded { a: NodeId, b: NodeId },
    EdgeRemoved { id: EdgeId },
    EdgeRemovedBetween { from: NodeId, to: NodeId },
    TeleportRemovedWithReverse { id: EdgeId },
    StartSet(NodeId),
    FinishSet(NodeId),

    // --- trace: same fields as the matching mutating variant above, for a command
    // `apply_commands` proposed but whose revalidation rejected it (its `ok == false` branch). ---
    DirectedEdgeDeclined { from: NodeId, to: NodeId },
    BidirectionalEdgeDeclined { a: NodeId, b: NodeId },
    DirectedTeleportDeclined { from: NodeId, to: NodeId },
    BidirectionalTeleportDeclined { a: NodeId, b: NodeId },
    EdgeRemoveDeclined { id: EdgeId },
    EdgeRemoveBetweenDeclined { from: NodeId, to: NodeId },
    TeleportRemoveWithReverseDeclined { id: EdgeId },
    StartSetDeclined(NodeId),
    FinishSetDeclined(NodeId),
}

impl DebugEvent for QcEvent {
    /// `true` for exactly the 9 mutation-mirror variants — these are the only `QcEvent`s that
    /// change the maze graph. Every `*Declined` variant is `false` alongside every trace variant:
    /// a declined command never touched the graph, only narrates that the strategy's proposal
    /// didn't survive revalidation.
    fn is_mutating(&self) -> bool {
        matches!(
            self,
            QcEvent::DirectedEdgeAdded { .. }
                | QcEvent::BidirectionalEdgeAdded { .. }
                | QcEvent::DirectedTeleportAdded { .. }
                | QcEvent::BidirectionalTeleportAdded { .. }
                | QcEvent::EdgeRemoved { .. }
                | QcEvent::EdgeRemovedBetween { .. }
                | QcEvent::TeleportRemovedWithReverse { .. }
                | QcEvent::StartSet(_)
                | QcEvent::FinishSet(_)
        )
    }
}

fn write_node_id(out: &mut Vec<u8>, id: NodeId) {
    out.extend_from_slice(&id.to_le_bytes());
}

/// `EdgeId` is `usize` (platform-dependent width) — always widened to `u64` before writing, same
/// as every `NodeId` write, so the wire format doesn't depend on whether this was built for a
/// 32-bit (wasm32) or 64-bit (native `cargo test`) target.
fn write_edge_id(out: &mut Vec<u8>, id: EdgeId) {
    out.extend_from_slice(&(id as u64).to_le_bytes());
}

fn write_issue_payload(out: &mut Vec<u8>, payload: &IssuePayload) {
    match payload {
        IssuePayload::None => out.push(0),
        IssuePayload::InvalidLoop { edges } => {
            out.push(1);
            write_str_keyed_edge_pairs(out, edges);
        }
        IssuePayload::RegionNeedsExpansion { nodes } => {
            out.push(2);
            write_str_keyed_node_lists(out, nodes);
        }
    }
}

fn write_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn write_str_keyed_edge_pairs(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<Vec<[u32; 2]>>>) {
    out.extend_from_slice(&(map.len() as u32).to_le_bytes());
    for (key, cycles) in map {
        write_str(out, key);
        out.extend_from_slice(&(cycles.len() as u32).to_le_bytes());
        for cycle in cycles {
            out.extend_from_slice(&(cycle.len() as u32).to_le_bytes());
            for [from, to] in cycle {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
            }
        }
    }
}

fn write_str_keyed_node_lists(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<Vec<u32>>>) {
    out.extend_from_slice(&(map.len() as u32).to_le_bytes());
    for (key, regions) in map {
        write_str(out, key);
        out.extend_from_slice(&(regions.len() as u32).to_le_bytes());
        for region in regions {
            out.extend_from_slice(&(region.len() as u32).to_le_bytes());
            for &node in region {
                out.extend_from_slice(&node.to_le_bytes());
            }
        }
    }
}

impl EncodeEventPayload for QcEvent {
    fn type_id(&self) -> u16 {
        match self {
            QcEvent::IterationStarted(_) => wire_tags::ITERATION_STARTED,
            QcEvent::CheckRan { .. } => wire_tags::CHECK_RAN,
            QcEvent::IssuesMerged { .. } => wire_tags::ISSUES_MERGED,
            QcEvent::IterationLimitReached(_) => wire_tags::ITERATION_LIMIT_REACHED,

            QcEvent::DirectedEdgeAdded { .. } => wire_tags::DIRECTED_EDGE_ADDED,
            QcEvent::BidirectionalEdgeAdded { .. } => wire_tags::BIDIRECTIONAL_EDGE_ADDED,
            QcEvent::DirectedTeleportAdded { .. } => wire_tags::DIRECTED_TELEPORT_ADDED,
            QcEvent::BidirectionalTeleportAdded { .. } => wire_tags::BIDIRECTIONAL_TELEPORT_ADDED,
            QcEvent::EdgeRemoved { .. } => wire_tags::EDGE_REMOVED,
            QcEvent::EdgeRemovedBetween { .. } => wire_tags::EDGE_REMOVED_BETWEEN,
            QcEvent::TeleportRemovedWithReverse { .. } => wire_tags::TELEPORT_REMOVED_WITH_REVERSE,
            QcEvent::StartSet(_) => wire_tags::START_SET,
            QcEvent::FinishSet(_) => wire_tags::FINISH_SET,

            QcEvent::DirectedEdgeDeclined { .. } => wire_tags::DIRECTED_EDGE_DECLINED,
            QcEvent::BidirectionalEdgeDeclined { .. } => wire_tags::BIDIRECTIONAL_EDGE_DECLINED,
            QcEvent::DirectedTeleportDeclined { .. } => wire_tags::DIRECTED_TELEPORT_DECLINED,
            QcEvent::BidirectionalTeleportDeclined { .. } => wire_tags::BIDIRECTIONAL_TELEPORT_DECLINED,
            QcEvent::EdgeRemoveDeclined { .. } => wire_tags::EDGE_REMOVE_DECLINED,
            QcEvent::EdgeRemoveBetweenDeclined { .. } => wire_tags::EDGE_REMOVE_BETWEEN_DECLINED,
            QcEvent::TeleportRemoveWithReverseDeclined { .. } => wire_tags::TELEPORT_REMOVE_WITH_REVERSE_DECLINED,
            QcEvent::StartSetDeclined(_) => wire_tags::START_SET_DECLINED,
            QcEvent::FinishSetDeclined(_) => wire_tags::FINISH_SET_DECLINED,

            QcEvent::DirectedEdgeProposed { .. } => wire_tags::DIRECTED_EDGE_PROPOSED,
            QcEvent::BidirectionalEdgeProposed { .. } => wire_tags::BIDIRECTIONAL_EDGE_PROPOSED,
            QcEvent::DirectedTeleportProposed { .. } => wire_tags::DIRECTED_TELEPORT_PROPOSED,
            QcEvent::BidirectionalTeleportProposed { .. } => wire_tags::BIDIRECTIONAL_TELEPORT_PROPOSED,
            QcEvent::EdgeRemoveProposed { .. } => wire_tags::EDGE_REMOVE_PROPOSED,
            QcEvent::EdgeRemoveBetweenProposed { .. } => wire_tags::EDGE_REMOVE_BETWEEN_PROPOSED,
            QcEvent::TeleportRemoveWithReverseProposed { .. } => wire_tags::TELEPORT_REMOVE_WITH_REVERSE_PROPOSED,
            QcEvent::StartSetProposed(_) => wire_tags::START_SET_PROPOSED,
            QcEvent::FinishSetProposed(_) => wire_tags::FINISH_SET_PROPOSED,
        }
    }

    fn encode_payload(&self, out: &mut Vec<u8>) {
        match self {
            QcEvent::IterationStarted(n) => out.extend_from_slice(&n.to_le_bytes()),
            QcEvent::CheckRan { check_id, issue } => {
                write_str(out, check_id);
                match issue {
                    None => out.push(0),
                    Some((kind, payload)) => {
                        out.push(1);
                        write_str(out, kind.as_str());
                        write_issue_payload(out, payload);
                    }
                }
            }
            QcEvent::IssuesMerged { kind } => write_str(out, kind.as_str()),
            QcEvent::IterationLimitReached(kind) => out.push(match kind {
                RepairLimitKind::MaxIterations => 0,
                RepairLimitKind::TimeBudget => 1,
            }),

            QcEvent::DirectedEdgeAdded { from, to } | QcEvent::DirectedEdgeDeclined { from, to } | QcEvent::DirectedEdgeProposed { from, to }
            | QcEvent::DirectedTeleportAdded { from, to } | QcEvent::DirectedTeleportDeclined { from, to } | QcEvent::DirectedTeleportProposed { from, to }
            | QcEvent::EdgeRemovedBetween { from, to } | QcEvent::EdgeRemoveBetweenDeclined { from, to } | QcEvent::EdgeRemoveBetweenProposed { from, to } => {
                write_node_id(out, *from);
                write_node_id(out, *to);
            }
            QcEvent::BidirectionalEdgeAdded { a, b } | QcEvent::BidirectionalEdgeDeclined { a, b } | QcEvent::BidirectionalEdgeProposed { a, b }
            | QcEvent::BidirectionalTeleportAdded { a, b } | QcEvent::BidirectionalTeleportDeclined { a, b } | QcEvent::BidirectionalTeleportProposed { a, b } => {
                write_node_id(out, *a);
                write_node_id(out, *b);
            }
            QcEvent::EdgeRemoved { id } | QcEvent::EdgeRemoveDeclined { id } | QcEvent::EdgeRemoveProposed { id }
            | QcEvent::TeleportRemovedWithReverse { id } | QcEvent::TeleportRemoveWithReverseDeclined { id } | QcEvent::TeleportRemoveWithReverseProposed { id } => {
                write_edge_id(out, *id);
            }
            QcEvent::StartSet(id) | QcEvent::StartSetDeclined(id) | QcEvent::StartSetProposed(id)
            | QcEvent::FinishSet(id) | QcEvent::FinishSetDeclined(id) | QcEvent::FinishSetProposed(id) => {
                write_node_id(out, *id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutating_split_matches_mutation_mirror_variants() {
        assert!(QcEvent::DirectedEdgeAdded { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::BidirectionalEdgeAdded { a: 1, b: 2 }.is_mutating());
        assert!(QcEvent::DirectedTeleportAdded { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::BidirectionalTeleportAdded { a: 1, b: 2 }.is_mutating());
        assert!(QcEvent::EdgeRemoved { id: 1 }.is_mutating());
        assert!(QcEvent::EdgeRemovedBetween { from: 1, to: 2 }.is_mutating());
        assert!(QcEvent::TeleportRemovedWithReverse { id: 1 }.is_mutating());
        assert!(QcEvent::StartSet(1).is_mutating());
        assert!(QcEvent::FinishSet(1).is_mutating());
    }

    #[test]
    fn trace_events_are_not_mutating() {
        assert!(!QcEvent::IterationStarted(0).is_mutating());
        assert!(!QcEvent::CheckRan { check_id: "c", issue: None }.is_mutating());
        assert!(!QcEvent::IssuesMerged { kind: IssueKind::from_str("missing_endpoints").unwrap() }.is_mutating());
        assert!(!QcEvent::IterationLimitReached(RepairLimitKind::MaxIterations).is_mutating());
    }

    #[test]
    fn declined_variants_are_not_mutating() {
        assert!(!QcEvent::DirectedEdgeDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalEdgeDeclined { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::DirectedTeleportDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalTeleportDeclined { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveDeclined { id: 1 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveBetweenDeclined { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::TeleportRemoveWithReverseDeclined { id: 1 }.is_mutating());
        assert!(!QcEvent::StartSetDeclined(1).is_mutating());
        assert!(!QcEvent::FinishSetDeclined(1).is_mutating());
    }

    #[test]
    fn proposed_variants_are_not_mutating() {
        assert!(!QcEvent::DirectedEdgeProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalEdgeProposed { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::DirectedTeleportProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::BidirectionalTeleportProposed { a: 1, b: 2 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveProposed { id: 1 }.is_mutating());
        assert!(!QcEvent::EdgeRemoveBetweenProposed { from: 1, to: 2 }.is_mutating());
        assert!(!QcEvent::TeleportRemoveWithReverseProposed { id: 1 }.is_mutating());
        assert!(!QcEvent::StartSetProposed(1).is_mutating());
        assert!(!QcEvent::FinishSetProposed(1).is_mutating());
    }

    #[test]
    fn every_variant_has_a_unique_nonzero_wire_tag() {
        use std::collections::HashSet;
        let events: Vec<QcEvent> = vec![
            QcEvent::IterationStarted(0),
            QcEvent::CheckRan { check_id: "c", issue: None },
            QcEvent::IssuesMerged { kind: IssueKind::from_str("missing_endpoints").unwrap() },
            QcEvent::IterationLimitReached(RepairLimitKind::MaxIterations),
            QcEvent::DirectedEdgeAdded { from: 0, to: 0 },
            QcEvent::BidirectionalEdgeAdded { a: 0, b: 0 },
            QcEvent::DirectedTeleportAdded { from: 0, to: 0 },
            QcEvent::BidirectionalTeleportAdded { a: 0, b: 0 },
            QcEvent::EdgeRemoved { id: 0 },
            QcEvent::EdgeRemovedBetween { from: 0, to: 0 },
            QcEvent::TeleportRemovedWithReverse { id: 0 },
            QcEvent::StartSet(0),
            QcEvent::FinishSet(0),
            QcEvent::DirectedEdgeDeclined { from: 0, to: 0 },
            QcEvent::BidirectionalEdgeDeclined { a: 0, b: 0 },
            QcEvent::DirectedTeleportDeclined { from: 0, to: 0 },
            QcEvent::BidirectionalTeleportDeclined { a: 0, b: 0 },
            QcEvent::EdgeRemoveDeclined { id: 0 },
            QcEvent::EdgeRemoveBetweenDeclined { from: 0, to: 0 },
            QcEvent::TeleportRemoveWithReverseDeclined { id: 0 },
            QcEvent::StartSetDeclined(0),
            QcEvent::FinishSetDeclined(0),
            QcEvent::DirectedEdgeProposed { from: 0, to: 0 },
            QcEvent::BidirectionalEdgeProposed { a: 0, b: 0 },
            QcEvent::DirectedTeleportProposed { from: 0, to: 0 },
            QcEvent::BidirectionalTeleportProposed { a: 0, b: 0 },
            QcEvent::EdgeRemoveProposed { id: 0 },
            QcEvent::EdgeRemoveBetweenProposed { from: 0, to: 0 },
            QcEvent::TeleportRemoveWithReverseProposed { id: 0 },
            QcEvent::StartSetProposed(0),
            QcEvent::FinishSetProposed(0),
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
        let event = QcEvent::CheckRan { check_id: "c1", issue: None };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 0);
        assert_eq!(bytes.len(), offset + 1);
    }

    #[test]
    fn check_ran_with_issue_payload_none_encodes_kind_then_a_zero_payload_variant_byte() {
        let event = QcEvent::CheckRan {
            check_id: "c1",
            issue: Some((IssueKind::from_str("missing_endpoints").unwrap(), IssuePayload::None)),
        };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "c1");
        assert_eq!(bytes[offset], 1);
        offset += 1;
        assert_eq!(read_str(&bytes, &mut offset), "missing_endpoints");
        assert_eq!(bytes[offset], 0);
        assert_eq!(bytes.len(), offset + 1);
    }

    #[test]
    fn check_ran_with_invalid_loop_payload_encodes_the_full_str_keyed_edge_pairs_map() {
        let mut edges = std::collections::HashMap::new();
        edges.insert("check1".to_string(), vec![vec![[1u32, 2u32]]]);
        let event = QcEvent::CheckRan {
            check_id: "c1",
            issue: Some((IssueKind::from_str("invalid_loop").unwrap(), IssuePayload::InvalidLoop { edges })),
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
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn check_ran_with_region_needs_expansion_payload_encodes_the_full_str_keyed_node_lists_map() {
        let mut nodes = std::collections::HashMap::new();
        nodes.insert("check1".to_string(), vec![vec![5u32]]);
        let event = QcEvent::CheckRan {
            check_id: "c1",
            issue: Some((IssueKind::from_str("region_needs_expansion").unwrap(), IssuePayload::RegionNeedsExpansion { nodes })),
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
        assert_eq!(bytes.len(), offset);
    }

    #[test]
    fn issues_merged_encodes_the_kind_string() {
        let event = QcEvent::IssuesMerged { kind: IssueKind::from_str("invalid_loop").unwrap() };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        let mut offset = 0;
        assert_eq!(read_str(&bytes, &mut offset), "invalid_loop");
        assert_eq!(bytes.len(), offset);
    }
}
