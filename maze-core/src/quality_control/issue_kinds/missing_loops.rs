use crate::quality_control::issue::{
    IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement, MISSING_LOOPS,
};

/// Produced by any check that flags the maze as short on loops overall (currently only
/// `MinLoopsCountCheck`/`MinLoopDensityCheck`; future checks needing more loops added may reuse
/// this same kind). `missing` is how many loops the maze is short.
#[derive(Debug, Clone, PartialEq)]
pub struct MissingLoopsIssue {
    meta: IssueMeta,
    pub missing: u32,
}

impl MissingLoopsIssue {
    pub fn new_from_check(source_check: &str, missing: u32) -> Self {
        Self {
            meta: IssueMeta::new_from_check(source_check),
            missing,
        }
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

crate::impl_issue!(MissingLoopsIssue);

impl IssueMerge for MissingLoopsIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        self.missing = self.missing.max(other.missing);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::Issue;

    #[test]
    fn merge_takes_the_larger_missing_value_for_the_same_area() {
        let mut a = MissingLoopsIssue::new_from_check("min_loops_count", 5);
        let b = MissingLoopsIssue::new_from_check("min_loop_density", 8);
        a.merge(b);
        assert_eq!(
            a.missing, 8,
            "must not silently keep the smaller self value"
        );
    }

    #[test]
    fn merge_unions_source_checks_and_details() {
        let mut a = MissingLoopsIssue::new_from_check("min_loops_count", 5).with_detail(
            "min_loops_count",
            "missing",
            "5".to_string(),
        );
        let b = MissingLoopsIssue::new_from_check("min_loop_density", 8).with_detail(
            "min_loop_density",
            "missing",
            "8".to_string(),
        );
        a.merge(b);

        assert_eq!(
            a.source_checks(),
            vec![
                "min_loops_count".to_string(),
                "min_loop_density".to_string()
            ]
        );
        assert_eq!(
            a.details()
                .get("min_loops_count")
                .and_then(|kv| kv.get("missing")),
            Some(&"5".to_string())
        );
        assert_eq!(
            a.details()
                .get("min_loop_density")
                .and_then(|kv| kv.get("missing")),
            Some(&"8".to_string())
        );
    }
}
