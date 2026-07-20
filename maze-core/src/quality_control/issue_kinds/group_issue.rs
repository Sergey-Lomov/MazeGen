use std::collections::HashMap;
use std::marker::PhantomData;
use crate::quality_control::issue::{Issue, IssueKind, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta};

/// What distinguishes one `InvalidGroupIssue<K>` instantiation from another — see GitHub issue
/// #208. `K` is a zero-sized marker type (never constructed), used only to give
/// `InvalidGroupIssue<K>`/`GroupSelectStrategy<K>` a distinct Rust type per semantic kind (e.g.
/// `OneWayGroupKind`), so `IssueKindConst::KIND` and the type system agree on which `IssueKind` a
/// given instantiation carries — the same guarantee every other concrete `Issue` type gets from
/// being its own struct.
///
/// `Element` is the type of one item inside a group — `EdgeId` for a group of edges (the shape
/// `InvalidOneWayGroupIssue` already used). `Element: Ord + Hash` is what `canonical_group_key`
/// (below) and `group_select_apply`'s own reverse candidate index need to produce a stable,
/// order-independent key from a group's contents and to index candidates by identity — for an
/// element type that itself needs canonicalizing before it's meaningfully comparable, the caller
/// constructing groups is responsible for canonicalizing each element before it enters a group.
///
/// GitHub issue #210: `nested_issue`/`resolved_elements` used to live here as trait methods, one
/// impl per `K`. Moved to `group_select_apply`'s own `build_nested_issue`/`element_invalidated`
/// closure parameters instead — building the nested `Issue` and deciding when a candidate is
/// invalidated is the calling *strategy*'s responsibility (it alone has the full picture: what
/// other candidates are still live, what the nested strategy's contract actually needs), not
/// something a marker type describing the issue's *shape* should own. `InvalidGroupIssueKind` is
/// now pure data: the element type and the nested dispatch target's identity.
pub trait InvalidGroupIssueKind: 'static {
    type Element: Clone + Ord + std::hash::Hash + std::fmt::Debug;

    const KIND: IssueKind;
    /// The `IssueKind` `group_select_apply`'s caller expects its nested strategy to handle.
    const NESTED_KIND: IssueKind;
    /// Slot id for the nested strategy the calling strategy delegates a single candidate's fix
    /// to — see `NestedSlot::slot_id`'s doc comment for why this is part of the strategy's public
    /// configuration API and must never be renamed casually once shipped.
    const NESTED_SLOT_ID: &'static str;
}

/// Canonical key for a group: its elements, sorted — mirrors `canonical_cycle_key`'s role for
/// cycles. Two groups covering the same element set (any order) produce the same key.
fn canonical_group_key<E: Clone + Ord>(group: &[E]) -> Vec<E> {
    let mut key = group.to_vec();
    key.sort_unstable();
    key
}

/// Generic reusable shape for "a group of elements paired with how many of them still need
/// fixing" — see GitHub issue #208. Extracted from `InvalidOneWayGroupIssue`/`OneWayGroup`, the
/// canonical instance of this shape (see that type's own doc comment, preserved verbatim below,
/// for the full rationale of what the paired `u32` means). `type InvalidOneWayGroupIssue =
/// InvalidGroupIssue<OneWayGroupKind>` is now a type alias onto this — same wire shape, same
/// behavior, just extracted so a future group-level issue kind (teleport/loop group — not
/// migrated here, see GitHub issue #208's scope note) can reuse it instead of reimplementing.
#[derive(Debug, Clone, PartialEq)]
pub struct InvalidGroupIssue<K: InvalidGroupIssueKind> {
    meta: IssueMeta,
    /// One flagged group, paired with how many of its elements still need fixing — distinct from
    /// the group's own element set: a group's *size* is "every element implicated in this
    /// problem", while the paired count is "how many of those actually need to be resolved before
    /// the problem is gone" (e.g. always 1 for a proximity pair, an excess count for a
    /// super-hub/maze-wide check). `GroupSelectStrategy<K>` reads this count to know how many
    /// elements to pull out of the group before considering it resolved, instead of assuming
    /// exactly one fix always clears a group.
    pub groups: Vec<(Vec<K::Element>, u32)>,
    /// Per-group check provenance, keyed by `canonical_group_key`.
    pub invalid_sources: HashMap<Vec<K::Element>, Vec<String>>,
    _marker: PhantomData<K>,
}

impl<K: InvalidGroupIssueKind> Default for InvalidGroupIssue<K> {
    fn default() -> Self {
        Self { meta: IssueMeta::default(), groups: Vec::new(), invalid_sources: HashMap::new(), _marker: PhantomData }
    }
}

