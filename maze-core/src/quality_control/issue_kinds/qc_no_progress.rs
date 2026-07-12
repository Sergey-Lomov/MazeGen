use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, QC_NO_PROGRESS};

/// Carried by `QC_NO_PROGRESS` (see that const's doc comment) — the rule ids whose merged
/// `(rule_id, Issue)` pair was byte-for-byte identical to the previous iteration's, the condition
/// that tripped the no-progress guard. Not produced by any `Check<T, I>`, so it's always
/// constructed via `IssueMeta::new()` (no source check).
#[derive(Debug, Clone, PartialEq)]
pub struct QcNoProgressIssue {
    meta: IssueMeta,
    pub rule_ids: Vec<String>,
}

impl QcNoProgressIssue {
    pub fn new(rule_ids: Vec<String>) -> Self {
        Self { meta: IssueMeta::new(), rule_ids }
    }
}

impl IssueKindConst for QcNoProgressIssue {
    const KIND: IssueKind = QC_NO_PROGRESS;
}

impl IssueRequirement for QcNoProgressIssue {
    type Requirement = ();
}

impl Issue for QcNoProgressIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

impl IssueMerge for QcNoProgressIssue {
    /// Never actually merged in practice — `build_maze` pushes this at most once per `run_full`
    /// call, outside any `Rule`.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());
        for id in other.rule_ids {
            if !self.rule_ids.contains(&id) {
                self.rule_ids.push(id);
            }
        }
    }
}
