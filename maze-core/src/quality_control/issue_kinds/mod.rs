//! 12 concrete `Issue` types, one per `IssueKind` variant — see `Specs/quality_control.md` and
//! GitHub issue #113. Each type carries its own data fields directly (no shared `IssueData`
//! enum) plus a `meta: IssueMeta` for the common `source_checks`/`details` bookkeeping.

use std::collections::HashMap;

mod missing_endpoints;
mod unreachable_finish;
mod invalid_loop;
mod invalid_loop_group;
mod missing_loops;
mod cycle_analysis_overflowed;
mod repair_limit_reached;
mod excessive_scc_count;
mod region_needs_expansion;
mod region_needs_shrink;
mod missing_regions;
mod invalid_teleport;
mod invalid_teleport_group;
mod invalid_one_way;
pub(crate) mod group_issue;
mod invalid_one_way_group;
mod missing_one_ways;
mod missing_teleports;

pub use group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};
pub use missing_endpoints::MissingEndpointsIssue;
pub use unreachable_finish::UnreachableFinishIssue;
pub use invalid_loop::{InvalidLoopIssue, InvalidLoopRequirement};
pub use invalid_loop_group::{InvalidLoopGroupIssue, InvalidLoopGroupRequirement};
pub use missing_loops::MissingLoopsIssue;
pub use cycle_analysis_overflowed::CycleAnalysisOverflowedIssue;
pub use repair_limit_reached::{RepairLimitReachedIssue, RepairLimitKind};
pub use excessive_scc_count::ExcessiveSccCountIssue;
pub use region_needs_expansion::RegionNeedsExpansionIssue;
pub use region_needs_shrink::RegionNeedsShrinkIssue;
pub use missing_regions::MissingRegionsIssue;
pub use invalid_teleport::InvalidTeleportIssue;
pub use invalid_teleport_group::{InvalidTeleportGroupIssue, TeleportGroupKind};
pub use invalid_one_way::InvalidOneWayIssue;
pub use invalid_one_way_group::{InvalidOneWayGroupIssue, OneWayGroupKind};
pub use missing_one_ways::MissingOneWaysIssue;
pub use missing_teleports::MissingTeleportsIssue;

/// Canonical key for a cycle: its edge set, sorted. Two `Vec<EdgeId>` describing the same cycle
/// (same edges, any order) produce the same key — used both to dedup cycles across merges and
/// to attribute per-cycle check provenance (`invalid_sources`) in a way that survives `all`/
/// `invalid` being re-indexed during merge. `pub`, not `pub(crate)` — `maze-wasm`'s
/// `analytics.rs` needs the same canonicalization to attribute `InvalidLoopIssue.invalid_sources`
/// entries back to cycle edge sets when building `IssuePayloadDto::InvalidLoop`.
pub fn canonical_cycle_key(cycle: &[crate::ids::EdgeId]) -> Vec<crate::ids::EdgeId> {
    let mut key = cycle.to_vec();
    key.sort_unstable();
    key
}

/// Shared merge algorithm for the `all`/`invalid`/`invalid_sources` cycle-set shape common to
/// `InvalidLoopIssue` and `InvalidLoopGroupIssue` — both flag a subset of the maze's simple
/// cycles as invalid, just for different semantic reasons (a cycle's own property vs. a
/// group-level decision), and both need identical normalize → dedup → remap merge behavior. Takes
/// the raw fields rather than `&mut Self` so it stays usable by any future cycle-set-shaped
/// `Issue` type without adding a shared trait — callers pass `&mut self.all` etc. and this
/// function overwrites them in place with the merged result. Three explicit steps so each step's
/// invariant stays locally checkable, rather than one pass that conflates "is this the same
/// cycle" with "what's its new index" with "which indices are invalid":
/// 1. dedup — build the merged `all`, mapping every old index (from both sides) to its new index;
///    identical cycles (by `canonical_cycle_key`) collapse onto the same new index.
/// 2. remap — translate both `invalid` index lists through the old->new mapping, deduplicating
///    (the same merged cycle may be invalid per both sides). Indexes via `.get()`, not `[]` — a
///    well-behaved `Check` only ever puts indices into `invalid` that are valid for its own `all`,
///    but that's a caller contract, not something this step can verify; an out-of-range index
///    from a malformed future `Check` is dropped (with a debug-build signal, `context` naming the
///    caller type for a useful message) rather than panicking the whole repair pipeline.
/// 3. `invalid_sources` — keyed by canonical key, no remap needed — union directly, deduplicating
///    per-check-id within each cycle's source list.
pub(crate) fn merge_cycle_sets(
    context: &'static str,
    self_all: &mut Vec<Vec<crate::ids::EdgeId>>,
    self_invalid: &mut Vec<usize>,
    self_invalid_sources: &mut HashMap<Vec<crate::ids::EdgeId>, Vec<String>>,
    other_all: Vec<Vec<crate::ids::EdgeId>>,
    other_invalid: Vec<usize>,
    other_invalid_sources: HashMap<Vec<crate::ids::EdgeId>, Vec<String>>,
) {
    let mut canonical_to_new_index: HashMap<Vec<crate::ids::EdgeId>, usize> = HashMap::new();
    let mut merged_all: Vec<Vec<crate::ids::EdgeId>> = Vec::new();
    let mut existing_old_to_new: Vec<usize> = Vec::with_capacity(self_all.len());
    for cycle in self_all.iter() {
        let key = canonical_cycle_key(cycle);
        let new_index = *canonical_to_new_index.entry(key).or_insert_with(|| {
            merged_all.push(cycle.clone());
            merged_all.len() - 1
        });
        existing_old_to_new.push(new_index);
    }
    let mut incoming_old_to_new: Vec<usize> = Vec::with_capacity(other_all.len());
    for cycle in other_all.into_iter() {
        let key = canonical_cycle_key(&cycle);
        let new_index = *canonical_to_new_index.entry(key).or_insert_with(|| {
            merged_all.push(cycle);
            merged_all.len() - 1
        });
        incoming_old_to_new.push(new_index);
    }

    let mut merged_invalid: Vec<usize> = Vec::new();
    let mut seen_invalid: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for &old_idx in self_invalid.iter() {
        let Some(&new_idx) = existing_old_to_new.get(old_idx) else {
            debug_assert!(false, "{context}::merge: invalid index {old_idx} out of range for self.all (len {})", existing_old_to_new.len());
            continue;
        };
        if seen_invalid.insert(new_idx) {
            merged_invalid.push(new_idx);
        }
    }
    for &old_idx in other_invalid.iter() {
        let Some(&new_idx) = incoming_old_to_new.get(old_idx) else {
            debug_assert!(false, "{context}::merge: invalid index {old_idx} out of range for other.all (len {})", incoming_old_to_new.len());
            continue;
        };
        if seen_invalid.insert(new_idx) {
            merged_invalid.push(new_idx);
        }
    }

    for (key, sources) in other_invalid_sources {
        let entry = self_invalid_sources.entry(key).or_default();
        for source in sources {
            if !entry.contains(&source) {
                entry.push(source);
            }
        }
    }

    *self_all = merged_all;
    *self_invalid = merged_invalid;
}
