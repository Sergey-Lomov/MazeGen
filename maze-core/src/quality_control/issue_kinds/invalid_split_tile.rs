use std::collections::HashMap;
use crate::ids::NodeId;
use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_SPLIT_TILE};

/// Produced by any check that flags an extra split node (never a point's slot-0 original)
/// invalid for a check-specific reason — currently `SplitDistanceFromWaypointCheck`. `invalid`
/// holds the base-`Graph`/`Field` `NodeId` of each flagged extra split node directly — mirrors
/// `InvalidTeleportIssue`: a split node is a single node, not a cycle of edges, so there is no
/// `all`/index-into-`all` indirection here. **Mandatory** for this kind, see
/// `RemoveSplitStrategy`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidSplitTileIssue {
    meta: IssueMeta,
    pub invalid: Vec<NodeId>,
    /// Per-node check provenance, keyed directly by `NodeId` (no remap needed across merges,
    /// same rationale as `InvalidTeleportIssue.invalid_sources` — a `NodeId` is already stable
    /// identity).
    pub invalid_sources: HashMap<NodeId, Vec<String>>,
}

impl InvalidSplitTileIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<NodeId>) -> Self {
        let invalid_sources = invalid.iter().map(|&id| (id, vec![source_check.to_string()])).collect();
        Self { meta: IssueMeta::new_from_check(source_check), invalid, invalid_sources }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidSplitTileIssue {
    const KIND: IssueKind = INVALID_SPLIT_TILE;
}

impl IssueRequirement for InvalidSplitTileIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidSplitTileIssue);

impl IssueMerge for InvalidSplitTileIssue {
    /// A split node is a single node, not a cycle of edges — unlike `InvalidLoopIssue` there is
    /// no index-into-`all` indirection to remap, just a dedup-union of flagged `NodeId`s, mirrors
    /// `InvalidTeleportIssue::merge`.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        super::merge_id_sets(&mut self.invalid, &mut self.invalid_sources, other.invalid, other.invalid_sources);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_unions_disjoint_node_ids() {
        let mut a = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint_a", vec![0]);
        let b = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint_b", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&0));
        assert!(a.invalid.contains(&1));
    }

    #[test]
    fn merge_attributes_each_node_to_only_its_own_flagging_check() {
        let mut a = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint_a", vec![0]);
        let b = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint_b", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&0), Some(&vec!["split_distance_from_waypoint_a".to_string()]));
        assert_eq!(a.invalid_sources.get(&1), Some(&vec!["split_distance_from_waypoint_b".to_string()]));
    }

    #[test]
    fn merge_deduplicates_shared_node_id() {
        let mut a = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint_a", vec![0]);
        let b = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint_b", vec![0]);
        a.merge(b);

        assert_eq!(a.invalid, vec![0], "the same node id flagged by both checks must not be duplicated");
    }
}
