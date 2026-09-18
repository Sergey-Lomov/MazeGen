use crate::quality_control::issue::{
    INVALID_SPLIT_TILE, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};
use crate::quality_control::issue_kinds::SplitTileNodes;
use std::collections::HashMap;

/// Produced by any check that flags a whole split tile (its full node list, slot-0 included —
/// see the epic #246 doc comment: slot-0 is an equal member of the tile for every purpose except
/// the removal step itself) invalid for a check-specific reason — currently
/// `SplitDistanceFromWaypointCheck`. `invalid` holds one `SplitTileNodes` per flagged tile —
/// mirrors `InvalidSplitTileGroupIssue`'s candidate unit (GitHub issue #249) at the single-tile
/// level too (GitHub issue #260): a "split tile" is the natural entity here, not any one of its
/// individual nodes. **Mandatory** for this kind, see `RemoveSplitStrategy`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidSplitTileIssue {
    meta: IssueMeta,
    pub invalid: Vec<SplitTileNodes>,
    /// Per-tile check provenance, keyed by the tile's own `SplitTileNodes` (canonicalized, so two
    /// checks flagging the same tile in any node order attribute to the same key) — same
    /// clone-based-key rationale as `InvalidGroupIssue::invalid_sources`.
    pub invalid_sources: HashMap<SplitTileNodes, Vec<String>>,
}

impl InvalidSplitTileIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<SplitTileNodes>) -> Self {
        let invalid_sources = invalid
            .iter()
            .map(|tile| (tile.clone(), vec![source_check.to_string()]))
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

impl IssueKindConst for InvalidSplitTileIssue {
    const KIND: IssueKind = INVALID_SPLIT_TILE;
}

impl IssueRequirement for InvalidSplitTileIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidSplitTileIssue);

impl IssueMerge for InvalidSplitTileIssue {
    /// `SplitTileNodes` isn't `Copy` (it wraps a `Vec`), so this can't reuse `merge_id_sets` —
    /// dedup-union by clone, mirroring `InvalidGroupIssue::merge`'s own clone-based-key approach.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);

        let mut seen: std::collections::HashSet<SplitTileNodes> =
            self.invalid.iter().cloned().collect();
        for tile in other.invalid {
            if seen.insert(tile.clone()) {
                self.invalid.push(tile);
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

    fn tile(nodes: Vec<crate::ids::NodeId>) -> SplitTileNodes {
        SplitTileNodes::new(nodes)
    }

    #[test]
    fn merge_unions_disjoint_tiles() {
        let mut a = InvalidSplitTileIssue::new_from_check(
            "split_distance_from_waypoint_a",
            vec![tile(vec![0])],
        );
        let b = InvalidSplitTileIssue::new_from_check(
            "split_distance_from_waypoint_b",
            vec![tile(vec![1])],
        );
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&tile(vec![0])));
        assert!(a.invalid.contains(&tile(vec![1])));
    }

    #[test]
    fn merge_attributes_each_tile_to_only_its_own_flagging_check() {
        let mut a = InvalidSplitTileIssue::new_from_check(
            "split_distance_from_waypoint_a",
            vec![tile(vec![0])],
        );
        let b = InvalidSplitTileIssue::new_from_check(
            "split_distance_from_waypoint_b",
            vec![tile(vec![1])],
        );
        a.merge(b);

        assert_eq!(
            a.invalid_sources.get(&tile(vec![0])),
            Some(&vec!["split_distance_from_waypoint_a".to_string()])
        );
        assert_eq!(
            a.invalid_sources.get(&tile(vec![1])),
            Some(&vec!["split_distance_from_waypoint_b".to_string()])
        );
    }

    #[test]
    fn merge_deduplicates_shared_tile() {
        let mut a = InvalidSplitTileIssue::new_from_check(
            "split_distance_from_waypoint_a",
            vec![tile(vec![0])],
        );
        let b = InvalidSplitTileIssue::new_from_check(
            "split_distance_from_waypoint_b",
            vec![tile(vec![0])],
        );
        a.merge(b);

        assert_eq!(
            a.invalid,
            vec![tile(vec![0])],
            "the same tile flagged by both checks must not be duplicated"
        );
    }
}
