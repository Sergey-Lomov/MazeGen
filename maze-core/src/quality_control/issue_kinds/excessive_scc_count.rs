use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueMeta, IssueKind, EXCESSIVE_SCC_COUNT};

/// Produced by `SccCountCheck` (paired with `EXCESSIVE_SCC_COUNT`) — mandatory for this kind:
/// `max_scc_count` is the configured threshold the check compared against, needed by
/// `ReduceSccCountStrategy` to compute how many regions to merge (`current_scc_count -
/// max_scc_count`) — there is no other channel to learn it (the check's own `max_scc_count`
/// field isn't visible to a strategy, only what it attaches to the issue).
#[derive(Debug, Clone, PartialEq)]
pub struct ExcessiveSccCountIssue {
    meta: IssueMeta,
    pub max_scc_count: u32,
}

impl ExcessiveSccCountIssue {
    pub fn new_from_check(source_check: &str, max_scc_count: u32) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), max_scc_count }
    }

    pub fn with_data(max_scc_count: u32) -> Self {
        Self { meta: IssueMeta::new(), max_scc_count }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for ExcessiveSccCountIssue {
    const KIND: IssueKind = EXCESSIVE_SCC_COUNT;
}

impl Issue for ExcessiveSccCountIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

impl IssueMerge for ExcessiveSccCountIssue {
    /// In practice there is normally exactly one active `scc_count` instance (see
    /// `Specs/quality_control.md`), so two differing thresholds reaching this merge would be a
    /// caller configuration conflict, not a case this merge can meaningfully resolve — same
    /// debug-only signal as the pre-#113 `merge_issue`'s analogous conflict.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());
        debug_assert_eq!(self.max_scc_count, other.max_scc_count,
            "ExcessiveSccCountIssue::merge: two instances disagree on max_scc_count ({} vs {})",
            self.max_scc_count, other.max_scc_count);
    }
}
