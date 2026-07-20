use std::collections::HashMap;
use crate::graph::region_class::RegionClass;
use crate::quality_control::issue::{IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, MISSING_REGIONS};

/// Produced by `MinRegionCountCheck` (paired with `MISSING_REGIONS`) — carries the region balance
/// per `RegionClass` (`Specs/repair.md`'s "Region Balance" data model): `-N` means the maze is
/// short N regions of that class against its configured minimum (a repair strategy must
/// create/convert regions into it), `+N` means the class has N regions *above* its minimum, a
/// spendable surplus a repair strategy may consume (reuse or grow-through) when fixing a
/// different class's shortfall. A class sitting exactly at its minimum, or with no minimum
/// configured, carries no entry at all (not a `0` entry) — absence means "nothing to fix, nothing
/// to spend" for that class.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MissingRegionsIssue {
    meta: IssueMeta,
    pub balance_by_class: HashMap<RegionClass, i32>,
}

impl MissingRegionsIssue {
    pub fn new_from_check(source_check: &str, balance_by_class: HashMap<RegionClass, i32>) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), balance_by_class }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for MissingRegionsIssue {
    const KIND: IssueKind = MISSING_REGIONS;
}

impl IssueRequirement for MissingRegionsIssue {
    type Requirement = ();
}

crate::impl_issue!(MissingRegionsIssue);

impl IssueMerge for MissingRegionsIssue {
    /// A single `MinRegionCountCheck` instance now reports every off-target class's balance in
    /// one issue, so this merge rarely runs in practice, but stays defined for the rare case of
    /// two instances active at once. Two entries for the same class take the plain `min`: between
    /// two shortfalls (`-N`) that's the larger shortfall (more negative); between a shortfall and
    /// a surplus (`+N`) the shortfall always wins ("must add" is a hard requirement, "has spare"
    /// is merely opportunistic); between two surpluses that's the smaller surplus (the safer,
    /// less optimistic spendable amount).
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);

        for (class, balance) in other.balance_by_class {
            self.balance_by_class.entry(class)
                .and_modify(|b| *b = (*b).min(balance))
                .or_insert(balance);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(source_check: &str, class: RegionClass, balance: i32) -> MissingRegionsIssue {
        MissingRegionsIssue::new_from_check(source_check, HashMap::from([(class, balance)]))
    }

    #[test]
    fn merge_unions_different_classes() {
        let mut a = issue("min_region_count_1", RegionClass::Trap, -2);
        let b = issue("min_region_count_2", RegionClass::Alternative, 1);
        a.merge(b);

        assert_eq!(a.balance_by_class, HashMap::from([(RegionClass::Trap, -2), (RegionClass::Alternative, 1)]));
    }

    #[test]
    fn merge_takes_the_larger_shortfall_for_same_class() {
        let mut a = issue("min_region_count_1", RegionClass::Trap, -2);
        let b = issue("min_region_count_2", RegionClass::Trap, -5);
        a.merge(b);

        assert_eq!(a.balance_by_class, HashMap::from([(RegionClass::Trap, -5)]),
            "same-class shortfalls describe one underlying demand — take the stricter (further from zero), not the sum");
    }

    #[test]
    fn merge_takes_the_smaller_surplus_for_same_class() {
        let mut a = issue("min_region_count_1", RegionClass::Trap, 5);
        let b = issue("min_region_count_2", RegionClass::Trap, 2);
        a.merge(b);

        assert_eq!(a.balance_by_class, HashMap::from([(RegionClass::Trap, 2)]),
            "the smaller surplus is the safer, less optimistic spendable amount");
    }

    #[test]
    fn merge_shortfall_always_wins_over_surplus_regardless_of_side() {
        let mut a = issue("min_region_count_1", RegionClass::Trap, -3);
        let b = issue("min_region_count_2", RegionClass::Trap, 2);
        a.merge(b.clone());
        assert_eq!(a.balance_by_class, HashMap::from([(RegionClass::Trap, -3)]),
            "must-add shortfall cannot be overridden by a has-spare surplus");

        let mut c = issue("min_region_count_2", RegionClass::Trap, 2);
        c.merge(issue("min_region_count_1", RegionClass::Trap, -3));
        assert_eq!(c.balance_by_class, HashMap::from([(RegionClass::Trap, -3)]),
            "shortfall wins regardless of which side it came from");
    }
}
