use std::collections::HashMap;
use crate::ids::NodeId;
use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_SPLIT_NODE};

/// Produced by any check that flags a single split node (any node of a split tile, slot-0
/// included — see the epic #246 doc comment: slot-0 is an equal member of the tile for every
/// purpose except the removal step itself) invalid for a check-specific reason — currently
/// `SplitNodeConnectionCountCheck`. `invalid` holds the `NodeId` of each flagged node directly —
/// unlike `InvalidSplitTileIssue`, the unit of work here is a single node, not a whole tile
/// (GitHub issue #250, part of epic #246). Mirrors `InvalidTeleportIssue`'s flat-`Vec<Id>` shape.
/// **Mandatory** for this kind, see `RemoveSplitNodeStrategy`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidSplitNodeIssue {
    meta: IssueMeta,
    pub invalid: Vec<NodeId>,
    /// Per-node check provenance, keyed directly by `NodeId` (no remap needed across merges — a
    /// `NodeId` is already stable identity, same rationale as `InvalidTeleportIssue::invalid_sources`).
    pub invalid_sources: HashMap<NodeId, Vec<String>>,
}

impl InvalidSplitNodeIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<NodeId>) -> Self {
        let invalid_sources = invalid.iter().map(|&id| (id, vec![source_check.to_string()])).collect();
        Self { meta: IssueMeta::new_from_check(source_check), invalid, invalid_sources }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidSplitNodeIssue {
    const KIND: IssueKind = INVALID_SPLIT_NODE;
}

impl IssueRequirement for InvalidSplitNodeIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidSplitNodeIssue);

impl IssueMerge for InvalidSplitNodeIssue {
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
        let mut a = InvalidSplitNodeIssue::new_from_check("split_node_connection_count_a", vec![0]);
        let b = InvalidSplitNodeIssue::new_from_check("split_node_connection_count_b", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&0));
        assert!(a.invalid.contains(&1));
    }

    #[test]
    fn merge_attributes_each_node_to_only_its_own_flagging_check() {
        let mut a = InvalidSplitNodeIssue::new_from_check("split_node_connection_count_a", vec![0]);
        let b = InvalidSplitNodeIssue::new_from_check("split_node_connection_count_b", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&0), Some(&vec!["split_node_connection_count_a".to_string()]));
        assert_eq!(a.invalid_sources.get(&1), Some(&vec!["split_node_connection_count_b".to_string()]));
    }

    #[test]
    fn merge_deduplicates_shared_node_id() {
        let mut a = InvalidSplitNodeIssue::new_from_check("split_node_connection_count_a", vec![0]);
        let b = InvalidSplitNodeIssue::new_from_check("split_node_connection_count_b", vec![0]);
        a.merge(b);

        assert_eq!(a.invalid, vec![0], "the same node id flagged by both checks must not be duplicated");
    }
}
