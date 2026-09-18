use super::invalid_elevator::ElevatorNodes;
#[cfg(test)]
use crate::quality_control::issue::Issue;
use crate::quality_control::issue::{
    IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement, MISSING_ELEVATOR_HEIGHT,
};
use std::collections::HashMap;
#[cfg(test)]
use std::collections::HashSet;

/// Produced by `MinElevatorHeightCheck` — an existing elevator's stop span is shorter than the
/// configured minimum. See GitHub issue #402, part of epic #344. `missing` holds one entry per
/// flagged elevator: the elevator itself and the required minimum span (in floors). Deliberately
/// carries no candidate floors — growing the stop interval (possibly on both ends) is
/// `AddElevatorHeightStopStrategy`'s job, not the check's.
#[derive(Debug, Clone, PartialEq)]
pub struct MissingElevatorHeightIssue {
    meta: IssueMeta,
    pub missing: Vec<(ElevatorNodes, u32)>,
    /// Which check(s) flagged each `missing` entry, keyed by the entry itself — mirrors
    /// `InvalidElevatorIssue::invalid_sources`.
    pub invalid_sources: HashMap<(ElevatorNodes, u32), Vec<String>>,
}

impl MissingElevatorHeightIssue {
    pub fn new_from_check(source_check: &str, missing: Vec<(ElevatorNodes, u32)>) -> Self {
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

impl IssueKindConst for MissingElevatorHeightIssue {
    const KIND: IssueKind = MISSING_ELEVATOR_HEIGHT;
}

impl IssueRequirement for MissingElevatorHeightIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingElevatorHeightIssue);

impl IssueMerge for MissingElevatorHeightIssue {
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

    fn elevator(nodes: Vec<crate::ids::NodeId>) -> ElevatorNodes {
        ElevatorNodes::new(nodes)
    }

    #[test]
    fn merge_concatenates_entries_without_deduping_by_elevator() {
        let mut a = MissingElevatorHeightIssue::new_from_check(
            "min_elevator_height",
            vec![(elevator(vec![0, 1]), 6)],
        );
        let b = MissingElevatorHeightIssue::new_from_check(
            "min_elevator_height",
            vec![(elevator(vec![0, 1]), 6)],
        );
        a.merge(b);
        assert_eq!(a.missing.len(), 2);
    }

    #[test]
    fn merge_keeps_source_check_and_details() {
        let mut a = MissingElevatorHeightIssue::new_from_check(
            "min_elevator_height",
            vec![(elevator(vec![0, 1]), 6)],
        )
        .with_detail(
            "min_elevator_height",
            "min_elevator_height",
            "6".to_string(),
        );
        let b = MissingElevatorHeightIssue::new_from_check(
            "min_elevator_height",
            vec![(elevator(vec![2, 3]), 6)],
        )
        .with_detail(
            "min_elevator_height",
            "min_elevator_height",
            "6".to_string(),
        );
        a.merge(b);

        assert_eq!(a.source_checks(), vec!["min_elevator_height".to_string()]);
        assert_eq!(
            a.details()
                .get("min_elevator_height")
                .and_then(|kv| kv.get("min_elevator_height")),
            Some(&"6".to_string())
        );
    }

    #[test]
    fn merge_keeps_disjoint_elevators_from_both_sides() {
        let mut a = MissingElevatorHeightIssue::new_from_check(
            "min_elevator_height",
            vec![(elevator(vec![0, 1]), 6)],
        );
        let b = MissingElevatorHeightIssue::new_from_check(
            "min_elevator_height",
            vec![(elevator(vec![5, 6]), 4)],
        );
        a.merge(b);
        let elevators: HashSet<_> = a.missing.iter().map(|(e, _)| e.clone()).collect();
        assert_eq!(elevators.len(), 2);
    }
}
