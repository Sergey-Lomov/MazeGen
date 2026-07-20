use std::collections::HashMap;
use crate::ids::EdgeId;
use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_TELEPORT};

/// Produced by any check that flags a teleport edge (`EdgeKind::Teleport`) invalid for a
/// check-specific reason — currently `TeleportDuplicatesConnectionCheck`,
/// `TeleportWaypointDistanceCheck`, `TeleportMinGeometricLengthCheck`,
/// `TeleportMaxGeometricLengthCheck`, `TeleportSuperHubAvoidanceCheck`. `invalid` holds the
/// base-`Graph` `EdgeId` of each flagged teleport edge directly — unlike `InvalidLoopIssue`,
/// there is no `all`/index-into-`all` indirection here: a teleport is a single edge, not a cycle
/// of edges, so there is nothing to resolve an index against. **Mandatory** for this kind, see
/// `RemoveTeleportStrategy`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidTeleportIssue {
    meta: IssueMeta,
    pub invalid: Vec<EdgeId>,
    /// Per-edge check provenance, keyed directly by `EdgeId` (no remap needed across merges,
    /// unlike `InvalidLoopIssue.invalid_sources`'s canonical-cycle-key indirection — an `EdgeId`
    /// is already stable identity). Built automatically in `new_from_check` from `invalid`
    /// (every flagged edge is attributed to that single constructing check, per the pre-merge
    /// "exactly one source" invariant `IssueMeta` documents), then unioned per edge in `merge` —
    /// see GitHub issue #195's follow-up: without this, `resolve_issue_payload`'s teleport
    /// highlight had no way to attribute a merged issue's edges back to the specific check that
    /// flagged each one, so hovering one check's bubble wrongly highlighted every contributing
    /// check's edges combined.
    pub invalid_sources: HashMap<EdgeId, Vec<String>>,
}

impl InvalidTeleportIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<EdgeId>) -> Self {
        let invalid_sources = invalid.iter().map(|&id| (id, vec![source_check.to_string()])).collect();
        Self { meta: IssueMeta::new_from_check(source_check), invalid, invalid_sources }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidTeleportIssue {
    const KIND: IssueKind = INVALID_TELEPORT;
}

impl IssueRequirement for InvalidTeleportIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidTeleportIssue);

impl IssueMerge for InvalidTeleportIssue {
    /// A teleport is a single edge, not a cycle of edges — unlike `InvalidLoopIssue` there is no
    /// index-into-`all` indirection to remap, just a dedup-union of flagged `EdgeId`s.
    /// `invalid_sources` is unioned per edge id (no remap needed — `EdgeId` is already stable
    /// identity), deduplicating per-check-id within each edge's source list, mirroring
    /// `InvalidLoopIssue`'s `invalid_sources` merge.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        super::merge_id_sets(&mut self.invalid, &mut self.invalid_sources, other.invalid, other.invalid_sources);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_unions_disjoint_edge_ids() {
        // e.g. teleport_duplicates_connection flags edge 0, teleport_waypoint_distance flags a
        // different edge 1 in the same pass — both must survive in the merged issue.
        let mut a = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![0]);
        let b = InvalidTeleportIssue::new_from_check("teleport_waypoint_distance", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&0));
        assert!(a.invalid.contains(&1));
    }

    #[test]
    fn merge_attributes_each_edge_to_only_its_own_flagging_check() {
        // GitHub issue #195's follow-up: edge 0 was flagged only by teleport_duplicates_connection,
        // edge 1 only by teleport_waypoint_distance -- after merge, each edge's invalid_sources
        // entry must list only the check that actually flagged it, not both.
        let mut a = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![0]);
        let b = InvalidTeleportIssue::new_from_check("teleport_waypoint_distance", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&0), Some(&vec!["teleport_duplicates_connection".to_string()]));
        assert_eq!(a.invalid_sources.get(&1), Some(&vec!["teleport_waypoint_distance".to_string()]));
    }

    #[test]
    fn merge_invalid_sources_no_duplicate_for_repeated_check_on_same_edge() {
        // Same check id, same edge, flagged in two separate merged issues (e.g. two rule stages
        // both running the same check type) -- the dedup guard (`if !entry.contains`) must skip
        // the second push instead of recording the source twice.
        let mut a = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![0]);
        let b = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![0]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&0), Some(&vec!["teleport_duplicates_connection".to_string()]));
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_edge() {
        let mut a = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![0]);
        let b = InvalidTeleportIssue::new_from_check("teleport_waypoint_distance", vec![0]);
        a.merge(b);

        let sources = a.invalid_sources.get(&0).expect("merged edge must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"teleport_duplicates_connection".to_string()));
        assert!(sources.contains(&"teleport_waypoint_distance".to_string()));
    }

    #[test]
    fn merge_deduplicates_shared_edge_id() {
        // The same teleport edge flagged by two different checks (e.g. both duplicates a
        // connection AND sits too close to start) must appear once in the merged issue.
        let mut a = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![0]);
        let b = InvalidTeleportIssue::new_from_check("teleport_waypoint_distance", vec![0]);
        a.merge(b);

        assert_eq!(a.invalid, vec![0], "the same edge id flagged by both checks must not be duplicated");
    }
}
