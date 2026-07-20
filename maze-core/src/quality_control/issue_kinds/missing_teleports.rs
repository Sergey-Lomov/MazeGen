use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_TELEPORTS};

/// Produced by any check that flags the maze as short on teleport edges overall (currently
/// `MinTeleportCountCheck`/`MinTeleportRatioCheck` — see GitHub issue #211). Mirrors
/// `MissingOneWaysIssue`'s role for one-ways. `missing` is how many teleport edges short of the
/// requirement the maze is.
#[derive(Debug, Clone, PartialEq)]
pub struct MissingTeleportsIssue {
    meta: IssueMeta,
    pub missing: u32,
}

impl MissingTeleportsIssue {
    pub fn new_from_check(source_check: &str, missing: u32) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), missing }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for MissingTeleportsIssue {
    const KIND: IssueKind = MISSING_TELEPORTS;
}

impl IssueRequirement for MissingTeleportsIssue {
    type Requirement = ();
}

impl Issue for MissingTeleportsIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
}

impl IssueMerge for MissingTeleportsIssue {
    /// Takes the larger of the two `missing` values — `min_teleport_count`/`min_teleport_ratio` are
    /// two independent checks that can both be active in the same rule and legitimately disagree
    /// on how many teleport edges are missing. Same rationale as `MissingOneWaysIssue::merge`.
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
        let mut a = MissingTeleportsIssue::new_from_check("min_teleport_count", 5);
        let b = MissingTeleportsIssue::new_from_check("min_teleport_ratio", 8);
        a.merge(b);
        assert_eq!(a.missing, 8, "must not silently keep the smaller self value");
    }

    #[test]
    fn merge_takes_the_larger_missing_value_when_self_is_larger() {
        let mut a = MissingTeleportsIssue::new_from_check("min_teleport_count", 8);
        let b = MissingTeleportsIssue::new_from_check("min_teleport_ratio", 5);
        a.merge(b);
        assert_eq!(a.missing, 8);
    }

    #[test]
    fn merge_unions_source_checks_and_details() {
        let mut a = MissingTeleportsIssue::new_from_check("min_teleport_count", 5)
            .with_detail("min_teleport_count", "missing", "5".to_string());
        let b = MissingTeleportsIssue::new_from_check("min_teleport_ratio", 8)
            .with_detail("min_teleport_ratio", "missing", "8".to_string());
        a.merge(b);

        assert_eq!(a.source_checks(), vec!["min_teleport_count".to_string(), "min_teleport_ratio".to_string()]);
        assert_eq!(a.details().get("min_teleport_count").and_then(|kv| kv.get("missing")), Some(&"5".to_string()));
        assert_eq!(a.details().get("min_teleport_ratio").and_then(|kv| kv.get("missing")), Some(&"8".to_string()));
    }
}
