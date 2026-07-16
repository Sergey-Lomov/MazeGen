use std::collections::HashSet;
use crate::ids::EdgeId;
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_TELEPORT};

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
}

impl InvalidTeleportIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<EdgeId>) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), invalid }
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

impl Issue for InvalidTeleportIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
}

impl IssueMerge for InvalidTeleportIssue {
    /// A teleport is a single edge, not a cycle of edges — unlike `InvalidLoopIssue` there is no
    /// index-into-`all` indirection to remap, just a dedup-union of flagged `EdgeId`s. Uses a
    /// `HashSet` for the membership check (existing entries only) so the union stays O(n + m)
    /// rather than O(n * m) for a linear-scan `.contains()` per incoming id.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());

        let seen: HashSet<EdgeId> = self.invalid.iter().copied().collect();
        self.invalid.extend(other.invalid.into_iter().filter(|id| !seen.contains(id)));
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
    fn merge_deduplicates_shared_edge_id() {
        // The same teleport edge flagged by two different checks (e.g. both duplicates a
        // connection AND sits too close to start) must appear once in the merged issue.
        let mut a = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![0]);
        let b = InvalidTeleportIssue::new_from_check("teleport_waypoint_distance", vec![0]);
        a.merge(b);

        assert_eq!(a.invalid, vec![0], "the same edge id flagged by both checks must not be duplicated");
    }
}
