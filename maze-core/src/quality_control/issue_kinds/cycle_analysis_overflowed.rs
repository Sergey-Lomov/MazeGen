use crate::quality_control::issue::{
    CYCLE_ANALYSIS_OVERFLOWED, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};

/// Raised directly by `build_analytics_snapshot` when cycle enumeration overflows — see
/// `CYCLE_ANALYSIS_OVERFLOWED`'s doc comment. Not produced by any `Check<T, I>`, so it's always
/// constructed via `IssueMeta::new()` (no source check). Carries no data beyond `IssueMeta`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CycleAnalysisOverflowedIssue {
    meta: IssueMeta,
}

impl CycleAnalysisOverflowedIssue {
    pub fn new() -> Self {
        Self {
            meta: IssueMeta::new(),
        }
    }
}

impl IssueKindConst for CycleAnalysisOverflowedIssue {
    const KIND: IssueKind = CYCLE_ANALYSIS_OVERFLOWED;
}

impl IssueRequirement for CycleAnalysisOverflowedIssue {
    type Requirement = ();
}

crate::impl_issue!(CycleAnalysisOverflowedIssue);

impl IssueMerge for CycleAnalysisOverflowedIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
    }
}
