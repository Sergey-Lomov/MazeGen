use crate::ids::EdgeId;
use crate::quality_control::issue::{
    INVALID_VERTICAL_PASSAGE, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};
use std::collections::HashMap;

/// Produced by any check that flags a `VerticalPassage` edge invalid for a check-specific reason —
/// currently `VerticalPassageGroupGeometricProximityCheck`/`VerticalPassageGroupGraphProximityCheck`
/// — see GitHub issue #343. Mirrors `InvalidTeleportIssue`'s shape exactly: `invalid` holds the base-
/// `Graph` `EdgeId` of each flagged edge directly, a vertical passage is a single edge (not a cycle),
/// so there is no `all`/index-into-`all` indirection. **Mandatory** for this kind, see
/// `RemoveVerticalPassageStrategy`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidVerticalPassageIssue {
    meta: IssueMeta,
    pub invalid: Vec<EdgeId>,
    /// Per-edge check provenance, keyed directly by `EdgeId` — mirrors `InvalidTeleportIssue::invalid_sources`.
    pub invalid_sources: HashMap<EdgeId, Vec<String>>,
}

impl InvalidVerticalPassageIssue {
    pub fn new_from_check(source_check: &str, invalid: Vec<EdgeId>) -> Self {
        let invalid_sources = invalid
            .iter()
            .map(|&id| (id, vec![source_check.to_string()]))
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

impl IssueKindConst for InvalidVerticalPassageIssue {
    const KIND: IssueKind = INVALID_VERTICAL_PASSAGE;
}

impl IssueRequirement for InvalidVerticalPassageIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidVerticalPassageIssue);

impl IssueMerge for InvalidVerticalPassageIssue {
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        super::merge_id_sets(
            &mut self.invalid,
            &mut self.invalid_sources,
            other.invalid,
            other.invalid_sources,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_unions_disjoint_edge_ids() {
        let mut a = InvalidVerticalPassageIssue::new_from_check(
            "vertical_passage_group_geometric_proximity",
            vec![0],
        );
        let b = InvalidVerticalPassageIssue::new_from_check(
            "vertical_passage_group_graph_proximity",
            vec![1],
        );
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert!(a.invalid.contains(&0));
        assert!(a.invalid.contains(&1));
    }

    #[test]
    fn merge_deduplicates_shared_edge_id() {
        let mut a = InvalidVerticalPassageIssue::new_from_check(
            "vertical_passage_group_geometric_proximity",
            vec![0],
        );
        let b = InvalidVerticalPassageIssue::new_from_check(
            "vertical_passage_group_graph_proximity",
            vec![0],
        );
        a.merge(b);

        assert_eq!(
            a.invalid,
            vec![0],
            "the same edge id flagged by both checks must not be duplicated"
        );
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_edge() {
        let mut a = InvalidVerticalPassageIssue::new_from_check(
            "vertical_passage_group_geometric_proximity",
            vec![0],
        );
        let b = InvalidVerticalPassageIssue::new_from_check(
            "vertical_passage_group_graph_proximity",
            vec![0],
        );
        a.merge(b);

        let sources = a
            .invalid_sources
            .get(&0)
            .expect("merged edge must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"vertical_passage_group_geometric_proximity".to_string()));
        assert!(sources.contains(&"vertical_passage_group_graph_proximity".to_string()));
    }
}
