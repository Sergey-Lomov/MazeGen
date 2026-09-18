use std::collections::HashMap;

use crate::ids::NodeId;
use crate::quality_control::cross_element::CrossElement;
use crate::quality_control::issue::{
    INVALID_CROSS_ELEMENT_GROUP, INVALID_TELEPORT, Issue, IssueKind, IssueKindConst, IssueMerge,
    IssueMeta, IssueRequirement,
};
use crate::quality_control::issue_kinds::group_issue::{InvalidGroupIssue, InvalidGroupIssueKind};

/// Marker type selecting the `InvalidGroupIssue<K>` instantiation for cross-element proximity
/// groups — see GitHub issue #376. `Element` is a whole logical [`CrossElement`] (a teleport
/// portal, an elevator, a split tile, ...), so one group is one too-close logical pair and
/// resolving either element of the pair clears it.
///
/// Unlike the single-type group kinds (`OneWayGroupKind`, `SplitGroupKind`, ...), this kind is
/// **not** repaired through `group_select_apply` — `CrossElementGroupSelectStrategy` has one
/// nested slot per element type and runs its own `multi_target_group_select_apply` engine. The
/// `NESTED_KIND`/`NESTED_SLOT_ID` consts on `InvalidGroupIssueKind` are vestigial (unread anywhere
/// in the codebase); they are filled with arbitrary placeholder values here and never consulted.
#[derive(Debug, Clone, PartialEq)]
pub struct CrossElementGroupKind;

impl InvalidGroupIssueKind for CrossElementGroupKind {
    type Element = CrossElement;
    const KIND: IssueKind = INVALID_CROSS_ELEMENT_GROUP;
    // Unread placeholders — see the doc comment above.
    const NESTED_KIND: IssueKind = INVALID_TELEPORT;
    const NESTED_SLOT_ID: &'static str = "unused";
}

/// The specific occurrence nodes of one flagged pair's two elements that actually fell within the
/// proximity threshold — GitHub issue #376's "highlight only the problematic markers" (points 4/5
/// of the follow-up). A teleport contributes two ends, an elevator N stops, a vertical passage two
/// floors; only some of those are close to the other element of the pair. The proximity scan
/// records exactly which occurrence nodes were within range, per element, so the payload resolver
/// can narrow each entry's highlight geometry to just those nodes instead of lighting up every
/// endpoint of both elements.
///
/// Keyed by canonical group key (the pair's two elements, sorted + deduped — mirrors
/// `InvalidGroupIssue`'s own `canonical_group_key`), then by the element the nodes belong to. An
/// element absent from the inner map (or with an empty node list) means "no narrowing information;
/// highlight the whole element", which is the correct fallback for single-location elements
/// (one-way, single-node split, start, finish) that carry no occurrence ambiguity.
pub type CrossElementCloseNodes = HashMap<Vec<CrossElement>, HashMap<CrossElement, Vec<NodeId>>>;

/// Produced by `CrossElementGeometricProximityCheck` / `CrossElementGraphProximityCheck` — see
/// GitHub issue #376. One group per too-close unordered pair of logical elements, `to_remove: 1`
/// (removing either element breaks the pair). A pair whose two elements are both unremovable
/// (`[Start, Finish]`, or both route-protected) still produces a group; the repair strategy then
/// reports `Failed` for it and the issue survives.
///
/// Wraps the generic `InvalidGroupIssue<CrossElementGroupKind>` shape (`groups` / `invalid_sources`
/// / `meta` / merge logic — see `group_issue.rs`) and adds `close_nodes`: the per-element
/// occurrence nodes that were actually within the proximity threshold, so the payload resolver can
/// highlight only the problematic markers (GitHub issue #376's follow-up points 4/5). The repair
/// strategy reads only `groups` / `invalid_sources` and is unaffected by `close_nodes`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidCrossElementGroupIssue {
    inner: InvalidGroupIssue<CrossElementGroupKind>,
    /// See [`CrossElementCloseNodes`]. Unioned per canonical group key on merge.
    pub close_nodes: CrossElementCloseNodes,
}

