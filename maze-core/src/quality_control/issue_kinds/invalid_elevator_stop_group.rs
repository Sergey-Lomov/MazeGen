use crate::ids::NodeId;
use crate::quality_control::issue::{IssueKind, INVALID_ELEVATOR_STOP, INVALID_ELEVATOR_STOP_GROUP};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};

/// Marker type selecting the `InvalidGroupIssue<K>`/`GroupSelectStrategy<K>` instantiation for
/// elevator-stop groups — see GitHub issue #399. `Element = NodeId`: a single stop node, not a
/// whole `ElevatorNodes` (unlike `ElevatorGroupKind`) — a fix here always removes one stop from
/// whichever elevator it belongs to, never the whole elevator. Never constructed — a zero-sized
/// type used only at the type level.
pub struct ElevatorStopGroupKind;

impl InvalidGroupIssueKind for ElevatorStopGroupKind {
    type Element = NodeId;
    const KIND: IssueKind = INVALID_ELEVATOR_STOP_GROUP;
    const NESTED_KIND: IssueKind = INVALID_ELEVATOR_STOP;
    const NESTED_SLOT_ID: &'static str = "fix_target";
}

/// Produced by any check that flags a set of elevator stops as jointly invalid (excess stop count
/// on one elevator, or excess elevator-stop density on one floor) — see GitHub issue #399.
/// Distinct from `INVALID_ELEVATOR_STOP`: that kind flags individual stops invalid on their own;
/// this one flags an aggregate condition over a group of stops, none of which is individually
/// invalid. Currently produced by `MaxElevatorStopsCheck`/`MaxElevatorStopsPerFloorCheck`. Mirrors
/// `InvalidElevatorGroupIssue` — a type alias onto the generic `InvalidGroupIssue<ElevatorStopGroupKind>`.
pub type InvalidElevatorStopGroupIssue = InvalidGroupIssue<ElevatorStopGroupKind>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::IssueMerge;

    #[test]
    fn merge_unions_disjoint_groups() {
        let mut a = InvalidElevatorStopGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidElevatorStopGroupIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
    }

    #[test]
    fn merge_deduplicates_identical_group() {
        let mut a = InvalidElevatorStopGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidElevatorStopGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 1)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 1)], "the same group flagged by both checks must not be duplicated");
    }
}
