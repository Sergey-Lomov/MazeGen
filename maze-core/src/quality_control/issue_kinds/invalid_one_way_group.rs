use std::collections::HashMap;
use crate::ids::EdgeId;
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_ONE_WAY_GROUP};

/// Canonical key for a group: its edge set, sorted — mirrors `canonical_cycle_key`'s role for
/// cycles. Two groups covering the same edge set (any order) produce the same key.
fn canonical_group_key(group: &[EdgeId]) -> Vec<EdgeId> {
    let mut key = group.to_vec();
    key.sort_unstable();
    key
}

/// Produced by any check that flags a set of one-way edges (`EdgeKind::Basic`, single direction)
/// placed too close to each other — see GitHub issue #199. Distinct from `INVALID_ONE_WAY`:
/// that kind flags a single one-way edge invalid on its own; this one flags a *relationship*
/// between two or more one-way edges, none of which is individually invalid. Mirrors
/// `InvalidTeleportGroupIssue`'s role for teleports, but shaped as `groups: Vec<Vec<EdgeId>>`
/// (not a flat pair list) so a repair strategy can uniformly handle any group size — currently
/// every producing check only ever emits 2-element groups (one problematic pair per scanned
/// edge, same "stop at the first hit" rule `TeleportGroupProximityCheck` uses), but the strategy
/// itself makes no such assumption. **Mandatory** for this kind: `OneWayGroupSelectStrategy`'s
/// `problematic` priority needs group membership to score which edge to pick.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidOneWayGroupIssue {
    meta: IssueMeta,
    pub groups: Vec<Vec<EdgeId>>,
    /// Per-group check provenance, keyed by `canonical_group_key` — mirrors
    /// `InvalidTeleportGroupIssue::invalid_sources`.
    pub invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
}

impl InvalidOneWayGroupIssue {
    pub fn new_from_check(source_check: &str, groups: Vec<Vec<EdgeId>>) -> Self {
        let invalid_sources = groups.iter().map(|g| (canonical_group_key(g), vec![source_check.to_string()])).collect();
        Self { meta: IssueMeta::new_from_check(source_check), groups, invalid_sources }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidOneWayGroupIssue {
    const KIND: IssueKind = INVALID_ONE_WAY_GROUP;
}

impl IssueRequirement for InvalidOneWayGroupIssue {
    type Requirement = ();
}

impl Issue for InvalidOneWayGroupIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
}

impl IssueMerge for InvalidOneWayGroupIssue {
    /// A group's edge order carries no meaning — dedup by unordered identity so two checks
    /// reporting the same edge set (any order) collapse to one entry instead of being kept as
    /// duplicates. `invalid_sources` is unioned per canonical group key, mirroring
    /// `InvalidTeleportGroupIssue`'s merge.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());

        use std::collections::HashSet;
        let mut seen: HashSet<Vec<EdgeId>> = self.groups.iter().map(|g| canonical_group_key(g)).collect();
        for group in other.groups {
            let key = canonical_group_key(&group);
            if seen.insert(key) {
                self.groups.push(group);
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
    fn merge_unions_disjoint_groups() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![vec![0, 1]]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![vec![2, 3]]);
        a.merge(b);

        assert_eq!(a.groups.len(), 2);
        assert!(a.groups.contains(&vec![0, 1]));
        assert!(a.groups.contains(&vec![2, 3]));
    }

    #[test]
    fn merge_deduplicates_identical_group() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![vec![0, 1]]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![vec![0, 1]]);
        a.merge(b);

        assert_eq!(a.groups, vec![vec![0, 1]], "the same group flagged by both checks must not be duplicated");
    }

    #[test]
    fn merge_deduplicates_group_regardless_of_edge_order() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![vec![0, 1]]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![vec![1, 0]]);
        a.merge(b);

        assert_eq!(a.groups.len(), 1, "(0,1) and (1,0) must collapse to a single group: {:?}", a.groups);
    }

    #[test]
    fn merge_attributes_each_group_to_only_its_own_flagging_check() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![vec![0, 1]]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![vec![2, 3]]);
        a.merge(b);

        assert_eq!(a.invalid_sources.get(&vec![0, 1]), Some(&vec!["rule_1:a".to_string()]));
        assert_eq!(a.invalid_sources.get(&vec![2, 3]), Some(&vec!["rule_1:b".to_string()]));
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_group() {
        let mut a = InvalidOneWayGroupIssue::new_from_check("rule_1:a", vec![vec![0, 1]]);
        let b = InvalidOneWayGroupIssue::new_from_check("rule_1:b", vec![vec![1, 0]]);
        a.merge(b);

        let sources = a.invalid_sources.get(&vec![0, 1]).expect("merged group must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"rule_1:a".to_string()));
        assert!(sources.contains(&"rule_1:b".to_string()));
    }
}
