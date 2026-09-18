use crate::quality_control::issue::{
    EXCESSIVE_SCC_COUNT, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};

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
        Self {
            meta: IssueMeta::new_from_check(source_check),
            max_scc_count,
        }
    }

    pub fn with_data(max_scc_count: u32) -> Self {
        Self {
            meta: IssueMeta::new(),
            max_scc_count,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for ExcessiveSccCountIssue {
    const KIND: IssueKind = EXCESSIVE_SCC_COUNT;
}

impl IssueRequirement for ExcessiveSccCountIssue {
    type Requirement = ();
}

crate::impl_issue!(ExcessiveSccCountIssue);

impl IssueMerge for ExcessiveSccCountIssue {
    /// `max_scc_count` is the threshold the repair strategy targets (`current_scc_count -
    /// max_scc_count` regions to merge). When two checks disagree, taking the stricter (smaller)
    /// threshold widens that gap so the repair satisfies both checks rather than under-fixing
    /// the stricter one.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        self.max_scc_count = self.max_scc_count.min(other.max_scc_count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::Issue;

    #[test]
    fn merge_takes_the_smaller_threshold_when_self_is_larger() {
        let mut a = ExcessiveSccCountIssue::new_from_check("scc_count_1", 8);
        let b = ExcessiveSccCountIssue::new_from_check("scc_count_2", 5);
        a.merge(b);
        assert_eq!(
            a.max_scc_count, 5,
            "the stricter (smaller) threshold must win, not silently keep self"
        );
    }

    #[test]
    fn merge_takes_the_smaller_threshold_when_self_is_smaller() {
        let mut a = ExcessiveSccCountIssue::new_from_check("scc_count_1", 5);
        let b = ExcessiveSccCountIssue::new_from_check("scc_count_2", 8);
        a.merge(b);
        assert_eq!(a.max_scc_count, 5);
    }

    #[test]
    fn merge_unions_source_checks_and_details() {
        let mut a = ExcessiveSccCountIssue::new_from_check("scc_count_1", 8).with_detail(
            "scc_count_1",
            "max_scc_count",
            "8".to_string(),
        );
        let b = ExcessiveSccCountIssue::new_from_check("scc_count_2", 5).with_detail(
            "scc_count_2",
            "max_scc_count",
            "5".to_string(),
        );
        a.merge(b);

        assert_eq!(
            a.source_checks(),
            vec!["scc_count_1".to_string(), "scc_count_2".to_string()]
        );
        assert_eq!(
            a.details()
                .get("scc_count_1")
                .and_then(|kv| kv.get("max_scc_count")),
            Some(&"8".to_string())
        );
        assert_eq!(
            a.details()
                .get("scc_count_2")
                .and_then(|kv| kv.get("max_scc_count")),
            Some(&"5".to_string())
        );
    }
}
