use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueMeta, IssueKind, CYCLE_ANALYSIS_OVERFLOWED};

/// Raised directly by `build_analytics_snapshot` when cycle enumeration overflows — see
/// `CYCLE_ANALYSIS_OVERFLOWED`'s doc comment. Not produced by any `Check<T, I>`, so it's always
/// constructed via `IssueMeta::new()` (no source check). Carries no data beyond `IssueMeta`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CycleAnalysisOverflowedIssue {
    meta: IssueMeta,
}

impl CycleAnalysisOverflowedIssue {
    pub fn new() -> Self {
        Self { meta: IssueMeta::new() }
    }
}

impl IssueKindConst for CycleAnalysisOverflowedIssue {
    const KIND: IssueKind = CYCLE_ANALYSIS_OVERFLOWED;
}

impl Issue for CycleAnalysisOverflowedIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

impl IssueMerge for CycleAnalysisOverflowedIssue {
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());
    }
}
