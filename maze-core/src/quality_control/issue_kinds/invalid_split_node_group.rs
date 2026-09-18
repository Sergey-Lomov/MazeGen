use crate::ids::NodeId;
use crate::quality_control::issue::{INVALID_SPLIT_NODE, INVALID_SPLIT_NODE_GROUP, IssueKind};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};

/// Marker type selecting the `InvalidGroupIssue<K>`/`group_select_apply` instantiation for
/// split-node-count groups — see GitHub issue #252, part of epic #246. A group's elements are
/// `NodeId`s — one split node each, mirroring `SplitNodeConnectionGroupKind`'s flat-element shape
/// (unlike `SplitGroupKind`, whose element is a whole tile's node list: here each candidate node is
/// resolved independently, since removing one excess node at a time is exactly what shrinks the
/// group toward its limit). Never constructed — a zero-sized type used only at the type level.
pub struct SplitNodeGroupKind;

impl InvalidGroupIssueKind for SplitNodeGroupKind {
    type Element = NodeId;
    const KIND: IssueKind = INVALID_SPLIT_NODE_GROUP;
    const NESTED_KIND: IssueKind = INVALID_SPLIT_NODE;
    const NESTED_SLOT_ID: &'static str = "fix_target";
}

/// Produced by `SplitTileNodeCountCheck` (paired with `INVALID_SPLIT_NODE_GROUP`) when a split
/// tile has more nodes than a configured limit — see GitHub issue #252, part of epic #246. No
/// individual node in a flagged group is invalid on its own; the problem is the tile's aggregate
/// node count, so each group is expressed as the generic `InvalidGroupIssue<K>` shape (`to_remove`
/// = excess count over the configured limit) rather than a flat node-id set.
///
/// Type alias onto the generic `InvalidGroupIssue<SplitNodeGroupKind>` — see `group_issue.rs` for
/// the shared shape/merge logic, same wire shape once resolved through the WASM payload layer.
pub type InvalidSplitNodeGroupIssue = InvalidGroupIssue<SplitNodeGroupKind>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::IssueMerge;

    #[test]
    fn merge_unions_disjoint_groups() {
        let mut a = InvalidSplitNodeGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidSplitNodeGroupIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
        assert!(a.groups.contains(&(vec![0, 1], 1)));
        assert!(a.groups.contains(&(vec![2, 3], 1)));
    }

    #[test]
    fn merge_keeps_the_larger_to_remove_for_the_same_group() {
        let mut a = InvalidSplitNodeGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidSplitNodeGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 3)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 3)]);
    }
}
