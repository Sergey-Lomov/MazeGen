use super::merge_repair_area_deficits;
use crate::quality_control::RepairArea;
#[cfg(test)]
use crate::quality_control::issue::Issue;
use crate::quality_control::issue::{
    IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement, MISSING_VERTICAL_PASSAGES,
};

/// Produced by any check that flags the maze as short on `VerticalPassage` edges overall
/// (currently `MinVerticalPassageCountCheck`/`MinVerticalPassageRatioCheck`) — see GitHub issue
/// #343. Mirrors `MissingTeleportsIssue`'s role/shape exactly, including the
/// `Vec<(RepairArea, u32)>` per-area deficit list.
#[derive(Debug, Clone, PartialEq)]
pub struct MissingVerticalPassagesIssue {
    meta: IssueMeta,
    pub missing: Vec<(RepairArea, u32)>,
}

impl MissingVerticalPassagesIssue {
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

impl IssueKindConst for MissingVerticalPassagesIssue {
    const KIND: IssueKind = MISSING_VERTICAL_PASSAGES;
}

impl IssueRequirement for MissingVerticalPassagesIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingVerticalPassagesIssue);

impl IssueMerge for MissingVerticalPassagesIssue {
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
        let mut a = MissingVerticalPassagesIssue::new_from_check(
            "min_vertical_passage_count",
            vec![(RepairArea::WholeMaze, 5)],
        );
        let b = MissingVerticalPassagesIssue::new_from_check(
            "min_vertical_passage_ratio",
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
        let mut a = MissingVerticalPassagesIssue::new_from_check(
            "min_vertical_passage_count",
            vec![(RepairArea::WholeMaze, 5)],
        )
        .with_detail("min_vertical_passage_count", "missing", "5".to_string());
        let b = MissingVerticalPassagesIssue::new_from_check(
            "min_vertical_passage_ratio",
            vec![(RepairArea::WholeMaze, 8)],
        )
        .with_detail("min_vertical_passage_ratio", "missing", "8".to_string());
        a.merge(b);

        assert_eq!(
            a.source_checks(),
            vec![
                "min_vertical_passage_count".to_string(),
                "min_vertical_passage_ratio".to_string()
            ]
        );
        assert_eq!(
            a.details()
                .get("min_vertical_passage_count")
                .and_then(|kv| kv.get("missing")),
            Some(&"5".to_string())
        );
        assert_eq!(
            a.details()
                .get("min_vertical_passage_ratio")
                .and_then(|kv| kv.get("missing")),
            Some(&"8".to_string())
        );
    }
}
