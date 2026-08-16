use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_LOOPS};
use crate::quality_control::RepairArea;
use super::merge_repair_area_deficits;

/// Produced by any check that flags the maze as short on loops overall (currently only
/// `MinLoopsCountCheck`/`MinLoopDensityCheck`; future checks needing more loops added may reuse
/// this same kind). `missing` is a list of `(RepairArea, count)` pairs — one entry per area the
/// maze is short in, `count` loops short there — so a repair strategy knows both how many loops to
/// add and where to add them (GitHub issue #369's floor-scope follow-up: a `FloorScope::PerFloor`
/// check's deficit is computed independently per floor, so a strategy sampling from the whole
/// field regardless could satisfy the reported total while adding every loop to the wrong floor).
/// A `FloorScope::WholeMaze` check reports a single `(RepairArea::WholeMaze, missing)` entry.
#[derive(Debug, Clone, PartialEq)]
pub struct MissingLoopsIssue {
    meta: IssueMeta,
    pub missing: Vec<(RepairArea, u32)>,
}

impl MissingLoopsIssue {
    pub fn new_from_check(source_check: &str, missing: Vec<(RepairArea, u32)>) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), missing }
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
        merge_repair_area_deficits(&mut self.missing, other.missing);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::Issue;

    #[test]
    fn merge_takes_the_larger_missing_value_for_the_same_area() {
        let mut a = MissingLoopsIssue::new_from_check("min_loops_count", vec![(RepairArea::WholeMaze, 5)]);
        let b = MissingLoopsIssue::new_from_check("min_loop_density", vec![(RepairArea::WholeMaze, 8)]);
        a.merge(b);
        assert_eq!(a.missing, vec![(RepairArea::WholeMaze, 8)], "must not silently keep the smaller self value");
    }

    #[test]
    fn merge_keeps_different_areas_as_separate_entries() {
        let mut ids = crate::IdGenerator::new();
        let mut field: crate::space::MultiLevelField<crate::space::SquareTessellation> =
            crate::space::MultiLevelField::single_level(crate::space::square_rect(1, 1), &mut ids).unwrap();
        let level_a = field.single_level_id();
        let level_b = field.add_level(crate::space::Field::new(crate::space::square_rect(1, 1), &mut ids).unwrap());

        let mut a = MissingLoopsIssue::new_from_check("min_loops_count", vec![(RepairArea::Level(level_a), 3)]);
        let b = MissingLoopsIssue::new_from_check("min_loops_count", vec![(RepairArea::Level(level_b), 4)]);
        a.merge(b);
        assert_eq!(a.missing.len(), 2);
        assert!(a.missing.contains(&(RepairArea::Level(level_a), 3)));
        assert!(a.missing.contains(&(RepairArea::Level(level_b), 4)));
    }

    #[test]
    fn merge_unions_source_checks_and_details() {
        let mut a = MissingLoopsIssue::new_from_check("min_loops_count", vec![(RepairArea::WholeMaze, 5)])
            .with_detail("min_loops_count", "missing", "5".to_string());
        let b = MissingLoopsIssue::new_from_check("min_loop_density", vec![(RepairArea::WholeMaze, 8)])
            .with_detail("min_loop_density", "missing", "8".to_string());
        a.merge(b);

        assert_eq!(a.source_checks(), vec!["min_loops_count".to_string(), "min_loop_density".to_string()]);
        assert_eq!(a.details().get("min_loops_count").and_then(|kv| kv.get("missing")), Some(&"5".to_string()));
        assert_eq!(a.details().get("min_loop_density").and_then(|kv| kv.get("missing")), Some(&"8".to_string()));
    }
}
