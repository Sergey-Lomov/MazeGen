use crate::ids::EdgeId;
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, TELEPORT_GROUP_PROXIMITY};

/// Produced by any check that flags a pair of teleport edges as topologically too close to each
/// other (paired with `TELEPORT_GROUP_PROXIMITY`) — currently only `TeleportGroupProximityCheck`,
/// see GitHub issue #75. Unlike `InvalidTeleportIssue`, neither edge in a `pairs` entry is
/// individually invalid — the problem is the relationship between the two, so this type carries
/// pair membership instead of a flat edge-id set. `pairs` holds every problematic pair found,
/// each as the two flagged `EdgeId`s — order carries no meaning, `(a, b)` and `(b, a)` are the
/// same pair. **Mandatory** for this kind, see `TeleportGroupProximityStrategy`, whose
/// `problematic` priority needs pair membership to score which teleport to remove.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TeleportGroupProximityIssue {
    meta: IssueMeta,
    pub pairs: Vec<(EdgeId, EdgeId)>,
}

impl TeleportGroupProximityIssue {
    pub fn new_from_check(source_check: &str, pairs: Vec<(EdgeId, EdgeId)>) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), pairs }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for TeleportGroupProximityIssue {
    const KIND: IssueKind = TELEPORT_GROUP_PROXIMITY;
}

impl IssueRequirement for TeleportGroupProximityIssue {
    type Requirement = ();
}

impl Issue for TeleportGroupProximityIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

impl IssueMerge for TeleportGroupProximityIssue {
    /// A pair's order carries no meaning — dedup by unordered identity so `(a, b)` and `(b, a)`
    /// from two different checks collapse to one entry instead of being kept as duplicates.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());

        use std::collections::HashSet;
        let mut seen: HashSet<(EdgeId, EdgeId)> = self.pairs.iter()
            .map(|&(a, b)| if a <= b { (a, b) } else { (b, a) })
            .collect();
        for (a, b) in other.pairs {
            let key = if a <= b { (a, b) } else { (b, a) };
            if seen.insert(key) {
                self.pairs.push((a, b));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_unions_disjoint_pairs() {
        let mut a = TeleportGroupProximityIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        let b = TeleportGroupProximityIssue::new_from_check("rule_1:b", vec![(2, 3)]);
        a.merge(b);

        assert_eq!(a.pairs.len(), 2);
        assert!(a.pairs.contains(&(0, 1)));
        assert!(a.pairs.contains(&(2, 3)));
    }

    #[test]
    fn merge_deduplicates_identical_pair() {
        let mut a = TeleportGroupProximityIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        let b = TeleportGroupProximityIssue::new_from_check("rule_1:b", vec![(0, 1)]);
        a.merge(b);

        assert_eq!(a.pairs, vec![(0, 1)], "the same pair flagged by both checks must not be duplicated");
    }

    #[test]
    fn merge_deduplicates_reversed_pair() {
        // (a, b) and (b, a) are the same pair (order carries no meaning) -- must collapse to one
        // entry, not be kept as two "different" pairs.
        let mut a = TeleportGroupProximityIssue::new_from_check("rule_1:a", vec![(0, 1)]);
        let b = TeleportGroupProximityIssue::new_from_check("rule_1:b", vec![(1, 0)]);
        a.merge(b);

        assert_eq!(a.pairs.len(), 1, "(0,1) and (1,0) must collapse to a single unordered pair: {:?}", a.pairs);
    }
}
