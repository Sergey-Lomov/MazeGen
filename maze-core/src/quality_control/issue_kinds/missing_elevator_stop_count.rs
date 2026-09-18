use super::invalid_elevator::ElevatorNodes;
#[cfg(test)]
use crate::quality_control::issue::Issue;
use crate::quality_control::issue::{
    IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement, MISSING_ELEVATOR_STOP_COUNT,
};
use crate::space::LevelId;
use std::collections::HashMap;
#[cfg(test)]
use std::collections::HashSet;

/// Produced by `MinElevatorStopCountCheck` — an existing elevator has fewer stops overall than the
/// configured minimum. See GitHub issue #402, part of epic #344. `missing` holds one entry per
/// flagged elevator: the elevator itself (`ElevatorNodes`), how many stops are still needed, and
/// every free floor at the elevator's own point offered as a candidate.
#[derive(Debug, Clone, PartialEq)]
pub struct MissingElevatorStopCountIssue {
    meta: IssueMeta,
    pub missing: Vec<(ElevatorNodes, u32, Vec<LevelId>)>,
    /// Which check(s) flagged each `missing` entry, keyed by the entry itself — mirrors
    /// `InvalidElevatorIssue::invalid_sources`.
    pub invalid_sources: HashMap<(ElevatorNodes, u32, Vec<LevelId>), Vec<String>>,
}

impl MissingElevatorStopCountIssue {
    pub fn new_from_check(
        source_check: &str,
        missing: Vec<(ElevatorNodes, u32, Vec<LevelId>)>,
    ) -> Self {
        let invalid_sources = missing
            .iter()
            .map(|e| (e.clone(), vec![source_check.to_string()]))
            .collect();
        Self {
            meta: IssueMeta::new_from_check(source_check),
            missing,
            invalid_sources,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for MissingElevatorStopCountIssue {
    const KIND: IssueKind = MISSING_ELEVATOR_STOP_COUNT;
}

impl IssueRequirement for MissingElevatorStopCountIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingElevatorStopCountIssue);

impl IssueMerge for MissingElevatorStopCountIssue {
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
        (0..count)
            .map(|_| {
                mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap())
            })
            .collect()
    }

    fn elevator(nodes: Vec<crate::ids::NodeId>) -> ElevatorNodes {
        ElevatorNodes::new(nodes)
    }

    #[test]
    fn merge_concatenates_entries_without_deduping_by_elevator() {
        let ls = levels(2);
        let mut a = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(elevator(vec![0, 1]), 2, vec![ls[0]])],
        );
        let b = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(elevator(vec![0, 1]), 2, vec![ls[1]])],
        );
        a.merge(b);
        assert_eq!(a.missing.len(), 2);
    }

    #[test]
    fn merge_keeps_source_check_and_details() {
        let ls = levels(2);
        let mut a = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(elevator(vec![0, 1]), 2, vec![ls[0]])],
        )
        .with_detail(
            "min_elevator_stop_count",
            "min_elevator_stop_count",
            "3".to_string(),
        );
        let b = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(elevator(vec![2, 3]), 1, vec![ls[1]])],
        )
        .with_detail(
            "min_elevator_stop_count",
            "min_elevator_stop_count",
            "3".to_string(),
        );
        a.merge(b);

        assert_eq!(
            a.source_checks(),
            vec!["min_elevator_stop_count".to_string()]
        );
        assert_eq!(
            a.details()
                .get("min_elevator_stop_count")
                .and_then(|kv| kv.get("min_elevator_stop_count")),
            Some(&"3".to_string())
        );
    }

    #[test]
    fn merge_keeps_disjoint_elevators_from_both_sides() {
        let ls = levels(4);
        let mut a = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(elevator(vec![0, 1]), 2, vec![ls[0]])],
        );
        let b = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(elevator(vec![5, 6]), 1, vec![ls[3]])],
        );
        a.merge(b);
        let elevators: HashSet<_> = a.missing.iter().map(|(e, _, _)| e.clone()).collect();
        assert_eq!(elevators.len(), 2);
    }
}
