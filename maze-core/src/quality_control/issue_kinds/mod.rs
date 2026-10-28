//! 12 concrete `Issue` types, one per `IssueKind` variant — see `Specs/quality_control.md` and
//! GitHub issue #113. Each type carries its own data fields directly (no shared `IssueData`
//! enum) plus a `meta: IssueMeta` for the common `source_checks`/`details` bookkeeping.

use crate::quality_control::RepairArea;
use std::collections::{HashMap, HashSet};

mod area_missing_elevator_stops;
mod cycle_analysis_overflowed;
mod excessive_elevator_stop_gap;
mod excessive_scc_count;
pub(crate) mod group_issue;
mod indeterminate_distance;
mod invalid_cross_element_group;
mod invalid_dead_end;
mod invalid_dead_end_group;
mod invalid_elevator;
mod invalid_elevator_group;
mod invalid_elevator_stop;
mod invalid_elevator_stop_group;
mod invalid_loop;
mod invalid_loop_group;
mod invalid_one_way;
mod invalid_one_way_group;
mod invalid_split_node;
mod invalid_split_node_connection;
mod invalid_split_node_connection_group;
mod invalid_split_node_group;
mod invalid_split_route;
mod invalid_split_tile;
mod invalid_split_tile_group;
mod invalid_teleport;
mod invalid_teleport_group;
mod invalid_vertical_passage;
mod invalid_vertical_passage_group;
mod missing_elevator_height;
mod missing_elevator_stop_count;
mod missing_elevators;
mod missing_endpoints;
mod missing_loops;
mod missing_one_ways;
mod missing_regions;
mod missing_split_tiles;
mod missing_teleports;
mod missing_vertical_passages;
mod region_needs_expansion;
mod region_needs_shrink;
mod repair_limit_reached;
mod unreachable_finish;

