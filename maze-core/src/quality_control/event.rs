use crate::ids::NodeId;
use crate::graph::EdgeKind;
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

    pub const PRESET_SEEDED: u16 = 34;

    pub const EDGE_REMOVED_WITH_REVERSE: u16 = 35;
    pub const EDGE_REMOVE_WITH_REVERSE_DECLINED: u16 = 36;
    pub const EDGE_REMOVE_WITH_REVERSE_PROPOSED: u16 = 37;
}

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
/// which command failed revalidation, not just that some command did. `PresetSeeded` is the one
/// exception (GitHub issue #173): it doesn't mirror a `MutationCommand` at all — see its own doc
/// comment.
#[derive(Debug, Clone, PartialEq)]
pub enum QcEvent {
    /// One fixpoint pass of `Stage::run_repair`'s loop has started.
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
    CheckRan { check_id: String, issue: Option<(IssueKind, IssuePayload, std::collections::HashMap<&'static str, String>)> },
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
    IssuesMerged { kind: IssueKind, payload: IssuePayload, details: std::collections::HashMap<String, std::collections::HashMap<&'static str, String>> },
    /// `Stage::run_repair`'s fixpoint loop stopped because the shared `RepairBudget` was
    /// exhausted (see `StageOutcome::LimitReached`).
    IterationLimitReached(RepairLimitKind),

    // --- proposed: exact mirror of `repair::MutationCommand`'s 10 variants, emitted for every
    // command a strategy's `apply()` returned, in the `"strategy <id>"` scope, before any of them
    // is applied/revalidated — narrates what the strategy *asked for*, independent of whether
    // `apply_commands` (in the separate `"apply requests"` scope right after) actually honors it. ---
    DirectedEdgeProposed { from: NodeId, to: NodeId },
    BidirectionalEdgeProposed { a: NodeId, b: NodeId },
    DirectedTeleportProposed { from: NodeId, to: NodeId },
    BidirectionalTeleportProposed { a: NodeId, b: NodeId },
    /// `from`/`to` (not `EdgeId`, GitHub issue #171's follow-up fix) — resolved from the graph
    /// (still intact at proposal time, before `apply_commands` runs) via `edge_endpoints`, the
    /// same way `EdgeRemoved`/`EdgeRemoveDeclined` resolve theirs. An `EdgeId` is meaningless to
    /// web-side narration (no coordinate to render — `bubbleLabel` mis-rendered it as a `NodeId`
    /// before this fix, crashing once the id exceeded the maze's own node count).
    EdgeRemoveProposed { from: NodeId, to: NodeId },
    EdgeRemoveBetweenProposed { from: NodeId, to: NodeId },
    /// `from`/`to` of the *primary* `id` only (GitHub issue #185, mirrors `EdgeRemoveProposed`) —
    /// the paired reverse-direction edge (if any) isn't narrated separately, same convention as
    /// `TeleportRemoveWithReverseProposed`.
    EdgeRemoveWithReverseProposed { from: NodeId, to: NodeId },
    /// `from`/`to` of the *primary* `id` only (GitHub issue #171's follow-up fix, mirrors
    /// `EdgeRemoveProposed`) — the paired reverse-direction teleport (if any) isn't narrated
    /// separately, same as before this fix.
    TeleportRemoveWithReverseProposed { from: NodeId, to: NodeId },
    StartSetProposed(NodeId),
    FinishSetProposed(NodeId),

    // --- mutating: exact mirror of `repair::MutationCommand`'s 10 variants, emitted only for
    // commands `apply_commands` actually applied (its `ok == true` branch). ---
    DirectedEdgeAdded { from: NodeId, to: NodeId },
    BidirectionalEdgeAdded { a: NodeId, b: NodeId },
    DirectedTeleportAdded { from: NodeId, to: NodeId },
    BidirectionalTeleportAdded { a: NodeId, b: NodeId },
    /// `from`/`to` (not `EdgeId`, GitHub issue #171's follow-up fix) — resolved from the graph via
    /// `edge_endpoints` immediately before the edge is actually removed (`apply_commands`'s own
    /// `try_remove_edge_by_id` call site), since the id alone is meaningless to web-side
    /// narration. See `EdgeRemoveProposed`'s doc comment for the crash this fixes.
    EdgeRemoved { from: NodeId, to: NodeId },
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
    EdgeRemovedWithReverse { from: NodeId, to: NodeId, reverse_removed: bool },
    /// `from`/`to` of the *primary* `id` only — mirrors `TeleportRemoveWithReverseProposed`'s doc
    /// comment. `reverse_removed` — see `EdgeRemovedWithReverse`'s own doc comment, same
    /// rationale, sourced from `try_remove_teleport_with_reverse`'s `Vec<EdgeId>` length instead.
    TeleportRemovedWithReverse { from: NodeId, to: NodeId, reverse_removed: bool },
    StartSet(NodeId),
    FinishSet(NodeId),
    /// Mutating, but not a `MutationCommand` mirror (GitHub issue #173) — emitted at most once,
    /// before the first iteration, only in `qc_experiment` mode: that mode skips the generation
    /// algorithm entirely, so there is no generation-phase event tape to establish the preset
    /// edges `build_preset_state` already wrote into the graph before QC/repair started. Without
    /// this, the web replay engine's first reconstructed frame would show an empty graph even
    /// though the real graph QC/repair operates on already has these edges. Carries every preset
    /// edge as one batch (not one event per edge) specifically so scrubbing through a large
    /// preset setup costs one step, not one step per edge.
    ///
    /// One tuple per actual directed graph edge, carrying its real `EdgeKind` (GitHub issue #193's
    /// follow-up: the original shape carried a `bidirectional: bool` flag that the emitter always
    /// hardcoded to `false`, and dropped `EdgeKind` entirely — a preset teleport was indistinguishable
    /// from a preset passage, and a two-way preset was misrepresented as one-way, in the web replay
    /// engine's first reconstructed frame). A bidirectional preset (e.g. `Passage`, or a `TwoWay`
    /// teleport) already exists as two separate directed graph edges, so it naturally yields two
    /// entries here — no separate direction flag needed, mirrors `KruskalEvent::PresetUnionsApplied`.
    PresetSeeded { edges: Vec<(NodeId, NodeId, EdgeKind)> },

    // --- trace: same fields as the matching mutating variant above, for a command
    // `apply_commands` proposed but whose revalidation rejected it (its `ok == false` branch). ---
    DirectedEdgeDeclined { from: NodeId, to: NodeId },
    BidirectionalEdgeDeclined { a: NodeId, b: NodeId },
    DirectedTeleportDeclined { from: NodeId, to: NodeId },
    BidirectionalTeleportDeclined { a: NodeId, b: NodeId },
    /// `from`/`to` — mirrors `EdgeRemoved`'s doc comment; resolved before revalidation, since a
    /// declined command means the edge was never actually removed but the id is still
    /// meaningless to web-side narration on its own.
    EdgeRemoveDeclined { from: NodeId, to: NodeId },
    EdgeRemoveBetweenDeclined { from: NodeId, to: NodeId },
    /// `from`/`to` of the *primary* `id` only — mirrors `EdgeRemoveWithReverseProposed`'s doc
    /// comment. `reverse_removed` is always `false` here — `apply_commands` only takes the
    /// declined branch when `try_remove_edge_with_reverse` removed nothing at all (`ok == false`
    /// means the returned `Vec<EdgeId>` was empty), so the reverse can never have been removed
    /// either. Carried anyway (not omitted) so this variant has the exact same field shape as its
    /// mutating mirror `EdgeRemovedWithReverse` — see that type's own doc comment for why the
    /// field exists at all.
    EdgeRemoveWithReverseDeclined { from: NodeId, to: NodeId, reverse_removed: bool },
    /// `from`/`to` of the *primary* `id` only — mirrors `TeleportRemoveWithReverseProposed`'s doc
    /// comment. `reverse_removed` — same "always `false`, carried for field-shape symmetry" note
    /// as `EdgeRemoveWithReverseDeclined`'s own doc comment.
    TeleportRemoveWithReverseDeclined { from: NodeId, to: NodeId, reverse_removed: bool },
    StartSetDeclined(NodeId),
    FinishSetDeclined(NodeId),
}

impl DebugEvent for QcEvent {
    /// `true` for the 10 mutation-mirror variants plus `PresetSeeded` — these are the only
    /// `QcEvent`s that change the maze graph. Every `*Declined` variant is `false` alongside every
    /// trace variant: a declined command never touched the graph, only narrates that the
    /// strategy's proposal didn't survive revalidation.
    fn is_mutating(&self) -> bool {
        matches!(
            self,
            QcEvent::DirectedEdgeAdded { .. }
                | QcEvent::BidirectionalEdgeAdded { .. }
                | QcEvent::DirectedTeleportAdded { .. }
                | QcEvent::BidirectionalTeleportAdded { .. }
                | QcEvent::EdgeRemoved { .. }
                | QcEvent::EdgeRemovedBetween { .. }
                | QcEvent::EdgeRemovedWithReverse { .. }
                | QcEvent::TeleportRemovedWithReverse { .. }
                | QcEvent::StartSet(_)
                | QcEvent::FinishSet(_)
                | QcEvent::PresetSeeded { .. }
        )
    }
}

fn write_node_id(out: &mut Vec<u8>, id: NodeId) {
    out.extend_from_slice(&id.to_le_bytes());
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
        IssuePayload::RegionNeedsShrink { nodes } => {
            out.push(3);
            write_str_keyed_node_lists(out, nodes);
        }
        IssuePayload::InvalidTeleport { groups } => {
            out.push(4);
            write_str_keyed_edge_pairs(out, groups);
        }
        IssuePayload::InvalidOneWay { groups } => {
            out.push(5);
            write_str_keyed_edge_pairs(out, groups);
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

/// Encodes one check's own raw display details (GitHub issue #171) — `Issue::details()`'s
/// per-check value, e.g. `{"threshold" -> "10"}`.
fn write_details(out: &mut Vec<u8>, details: &std::collections::HashMap<&'static str, String>) {
    out.extend_from_slice(&(details.len() as u32).to_le_bytes());
    for (key, value) in details {
        write_str(out, key);
        write_str(out, value);
    }
}

/// Encodes a merged issue's full details map, keyed by contributing check instance id (GitHub
/// issue #171) — mirrors `Issue::details()`'s own shape one level up.
fn write_details_map(out: &mut Vec<u8>, map: &std::collections::HashMap<String, std::collections::HashMap<&'static str, String>>) {
    out.extend_from_slice(&(map.len() as u32).to_le_bytes());
    for (check_id, details) in map {
        write_str(out, check_id);
        write_details(out, details);
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
            QcEvent::EdgeRemovedWithReverse { .. } => wire_tags::EDGE_REMOVED_WITH_REVERSE,
            QcEvent::TeleportRemovedWithReverse { .. } => wire_tags::TELEPORT_REMOVED_WITH_REVERSE,
            QcEvent::StartSet(_) => wire_tags::START_SET,
            QcEvent::FinishSet(_) => wire_tags::FINISH_SET,

            QcEvent::DirectedEdgeDeclined { .. } => wire_tags::DIRECTED_EDGE_DECLINED,
            QcEvent::BidirectionalEdgeDeclined { .. } => wire_tags::BIDIRECTIONAL_EDGE_DECLINED,
            QcEvent::DirectedTeleportDeclined { .. } => wire_tags::DIRECTED_TELEPORT_DECLINED,
            QcEvent::BidirectionalTeleportDeclined { .. } => wire_tags::BIDIRECTIONAL_TELEPORT_DECLINED,
            QcEvent::EdgeRemoveDeclined { .. } => wire_tags::EDGE_REMOVE_DECLINED,
            QcEvent::EdgeRemoveBetweenDeclined { .. } => wire_tags::EDGE_REMOVE_BETWEEN_DECLINED,
            QcEvent::EdgeRemoveWithReverseDeclined { .. } => wire_tags::EDGE_REMOVE_WITH_REVERSE_DECLINED,
            QcEvent::TeleportRemoveWithReverseDeclined { .. } => wire_tags::TELEPORT_REMOVE_WITH_REVERSE_DECLINED,
            QcEvent::StartSetDeclined(_) => wire_tags::START_SET_DECLINED,
            QcEvent::FinishSetDeclined(_) => wire_tags::FINISH_SET_DECLINED,

            QcEvent::DirectedEdgeProposed { .. } => wire_tags::DIRECTED_EDGE_PROPOSED,
            QcEvent::BidirectionalEdgeProposed { .. } => wire_tags::BIDIRECTIONAL_EDGE_PROPOSED,
            QcEvent::DirectedTeleportProposed { .. } => wire_tags::DIRECTED_TELEPORT_PROPOSED,
            QcEvent::BidirectionalTeleportProposed { .. } => wire_tags::BIDIRECTIONAL_TELEPORT_PROPOSED,
            QcEvent::EdgeRemoveProposed { .. } => wire_tags::EDGE_REMOVE_PROPOSED,
            QcEvent::EdgeRemoveBetweenProposed { .. } => wire_tags::EDGE_REMOVE_BETWEEN_PROPOSED,
            QcEvent::EdgeRemoveWithReverseProposed { .. } => wire_tags::EDGE_REMOVE_WITH_REVERSE_PROPOSED,
            QcEvent::TeleportRemoveWithReverseProposed { .. } => wire_tags::TELEPORT_REMOVE_WITH_REVERSE_PROPOSED,
            QcEvent::StartSetProposed(_) => wire_tags::START_SET_PROPOSED,
            QcEvent::FinishSetProposed(_) => wire_tags::FINISH_SET_PROPOSED,

            QcEvent::PresetSeeded { .. } => wire_tags::PRESET_SEEDED,
        }
    }

    fn encode_payload(&self, out: &mut Vec<u8>) {
        match self {
            QcEvent::IterationStarted(n) => out.extend_from_slice(&n.to_le_bytes()),
            QcEvent::CheckRan { check_id, issue } => {
                write_str(out, check_id);
                match issue {
                    None => out.push(0),
                    Some((kind, payload, details)) => {
                        out.push(1);
                        write_str(out, kind.as_str());
                        write_issue_payload(out, payload);
                        write_details(out, details);
                    }
                }
            }
            QcEvent::IssuesMerged { kind, payload, details } => {
                write_str(out, kind.as_str());
                write_issue_payload(out, payload);
                write_details_map(out, details);
            }
            QcEvent::IterationLimitReached(kind) => out.push(match kind {
                RepairLimitKind::MaxIterations => 0,
                RepairLimitKind::TimeBudget => 1,
            }),

            QcEvent::DirectedEdgeAdded { from, to } | QcEvent::DirectedEdgeDeclined { from, to } | QcEvent::DirectedEdgeProposed { from, to }
            | QcEvent::DirectedTeleportAdded { from, to } | QcEvent::DirectedTeleportDeclined { from, to } | QcEvent::DirectedTeleportProposed { from, to }
            | QcEvent::EdgeRemovedBetween { from, to } | QcEvent::EdgeRemoveBetweenDeclined { from, to } | QcEvent::EdgeRemoveBetweenProposed { from, to }
            | QcEvent::EdgeRemoved { from, to } | QcEvent::EdgeRemoveDeclined { from, to } | QcEvent::EdgeRemoveProposed { from, to }
            | QcEvent::EdgeRemoveWithReverseProposed { from, to }
            | QcEvent::TeleportRemoveWithReverseProposed { from, to } => {
                write_node_id(out, *from);
                write_node_id(out, *to);
            }
            // `reverse_removed` (GitHub issue #185's follow-up fix) appended as one trailing byte
            // after `from`/`to` — see `EdgeRemovedWithReverse`'s own doc comment for why it exists.
            QcEvent::EdgeRemovedWithReverse { from, to, reverse_removed }
            | QcEvent::EdgeRemoveWithReverseDeclined { from, to, reverse_removed }
            | QcEvent::TeleportRemovedWithReverse { from, to, reverse_removed }
            | QcEvent::TeleportRemoveWithReverseDeclined { from, to, reverse_removed } => {
                write_node_id(out, *from);
                write_node_id(out, *to);
                out.push(if *reverse_removed { 1 } else { 0 });
            }
            QcEvent::BidirectionalEdgeAdded { a, b } | QcEvent::BidirectionalEdgeDeclined { a, b } | QcEvent::BidirectionalEdgeProposed { a, b }
            | QcEvent::BidirectionalTeleportAdded { a, b } | QcEvent::BidirectionalTeleportDeclined { a, b } | QcEvent::BidirectionalTeleportProposed { a, b } => {
                write_node_id(out, *a);
                write_node_id(out, *b);
            }
            QcEvent::StartSet(id) | QcEvent::StartSetDeclined(id) | QcEvent::StartSetProposed(id)
            | QcEvent::FinishSet(id) | QcEvent::FinishSetDeclined(id) | QcEvent::FinishSetProposed(id) => {
                write_node_id(out, *id);
            }

            QcEvent::PresetSeeded { edges } => {
                out.extend_from_slice(&(edges.len() as u32).to_le_bytes());
                for (from, to, kind) in edges {
                    write_node_id(out, *from);
                    write_node_id(out, *to);
                    out.push(if *kind == EdgeKind::Teleport { 1 } else { 0 });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    }

    #[test]
    fn preset_seeded_is_mutating() {
        assert!(QcEvent::PresetSeeded { edges: vec![(1, 2, EdgeKind::Basic)] }.is_mutating());
        assert!(QcEvent::PresetSeeded { edges: vec![] }.is_mutating());
    }

    #[test]
    fn trace_events_are_not_mutating() {
        assert!(!QcEvent::IterationStarted(0).is_mutating());
        assert!(!QcEvent::CheckRan { check_id: "c".to_string(), issue: None }.is_mutating());
        assert!(!QcEvent::IssuesMerged {
            kind: IssueKind::from_str("missing_endpoints").unwrap(), payload: IssuePayload::None, details: HashMap::new(),
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
    }

    #[test]
    fn every_variant_has_a_unique_nonzero_wire_tag() {
        use std::collections::HashSet;
        let events: Vec<QcEvent> = vec![
            QcEvent::IterationStarted(0),
            QcEvent::CheckRan { check_id: "c".to_string(), issue: None },
            QcEvent::IssuesMerged {
                kind: IssueKind::from_str("missing_endpoints").unwrap(), payload: IssuePayload::None, details: HashMap::new(),
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
            QcEvent::PresetSeeded { edges: vec![(0, 0, EdgeKind::Basic)] },
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

    #[test]
    fn preset_seeded_encodes_count_then_from_to_kind_per_edge() {
        let event = QcEvent::PresetSeeded { edges: vec![(1, 2, EdgeKind::Basic), (3, 4, EdgeKind::Teleport)] };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);

        assert_eq!(bytes.len(), 4 + 2 * 17, "u32 count + 2 * (8 + 8 + 1) bytes per edge");
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 2);
        assert_eq!(u64::from_le_bytes(bytes[4..12].try_into().unwrap()), 1);
        assert_eq!(u64::from_le_bytes(bytes[12..20].try_into().unwrap()), 2);
        assert_eq!(bytes[20], 0, "Basic must encode as byte 0");
        assert_eq!(u64::from_le_bytes(bytes[21..29].try_into().unwrap()), 3);
        assert_eq!(u64::from_le_bytes(bytes[29..37].try_into().unwrap()), 4);
        assert_eq!(bytes[37], 1, "Teleport must encode as byte 1");
    }

    #[test]
    fn preset_seeded_with_no_edges_encodes_a_zero_count() {
        let event = QcEvent::PresetSeeded { edges: vec![] };
        let mut bytes = Vec::new();
        event.encode_payload(&mut bytes);
        assert_eq!(bytes, 0u32.to_le_bytes().to_vec());
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
    fn issues_merged_encodes_the_kind_string_then_a_zero_payload_variant_byte_then_an_empty_details_map() {
        let event = QcEvent::IssuesMerged {
            kind: IssueKind::from_str("invalid_loop").unwrap(), payload: IssuePayload::None, details: HashMap::new(),
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
            kind: IssueKind::from_str("invalid_loop").unwrap(),
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
