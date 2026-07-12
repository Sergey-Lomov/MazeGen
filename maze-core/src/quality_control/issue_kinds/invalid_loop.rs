use std::collections::HashSet;
use crate::ids::EdgeId;
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, INVALID_LOOP};

/// Produced by any check that flags a cycle invalid for a check-specific reason (currently
/// `MinLoopLengthCheck`/`MaxLoopLengthCheck`/etc.; future checks may flag cycles invalid for other
/// reasons and reuse this same kind). One `InvalidLoopIssue` describes exactly one invalid cycle
/// (see GitHub issue #98) — a check finding several invalid cycles in one `repair_check` call
/// still reports only its first one as `cycle`/`cycle_id`, folding the rest into `other_invalid`;
/// `report_check` (final QC report) instead produces one `InvalidLoopIssue` per invalid cycle.
///
/// `cycle_id`/`cycle` are a deliberate hybrid, not redundant: `cycle_id` is an index into
/// `MazeAnalysis::cycles()` (cheap to carry, cheap to re-resolve without a fresh
/// `resolve_to_edge_ids` call over the whole cycle set), `cycle` is that same cycle already
/// resolved to base-`Graph` `EdgeId`s (the only stable identity across a graph mutation — the
/// index space is rebuilt from scratch whenever `graph.version()` changes, so the *same* physical
/// cycle can get a different `cycle_id` a repair iteration later, and two *different* physical
/// cycles can coincidentally land on the same `cycle_id` in two different graph versions). See
/// this type's `PartialEq` impl for why `cycle`, not `cycle_id`, is what `Stage`'s no-progress
/// guard (issue #27) must compare.
#[derive(Debug, Clone, Default)]
pub struct InvalidLoopIssue {
    meta: IssueMeta,
    pub cycle_id: usize,
    pub cycle: Vec<EdgeId>,
    /// Indices (into `MazeAnalysis::cycles()`) of other invalid cycles found in the same QC pass
    /// — filled only if `InvalidLoopRequirement::OTHER_INVALID` was requested. Auxiliary context
    /// for a scoring strategy (`InvalidLoopScoredStrategy`'s `short_overlap`), not part of this
    /// issue's identity — deliberately excluded from `PartialEq`/`eq_dyn` (see that impl).
    pub other_invalid: Vec<usize>,
    /// Indices of valid cycles found in the same QC pass — filled only if
    /// `InvalidLoopRequirement::OTHER_VALID` was requested. Same auxiliary-context rationale as
    /// `other_invalid`.
    pub other_valid: Vec<usize>,
}

impl InvalidLoopIssue {
    /// Normalizes `other_invalid`/`other_valid` against `cycle_id` on construction (drops
    /// `cycle_id` from both, drops anything already in `other_invalid` from `other_valid`) so the
    /// no-overlap invariant holds in release builds too, not just under `debug_assert!`.
    pub fn new_from_check(
        source_check: &str,
        cycle_id: usize,
        cycle: Vec<EdgeId>,
        mut other_invalid: Vec<usize>,
        mut other_valid: Vec<usize>,
    ) -> Self {
        other_invalid.retain(|&idx| idx != cycle_id);
        let invalid_set: HashSet<usize> = other_invalid.iter().copied().collect();
        other_valid.retain(|&idx| idx != cycle_id && !invalid_set.contains(&idx));
        let issue = Self { meta: IssueMeta::new_from_check(source_check), cycle_id, cycle, other_invalid, other_valid };
        issue.debug_assert_no_overlap();
        issue
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }

    fn debug_assert_no_overlap(&self) {
        debug_assert!(!self.other_invalid.contains(&self.cycle_id),
            "InvalidLoopIssue: cycle_id must not appear in other_invalid");
        debug_assert!(!self.other_valid.contains(&self.cycle_id),
            "InvalidLoopIssue: cycle_id must not appear in other_valid");
        let invalid_set: HashSet<usize> = self.other_invalid.iter().copied().collect();
        debug_assert!(!self.other_valid.iter().any(|idx| invalid_set.contains(idx)),
            "InvalidLoopIssue: other_invalid and other_valid must not overlap");
    }
}

impl IssueKindConst for InvalidLoopIssue {
    const KIND: IssueKind = INVALID_LOOP;
}