pub use area_missing_elevator_stops::AreaMissingElevatorStopsIssue;
pub use cycle_analysis_overflowed::CycleAnalysisOverflowedIssue;
pub use excessive_elevator_stop_gap::ExcessiveElevatorStopGapIssue;
pub use excessive_scc_count::ExcessiveSccCountIssue;
pub use group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};
pub use indeterminate_distance::IndeterminateDistanceIssue;
pub use invalid_cross_element_group::{
    CrossElementCloseNodes, CrossElementGroupKind, InvalidCrossElementGroupIssue,
};
pub use invalid_dead_end::InvalidDeadEndIssue;
pub use invalid_dead_end_group::{DeadEndGroupKind, InvalidDeadEndGroupIssue};
pub use invalid_elevator::{ElevatorNodes, InvalidElevatorIssue};
pub use invalid_elevator_group::{ElevatorGroupKind, InvalidElevatorGroupIssue};
pub use invalid_elevator_stop::InvalidElevatorStopIssue;
pub use invalid_elevator_stop_group::{ElevatorStopGroupKind, InvalidElevatorStopGroupIssue};
pub use invalid_loop::{InvalidLoopIssue, InvalidLoopRequirement};
pub use invalid_loop_group::{InvalidLoopGroupIssue, InvalidLoopGroupRequirement};
pub use invalid_one_way::InvalidOneWayIssue;
pub use invalid_one_way_group::{InvalidOneWayGroupIssue, OneWayGroupKind};
pub use invalid_split_node::InvalidSplitNodeIssue;
pub use invalid_split_node_connection::InvalidSplitNodeConnectionIssue;
pub use invalid_split_node_connection_group::{
    InvalidSplitNodeConnectionGroupIssue, SplitNodeConnectionGroupKind,
};
pub use invalid_split_node_group::{InvalidSplitNodeGroupIssue, SplitNodeGroupKind};
pub use invalid_split_route::{InvalidSplitRouteIssue, SplitRouteEdge};
pub use invalid_split_tile::InvalidSplitTileIssue;
pub use invalid_split_tile_group::{InvalidSplitTileGroupIssue, SplitGroupKind, SplitTileNodes};
pub use invalid_teleport::InvalidTeleportIssue;
pub use invalid_teleport_group::{InvalidTeleportGroupIssue, TeleportGroupKind};
pub use invalid_vertical_passage::InvalidVerticalPassageIssue;
pub use invalid_vertical_passage_group::{
    InvalidVerticalPassageGroupIssue, VerticalPassageGroupKind,
};
pub use missing_elevator_height::MissingElevatorHeightIssue;
pub use missing_elevator_stop_count::MissingElevatorStopCountIssue;
pub use missing_elevators::MissingElevatorsIssue;
pub use missing_endpoints::MissingEndpointsIssue;
pub use missing_loops::MissingLoopsIssue;
pub use missing_one_ways::MissingOneWaysIssue;
pub use missing_regions::MissingRegionsIssue;
pub use missing_split_tiles::MissingSplitTilesIssue;
pub use missing_teleports::MissingTeleportsIssue;
pub use missing_vertical_passages::MissingVerticalPassagesIssue;
pub use region_needs_expansion::RegionNeedsExpansionIssue;
pub use region_needs_shrink::RegionNeedsShrinkIssue;
pub use repair_limit_reached::{RepairLimitKind, RepairLimitReachedIssue};
pub use unreachable_finish::UnreachableFinishIssue;

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
            debug_assert!(
                false,
                "{context}::merge: invalid index {old_idx} out of range for self.all (len {})",
                existing_old_to_new.len()
            );
            continue;
        };
        if seen_invalid.insert(new_idx) {
            merged_invalid.push(new_idx);
        }
    }
    for &old_idx in other_invalid.iter() {
        let Some(&new_idx) = incoming_old_to_new.get(old_idx) else {
            debug_assert!(
                false,
                "{context}::merge: invalid index {old_idx} out of range for other.all (len {})",
                incoming_old_to_new.len()
            );
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

/// Shared merge algorithm for the `invalid: Vec<Id>` / `invalid_sources: HashMap<Id, Vec<String>>`
/// shape common to every `Issue` type that flags a flat, already-stably-identified set with no
/// remapping needed (unlike cycle indices, which need `merge_cycle_sets`'s normalize→dedup→remap):
/// `RegionNeedsExpansionIssue`/`RegionNeedsShrinkIssue` (`Id = usize`, indices into
/// `maze.analysis.scc(&maze.graph).components` — stable because both sides read the same cache
/// entry for one QC pass) and `InvalidOneWayIssue`/`InvalidTeleportIssue` (`Id = EdgeId`, already
/// stable identity). Dedups `other_invalid` both against `self_invalid`'s existing contents and
/// against itself (`seen.insert` inside the loop, not just checked before it) — a naive
/// `.filter(|id| !seen.contains(id))` would miss a duplicate `Id` appearing twice within
/// `other_invalid` itself, since `seen` would never observe the first occurrence.
///
/// Shared merge algorithm for the `Vec<(RepairArea, u32)>` deficit shape common to every
/// per-area-deficit `Issue` type (`MissingLoopsIssue`, `MissingOneWaysIssue`,
/// `MissingTeleportsIssue`, `MissingSplitTilesIssue` — GitHub issue #369's floor-scope follow-up).
/// Two deficits for the *same* `RepairArea` take the **larger** of the two amounts — same
/// rationale as the old scalar `missing.max(other.missing)`: two independent checks (or two calls
/// of the same check) can legitimately disagree on how short one area is, and a repair strategy
/// must fix at least the larger reported deficit, never silently under-fix by adding the two
/// numbers or keeping whichever side happened to be `self`. Two deficits for *different*
/// `RepairArea`s are concatenated as separate entries — a repair strategy handles each area
/// independently, so there is nothing to combine.
pub(crate) fn merge_repair_area_deficits(
    self_missing: &mut Vec<(RepairArea, u32)>,
    other_missing: Vec<(RepairArea, u32)>,
) {
    for (area, amount) in other_missing {
        if let Some(entry) = self_missing.iter_mut().find(|(a, _)| *a == area) {
            entry.1 = entry.1.max(amount);
        } else {
            self_missing.push((area, amount));
        }
    }
}

pub(crate) fn merge_id_sets<Id: Copy + Eq + std::hash::Hash>(
    self_invalid: &mut Vec<Id>,
    self_invalid_sources: &mut HashMap<Id, Vec<String>>,
    other_invalid: Vec<Id>,
    other_invalid_sources: HashMap<Id, Vec<String>>,
) {
    let mut seen: HashSet<Id> = self_invalid.iter().copied().collect();
    for id in other_invalid {
        if seen.insert(id) {
            self_invalid.push(id);
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
}
