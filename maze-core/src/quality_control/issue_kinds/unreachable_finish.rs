use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueMeta, IssueKind, UNREACHABLE_FINISH};

/// The finish is set but not reachable from the start — see `UNREACHABLE_FINISH`'s doc comment.
/// Carries no data beyond `IssueMeta`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UnreachableFinishIssue {
    meta: IssueMeta,
}

impl UnreachableFinishIssue {
    pub fn new_from_check(source_check: &str) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check) }
    }
}

impl IssueKindConst for UnreachableFinishIssue {
    const KIND: IssueKind = UNREACHABLE_FINISH;
}

impl Issue for UnreachableFinishIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

impl IssueMerge for UnreachableFinishIssue {
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());
    }
}
