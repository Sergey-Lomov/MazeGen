use std::collections::HashMap;
#[cfg(test)]
use std::collections::HashSet;
use crate::space::LevelId;
use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, EXCESSIVE_ELEVATOR_STOP_GAP};
use super::invalid_elevator::ElevatorNodes;
#[cfg(test)]
use crate::quality_control::issue::Issue;

/// Produced by `MaxElevatorStopGapCheck` — an existing elevator has a consecutive stop pair whose
/// floor-index gap exceeds the configured maximum. See GitHub issue #402, part of epic #344.
/// `missing` holds one entry per over-large gap: the elevator itself and the gap's own bottom/top
/// floor. Deliberately carries no candidate floor list — picking a floor strictly between `lo`
/// and `hi` is `AddElevatorStopForGapStrategy`'s job, not the check's.
#[derive(Debug, Clone, PartialEq)]
pub struct ExcessiveElevatorStopGapIssue {
    meta: IssueMeta,
    pub missing: Vec<(ElevatorNodes, LevelId, LevelId)>,
    /// Which check(s) flagged each `missing` entry, keyed by the entry itself — mirrors
    /// `InvalidElevatorIssue::invalid_sources`.
    pub invalid_sources: HashMap<(ElevatorNodes, LevelId, LevelId), Vec<String>>,
}

impl ExcessiveElevatorStopGapIssue {
    pub fn new_from_check(source_check: &str, missing: Vec<(ElevatorNodes, LevelId, LevelId)>) -> Self {
        let invalid_sources = missing.iter().map(|e| (e.clone(), vec![source_check.to_string()])).collect();
        Self { meta: IssueMeta::new_from_check(source_check), missing, invalid_sources }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for ExcessiveElevatorStopGapIssue {
    const KIND: IssueKind = EXCESSIVE_ELEVATOR_STOP_GAP;
}

impl IssueRequirement for ExcessiveElevatorStopGapIssue {
    type Requirement = ();
}

crate::impl_issue!(ExcessiveElevatorStopGapIssue);

impl IssueMerge for ExcessiveElevatorStopGapIssue {
    /// Deliberately does not dedup/combine entries for the same elevator — mirrors
    /// `InvalidElevatorIssue.invalid`'s own plain-concat merge (`ElevatorNodes` isn't `Copy`, so
    /// this can't reuse `merge_id_sets` either).
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        self.missing.extend(other.missing);
        for (key, sources) in other.invalid_sources {
            let entry = self.invalid_sources.entry(key).or_default();
            for source in sources {
                if !entry.contains(&source) {
                    entry.push(source);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::space::{Field, MultiLevelField, SquareTessellation, square_rect};

    fn levels(count: u32) -> Vec<LevelId> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        (0..count).map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap())).collect()
    }

    fn elevator(nodes: Vec<crate::ids::NodeId>) -> ElevatorNodes {
        ElevatorNodes::new(nodes)
    }

    #[test]
    fn merge_concatenates_entries_without_deduping_by_elevator() {
        let ls = levels(6);
        let mut a = ExcessiveElevatorStopGapIssue::new_from_check("max_elevator_stop_gap", vec![(elevator(vec![0, 1]), ls[0], ls[5])]);
        let b = ExcessiveElevatorStopGapIssue::new_from_check("max_elevator_stop_gap", vec![(elevator(vec![0, 1]), ls[0], ls[5])]);
        a.merge(b);
        assert_eq!(a.missing.len(), 2);
    }

    #[test]
    fn merge_keeps_source_check_and_details() {
        let ls = levels(6);
        let mut a = ExcessiveElevatorStopGapIssue::new_from_check("max_elevator_stop_gap", vec![(elevator(vec![0, 1]), ls[0], ls[5])])
            .with_detail("max_elevator_stop_gap", "max_elevator_stop_gap", "2".to_string());
        let b = ExcessiveElevatorStopGapIssue::new_from_check("max_elevator_stop_gap", vec![(elevator(vec![2, 3]), ls[0], ls[4])])
            .with_detail("max_elevator_stop_gap", "max_elevator_stop_gap", "2".to_string());
        a.merge(b);

        assert_eq!(a.source_checks(), vec!["max_elevator_stop_gap".to_string()]);
        assert_eq!(a.details().get("max_elevator_stop_gap").and_then(|kv| kv.get("max_elevator_stop_gap")), Some(&"2".to_string()));
    }

    #[test]
    fn merge_keeps_disjoint_elevators_from_both_sides() {
        let ls = levels(6);
        let mut a = ExcessiveElevatorStopGapIssue::new_from_check("max_elevator_stop_gap", vec![(elevator(vec![0, 1]), ls[0], ls[5])]);
        let b = ExcessiveElevatorStopGapIssue::new_from_check("max_elevator_stop_gap", vec![(elevator(vec![5, 6]), ls[0], ls[4])]);
        a.merge(b);
        let elevators: HashSet<_> = a.missing.iter().map(|(e, _, _)| e.clone()).collect();
        assert_eq!(elevators.len(), 2);
    }
}
