use crate::ids::EdgeId;
#[cfg(test)]
use crate::quality_control::issue::Issue;
use crate::quality_control::issue::{
    INVALID_LOOP, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};
use std::collections::HashMap;

/// Produced by any check that flags cycles invalid for a check-specific reason (currently
/// `MinLoopLengthCheck`/`MaxLoopLengthCheck`; future checks may flag cycles invalid for other
/// reasons and reuse this same kind). `all` holds every simple cycle found in the maze (valid and
/// invalid alike), each as the set of base-Graph edges forming it — membership only, order
/// carries no meaning, edge ids within one cycle never repeat. `invalid` is the subset of indices
/// into `all` that the producing check(s) flagged (the ones a repair strategy must break).
/// Keeping the valid cycles alongside the invalid ones lets a strategy avoid cutting an edge
/// shared with a cycle it must not destroy, instead of only seeing the cycles it's supposed to
/// break.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidLoopIssue {
    meta: IssueMeta,
    pub all: Vec<Vec<EdgeId>>,
    pub invalid: Vec<usize>,
    /// Per-cycle check provenance, keyed by `canonical_cycle_key` (not by index into `all`) —
    /// indices are re-mapped on every merge, but a cycle's canonical key is stable across merges,
    /// so this map never needs remapping. A cycle absent here was flagged by no check directly
    /// tracked (shouldn't happen for entries in `invalid`, but the map is not required to cover
    /// every index — absence means "no recorded source", not an error).
    pub invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
}

