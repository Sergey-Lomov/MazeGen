use crate::ids::NodeId;
use crate::quality_control::issue::{INVALID_SPLIT_TILE, INVALID_SPLIT_TILE_GROUP, IssueKind};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};

/// One split tile's full node list — slot-0 included, see the epic #246 doc comment: slot-0 is
/// an equal member of the tile for every purpose (issue #281: including removal-eligibility —
/// only a tile's *last remaining node*, whichever one that happens to be, is ever protected) — as
/// a single `InvalidGroupIssueKind::Element` unit. See GitHub issue #249's regression: a flat
/// `Vec<NodeId>` group mixing several tiles' nodes together let `group_select_apply`'s
/// per-element candidate pass pick nodes from *different* tiles independently, instead of
/// resolving one whole tile at a time. Wrapping each tile's node list in its own `SplitTileNodes`
/// makes the tile the candidate unit: `group_select_apply` picks one `SplitTileNodes` (i.e. one
/// tile) per fix, and the nested `RemoveSplitStrategy` call collapses the whole tile into one
/// surviving node via a single `MutationCommand::ReplacePointNodes`.
///
/// Canonicalized (sorted) on construction so two `SplitTileNodes` built from the same node set in
/// different orders compare/hash equal — required for `Ord`/`Hash` (`canonical_group_key`'s own
/// element-level dedup) the same way `canonical_group_key` itself sorts a group's element list.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SplitTileNodes(pub Vec<NodeId>);

impl SplitTileNodes {
    pub fn new(mut nodes: Vec<NodeId>) -> Self {
        nodes.sort_unstable();
        Self(nodes)
    }
}

/// Marker type selecting the `InvalidGroupIssue<K>`/`GroupSelectStrategy<K>` instantiation for
/// split-tile groups — see GitHub issue #249, mirroring `OneWayGroupKind`'s role. A group's
/// elements are `SplitTileNodes` (one whole tile's full node list each, slot-0 included) — a
/// group-level check flagging a tile puts *every* node of that tile into one `SplitTileNodes`, so
/// resolving one `SplitTileNodes` candidate collapses that tile entirely (every removable node in
/// it), never just some of its nodes.
pub struct SplitGroupKind;

impl InvalidGroupIssueKind for SplitGroupKind {
    type Element = SplitTileNodes;
    const KIND: IssueKind = INVALID_SPLIT_TILE_GROUP;
    const NESTED_KIND: IssueKind = INVALID_SPLIT_TILE;
    const NESTED_SLOT_ID: &'static str = "fix_target";
}

/// Produced by any check that flags a set of split tiles as jointly invalid — see GitHub issue
/// #249. Distinct from `INVALID_SPLIT_TILE`: that kind flags a single tile invalid on its own
/// (too close/far from a waypoint); this one flags a *relationship*/*aggregate* condition over
/// the field's split tiles as a whole (excess count, excess density, or a too-close pair of
/// tiles), none of which is individually invalid. Mirrors `InvalidOneWayGroupIssue`'s role.
///
/// Shaped as `groups: Vec<(Vec<SplitTileNodes>, u32)>` (the generic `InvalidGroupIssue<K>` shape)
/// so a repair strategy handles any group size uniformly: a proximity pair puts both tiles (one
/// `SplitTileNodes` each) into one group with `to_remove` equal to the number of *tiles* that
/// need collapsing (resolving either side breaks the pair); a count/density excess puts every
/// split tile on the field into a single group with `to_remove` equal to the excess tile count.
/// **`to_remove` counts tiles, not individual extra nodes** — this is the fix from GitHub issue
/// #249's regression, where it used to count nodes against a flat node-level candidate pass.
pub type InvalidSplitTileGroupIssue = InvalidGroupIssue<SplitGroupKind>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::IssueMerge;

    fn tile(nodes: Vec<NodeId>) -> SplitTileNodes {
        SplitTileNodes::new(nodes)
    }

    #[test]
    fn merge_unions_disjoint_groups() {
        let mut a = InvalidSplitTileGroupIssue::new_from_check(
            "rule_1:a",
            vec![(vec![tile(vec![0, 1])], 1)],
        );
        let b =
            InvalidSplitTileGroupIssue::new_from_check("rule_1:b", vec![(vec![tile(vec![2])], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
        assert!(a.groups.contains(&(vec![tile(vec![0, 1])], 1)));
        assert!(a.groups.contains(&(vec![tile(vec![2])], 1)));
    }

    #[test]
    fn merge_keeps_the_larger_to_remove_for_the_same_group() {
        let mut a = InvalidSplitTileGroupIssue::new_from_check(
            "rule_1:a",
            vec![(vec![tile(vec![0, 1])], 1)],
        );
        let b = InvalidSplitTileGroupIssue::new_from_check(
            "rule_1:b",
            vec![(vec![tile(vec![0, 1])], 2)],
        );
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![tile(vec![0, 1])], 2)]);
    }

    #[test]
    fn split_tile_nodes_canonicalizes_regardless_of_input_order() {
        assert_eq!(
            SplitTileNodes::new(vec![2, 1]),
            SplitTileNodes::new(vec![1, 2])
        );
    }
}
