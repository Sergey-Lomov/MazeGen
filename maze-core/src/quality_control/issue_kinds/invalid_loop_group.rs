use std::collections::HashMap;
use crate::ids::EdgeId;
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_LOOP_GROUP};
use super::canonical_cycle_key;

/// Produced by any check that flags cycles as part of a group-level decision across every loop on
/// the field (currently only `MaxLoopDensityCheck`'s excess field-density) — mirrors
/// `InvalidLoopIssue`'s exact shape/merge semantics, but paired with `INVALID_LOOP_GROUP` instead
/// of `INVALID_LOOP` since neither flagged cycle here is individually invalid on its own terms;
/// see `INVALID_LOOP_GROUP`'s doc comment for the distinction. `all` holds every simple cycle
/// found in the maze (valid and invalid alike); `invalid` is the subset of indices into `all` a
/// repair strategy must break.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidLoopGroupIssue {
    meta: IssueMeta,
    pub all: Vec<Vec<EdgeId>>,
    pub invalid: Vec<usize>,
    /// Per-cycle check provenance, keyed by `canonical_cycle_key` — see `InvalidLoopIssue::invalid_sources`.
    pub invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
}

impl InvalidLoopGroupIssue {
    pub fn new_from_check(
        source_check: &str,
        all: Vec<Vec<EdgeId>>,
        invalid: Vec<usize>,
        invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
    ) -> Self {
        Self { meta: IssueMeta::new_from_check(source_check), all, invalid, invalid_sources }
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
    /// Mirrors `InvalidLoopRequirement` — see that type's doc comment for the rationale. No
    /// strategy exists yet for `InvalidLoopGroupIssue` (repair defaults to `no_fix`, logging
    /// only), so this currently has no consumer requesting anything less than the default, but
    /// the mechanism is kept symmetric with `InvalidLoopIssue` for when one is added.
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
    /// Delegates to `merge_cycle_sets` — see that function's doc comment for the normalize →
    /// dedup → remap algorithm shared with `InvalidLoopIssue`.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());
        super::merge_cycle_sets(
            "InvalidLoopGroupIssue",
            &mut self.all, &mut self.invalid, &mut self.invalid_sources,
            other.all, other.invalid, other.invalid_sources,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(source_check: &str, all: Vec<Vec<EdgeId>>, invalid: Vec<usize>) -> InvalidLoopGroupIssue {
        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<String>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources.entry(canonical_cycle_key(&all[idx])).or_default().push(source_check.to_string());
        }
        InvalidLoopGroupIssue::new_from_check(source_check, all, invalid, invalid_sources)
    }

    #[test]
    fn default_requirement_is_all_flags_set() {
        assert_eq!(InvalidLoopGroupRequirement::default(), InvalidLoopGroupRequirement::all());
    }

    #[test]
    fn merge_disjoint_cycles_unions_all_and_invalid() {
        let mut a = issue("max_loop_density", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("max_loop_density", vec![vec![4, 5, 6]], vec![0]);
        a.merge(b);

        assert_eq!(a.all.len(), 2, "disjoint cycles must not collapse");
        assert_eq!(a.invalid.len(), 2, "both cycles are invalid, from different sources");
    }

    #[test]
    fn merge_deduplicates_identical_cycle_found_by_both_sides() {
        let mut a = issue("max_loop_density", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("max_loop_density", vec![vec![3, 1, 2]], vec![0]);
        a.merge(b);

        assert_eq!(a.all.len(), 1, "identical cycle (as an edge set) must not be duplicated");
        assert_eq!(a.invalid, vec![0], "both sides' invalid index must collapse onto the same merged index");
    }

    #[test]
    fn merge_keeps_valid_cycles_distinct_from_invalid_ones() {
        let mut a = issue("max_loop_density", vec![vec![1, 2, 3], vec![7, 8, 9]], vec![0]);
        let b = issue("max_loop_density", vec![vec![4, 5, 6]], vec![0]);
        a.merge(b);

        assert_eq!(a.all.len(), 3);
        assert_eq!(a.invalid.len(), 2, "only the two flagged cycles are invalid; the valid one stays out of `invalid`");
    }
}