impl<K: InvalidGroupIssueKind> InvalidGroupIssue<K> {
    pub fn new_from_check(source_check: &str, groups: Vec<(Vec<K::Element>, u32)>) -> Self {
        let invalid_sources = groups.iter()
            .map(|(g, _)| (canonical_group_key(g), vec![source_check.to_string()]))
            .collect();
        Self { meta: IssueMeta::new_from_check(source_check), groups, invalid_sources, _marker: PhantomData }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl<K: InvalidGroupIssueKind> IssueKindConst for InvalidGroupIssue<K> {
    const KIND: IssueKind = K::KIND;
}

impl<K: InvalidGroupIssueKind> IssueRequirement for InvalidGroupIssue<K> {
    type Requirement = ();
}

impl<K: InvalidGroupIssueKind> Issue for InvalidGroupIssue<K> {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
}

impl<K: InvalidGroupIssueKind> IssueMerge for InvalidGroupIssue<K> {
    /// A group's element order carries no meaning — dedup by unordered identity so two checks
    /// reporting the same element set (any order) collapse to one entry instead of being kept as
    /// duplicates. When both sides flag the same element set with different `to_remove` counts,
    /// the larger of the two wins (the more demanding requirement is the one that must actually be
    /// satisfied for the group to be considered resolved). `invalid_sources` is unioned per
    /// canonical group key regardless of which side's `to_remove` won — a check that didn't
    /// contribute the winning count is still a valid source for the group. Mirrors
    /// `InvalidOneWayGroupIssue::merge` exactly.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);

        let mut by_key: HashMap<Vec<K::Element>, usize> = self.groups.iter().enumerate()
            .map(|(i, (g, _))| (canonical_group_key(g), i))
            .collect();
        for (group, to_remove) in other.groups {
            let key = canonical_group_key(&group);
            match by_key.get(&key) {
                Some(&i) => {
                    if to_remove > self.groups[i].1 {
                        self.groups[i].1 = to_remove;
                    }
                }
                None => {
                    by_key.insert(key, self.groups.len());
                    self.groups.push((group, to_remove));
                }
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
    use crate::ids::EdgeId;
    use crate::quality_control::issue::INVALID_ONE_WAY_GROUP;

    struct TestGroupKind;
    impl InvalidGroupIssueKind for TestGroupKind {
        type Element = EdgeId;
        const KIND: IssueKind = INVALID_ONE_WAY_GROUP;
        const NESTED_KIND: IssueKind = crate::quality_control::issue::INVALID_ONE_WAY;
        const NESTED_SLOT_ID: &'static str = "test_fix_target";
    }
    type TestIssue = InvalidGroupIssue<TestGroupKind>;

    #[test]
    fn merge_unions_disjoint_groups() {
        let mut a = TestIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = TestIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
        assert!(a.groups.contains(&(vec![0, 1], 1)));
        assert!(a.groups.contains(&(vec![2, 3], 1)));
    }

    #[test]
    fn merge_deduplicates_identical_group() {
        let mut a = TestIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = TestIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 1)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 1)], "the same group flagged by both checks must not be duplicated");
    }

    #[test]
    fn merge_deduplicates_group_regardless_of_element_order() {
        let mut a = TestIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = TestIssue::new_from_check("rule_1:b", vec![(vec![1, 0], 1)]);
        a.merge(b);

        assert_eq!(a.groups.len(), 1, "(0,1) and (1,0) must collapse to a single group: {:?}", a.groups);
    }

    #[test]
    fn merge_keeps_the_larger_to_remove_for_the_same_group() {
        let mut a = TestIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = TestIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 3)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 3)], "the larger to_remove must win");
    }

    #[test]
    fn merge_keeps_the_larger_to_remove_regardless_of_merge_direction() {
        let mut a = TestIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 3)]);
        let b = TestIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 1)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 3)], "the larger to_remove must win regardless of which side already had it");
    }

    #[test]
    fn merge_attributes_each_group_to_only_its_own_flagging_check() {
        let mut a = TestIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = TestIssue::new_from_check("rule_1:b", vec![(vec![2, 3], 1)]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&vec![0, 1]), Some(&vec!["rule_1:a".to_string()]));
        assert_eq!(a.invalid_sources.get(&vec![2, 3]), Some(&vec!["rule_1:b".to_string()]));
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_group() {
        let mut a = TestIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 1)]);
        let b = TestIssue::new_from_check("rule_1:b", vec![(vec![1, 0], 2)]);
        a.merge(b);

        let sources = a.invalid_sources.get(&vec![0, 1]).expect("merged group must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"rule_1:a".to_string()));
        assert!(sources.contains(&"rule_1:b".to_string()));
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_even_when_one_side_does_not_win_to_remove() {
        let mut a = TestIssue::new_from_check("rule_1:a", vec![(vec![0, 1], 5)]);
        let b = TestIssue::new_from_check("rule_1:b", vec![(vec![0, 1], 1)]);
        a.merge(b);

        assert_eq!(a.groups, vec![(vec![0, 1], 5)]);
        let sources = a.invalid_sources.get(&vec![0, 1]).expect("merged group must have recorded sources");
        assert!(sources.contains(&"rule_1:a".to_string()));
        assert!(sources.contains(&"rule_1:b".to_string()));
    }
}
