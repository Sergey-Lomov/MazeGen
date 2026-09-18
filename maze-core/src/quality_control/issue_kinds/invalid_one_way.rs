use crate::ids::EdgeId;
use crate::quality_control::issue::{
    INVALID_ONE_WAY, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};
use std::collections::HashMap;

/// Produced by any check that flags a one-way passage edge (`EdgeKind::Basic`, single direction)
/// invalid for a check-specific reason — currently `OneWayWaypointDistanceCheck`. See GitHub issue
/// #198. `invalid` holds the base-`Graph` `EdgeId` of each flagged one-way edge directly — mirrors
/// `InvalidTeleportIssue`'s shape exactly: a one-way edge is a single edge, not a cycle of edges,
/// so there is no `all`/index-into-`all` indirection to resolve against.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidOneWayIssue {
    meta: IssueMeta,
    pub invalid: Vec<EdgeId>,
    /// Per-edge check provenance, keyed directly by `EdgeId` — same rationale as
    /// `InvalidTeleportIssue::invalid_sources`.
    pub invalid_sources: HashMap<EdgeId, Vec<String>>,
}

impl InvalidOneWayIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<EdgeId>) -> Self {
        let invalid_sources = invalid
            .iter()
            .map(|&id| (id, vec![source_check.to_string()]))
            .collect();
        Self {
            meta: IssueMeta::new_from_check(source_check),
            invalid,
            invalid_sources,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidOneWayIssue {
    const KIND: IssueKind = INVALID_ONE_WAY;
}

impl IssueRequirement for InvalidOneWayIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidOneWayIssue);

impl IssueMerge for InvalidOneWayIssue {
    /// A one-way edge is a single edge, not a cycle of edges — same dedup-union merge as
    /// `InvalidTeleportIssue`.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        super::merge_id_sets(
            &mut self.invalid,
            &mut self.invalid_sources,
            other.invalid,
            other.invalid_sources,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_unions_disjoint_edge_ids() {
        let mut a = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![0]);
        let b = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance_2", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&0));
        assert!(a.invalid.contains(&1));
    }

    #[test]
    fn merge_deduplicates_shared_edge_id() {
        let mut a = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![0]);
        let b = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance_2", vec![0]);
        a.merge(b);

        assert_eq!(
            a.invalid,
            vec![0],
            "the same edge id flagged by both checks must not be duplicated"
        );
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_edge() {
        let mut a = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![0]);
        let b = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance_2", vec![0]);
        a.merge(b);

        let sources = a
            .invalid_sources
            .get(&0)
            .expect("merged edge must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"one_way_waypoint_distance".to_string()));
        assert!(sources.contains(&"one_way_waypoint_distance_2".to_string()));
    }
}