bitflags::bitflags! {
    /// See GitHub issue #105 — what a `RepairStrategy<T, InvalidLoopIssue>` may ask its producing
    /// `Check` to compute, as optional layers on top of the base data a check always builds (the
    /// main invalid cycle itself, `cycle_id`/`cycle` — always resolved regardless of these flags,
    /// since `cycle` is needed for `PartialEq`/no-progress comparison independent of what a
    /// strategy asked for).
    ///
    /// `Default` is **all flags set** ("compute everything"), not empty — `IssueRequirement`'s
    /// contract requires `Default` to mean "full", since `Check::report_check` has no strategy to
    /// consult and always passes the default.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct InvalidLoopRequirement: u8 {
        /// Resolve indices of other invalid cycles found in the same QC pass into `other_invalid`.
        /// Needed by `InvalidLoopScoredStrategy` for its `short_overlap` term.
        const OTHER_INVALID = 1 << 0;
        /// Resolve indices of valid cycles found in the same QC pass into `other_valid`. Needed by
        /// `InvalidLoopScoredStrategy` for its `other_overlap` term.
        const OTHER_VALID = 1 << 1;
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

impl Issue for InvalidLoopIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

/// Deliberately hand-written, not `derive`d — only `cycle` (the physical identity of the main
/// invalid cycle) and `meta` (source-check attribution/details) participate. `cycle_id`,
/// `other_invalid`, `other_valid` are excluded on purpose:
/// - `cycle_id` is an index into a per-graph-version cache — comparing it directly across two
///   `Stage::run_repair` iterations (which is exactly what `eq_dyn`/`PartialEq` is used for, via
///   the no-progress guard, issue #27) is unsound in both directions: the same physical cycle can
///   get a different `cycle_id` after an unrelated rule mutates the graph in between, and two
///   different physical cycles can coincidentally share a `cycle_id` in two different graph
///   versions. `cycle` (the resolved `Vec<EdgeId>`) is the only representation stable enough to
///   answer "is this the same invalid cycle as last iteration" correctly.
/// - `other_invalid`/`other_valid` are re-enumerated from scratch every `repair_check` call and
///   almost always differ between iterations purely from that recomputation, even when nothing
///   changed for this rule's own main cycle — including them in equality would make the
///   no-progress guard fire far less reliably than it should (auxiliary context, not part of this
///   issue's identity).
impl PartialEq for InvalidLoopIssue {
    fn eq(&self, other: &Self) -> bool {
        self.cycle == other.cycle && self.meta == other.meta
    }
}

impl IssueMerge for InvalidLoopIssue {
    /// Combines every check in one `Rule` that flagged something this QC pass. The first
    /// non-empty check's issue seeds `self`; each subsequent `other` folds in as follows:
    /// - `self.cycle_id`/`self.cycle` never change — the first check's main cycle wins.
    /// - `other.cycle_id` (the `other` check's own main cycle) joins `self.other_invalid` — it's
    ///   still an invalid cycle from this rule's perspective, just not the one this merged issue
    ///   leads with.
    /// - `other_invalid`/`other_valid` union in directly (plain index sets, no remapping needed —
    ///   every check in one `Rule` reads the same `MazeAnalysis::cycles()` snapshot within one QC
    ///   pass, so an index means the same cycle on both sides).
    /// - After the union, `self.cycle_id` is scrubbed from both lists, and anything in
    ///   `other_invalid` is scrubbed from `other_valid` (invalid membership wins over valid) —
    ///   mirrors the same normalization `new_from_check` applies at construction.
    /// - Final lists are sorted ascending (not left in `HashSet` iteration order) so two merges of
    ///   the same inputs in the same order produce byte-identical results run to run.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());

        let mut invalid: HashSet<usize> = self.other_invalid.iter().copied().collect();
        invalid.extend(other.other_invalid.iter().copied());
        invalid.insert(other.cycle_id);

        let mut valid: HashSet<usize> = self.other_valid.iter().copied().collect();
        valid.extend(other.other_valid.iter().copied());

        invalid.remove(&self.cycle_id);
        valid.remove(&self.cycle_id);
        valid.retain(|idx| !invalid.contains(idx));

        self.other_invalid = invalid.into_iter().collect();
        self.other_invalid.sort_unstable();
        self.other_valid = valid.into_iter().collect();
        self.other_valid.sort_unstable();

        self.debug_assert_no_overlap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(source_check: &str, cycle_id: usize, cycle: Vec<EdgeId>, other_invalid: Vec<usize>, other_valid: Vec<usize>) -> InvalidLoopIssue {
        InvalidLoopIssue::new_from_check(source_check, cycle_id, cycle, other_invalid, other_valid)
    }

    /// See GitHub issue #105 — `IssueRequirement`'s contract requires `Default` to mean "compute
    /// everything". The `bitflags!` macro's own derive would give `empty()`; this guards the
    /// hand-written `impl Default` actually overrides that to `all()`.
    #[test]
    fn default_requirement_is_all_flags_set() {
        assert_eq!(InvalidLoopRequirement::default(), InvalidLoopRequirement::all());
    }

    #[test]
    fn constructor_strips_cycle_id_from_other_lists() {
        let issue = issue("check", 0, vec![1, 2, 3], vec![0, 1], vec![0, 2]);
        assert_eq!(issue.other_invalid, vec![1]);
        assert_eq!(issue.other_valid, vec![2]);
    }

    #[test]
    fn constructor_strips_invalid_membership_from_valid_list() {
        // Same index in both incoming lists -- invalid membership wins, so it must not remain in
        // other_valid after normalization.
        let issue = issue("check", 0, vec![1, 2, 3], vec![5], vec![5, 6]);
        assert_eq!(issue.other_invalid, vec![5]);
        assert_eq!(issue.other_valid, vec![6]);
    }

    #[test]
    fn partial_eq_ignores_cycle_id_and_other_lists() {
        let a = issue("check", 0, vec![1, 2, 3], vec![10], vec![20]);
        let b = issue("check", 99, vec![1, 2, 3], vec![], vec![]);
        assert_eq!(a, b, "same cycle + same meta must compare equal regardless of cycle_id/other_invalid/other_valid");
    }

    #[test]
    fn partial_eq_differs_on_cycle_content() {
        let a = issue("check", 0, vec![1, 2, 3], vec![], vec![]);
        let b = issue("check", 0, vec![4, 5, 6], vec![], vec![]);
        assert_ne!(a, b, "a different physical cycle must never compare equal, even with the same cycle_id");
    }

    #[test]
    fn partial_eq_differs_on_meta() {
        let a = issue("check_a", 0, vec![1, 2, 3], vec![], vec![]);
        let b = issue("check_b", 0, vec![1, 2, 3], vec![], vec![]);
        assert_ne!(a, b, "different source checks must not compare equal");
    }

    #[test]
    fn merge_keeps_each_source_checks_details_after_merge() {
        let mut a = issue("min_loop_length", 0, vec![1, 2, 3], vec![], vec![])
            .with_detail("min_loop_length", "threshold", "10".to_string());
        let b = issue("max_loop_length", 1, vec![4, 5, 6], vec![], vec![])
            .with_detail("max_loop_length", "threshold", "100".to_string());
        a.merge(b);

        assert_eq!(a.details().get("min_loop_length").and_then(|kv| kv.get("threshold")), Some(&"10".to_string()));
        assert_eq!(a.details().get("max_loop_length").and_then(|kv| kv.get("threshold")), Some(&"100".to_string()));
    }

    #[test]
    fn merge_keeps_self_cycle_as_the_leading_cycle() {
        let mut a = issue("min_loop_length", 0, vec![1, 2, 3], vec![], vec![]);
        let b = issue("max_loop_length", 1, vec![4, 5, 6], vec![], vec![]);
        a.merge(b);

        assert_eq!(a.cycle_id, 0, "self's cycle_id must survive the merge unchanged");
        assert_eq!(a.cycle, vec![1, 2, 3], "self's cycle must survive the merge unchanged");
    }

    #[test]
    fn merge_folds_others_main_cycle_into_other_invalid() {
        let mut a = issue("min_loop_length", 0, vec![1, 2, 3], vec![], vec![]);
        let b = issue("max_loop_length", 1, vec![4, 5, 6], vec![], vec![]);
        a.merge(b);

        assert_eq!(a.other_invalid, vec![1], "other's own cycle_id becomes one of self's other_invalid entries");
    }

    #[test]
    fn merge_unions_other_invalid_and_other_valid() {
        let mut a = issue("check_a", 0, vec![1], vec![2, 3], vec![7, 8]);
        let b = issue("check_b", 4, vec![9], vec![5, 6], vec![10, 11]);
        a.merge(b);

        assert_eq!(a.other_invalid, vec![2, 3, 4, 5, 6]);
        assert_eq!(a.other_valid, vec![7, 8, 10, 11]);
    }

    #[test]
    fn merge_deduplicates_and_sorts_indices() {
        let mut a = issue("check_a", 0, vec![1], vec![5, 3], vec![]);
        let b = issue("check_b", 4, vec![9], vec![3, 5], vec![]);
        a.merge(b);

        assert_eq!(a.other_invalid, vec![3, 4, 5], "duplicates across both sides collapse, result is sorted ascending");
    }

    #[test]
    fn merge_removes_self_cycle_id_from_other_lists() {
        // other's own other_invalid/other_valid happen to (re-)mention self's cycle_id -- must be
        // scrubbed after the union, same normalization as the constructor.
        let mut a = issue("check_a", 0, vec![1], vec![], vec![]);
        let b = issue("check_b", 4, vec![9], vec![0], vec![0]);
        a.merge(b);

        assert!(!a.other_invalid.contains(&0));
        assert!(!a.other_valid.contains(&0));
    }

    #[test]
    fn merge_invalid_membership_wins_over_valid_across_sides() {
        // Index 5 is invalid per `a`, valid per `b` -- after merge it must end up only in
        // other_invalid, never in other_valid.
        let mut a = issue("check_a", 0, vec![1], vec![5], vec![]);
        let b = issue("check_b", 4, vec![9], vec![], vec![5]);
        a.merge(b);

        assert!(a.other_invalid.contains(&5));
        assert!(!a.other_valid.contains(&5));
    }

    #[test]
    fn merge_source_checks_has_no_duplicates() {
        let mut a = issue("missing_endpoints", 0, vec![1], vec![], vec![]);
        let b = issue("missing_endpoints", 0, vec![1], vec![], vec![]);
        a.merge(b);
        assert_eq!(a.source_checks(), vec!["missing_endpoints".to_string()], "merging the same source twice must not duplicate it");
    }
}
