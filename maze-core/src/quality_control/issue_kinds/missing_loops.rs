use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_LOOPS};

/// Produced by any check that flags the maze as short on loops overall (currently only
/// `MinLoopsCountCheck`/`MinLoopDensityCheck`; future checks needing more loops added may reuse
/// this same kind). `missing` is how many loops short of the requirement the maze is — lets a
/// repair strategy know how many to add.
#[derive(Debug, Clone, PartialEq)]
pub struct MissingLoopsIssue {
    meta: IssueMeta,
    pub missing: u32,
}

impl MissingLoopsIssue {
    pub fn new_from_check(source_check: &str, missing: u32) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), missing }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for MissingLoopsIssue {
    const KIND: IssueKind = MISSING_LOOPS;
}

impl IssueRequirement for MissingLoopsIssue {
    type Requirement = ();
}

impl Issue for MissingLoopsIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

impl IssueMerge for MissingLoopsIssue {
    /// No merge rule defined for `missing` on the pre-#113 `IssueData::Missing` either — currently
    /// only one check ever produces `MISSING_LOOPS` in a single active configuration, so this
    /// path is never exercised in practice. Mirrors the old `debug_assert!(false, ...)` fallback
    /// posture: union sources/details (always safe), but signal loudly in debug builds if two
    /// `missing` values actually need reconciling, rather than silently picking one side.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());
        debug_assert_eq!(self.missing, other.missing,
            "MissingLoopsIssue::merge: two instances disagree on missing ({} vs {}) — no merge rule defined for differing values",
            self.missing, other.missing);
    }
}
