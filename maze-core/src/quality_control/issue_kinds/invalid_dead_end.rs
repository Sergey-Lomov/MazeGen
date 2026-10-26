use crate::ids::NodeId;
use crate::quality_control::issue::{
    INVALID_DEAD_END, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};
use std::collections::HashMap;

/// A specific dead-end node selected for repair. This is a nested-only issue produced by
/// `DeadEndGroupSelectStrategy`; checks continue to report aggregate
/// `InvalidDeadEndGroupIssue` values.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidDeadEndIssue {
    meta: IssueMeta,
    pub invalid: Vec<NodeId>,
    pub invalid_sources: HashMap<NodeId, Vec<String>>,
    /// Still-live candidates from the selecting group pass, used only for nested exit priority.
    /// `invalid` remains the exact repair target.
    pub reported_candidates: Vec<NodeId>,
}

impl InvalidDeadEndIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<NodeId>) -> Self {
        let invalid_sources = invalid
            .iter()
            .map(|&id| (id, vec![source_check.to_string()]))
            .collect();
        Self {
            meta: IssueMeta::new_from_check(source_check),
            reported_candidates: invalid.clone(),
            invalid,
            invalid_sources,
        }
    }

    pub fn new_from_group_select(source_check: &str, target: NodeId, others: &[NodeId]) -> Self {
        let mut issue = Self::new_from_check(source_check, vec![target]);
        issue.reported_candidates.extend_from_slice(others);
        issue.reported_candidates.sort_unstable();
        issue.reported_candidates.dedup();
        issue
    }
}

impl IssueKindConst for InvalidDeadEndIssue {
    const KIND: IssueKind = INVALID_DEAD_END;
}

impl IssueRequirement for InvalidDeadEndIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidDeadEndIssue);

impl IssueMerge for InvalidDeadEndIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        let other_reported_candidates = other.reported_candidates.clone();
        super::merge_id_sets(
            &mut self.invalid,
            &mut self.invalid_sources,
            other.invalid,
            other.invalid_sources,
        );
        self.reported_candidates.extend(other_reported_candidates);
        self.reported_candidates.sort_unstable();
        self.reported_candidates.dedup();
    }
}