impl InvalidCrossElementGroupIssue {
    /// Mirrors `InvalidGroupIssue::new_from_check` plus the per-element close-node map (see
    /// [`CrossElementCloseNodes`]). `close_nodes`'s keys must already be canonical group keys.
    pub fn new_from_check(
        source_check: &str,
        groups: Vec<(Vec<CrossElement>, u32)>,
        close_nodes: CrossElementCloseNodes,
    ) -> Self {
        Self {
            inner: InvalidGroupIssue::new_from_check(source_check, groups),
            close_nodes,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.inner = self.inner.with_detail(source_check, key, value);
        self
    }

    /// The flagged groups — one `(pair, to_remove)` per too-close logical pair. Delegates to the
    /// wrapped `InvalidGroupIssue`.
    pub fn groups(&self) -> &Vec<(Vec<CrossElement>, u32)> {
        &self.inner.groups
    }

    /// Per-group check provenance, keyed by canonical group key. Delegates to the wrapped
    /// `InvalidGroupIssue`.
    pub fn invalid_sources(&self) -> &HashMap<Vec<CrossElement>, Vec<String>> {
        &self.inner.invalid_sources
    }
}

impl IssueKindConst for InvalidCrossElementGroupIssue {
    const KIND: IssueKind = INVALID_CROSS_ELEMENT_GROUP;
}

impl IssueRequirement for InvalidCrossElementGroupIssue {
    type Requirement = ();
}

impl Issue for InvalidCrossElementGroupIssue {
    fn kind(&self) -> IssueKind {
        Self::KIND
    }
    fn meta(&self) -> &IssueMeta {
        self.inner.meta()
    }
    fn meta_mut(&mut self) -> &mut IssueMeta {
        self.inner.meta_mut()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl IssueMerge for InvalidCrossElementGroupIssue {
    /// Merges the wrapped `InvalidGroupIssue` (groups / invalid_sources / meta) exactly as
    /// before, then unions `close_nodes` per canonical group key: for a pair flagged by both
    /// sides, the two elements' close-node lists are combined (deduped), so the highlight covers
    /// every occurrence either check found within range.
    fn merge(&mut self, other: Self) {
        self.inner.merge(other.inner);
        for (key, per_element) in other.close_nodes {
            let entry = self.close_nodes.entry(key).or_default();
            for (element, nodes) in per_element {
                let slot = entry.entry(element).or_default();
                for node in nodes {
                    if !slot.contains(&node) {
                        slot.push(node);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::issue::IssueMerge;

    fn teleport(a: u64, b: u64) -> CrossElement {
        CrossElement::Teleport((a.min(b), a.max(b)))
    }
    fn one_way(id: usize) -> CrossElement {
        CrossElement::OneWay(id)
    }

    fn issue(source: &str, pair: Vec<CrossElement>) -> InvalidCrossElementGroupIssue {
        InvalidCrossElementGroupIssue::new_from_check(source, vec![(pair, 1)], HashMap::new())
    }

    #[test]
    fn merge_unions_independent_pairs() {
        let mut a = issue("rule_1:a", vec![teleport(0, 1), one_way(2)]);
        let b = issue("rule_1:b", vec![one_way(3), CrossElement::Start(4)]);
        a.merge(b);
        assert_eq!(a.groups().len(), 2);
    }

    #[test]
    fn merge_deduplicates_the_same_pair_from_two_instances_regardless_of_order() {
        let mut a = issue("rule_1:a", vec![teleport(0, 1), one_way(2)]);
        let b = issue("rule_2:b", vec![one_way(2), teleport(0, 1)]);
        a.merge(b);
        assert_eq!(
            a.groups().len(),
            1,
            "same logical pair from two instances collapses to one group"
        );
        let sources = a
            .invalid_sources()
            .values()
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        assert!(sources.contains(&"rule_1:a".to_string()));
        assert!(sources.contains(&"rule_2:b".to_string()));
    }

    #[test]
    fn merge_keeps_overlapping_pairs_as_distinct_groups() {
        // (A,B) and (B,C) share B but are different pairs -- both kept.
        let mut a = issue("rule_1:a", vec![teleport(0, 1), one_way(2)]);
        let b = issue("rule_1:b", vec![one_way(2), one_way(5)]);
        a.merge(b);
        assert_eq!(a.groups().len(), 2);
    }

    #[test]
    fn merge_unions_close_nodes_per_canonical_key() {
        let pair = vec![teleport(0, 1), one_way(2)];
        let mut key = pair.clone();
        key.sort_unstable();
        key.dedup();

        let mut close_a = HashMap::new();
        close_a.insert(key.clone(), HashMap::from([(teleport(0, 1), vec![0])]));
        let mut a = InvalidCrossElementGroupIssue::new_from_check(
            "rule_1:a",
            vec![(pair.clone(), 1)],
            close_a,
        );

        let mut close_b = HashMap::new();
        close_b.insert(
            key.clone(),
            HashMap::from([(teleport(0, 1), vec![1]), (one_way(2), vec![7])]),
        );
        let b = InvalidCrossElementGroupIssue::new_from_check(
            "rule_1:b",
            vec![(pair.clone(), 1)],
            close_b,
        );

        a.merge(b);
        let merged = &a.close_nodes[&key];
        let mut tp_nodes = merged[&teleport(0, 1)].clone();
        tp_nodes.sort_unstable();
        assert_eq!(
            tp_nodes,
            vec![0, 1],
            "both ends the two checks found are kept"
        );
        assert_eq!(merged[&one_way(2)], vec![7]);
    }
}
