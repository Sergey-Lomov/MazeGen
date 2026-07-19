use crate::ids::EdgeId;
use crate::quality_control::issue::{Issue, IssueKind, INVALID_TELEPORT, INVALID_TELEPORT_GROUP};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};
use crate::quality_control::issue_kinds::InvalidTeleportIssue;
use crate::repair::{MutationCommand, removed_edge_ids};

/// Marker type selecting the `InvalidGroupIssue<K>`/`GroupSelectStrategy<K>` instantiation for
/// teleport proximity pairs — see GitHub issue #209 (generalizing the abstraction extracted in
/// #208). `InvalidTeleportGroupIssue`'s pre-#209 shape (a flat `pairs: Vec<(EdgeId, EdgeId)>` list)
/// is now expressed as the generic `groups: Vec<(Vec<EdgeId>, u32)>` shape instead, one two-element
/// group per pair, always paired with `to_remove = 1` (removing either side of the pair resolves
/// it). Never constructed — a zero-sized type used only at the type level.
pub struct TeleportGroupKind;

impl InvalidGroupIssueKind for TeleportGroupKind {
    type Element = EdgeId;
    const KIND: IssueKind = INVALID_TELEPORT_GROUP;
    const NESTED_KIND: IssueKind = INVALID_TELEPORT;
    const NESTED_SLOT_ID: &'static str = "fix_target";

    fn nested_issue(source_check: &str, element: EdgeId) -> Box<dyn Issue> {
        Box::new(InvalidTeleportIssue::new_from_check(source_check, vec![element]))
    }

    /// Mirrors `TeleportGroupSelectStrategy`'s pre-#209 `mark_removed` helper: every edge the
    /// nested strategy's commands actually removed, plus `target` itself, plus `target`'s
    /// opposite-direction `Teleport` counterpart (if any) read directly from `maze` — needed
    /// because `removed_edge_ids` only ever recognizes a `RemoveTeleportWithReverse` command's
    /// primary id, never the reverse id it also removed (GitHub issue #171's known gap). Without
    /// this, a group referencing only the reverse direction of a just-removed two-way teleport
    /// would never have its budget retired, and could still offer up a redundant (and by then
    /// no-op) fix for an edge that's already gone.
    fn resolved_elements<T: crate::space::Tessellation>(target: &EdgeId, nested_commands: &[MutationCommand], maze: &crate::Maze<T>) -> Vec<EdgeId> {
        let reverse = maze.graph.teleport_reverse(*target);
        removed_edge_ids(nested_commands).into_iter()
            .chain(std::iter::once(*target))
            .chain(reverse)
            .collect()
    }
}

/// Produced by any check that flags a pair of teleport edges as topologically too close to each
/// other (paired with `INVALID_TELEPORT_GROUP`) — currently only `TeleportGroupProximityCheck`,
/// see GitHub issue #75. Unlike `InvalidTeleportIssue`, neither edge in a flagged pair is
/// individually invalid — the problem is the relationship between the two, so each pair is
/// expressed as a two-element group (`to_remove = 1`: removing either side resolves it) rather
/// than a flat edge-id set.
///
/// GitHub issue #209: now a type alias onto the generic `InvalidGroupIssue<TeleportGroupKind>` —
/// see `group_issue.rs` for the extracted shape/merge logic (identical behavior, same wire shape
/// once resolved through `issue_payload::resolve_invalid_teleport_group_payload`).
pub type InvalidTeleportGroupIssue = InvalidGroupIssue<TeleportGroupKind>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::IssueMerge;

    #[test]
    fn merge_unions_disjoint_pairs() {
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
        assert!(a.groups.contains(&(vec![0, 1], 1)));
        assert!(a.groups.contains(&(vec![2, 3], 1)));
    }

    #[test]
    fn merge_attributes_each_pair_to_only_its_own_flagging_check() {
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&vec![0, 1]), Some(&vec!["rule_1:a".to_string()]));
        assert_eq!(a.invalid_sources.get(&vec![2, 3]), Some(&vec!["rule_1:b".to_string()]));
    }

    #[test]
    fn merge_deduplicates_identical_pair() {
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 1)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 1)], "the same pair flagged by both checks must not be duplicated");
    }

    #[test]
    fn merge_deduplicates_reversed_pair() {
        // (a, b) and (b, a) are the same pair (order carries no meaning) -- must collapse to one
        // entry, not be kept as two "different" pairs.
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:b", vec![(vec![1, 0], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 1, "(0,1) and (1,0) must collapse to a single unordered pair: {:?}", a.groups);
    }
}
