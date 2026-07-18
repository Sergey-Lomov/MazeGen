use std::collections::HashMap;
use crate::ids::EdgeId;
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_TELEPORT_GROUP};

/// Canonical key for a pair: order carries no meaning, so `(a, b)` and `(b, a)` must produce the
/// same key — mirrors `invalid_loop::canonical_cycle_key`'s role for cycles.
fn canonical_pair_key(a: EdgeId, b: EdgeId) -> (EdgeId, EdgeId) {
    if a <= b { (a, b) } else { (b, a) }
}

/// Produced by any check that flags a pair of teleport edges as topologically too close to each
/// other (paired with `INVALID_TELEPORT_GROUP`) — currently only `TeleportGroupProximityCheck`,
/// see GitHub issue #75. Unlike `InvalidTeleportIssue`, neither edge in a `pairs` entry is
/// individually invalid — the problem is the relationship between the two, so this type carries
/// pair membership instead of a flat edge-id set. `pairs` holds every problematic pair found,
/// each as the two flagged `EdgeId`s — order carries no meaning, `(a, b)` and `(b, a)` are the
/// same pair. **Mandatory** for this kind, see `TeleportGroupProximityStrategy`, whose
/// `problematic` priority needs pair membership to score which teleport to remove.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidTeleportGroupIssue {
    meta: IssueMeta,
    pub pairs: Vec<(EdgeId, EdgeId)>,
    /// Per-pair check provenance, keyed by `canonical_pair_key` (not raw `(a, b)` order) — no
    /// remap needed across merges, an `EdgeId` pair is already stable identity. Built
    /// automatically in `new_from_check` from `pairs` (every flagged pair is attributed to that
    /// single constructing check, per the pre-merge "exactly one source" invariant `IssueMeta`
    /// documents), then unioned per pair in `merge` — mirrors `InvalidTeleportIssue`'s
    /// `invalid_sources`, see GitHub issue #195's follow-up.
    pub invalid_sources: HashMap<(EdgeId, EdgeId), Vec<String>>,
}

impl InvalidTeleportGroupIssue {
    pub fn new_from_check(source_check: &str, pairs: Vec<(EdgeId, EdgeId)>) -> Self {
        let invalid_sources = pairs.iter().map(|&(a, b)| (canonical_pair_key(a, b), vec![source_check.to_string()])).collect();
        Self { meta: IssueMeta::new_from_check(source_check), pairs, invalid_sources }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidTeleportGroupIssue {
    const KIND: IssueKind = INVALID_TELEPORT_GROUP;
}

impl IssueRequirement for InvalidTeleportGroupIssue {
    type Requirement = ();
}

impl Issue for InvalidTeleportGroupIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
}

impl IssueMerge for InvalidTeleportGroupIssue {
    /// A pair's order carries no meaning — dedup by unordered identity so `(a, b)` and `(b, a)`
    /// from two different checks collapse to one entry instead of being kept as duplicates.
    /// `invalid_sources` is unioned per canonical pair key, deduplicating per-check-id within
    /// each pair's source list, mirroring `InvalidTeleportIssue`'s `invalid_sources` merge.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());

        use std::collections::HashSet;
        let mut seen: HashSet<(EdgeId, EdgeId)> = self.pairs.iter()
            .map(|&(a, b)| canonical_pair_key(a, b))
            .collect();
        for (a, b) in other.pairs {
            let key = canonical_pair_key(a, b);
            if seen.insert(key) {
                self.pairs.push((a, b));
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

    #[test]
    fn merge_unions_disjoint_pairs() {
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:b", vec![(2, 3)]);
        a.merge(b);

        assert_eq!(a.pairs.len(), 2);
        assert!(a.pairs.contains(&(0, 1)));
        assert!(a.pairs.contains(&(2, 3)));
    }

    #[test]
    fn merge_attributes_each_pair_to_only_its_own_flagging_check() {
        // GitHub issue #195's follow-up: pair (0,1) was flagged only by rule_1:a, pair (2,3) only
        // by rule_1:b -- after merge, each pair's invalid_sources entry must list only the check
        // that actually flagged it, not both.
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:b", vec![(2, 3)]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&(0, 1)), Some(&vec!["rule_1:a".to_string()]));
        assert_eq!(a.invalid_sources.get(&(2, 3)), Some(&vec!["rule_1:b".to_string()]));
    }

    #[test]
    fn merge_invalid_sources_no_duplicate_for_repeated_check_on_same_pair() {
        // Same check id, same pair, flagged in two separate merged issues -- the dedup guard
        // (`if !entry.contains`) must skip the second push instead of recording the source twice.
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&(0, 1)), Some(&vec!["rule_1:a".to_string()]));
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_pair_regardless_of_order() {
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:b", vec![(1, 0)]);
        a.merge(b);

        let sources = a.invalid_sources.get(&(0, 1)).expect("merged pair must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"rule_1:a".to_string()));
        assert!(sources.contains(&"rule_1:b".to_string()));
    }

    #[test]
    fn merge_deduplicates_identical_pair() {
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:b", vec![(0, 1)]);
        a.merge(b);

        assert_eq!(a.pairs, vec![(0, 1)], "the same pair flagged by both checks must not be duplicated");
    }

    #[test]
    fn merge_deduplicates_reversed_pair() {
        // (a, b) and (b, a) are the same pair (order carries no meaning) -- must collapse to one
        // entry, not be kept as two "different" pairs.
        let mut a = InvalidTeleportGroupIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        let b = InvalidTeleportGroupIssue::new_from_check("rule_1:b", vec![(1, 0)]);
        a.merge(b);

        assert_eq!(a.pairs.len(), 1, "(0,1) and (1,0) must collapse to a single unordered pair: {:?}", a.pairs);
    }
}
