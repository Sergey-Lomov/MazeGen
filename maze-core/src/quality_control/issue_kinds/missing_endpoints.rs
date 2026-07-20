use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_ENDPOINTS};

/// The maze has no start and/or no finish set — see `MISSING_ENDPOINTS`'s doc comment. Carries
/// no data beyond `IssueMeta`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MissingEndpointsIssue {
    meta: IssueMeta,
}

impl MissingEndpointsIssue {
    pub fn new_from_check(source_check: &str) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check) }
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_unions_sources() {
        let mut a = MissingEndpointsIssue::new_from_check("missing_endpoints");
        let b = MissingEndpointsIssue::new_from_check("missing_endpoints_2");
        a.merge(b);
        assert_eq!(a.meta.source_checks(), vec!["missing_endpoints".to_string(), "missing_endpoints_2".to_string()]);
    }
}
