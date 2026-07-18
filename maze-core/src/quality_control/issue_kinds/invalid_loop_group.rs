use std::collections::HashMap;
use crate::ids::EdgeId;
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_LOOP_GROUP};
use super::canonical_cycle_key;

/// Produced by any check that flags cycles as part of a group-level decision across every loop on
/// the field (currently only `MaxLoopDensityCheck`'s excess field-density) — pairs with
/// `INVALID_LOOP_GROUP` instead of `INVALID_LOOP` since neither flagged cycle here is individually
/// invalid on its own terms; see `INVALID_LOOP_GROUP`'s doc comment for the distinction. `invalid`
/// holds every cycle a repair strategy must break; `valid` holds every other simple cycle found in
/// the maze — kept alongside so a strategy can avoid cutting an edge shared with a cycle it must
/// not destroy.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidLoopGroupIssue {
    meta: IssueMeta,
    pub invalid: Vec<Vec<EdgeId>>,
    pub valid: Vec<Vec<EdgeId>>,
    /// Per-cycle check provenance, keyed by `canonical_cycle_key` — see `InvalidLoopIssue::invalid_sources`.
    pub invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
}

impl InvalidLoopGroupIssue {
    pub fn new_from_check(
        source_check: &str,
        invalid: Vec<Vec<EdgeId>>,
        valid: Vec<Vec<EdgeId>>,
        invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
    ) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), invalid, valid, invalid_sources }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidLoopGroupIssue {
    const KIND: IssueKind = INVALID_LOOP_GROUP;
}

bitflags::bitflags! {
    /// Mirrors `InvalidLoopRequirement` — see that type's doc comment for the rationale.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct InvalidLoopGroupRequirement: u8 {
        const VALID_CYCLES = 1 << 0;
    }
}

impl Default for InvalidLoopGroupRequirement {
    fn default() -> Self {
        Self::all()
    }
}

impl IssueRequirement for InvalidLoopGroupIssue {
    type Requirement = InvalidLoopGroupRequirement;
}

impl Issue for InvalidLoopGroupIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
}

impl IssueMerge for InvalidLoopGroupIssue {
    /// Dedups `invalid`/`valid` independently by `canonical_cycle_key`, unlike
    /// `InvalidLoopIssue`'s shared `all`/index scheme — a cycle appearing on both sides as
    /// invalid stays invalid; one appearing as valid on both sides stays valid once. A cycle
    /// flagged invalid by one side and valid by the other is kept invalid (the stricter side
    /// wins), since a repair strategy must break it if any source flagged it.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());

        let mut invalid_keys: std::collections::HashSet<Vec<EdgeId>> = self.invalid.iter().map(|c| canonical_cycle_key(c)).collect();
        for cycle in other.invalid {
            let key = canonical_cycle_key(&cycle);
            if invalid_keys.insert(key) {
                self.invalid.push(cycle);
            }
        }

        let mut valid_keys: std::collections::HashSet<Vec<EdgeId>> = self.valid.iter().map(|c| canonical_cycle_key(c)).collect();
        for cycle in other.valid {
            let key = canonical_cycle_key(&cycle);
            if invalid_keys.contains(&key) {
                continue;
            }
            if valid_keys.insert(key) {
                self.valid.push(cycle);
            }
        }
        // Drop any of self's own valid cycles that the merge just promoted to invalid.
        self.valid.retain(|cycle| !invalid_keys.contains(&canonical_cycle_key(cycle)));

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

    fn issue(source_check: &str, invalid: Vec<Vec<EdgeId>>, valid: Vec<Vec<EdgeId>>) -> InvalidLoopGroupIssue {
        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<String>> = HashMap::new();
        for cycle in &invalid {
            invalid_sources.entry(canonical_cycle_key(cycle)).or_default().push(source_check.to_string());
        }
        InvalidLoopGroupIssue::new_from_check(source_check, invalid, valid, invalid_sources)
    }

    #[test]
    fn default_requirement_is_all_flags_set() {
        assert_eq!(InvalidLoopGroupRequirement::default(), InvalidLoopGroupRequirement::all());
    }

    #[test]
    fn merge_disjoint_cycles_unions_invalid() {
        let mut a = issue("max_loop_density", vec![vec![1, 2, 3]], vec![]);
        let b = issue("max_loop_density", vec![vec![4, 5, 6]], vec![]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 2, "disjoint invalid cycles must not collapse");
    }

    #[test]
    fn merge_deduplicates_identical_invalid_cycle_found_by_both_sides() {
        let mut a = issue("max_loop_density", vec![vec![1, 2, 3]], vec![]);
        let b = issue("max_loop_density", vec![vec![3, 1, 2]], vec![]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 1, "identical cycle (as an edge set) must not be duplicated");
    }

    #[test]
    fn merge_keeps_valid_cycles_distinct_from_invalid_ones() {
        let mut a = issue("max_loop_density", vec![vec![1, 2, 3]], vec![vec![7, 8, 9]]);
        let b = issue("max_loop_density", vec![vec![4, 5, 6]], vec![]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 2);
        assert_eq!(a.valid.len(), 1, "the valid cycle stays out of invalid");
    }

    #[test]
    fn merge_promotes_a_cycle_flagged_invalid_by_either_side_to_invalid() {
        let mut a = issue("check_a", vec![], vec![vec![1, 2, 3]]);
        let b = issue("check_b", vec![vec![1, 2, 3]], vec![]);
        a.merge(b);

        assert_eq!(a.invalid.len(), 1, "cycle flagged invalid by either side ends up invalid");
        assert!(a.valid.is_empty(), "must not remain in valid once promoted to invalid");
    }

    #[test]
    fn merge_deduplicates_identical_valid_cycle_found_by_both_sides() {
        let mut a = issue("check_a", vec![], vec![vec![1, 2, 3]]);
        let b = issue("check_b", vec![], vec![vec![3, 1, 2]]);
        a.merge(b);

        assert_eq!(a.valid.len(), 1, "identical valid cycle must not be duplicated");
    }

    #[test]
    fn merge_unions_disjoint_valid_cycles_from_both_sides() {
        let mut a = issue("check_a", vec![], vec![vec![1, 2, 3]]);
        let b = issue("check_b", vec![], vec![vec![4, 5, 6]]);
        a.merge(b);

        assert_eq!(a.valid.len(), 2, "two distinct valid cycles must both survive the merge");
    }
}
