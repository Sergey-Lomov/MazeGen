use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_SPLIT_TILES};
use crate::quality_control::RepairArea;
use super::merge_repair_area_deficits;

/// Produced by any check that flags the maze as short on split tiles overall (currently only
/// `SplitCountCheck`/`SplitDensityCheck`; future checks needing more split tiles added may reuse
/// this same kind). Mirrors `MissingLoopsIssue`'s shape/role exactly, including the
/// `Vec<(RepairArea, u32)>` per-area deficit list (GitHub issue #369's floor-scope follow-up).
#[derive(Debug, Clone, PartialEq)]
pub struct MissingSplitTilesIssue {
    meta: IssueMeta,
    pub missing: Vec<(RepairArea, u32)>,
}

impl MissingSplitTilesIssue {
    pub fn new_from_check(source_check: &str, missing: Vec<(RepairArea, u32)>) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), missing }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for MissingSplitTilesIssue {
    const KIND: IssueKind = MISSING_SPLIT_TILES;
}

impl IssueRequirement for MissingSplitTilesIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingSplitTilesIssue);

impl IssueMerge for MissingSplitTilesIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        merge_repair_area_deficits(&mut self.missing, other.missing);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::Issue;

    #[test]
    fn merge_takes_the_larger_missing_value_for_the_same_area() {
        let mut a = MissingSplitTilesIssue::new_from_check("split_count", vec![(RepairArea::WholeMaze, 5)]);
        let b = MissingSplitTilesIssue::new_from_check("split_density", vec![(RepairArea::WholeMaze, 8)]);
        a.merge(b);
        assert_eq!(a.missing, vec![(RepairArea::WholeMaze, 8)], "must not silently keep the smaller self value");
    }

    #[test]
    fn merge_unions_source_checks_and_details() {
        let mut a = MissingSplitTilesIssue::new_from_check("split_count", vec![(RepairArea::WholeMaze, 5)])
            .with_detail("split_count", "missing", "5".to_string());
        let b = MissingSplitTilesIssue::new_from_check("split_density", vec![(RepairArea::WholeMaze, 8)])
            .with_detail("split_density", "missing", "8".to_string());
        a.merge(b);

        assert_eq!(a.source_checks(), vec!["split_count".to_string(), "split_density".to_string()]);
        assert_eq!(a.details().get("split_count").and_then(|kv| kv.get("missing")), Some(&"5".to_string()));
        assert_eq!(a.details().get("split_density").and_then(|kv| kv.get("missing")), Some(&"8".to_string()));
    }
}
