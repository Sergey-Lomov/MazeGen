use std::collections::HashMap;
use crate::graph::region_class::RegionClass;
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueMeta, IssueKind, MISSING_REGIONS};

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

impl Issue for MissingRegionsIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

impl IssueMerge for MissingRegionsIssue {
    /// A single `MinRegionCountCheck` instance now reports every off-target class's balance in
    /// one issue, so this merge rarely runs in practice, but stays defined for the rare case of
    /// two instances active at once. Two entries for the same class take the value **further
    /// from zero** (the stricter demand/surplus): for a shared shortfall (`-N`) that's the more
    /// negative value; a shortfall and a surplus on the same class in the same pass is a
    /// configuration conflict between instances, not something this merge can resolve —
    /// `debug_assert!` against it rather than silently picking one side.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());

        for (class, balance) in other.balance_by_class {
            self.balance_by_class.entry(class)
                .and_modify(|b| {
                    debug_assert!(
                        (*b < 0) == (balance < 0),
                        "MissingRegionsIssue::merge: class {class:?} has conflicting-sign balances ({b} vs {balance}) from two instances in one rule"
                    );
                    *b = if b.abs() >= balance.abs() { *b } else { balance };
                })
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
    fn merge_takes_stricter_for_same_class() {
        let mut a = issue("min_region_count_1", RegionClass::Trap, -2);
        let b = issue("min_region_count_2", RegionClass::Trap, -5);
        a.merge(b);

        assert_eq!(a.balance_by_class, HashMap::from([(RegionClass::Trap, -5)]),
            "same-class shortfalls describe one underlying demand — take the stricter (further from zero), not the sum");
    }
}
