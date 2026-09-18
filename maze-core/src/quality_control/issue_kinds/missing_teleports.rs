use super::merge_repair_area_deficits;
use crate::quality_control::RepairArea;
#[cfg(test)]
use crate::quality_control::issue::Issue;
use crate::quality_control::issue::{
    IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement, MISSING_TELEPORTS,
};

/// Produced by any check that flags the maze as short on teleport edges overall (currently
/// `MinTeleportCountCheck`/`MinTeleportRatioCheck` — see GitHub issue #211). Mirrors
/// `MissingOneWaysIssue`'s role/shape for one-ways exactly, including the `Vec<(RepairArea, u32)>`
/// per-area deficit list (GitHub issue #369's floor-scope follow-up).
#[derive(Debug, Clone, PartialEq)]
pub struct MissingTeleportsIssue {
    meta: IssueMeta,
    pub missing: Vec<(RepairArea, u32)>,
}

impl MissingTeleportsIssue {
    pub fn new_from_check(source_check: &str, missing: Vec<(RepairArea, u32)>) -> Self {
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

impl IssueKindConst for MissingTeleportsIssue {
    const KIND: IssueKind = MISSING_TELEPORTS;
}

impl IssueRequirement for MissingTeleportsIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingTeleportsIssue);

impl IssueMerge for MissingTeleportsIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        merge_repair_area_deficits(&mut self.missing, other.missing);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_takes_the_larger_missing_value_for_the_same_area() {
        let mut a = MissingTeleportsIssue::new_from_check(
            "min_teleport_count",
            vec![(RepairArea::WholeMaze, 5)],
        );
        let b = MissingTeleportsIssue::new_from_check(
            "min_teleport_ratio",
            vec![(RepairArea::WholeMaze, 8)],
        );
        a.merge(b);
        assert_eq!(
            a.missing,
            vec![(RepairArea::WholeMaze, 8)],
            "must not silently keep the smaller self value"
        );
    }

    #[test]
    fn merge_unions_source_checks_and_details() {
        let mut a = MissingTeleportsIssue::new_from_check(
            "min_teleport_count",
            vec![(RepairArea::WholeMaze, 5)],
        )
        .with_detail("min_teleport_count", "missing", "5".to_string());
        let b = MissingTeleportsIssue::new_from_check(
            "min_teleport_ratio",
            vec![(RepairArea::WholeMaze, 8)],
        )
        .with_detail("min_teleport_ratio", "missing", "8".to_string());
        a.merge(b);

        assert_eq!(
            a.source_checks(),
            vec![
                "min_teleport_count".to_string(),
                "min_teleport_ratio".to_string()
            ]
        );
        assert_eq!(
            a.details()
                .get("min_teleport_count")
                .and_then(|kv| kv.get("missing")),
            Some(&"5".to_string())
        );
        assert_eq!(
            a.details()
                .get("min_teleport_ratio")
                .and_then(|kv| kv.get("missing")),
            Some(&"8".to_string())
        );
    }
}
