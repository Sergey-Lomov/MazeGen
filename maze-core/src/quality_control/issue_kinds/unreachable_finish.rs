use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, UNREACHABLE_FINISH};

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

impl IssueRequirement for UnreachableFinishIssue {
    type Requirement = ();
}

crate::impl_issue!(UnreachableFinishIssue);

impl IssueMerge for UnreachableFinishIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
    }
}
