use super::merge_repair_area_deficits;
use crate::quality_control::RepairArea;
#[cfg(test)]
use crate::quality_control::issue::Issue;
use crate::quality_control::issue::{
    IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement, MISSING_ELEVATORS,
};

/// Produced by any check that flags the maze as short on elevators overall (currently
/// `MinElevatorCountCheck`/`MinElevatorDensityCheck`) — see GitHub issue #401, part of epic #344.
/// Mirrors `MissingTeleportsIssue`'s role/shape exactly, including the `Vec<(RepairArea, u32)>`
/// per-area deficit list, though in practice `missing` only ever carries a single
/// `RepairArea::WholeMaze` entry — both source checks are whole-maze scope only (see
/// `MISSING_ELEVATORS`'s doc comment for why).
#[derive(Debug, Clone, PartialEq)]
pub struct MissingElevatorsIssue {
    meta: IssueMeta,
    pub missing: Vec<(RepairArea, u32)>,
}

impl MissingElevatorsIssue {
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

impl IssueKindConst for MissingElevatorsIssue {
    const KIND: IssueKind = MISSING_ELEVATORS;
}

impl IssueRequirement for MissingElevatorsIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingElevatorsIssue);

impl IssueMerge for MissingElevatorsIssue {
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
        let mut a = MissingElevatorsIssue::new_from_check(
            "min_elevator_count",
            vec![(RepairArea::WholeMaze, 5)],
        );
        let b = MissingElevatorsIssue::new_from_check(
            "min_elevator_density",
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
        let mut a = MissingElevatorsIssue::new_from_check(
            "min_elevator_count",
            vec![(RepairArea::WholeMaze, 5)],
        )
        .with_detail("min_elevator_count", "missing", "5".to_string());
        let b = MissingElevatorsIssue::new_from_check(
            "min_elevator_density",
            vec![(RepairArea::WholeMaze, 8)],
        )
        .with_detail("min_elevator_density", "missing", "8".to_string());
        a.merge(b);

        assert_eq!(
            a.source_checks(),
            vec![
                "min_elevator_count".to_string(),
                "min_elevator_density".to_string()
            ]
        );
        assert_eq!(
            a.details()
                .get("min_elevator_count")
                .and_then(|kv| kv.get("missing")),
            Some(&"5".to_string())
        );
        assert_eq!(
            a.details()
                .get("min_elevator_density")
                .and_then(|kv| kv.get("missing")),
            Some(&"8".to_string())
        );
    }
}
