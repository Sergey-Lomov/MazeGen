use std::collections::HashMap;
use crate::ids::EdgeId;
use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_SPLIT_NODE_CONNECTION};

/// Produced (synthetically, by `SplitNodeConnectionGroupSelectStrategy` for its own nested calls
/// — no check ever constructs this directly, see `INVALID_SPLIT_NODE_CONNECTION`'s doc comment)
/// to flag a single connection (edge) from a split node out to an outside neighbor for removal —
/// see GitHub issue #251, part of epic #246. `invalid` holds the base-`Graph` `EdgeId` of each
/// flagged edge directly — mirrors `InvalidOneWayIssue`'s shape exactly.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidSplitNodeConnectionIssue {
    meta: IssueMeta,
    pub invalid: Vec<EdgeId>,
    /// Per-edge check provenance, keyed directly by `EdgeId` — same rationale as
    /// `InvalidOneWayIssue::invalid_sources`.
    pub invalid_sources: HashMap<EdgeId, Vec<String>>,
}

impl InvalidSplitNodeConnectionIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<EdgeId>) -> Self {
        let invalid_sources = invalid.iter().map(|&id| (id, vec![source_check.to_string()])).collect();
        Self { meta: IssueMeta::new_from_check(source_check), invalid, invalid_sources }
    }
}

impl IssueKindConst for InvalidSplitNodeConnectionIssue {
    const KIND: IssueKind = INVALID_SPLIT_NODE_CONNECTION;
}

impl IssueRequirement for InvalidSplitNodeConnectionIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidSplitNodeConnectionIssue);

impl IssueMerge for InvalidSplitNodeConnectionIssue {
    /// A split-node connection is a single edge, not a cycle of edges — same dedup-union merge as
    /// `InvalidOneWayIssue`.
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
        let mut a = InvalidSplitNodeConnectionIssue::new_from_check("group_select", vec![0]);
        let b = InvalidSplitNodeConnectionIssue::new_from_check("group_select", vec![1]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&0));
        assert!(a.invalid.contains(&1));
    }

    #[test]
    fn merge_deduplicates_shared_edge_id() {
        let mut a = InvalidSplitNodeConnectionIssue::new_from_check("group_select", vec![0]);
        let b = InvalidSplitNodeConnectionIssue::new_from_check("group_select", vec![0]);
        a.merge(b);

        assert_eq!(a.invalid, vec![0], "the same edge id flagged twice must not be duplicated");
    }
}
