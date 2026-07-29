use crate::ids::EdgeId;
use crate::quality_control::issue::{IssueKind, INVALID_SPLIT_NODE_CONNECTION, INVALID_SPLIT_NODE_CONNECTION_GROUP};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};

/// Marker type selecting the `InvalidGroupIssue<K>`/`group_select_apply` instantiation for
/// split-node connection groups — see GitHub issue #251, part of epic #246. A group's elements
/// are `EdgeId`s — one edge (a single outgoing connection from a split node to an outside
/// neighbor) each, mirroring `OneWayGroupKind`/`TeleportGroupKind`'s flat-`EdgeId` shape. Never
/// constructed — a zero-sized type used only at the type level.
pub struct SplitNodeConnectionGroupKind;

impl InvalidGroupIssueKind for SplitNodeConnectionGroupKind {
    type Element = EdgeId;
    const KIND: IssueKind = INVALID_SPLIT_NODE_CONNECTION_GROUP;
    const NESTED_KIND: IssueKind = INVALID_SPLIT_NODE_CONNECTION;
    const NESTED_SLOT_ID: &'static str = "fix_target";
}

/// Produced by `SplitNodeConnectionPerNeighborCheck`/`SplitNodeConnectionPerFaceCheck` (paired
/// with `INVALID_SPLIT_NODE_CONNECTION_GROUP`) when a split tile's nodes collectively over-connect
/// to the outside world — see GitHub issue #251, part of epic #246. Neither individual connection
/// in a flagged group is invalid on its own; the problem is the aggregate (too many of them
/// converging on the same outside neighbor, or going out through the same tile face direction),
/// so each group is expressed as the generic `InvalidGroupIssue<K>` shape (`to_remove` = excess
/// count over the configured cap) rather than a flat edge-id set.
///
/// Type alias onto the generic `InvalidGroupIssue<SplitNodeConnectionGroupKind>` — see
/// `group_issue.rs` for the shared shape/merge logic, same wire shape once resolved through the
/// WASM payload layer.
pub type InvalidSplitNodeConnectionGroupIssue = InvalidGroupIssue<SplitNodeConnectionGroupKind>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::IssueMerge;

    #[test]
    fn merge_unions_disjoint_groups() {
        let mut a = InvalidSplitNodeConnectionGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidSplitNodeConnectionGroupIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
        assert!(a.groups.contains(&(vec![0, 1], 1)));
        assert!(a.groups.contains(&(vec![2, 3], 1)));
    }

    #[test]
    fn merge_keeps_the_larger_to_remove_for_the_same_group() {
        let mut a = InvalidSplitNodeConnectionGroupIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = InvalidSplitNodeConnectionGroupIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 3)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 3)]);
    }
}