impl InvalidLoopIssue {
    pub fn new_from_check(
        source_check: &str,
        all: Vec<Vec<EdgeId>>,
        invalid: Vec<usize>,
        invalid_sources: HashMap<Vec<EdgeId>, Vec<String>>,
    ) -> Self {
        Self {
            meta: IssueMeta::new_from_check(source_check),
            all,
            invalid,
            invalid_sources,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidLoopIssue {
    const KIND: IssueKind = INVALID_LOOP;
}

bitflags::bitflags! {
    /// See GitHub issue #105 — what a `RepairStrategy<T, InvalidLoopIssue>` may ask its producing
    /// `Check` to compute, as a set of optional layers on top of the base data a check always
    /// builds (the flagged/invalid cycles themselves, resolved to `EdgeId`s). Currently one flag
    /// exists (`VALID_CYCLES`); more may be added later as independent layers, each requestable
    /// on its own.
    ///
    /// `Default` is **all flags set** ("compute everything"), not empty — `IssueRequirement`'s
    /// contract requires `Default` to mean "full", since `Check::report_check` has no strategy to
    /// consult and always passes the default.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct InvalidLoopRequirement: u8 {
        /// Resolve every valid (non-flagged) cycle into `all` too (not just the invalid ones),
        /// and build `invalid_sources`. Without this flag, a check builds only the base layer:
        /// `all`/`invalid` cover exactly the flagged cycles, `invalid_sources` stays empty. Only
        /// a strategy that never reads a valid cycle's content may omit this flag — see
        /// `InvalidLoopRandomStrategy::requirement`'s doc comment for the proof this is safe there.
        const VALID_CYCLES = 1 << 0;
    }
}

impl Default for InvalidLoopRequirement {
    /// Per `IssueRequirement`'s contract — default means "compute everything". See this type's
    /// doc comment.
    fn default() -> Self {
        Self::all()
    }
}

impl IssueRequirement for InvalidLoopIssue {
    type Requirement = InvalidLoopRequirement;
}

crate::impl_issue!(InvalidLoopIssue);

impl IssueMerge for InvalidLoopIssue {
    /// Delegates to `merge_cycle_sets` — see that function's doc comment for the normalize →
    /// dedup → remap algorithm shared with `InvalidLoopGroupIssue`.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);
        super::merge_cycle_sets(
            "InvalidLoopIssue",
            &mut self.all,
            &mut self.invalid,
            &mut self.invalid_sources,
            other.all,
            other.invalid,
            other.invalid_sources,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::canonical_cycle_key;
    use super::*;

    fn issue(source_check: &str, all: Vec<Vec<EdgeId>>, invalid: Vec<usize>) -> InvalidLoopIssue {
        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<String>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources
                .entry(canonical_cycle_key(&all[idx]))
                .or_default()
                .push(source_check.to_string());
        }
        InvalidLoopIssue::new_from_check(source_check, all, invalid, invalid_sources)
    }

    /// See GitHub issue #105 — `IssueRequirement`'s contract requires `Default` to mean "compute
    /// everything". The `bitflags!` macro's own derive would give `empty()`; this guards the
    /// hand-written `impl Default` actually overrides that to `all()`, since `Check::report_check`
    /// relies on this exact meaning and has no other way to be caught if it silently regressed.
    #[test]
    fn default_requirement_is_all_flags_set() {
        assert_eq!(
            InvalidLoopRequirement::default(),
            InvalidLoopRequirement::all()
        );
    }

    #[test]
    fn merge_keeps_each_source_checks_details_after_merge() {
        let mut a = issue("min_loop_length", vec![vec![1, 2, 3]], vec![0]).with_detail(
            "min_loop_length",
            "threshold",
            "10".to_string(),
        );
        let b = issue("max_loop_length", vec![vec![4, 5, 6]], vec![0]).with_detail(
            "max_loop_length",
            "threshold",
            "100".to_string(),
        );
        a.merge(b);

        assert_eq!(
            a.details()
                .get("min_loop_length")
                .and_then(|kv| kv.get("threshold")),
            Some(&"10".to_string())
        );
        assert_eq!(
            a.details()
                .get("max_loop_length")
                .and_then(|kv| kv.get("threshold")),
            Some(&"100".to_string())
        );
    }

    #[test]
    fn merge_disjoint_cycles_unions_all_and_invalid() {
        let mut a = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("unreachable_finish", vec![vec![4, 5, 6]], vec![0]);
        a.merge(b);

        assert_eq!(a.all.len(), 2, "disjoint cycles must not collapse");
        assert_eq!(
            a.invalid.len(),
            2,
            "both cycles are invalid, from different sources"
        );
        assert_eq!(
            a.source_checks(),
            vec![
                "missing_endpoints".to_string(),
                "unreachable_finish".to_string()
            ]
        );
    }

    #[test]
    fn merge_deduplicates_identical_cycle_found_by_both_sides() {
        // Same cycle, edges listed in a different order — must collapse to one entry in `all`.
        let mut a = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("unreachable_finish", vec![vec![3, 1, 2]], vec![0]);
        a.merge(b);

        assert_eq!(
            a.all.len(),
            1,
            "identical cycle (as an edge set) must not be duplicated"
        );
        assert_eq!(
            a.invalid,
            vec![0],
            "both sides' invalid index must collapse onto the same merged index"
        );
    }

    #[test]
    fn merge_keeps_valid_cycles_distinct_from_invalid_ones() {
        let mut a = issue(
            "missing_endpoints",
            vec![vec![1, 2, 3], vec![7, 8, 9]],
            vec![0],
        ); // second cycle valid
        let b = issue("unreachable_finish", vec![vec![4, 5, 6]], vec![0]);
        a.merge(b);

        assert_eq!(a.all.len(), 3);
        assert_eq!(
            a.invalid.len(),
            2,
            "only the two flagged cycles are invalid; the valid one stays out of `invalid`"
        );
    }

    #[test]
    fn merge_source_checks_has_no_duplicates() {
        let mut a = issue("missing_endpoints", vec![], vec![]);
        let b = issue("missing_endpoints", vec![], vec![]);
        a.merge(b);
        assert_eq!(
            a.source_checks(),
            vec!["missing_endpoints".to_string()],
            "merging the same source twice must not duplicate it"
        );
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_cycle() {
        // Same cycle (different edge order), flagged invalid by two different checks — both
        // check ids must end up attributed to it, not just one side's.
        let mut a = issue("min_loop_length", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("max_loop_length", vec![vec![3, 1, 2]], vec![0]);
        a.merge(b);

        let key = canonical_cycle_key(&[1, 2, 3]);
        let sources = a
            .invalid_sources
            .get(&key)
            .expect("merged cycle must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"min_loop_length".to_string()));
        assert!(sources.contains(&"max_loop_length".to_string()));
    }

    #[test]
    fn merge_invalid_sources_no_duplicate_for_repeated_check() {
        let mut a = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        a.merge(b);

        let key = canonical_cycle_key(&[1, 2, 3]);
        assert_eq!(
            a.invalid_sources.get(&key),
            Some(&vec!["missing_endpoints".to_string()])
        );
    }

    #[test]
    fn merge_invalid_sources_associative_regardless_of_merge_order() {
        let a = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("unreachable_finish", vec![vec![1, 2, 3]], vec![0]);
        let c = issue("min_loops_count", vec![vec![1, 2, 3]], vec![0]);

        let mut left_first = a.clone();
        left_first.merge(b.clone());
        left_first.merge(c.clone());

        let mut right_first = b;
        right_first.merge(c);
        right_first.merge(a);

        let key = canonical_cycle_key(&[1, 2, 3]);
        let extract_sorted = |issue: &InvalidLoopIssue| {
            let mut sources = issue.invalid_sources.get(&key).cloned().unwrap_or_default();
            sources.sort_unstable();
            sources
        };
        assert_eq!(extract_sorted(&left_first), extract_sorted(&right_first));
        assert_eq!(
            extract_sorted(&left_first),
            vec![
                "min_loops_count".to_string(),
                "missing_endpoints".to_string(),
                "unreachable_finish".to_string()
            ]
        );
    }

    #[test]
    #[cfg_attr(debug_assertions, should_panic(expected = "out of range"))]
    fn merge_drops_out_of_range_invalid_index_instead_of_panicking() {
        // A malformed `Check` impl could put an index into `invalid` that's out of range for its
        // own `all`. The remap step uses `.get()`, not `[]`, so the actual (release-build)
        // behavior is "drop the bad index, keep going" — never an array-index panic. In a debug
        // build the `debug_assert!` deliberately still fires (loud signal for whoever's
        // developing a new `Check` and got this wrong); this test asserts on that debug-only
        // panic message rather than disabling debug_assertions to exercise the release path,
        // since `cargo test` always builds with them on.
        let mut a = InvalidLoopIssue::new_from_check(
            "missing_endpoints",
            vec![vec![1, 2, 3]],
            vec![99],
            HashMap::new(),
        );
        let b = issue("unreachable_finish", vec![vec![4, 5, 6]], vec![0]);
        a.merge(b);

        assert_eq!(a.all.len(), 2, "both cycles still end up in the merged all");
        assert_eq!(
            a.invalid,
            vec![1],
            "the out-of-range index is dropped; only check_b's valid index survives"
        );
    }
}
