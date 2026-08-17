use crate::ids::EdgeId;
use crate::quality_control::issue::{IssueKind, INVALID_VERTICAL_PASSAGE, INVALID_VERTICAL_PASSAGE_GROUP};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};

/// Marker type selecting the `InvalidGroupIssue<K>`/`GroupSelectStrategy<K>` instantiation for
/// vertical-passage groups — see GitHub issue #343. Mirrors `OneWayGroupKind` exactly. Never
/// constructed — a zero-sized type used only at the type level.
pub struct VerticalPassageGroupKind;

impl InvalidGroupIssueKind for VerticalPassageGroupKind {
    type Element = EdgeId;
    const KIND: IssueKind = INVALID_VERTICAL_PASSAGE_GROUP;
    const NESTED_KIND: IssueKind = INVALID_VERTICAL_PASSAGE;
    const NESTED_SLOT_ID: &'static str = "fix_target";
}

/// Produced by any check that flags a set of `VerticalPassage` edges as jointly invalid (excess
/// count/ratio) — see GitHub issue #343. Distinct from `INVALID_VERTICAL_PASSAGE`: that kind flags
/// a single vertical-passage edge invalid on its own; this one flags an aggregate condition over
/// two or more of them, none of which is individually invalid. Currently produced by
/// `MaxVerticalPassageCountCheck`/`MaxVerticalPassageRatioCheck`. Mirrors `InvalidOneWayGroupIssue`
/// — a type alias onto the generic `InvalidGroupIssue<VerticalPassageGroupKind>`.
pub type InvalidVerticalPassageGroupIssue = InvalidGroupIssue<VerticalPassageGroupKind>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::IssueMerge;

    #[test]
    fn merge_unions_disjoint_groups() {
        let mut a = InvalidVerticalPassageGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidVerticalPassageGroupIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
        assert!(a.groups.contains(&(vec![0, 1], 1)));
        assert!(a.groups.contains(&(vec![2, 3], 1)));
    }

    #[test]
    fn merge_deduplicates_identical_group() {
        let mut a = InvalidVerticalPassageGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidVerticalPassageGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 1)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 1)], "the same group flagged by both checks must not be duplicated");
    }

    #[test]
    fn merge_keeps_the_larger_to_remove_for_the_same_group() {
        let mut a = InvalidVerticalPassageGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidVerticalPassageGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 3)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 3)], "the larger to_remove must win");
    }
}
