use crate::quality_control::issue::{
    IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement, MISSING_ENDPOINTS,
};

/// The maze has no start and/or no finish set — see `MISSING_ENDPOINTS`'s doc comment.
/// `missing_start`/`missing_finish` record which endpoint(s) are actually absent, so a
/// `RepairStrategy` acts on the issue itself instead of re-deriving the same fact from
/// `maze.meta` directly.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MissingEndpointsIssue {
    meta: IssueMeta,
    pub missing_start: bool,
    pub missing_finish: bool,
}

impl MissingEndpointsIssue {
    pub fn new_from_check(source_check: &str, missing_start: bool, missing_finish: bool) -> Self {
        Self {
            meta: IssueMeta::new_from_check(source_check),
            missing_start,
            missing_finish,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for MissingEndpointsIssue {
    const KIND: IssueKind = MISSING_ENDPOINTS;
}

impl IssueRequirement for MissingEndpointsIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingEndpointsIssue);

impl IssueMerge for MissingEndpointsIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        self.missing_start = self.missing_start || other.missing_start;
        self.missing_finish = self.missing_finish || other.missing_finish;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_unions_sources() {
        let mut a = MissingEndpointsIssue::new_from_check("missing_endpoints", true, false);
        let b = MissingEndpointsIssue::new_from_check("missing_endpoints_2", true, false);
        a.merge(b);
        assert_eq!(
            a.meta.source_checks(),
            vec![
                "missing_endpoints".to_string(),
                "missing_endpoints_2".to_string()
            ]
        );
    }

    #[test]
    fn merge_ors_missing_flags() {
        let mut a = MissingEndpointsIssue::new_from_check("a", true, false);
        let b = MissingEndpointsIssue::new_from_check("b", false, true);
        a.merge(b);
        assert!(a.missing_start);
        assert!(a.missing_finish);
    }
}
