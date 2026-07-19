use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_ONE_WAYS};

/// Produced by any check that flags the maze as short on one-way passage edges overall (currently
/// `MinOneWayCountCheck`/`MinOneWayRatioCheck` — see GitHub issue #201, part of the one-way
/// management epic #92). Mirrors `MissingLoopsIssue`'s role for loops. `missing` is how many
/// one-way edges short of the requirement the maze is.
#[derive(Debug, Clone, PartialEq)]
pub struct MissingOneWaysIssue {
    meta: IssueMeta,
    pub missing: u32,
}

impl MissingOneWaysIssue {
    pub fn new_from_check(source_check: &str, missing: u32) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), missing }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for MissingOneWaysIssue {
    const KIND: IssueKind = MISSING_ONE_WAYS;
}

impl IssueRequirement for MissingOneWaysIssue {
    type Requirement = ();
}

impl Issue for MissingOneWaysIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
}

impl IssueMerge for MissingOneWaysIssue {
    /// Takes the larger of the two `missing` values — `min_one_way_count`/`min_one_way_ratio` are
    /// two independent checks that can both be active in the same rule and legitimately disagree
    /// on how many one-way edges are missing (see GitHub issue #201's follow-up). A repair
    /// strategy must fix at least the largest reported deficit; silently keeping whichever side
    /// happened to be `self` (the pre-#201-follow-up behavior) could under-fix the smaller
    /// disagreeing check's requirement and force an extra repair iteration to catch up.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());
        self.missing = self.missing.max(other.missing);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_takes_the_larger_missing_value_when_self_is_smaller() {
        let mut a = MissingOneWaysIssue::new_from_check("min_one_way_count", 5);
        let b = MissingOneWaysIssue::new_from_check("min_one_way_ratio", 8);
        a.merge(b);
        assert_eq!(a.missing, 8, "must not silently keep the smaller self value");
    }

    #[test]
    fn merge_takes_the_larger_missing_value_when_self_is_larger() {
        let mut a = MissingOneWaysIssue::new_from_check("min_one_way_count", 8);
        let b = MissingOneWaysIssue::new_from_check("min_one_way_ratio", 5);
        a.merge(b);
        assert_eq!(a.missing, 8);
    }

    #[test]
    fn merge_unions_source_checks_and_details() {
        let mut a = MissingOneWaysIssue::new_from_check("min_one_way_count", 5)
            .with_detail("min_one_way_count", "missing", "5".to_string());
        let b = MissingOneWaysIssue::new_from_check("min_one_way_ratio", 8)
            .with_detail("min_one_way_ratio", "missing", "8".to_string());
        a.merge(b);

        assert_eq!(a.source_checks(), vec!["min_one_way_count".to_string(), "min_one_way_ratio".to_string()]);
        assert_eq!(a.details().get("min_one_way_count").and_then(|kv| kv.get("missing")), Some(&"5".to_string()));
        assert_eq!(a.details().get("min_one_way_ratio").and_then(|kv| kv.get("missing")), Some(&"8".to_string()));
    }
}
