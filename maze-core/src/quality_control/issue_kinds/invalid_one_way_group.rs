use crate::ids::EdgeId;
use crate::quality_control::issue::{IssueKind, INVALID_ONE_WAY, INVALID_ONE_WAY_GROUP};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};

/// Marker type selecting the `InvalidGroupIssue<K>`/`GroupSelectStrategy<K>` instantiation for
/// one-way groups — see GitHub issue #208. `InvalidOneWayGroupIssue`'s pre-#208 shape (a group:
/// its edge set paired with how many of those edges still need fixing — always 1 for a proximity
/// pair, an excess count for a super-hub/maze-wide check) is the reference instance
/// `InvalidGroupIssue<K>` was extracted from; this marker is what wires it back to
/// `INVALID_ONE_WAY_GROUP`/`INVALID_ONE_WAY` without reimplementing any of the generic type's
/// logic. Never constructed — a zero-sized type used only at the type level.
///
/// GitHub issue #210: the nested-issue-building/candidate-invalidation logic that used to live
/// here as trait methods now lives in `OneWayGroupSelectStrategy::apply`'s own closures passed to
/// `group_select_apply` — see that strategy's doc comment.
pub struct OneWayGroupKind;

impl InvalidGroupIssueKind for OneWayGroupKind {
    type Element = EdgeId;
    const KIND: IssueKind = INVALID_ONE_WAY_GROUP;
    const NESTED_KIND: IssueKind = INVALID_ONE_WAY;
    const NESTED_SLOT_ID: &'static str = "fix_target";
}

/// Produced by any check that flags a set of one-way edges (`EdgeKind::Basic`, single direction)
/// as jointly invalid — see GitHub issue #199. Distinct from `INVALID_ONE_WAY`: that kind flags a
/// single one-way edge invalid on its own; this one flags a *relationship*/*aggregate* condition
/// over two or more one-way edges, none of which is individually invalid. Mirrors
/// `InvalidTeleportGroupIssue`'s role for teleports, but shaped as `groups: Vec<(Vec<EdgeId>, u32)>`
/// (not a flat pair list) so a repair strategy can uniformly handle any group size — see
/// `InvalidGroupIssue`'s doc comment for what the paired count means. **Mandatory** for this kind:
/// `OneWayGroupSelectStrategy`'s `problematic` priority needs group membership to score which edge
/// to pick.
///
/// GitHub issue #208: now a type alias onto the generic `InvalidGroupIssue<OneWayGroupKind>` — see
/// `group_issue.rs` for the extracted shape/merge logic (identical behavior, same wire shape).
pub type InvalidOneWayGroupIssue = InvalidGroupIssue<OneWayGroupKind>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::IssueMerge;

    #[test]
    fn merge_unions_disjoint_groups() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
        assert!(a.groups.contains(&(vec![0, 1], 1)));
        assert!(a.groups.contains(&(vec![2, 3], 1)));
    }

    #[test]
    fn merge_deduplicates_identical_group() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 1)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 1)], "the same group flagged by both checks must not be duplicated");
    }

    #[test]
    fn merge_deduplicates_group_regardless_of_edge_order() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![(vec![1, 0], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 1, "(0,1) and (1,0) must collapse to a single group: {:?}", a.groups);
    }

    #[test]
    fn merge_keeps_the_larger_to_remove_for_the_same_group() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 3)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 3)], "the larger to_remove must win");
    }

    #[test]
    fn merge_keeps_the_larger_to_remove_regardless_of_merge_direction() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 3)]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 1)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 3)], "the larger to_remove must win regardless of which side already had it");
    }

    #[test]
    fn merge_attributes_each_group_to_only_its_own_flagging_check() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&vec![0, 1]), Some(&vec!["rule_1:a".to_string()]));
        assert_eq!(a.invalid_sources.get(&vec![2, 3]), Some(&vec!["rule_1:b".to_string()]));
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_group() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![(vec![1, 0], 2)]);
        a.merge(b);

        let sources = a.invalid_sources.get(&vec![0, 1]).expect("merged group must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"rule_1:a".to_string()));
        assert!(sources.contains(&"rule_1:b".to_string()));
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_even_when_one_side_does_not_win_to_remove() {
        // The check that didn't contribute the winning to_remove is still a valid source.
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 5)]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 1)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 5)]);
        let sources = a.invalid_sources.get(&vec![0, 1]).expect("merged group must have recorded sources");
        assert!(sources.contains(&"rule_1:a".to_string()));
        assert!(sources.contains(&"rule_1:b".to_string()));
    }
}
