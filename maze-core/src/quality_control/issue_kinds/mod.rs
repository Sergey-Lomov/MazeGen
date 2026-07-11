//! 12 concrete `Issue` types, one per `IssueKind` variant — see `Specs/quality_control.md` and
//! GitHub issue #113. Each type carries its own data fields directly (no shared `IssueData`
//! enum) plus a `meta: IssueMeta` for the common `source_checks`/`details` bookkeeping.

mod missing_endpoints;
mod unreachable_finish;
mod invalid_loop;
mod missing_loops;
mod cycle_analysis_overflowed;
mod repair_limit_reached;
mod qc_no_progress;
mod excessive_scc_count;
mod region_needs_expansion;
mod missing_regions;
mod invalid_teleport;
mod teleport_group_proximity;

pub use missing_endpoints::MissingEndpointsIssue;
pub use unreachable_finish::UnreachableFinishIssue;
pub use invalid_loop::InvalidLoopIssue;
pub use missing_loops::MissingLoopsIssue;
pub use cycle_analysis_overflowed::CycleAnalysisOverflowedIssue;
pub use repair_limit_reached::{RepairLimitReachedIssue, RepairLimitKind};
pub use qc_no_progress::QcNoProgressIssue;
pub use excessive_scc_count::ExcessiveSccCountIssue;
pub use region_needs_expansion::RegionNeedsExpansionIssue;
pub use missing_regions::MissingRegionsIssue;
pub use invalid_teleport::InvalidTeleportIssue;
pub use teleport_group_proximity::TeleportGroupProximityIssue;

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
