use crate::ids::NodeId;
use crate::quality_control::issue::{
    INVALID_ELEVATOR_STOP, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};
use std::collections::HashMap;

/// Produced by any check that flags specific stop nodes of an elevator invalid for a
/// check-specific reason — see GitHub issue #399. `invalid` holds one `NodeId` per flagged stop
/// (not a whole `ElevatorNodes` — a single stop is the unit here, distinct from `InvalidElevatorIssue`
/// which flags a whole elevator). **Mandatory** for this kind, see `RemoveElevatorStopStrategy`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidElevatorStopIssue {
    meta: IssueMeta,
    pub invalid: Vec<NodeId>,
    /// Per-stop check provenance, keyed by the flagged stop node — mirrors
    /// `InvalidElevatorIssue::invalid_sources`.
    pub invalid_sources: HashMap<NodeId, Vec<String>>,
}

impl InvalidElevatorStopIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<NodeId>) -> Self {
        let invalid_sources = invalid
            .iter()
            .map(|&n| (n, vec![source_check.to_string()]))
            .collect();
        Self {
            meta: IssueMeta::new_from_check(source_check),
            invalid,
            invalid_sources,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidElevatorStopIssue {
    const KIND: IssueKind = INVALID_ELEVATOR_STOP;
}

impl IssueRequirement for InvalidElevatorStopIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidElevatorStopIssue);

impl IssueMerge for InvalidElevatorStopIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);

        let mut seen: std::collections::HashSet<NodeId> = self.invalid.iter().copied().collect();
        for node in other.invalid {
            if seen.insert(node) {
                self.invalid.push(node);
            }
        }
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

    #[test]
    fn merge_unions_disjoint_stops() {
        let mut a = InvalidElevatorStopIssue::new_from_check("elevator_stop_count_a", vec![0, 1]);
        let b = InvalidElevatorStopIssue::new_from_check("elevator_stop_count_b", vec![2, 3]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 4);
        assert!(a.invalid.contains(&0));
        assert!(a.invalid.contains(&3));
    }

    #[test]
    fn merge_deduplicates_shared_stop() {
        let mut a = InvalidElevatorStopIssue::new_from_check("elevator_stop_count_a", vec![0, 1]);
        let b = InvalidElevatorStopIssue::new_from_check("elevator_stop_count_b", vec![1]);
        a.merge(b);

        assert_eq!(
            a.invalid,
            vec![0, 1],
            "the same stop flagged by both checks must not be duplicated"
        );
    }

    #[test]
    fn merge_attributes_each_stop_to_only_its_own_flagging_check() {
        let mut a = InvalidElevatorStopIssue::new_from_check("max_elevator_stops_a", vec![0]);
        let b = InvalidElevatorStopIssue::new_from_check("max_elevator_stops_per_floor_b", vec![1]);
        a.merge(b);

        assert_eq!(
            a.invalid_sources.get(&0),
            Some(&vec!["max_elevator_stops_a".to_string()])
        );
        assert_eq!(
            a.invalid_sources.get(&1),
            Some(&vec!["max_elevator_stops_per_floor_b".to_string()])
        );
    }
}
