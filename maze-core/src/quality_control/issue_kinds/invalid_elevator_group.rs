use crate::quality_control::issue::{INVALID_ELEVATOR, INVALID_ELEVATOR_GROUP, IssueKind};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};
use crate::quality_control::issue_kinds::invalid_elevator::ElevatorNodes;

/// Marker type selecting the `InvalidGroupIssue<K>`/`GroupSelectStrategy<K>` instantiation for
/// elevator groups — see GitHub issue #398. Mirrors `VerticalPassageGroupKind`, except its
/// `Element` is `ElevatorNodes` (a whole elevator, named by its stop-node set) rather than a
/// single `EdgeId` — mirrors `SplitGroupKind`'s same whole-entity shape. Never constructed — a
/// zero-sized type used only at the type level.
pub struct ElevatorGroupKind;

impl InvalidGroupIssueKind for ElevatorGroupKind {
    type Element = ElevatorNodes;
    const KIND: IssueKind = INVALID_ELEVATOR_GROUP;
    const NESTED_KIND: IssueKind = INVALID_ELEVATOR;
    const NESTED_SLOT_ID: &'static str = "fix_target";
}

/// Produced by any check that flags a set of elevators as jointly invalid (excess count/density,
/// whole-maze scope) — see GitHub issue #398. Distinct from `INVALID_ELEVATOR`: that kind flags a
/// single elevator invalid on its own; this one flags an aggregate condition over the whole-maze
/// elevator group, none of which is individually invalid. Currently produced by
/// `MaxElevatorCountCheck`/`MaxElevatorDensityCheck`. Mirrors `InvalidVerticalPassageGroupIssue` —
/// a type alias onto the generic `InvalidGroupIssue<ElevatorGroupKind>`.
pub type InvalidElevatorGroupIssue = InvalidGroupIssue<ElevatorGroupKind>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::IssueMerge;

    fn elevator(nodes: Vec<crate::ids::NodeId>) -> ElevatorNodes {
        ElevatorNodes::new(nodes)
    }

    #[test]
    fn merge_unions_disjoint_groups() {
        let mut a = InvalidElevatorGroupIssue::new_from_check(
            "rule_1:a",
            vec![(vec![elevator(vec![0, 1])], 1)],
        );
        let b = InvalidElevatorGroupIssue::new_from_check(
            "rule_1:b",
            vec![(vec![elevator(vec![2, 3])], 1)],
        );
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
    }

    #[test]
    fn merge_deduplicates_identical_group() {
        let mut a = InvalidElevatorGroupIssue::new_from_check(
            "rule_1:a",
            vec![(vec![elevator(vec![0, 1])], 1)],
        );
        let b = InvalidElevatorGroupIssue::new_from_check(
            "rule_1:b",
            vec![(vec![elevator(vec![0, 1])], 1)],
        );
        a.merge(b);

        assert_eq!(
            a.groups,
            vec![(vec![elevator(vec![0, 1])], 1)],
            "the same group flagged by both checks must not be duplicated"
        );
    }
}
