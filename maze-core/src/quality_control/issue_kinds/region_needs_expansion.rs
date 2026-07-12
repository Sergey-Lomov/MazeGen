use std::collections::HashSet;
use crate::ids::NodeId;
use crate::quality_control::issue::{Issue, IssueKindConst, IssueMerge, IssueRequirement, IssueMeta, IssueKind, REGION_NEEDS_EXPANSION};

/// Produced by any check that flags an SCC region as needing expansion for a check-specific
/// reason (currently `MinRegionSizeCheck`/`MinRegionRatioCheck`; future checks may flag a region
/// for expansion for reasons unrelated to size). One `RegionNeedsExpansionIssue` describes exactly
/// one undersized region (see GitHub issue #99) — a check finding several undersized regions in
/// one `repair_check` call still reports only its first one as `region`/`region_id`, folding the
/// rest into `other_invalid`; `report_check` (final QC report) instead produces one
/// `RegionNeedsExpansionIssue` per undersized region.
///
/// `region_id`/`region` are a deliberate hybrid, not redundant: `region_id` is an index into
/// `MazeAnalysis::scc(&maze.graph).components` (cheap to carry, cheap to re-resolve without
/// copying the region's own node list), `region` is that same region's member `NodeId`s, sorted
/// (the only stable identity across a graph mutation — the component index space is rebuilt from
/// scratch whenever `graph.version()` changes, so the *same* physical region can get a different
/// `region_id` a repair iteration later, and two *different* physical regions can coincidentally
/// land on the same `region_id` in two different graph versions). See this type's `PartialEq`
/// impl for why `region`, not `region_id`, is what `Stage`'s no-progress guard (issue #27) must
/// compare.
#[derive(Debug, Clone, Default)]
pub struct RegionNeedsExpansionIssue {
    meta: IssueMeta,
    pub region_id: usize,
    pub region: Vec<NodeId>,
    /// Indices (into `MazeAnalysis::scc(&maze.graph).components`) of every *other* undersized
    /// region found in the same QC pass — not just geometric neighbors, since a merge strategy
    /// (e.g. `TeleportRegionMergeStrategy`) may bridge into a region with no adjacency to this
    /// one at all. Filled only if `RegionNeedsExpansionRequirement::OTHER_INVALID` was requested.
    /// Auxiliary context for target selection (`region_merge_core::pick_by_mode`'s
    /// `MODE_PREFER_NEEDY`), not part of this issue's identity — deliberately excluded from
    /// `PartialEq`/`eq_dyn` (see that impl).
    pub other_invalid: Vec<usize>,
}

impl RegionNeedsExpansionIssue {
    /// Normalizes `other_invalid` against `region_id` on construction (drops `region_id` from it)
    /// so the no-overlap invariant holds in release builds too, not just under `debug_assert!`.
    pub fn new_from_check(
        source_check: &str,
        region_id: usize,
        region: Vec<NodeId>,
        mut other_invalid: Vec<usize>,
    ) -> Self {
        other_invalid.retain(|&idx| idx != region_id);
        let issue = Self { meta: IssueMeta::new_from_check(source_check), region_id, region, other_invalid };
        issue.debug_assert_no_overlap();
        issue
    }

    /// For synthetic issues built by a parent `RepairStrategy` (e.g. `ReduceSccCountStrategy`)
    /// for a nested-strategy call — no source check.
    pub fn synthetic(region_id: usize, region: Vec<NodeId>) -> Self {
        Self { meta: IssueMeta::new(), region_id, region, other_invalid: Vec::new() }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }

    fn debug_assert_no_overlap(&self) {
        debug_assert!(!self.other_invalid.contains(&self.region_id),
            "RegionNeedsExpansionIssue: region_id must not appear in other_invalid");
    }
}

impl IssueKindConst for RegionNeedsExpansionIssue {
    const KIND: IssueKind = REGION_NEEDS_EXPANSION;
}

bitflags::bitflags! {
    /// See GitHub issue #105 — what a `RepairStrategy<T, RegionNeedsExpansionIssue>` may ask its
    /// producing `Check` to compute, as an optional layer on top of the base data a check always
    /// builds (the main undersized region itself, `region_id`/`region` — always resolved
    /// regardless of this flag, since `region` is needed for `PartialEq`/no-progress comparison
    /// independent of what a strategy asked for).
    ///
    /// `Default` is **all flags set** ("compute everything"), not empty — `IssueRequirement`'s
    /// contract requires `Default` to mean "full", since `Check::report_check` has no strategy to
    /// consult and always passes the default.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct RegionNeedsExpansionRequirement: u8 {
        /// Resolve indices of other undersized regions found in the same QC pass into
        /// `other_invalid`. Needed by `region_merge_core::pick_by_mode`'s `MODE_PREFER_NEEDY`.
        const OTHER_INVALID = 1 << 0;
    }
}

impl Default for RegionNeedsExpansionRequirement {
    /// Per `IssueRequirement`'s contract — default means "compute everything". See this type's
    /// doc comment.
    fn default() -> Self {
        Self::all()
    }
}

impl IssueRequirement for RegionNeedsExpansionIssue {
    type Requirement = RegionNeedsExpansionRequirement;
}

impl Issue for RegionNeedsExpansionIssue {
    fn kind(&self) -> IssueKind { Self::KIND }
    fn meta(&self) -> &IssueMeta { &self.meta }
    fn meta_mut(&mut self) -> &mut IssueMeta { &mut self.meta }
    fn as_any(&self) -> &dyn std::any::Any { self }
    crate::impl_issue_dyn_boilerplate!();
}

/// Deliberately hand-written, not `derive`d — only `region` (the physical identity of the main
/// undersized region) and `meta` (source-check attribution/details) participate. `region_id` and
/// `other_invalid` are excluded on purpose:
/// - `region_id` is an index into a per-graph-version cache — comparing it directly across two
///   `Stage::run_repair` iterations (which is exactly what `eq_dyn`/`PartialEq` is used for, via
///   the no-progress guard, issue #27) is unsound in both directions: the same physical region can
///   get a different `region_id` after an unrelated rule mutates the graph in between, and two
///   different physical regions can coincidentally share a `region_id` in two different graph
///   versions. `region` (the sorted `Vec<NodeId>`) is the only representation stable enough to
///   answer "is this the same undersized region as last iteration" correctly.
/// - `other_invalid` is re-enumerated from scratch every `repair_check` call and almost always
///   differs between iterations purely from that recomputation, even when nothing changed for
///   this rule's own main region — including it in equality would make the no-progress guard fire
///   far less reliably than it should (auxiliary context, not part of this issue's identity).
impl PartialEq for RegionNeedsExpansionIssue {
    fn eq(&self, other: &Self) -> bool {
        self.region == other.region && self.meta == other.meta
    }
}

impl IssueMerge for RegionNeedsExpansionIssue {
    /// Combines every check in one `Rule` that flagged something this QC pass. The first
    /// non-empty check's issue seeds `self`; each subsequent `other` folds in as follows:
    /// - `self.region_id`/`self.region` never change — the first check's main region wins.
    /// - `other.region_id` (the `other` check's own main region) joins `self.other_invalid` — it's
    ///   still an undersized region from this rule's perspective, just not the one this merged
    ///   issue leads with.
    /// - `other_invalid` unions in directly (a plain index set, no remapping needed — every check
    ///   in one `Rule` reads the same `maze.analysis.scc(&maze.graph)` cache entry within one QC
    ///   pass, so an index means the same region on both sides).
    /// - After the union, `self.region_id` is scrubbed from the list — mirrors the same
    ///   normalization `new_from_check` applies at construction.
    /// - Final list is sorted ascending (not left in `HashSet` iteration order) so two merges of
    ///   the same inputs in the same order produce byte-identical results run to run.
    fn merge(&mut self, other: Self) {
        for source in other.meta.source_checks() {
            self.meta.push_source(source);
        }
        self.meta.merge_details(other.meta.details().clone());

        let mut invalid: HashSet<usize> = self.other_invalid.iter().copied().collect();
        invalid.extend(other.other_invalid.iter().copied());
        invalid.insert(other.region_id);
        invalid.remove(&self.region_id);

        self.other_invalid = invalid.into_iter().collect();
        self.other_invalid.sort_unstable();

        self.debug_assert_no_overlap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: u64) -> NodeId {
        id
    }

    fn issue(source_check: &str, region_id: usize, region: Vec<NodeId>, other_invalid: Vec<usize>) -> RegionNeedsExpansionIssue {
        RegionNeedsExpansionIssue::new_from_check(source_check, region_id, region, other_invalid)
    }

    #[test]
    fn default_requirement_is_all_flags_set() {
        assert_eq!(RegionNeedsExpansionRequirement::default(), RegionNeedsExpansionRequirement::all());
    }

    #[test]
    fn constructor_strips_region_id_from_other_invalid() {
        let issue = issue("check", 0, vec![node(1)], vec![0, 1, 2]);
        assert_eq!(issue.other_invalid, vec![1, 2]);
    }

    #[test]
    fn partial_eq_ignores_region_id_and_other_invalid() {
        let a = issue("check", 0, vec![node(1), node(2)], vec![10]);
        let b = issue("check", 99, vec![node(1), node(2)], vec![]);
        assert_eq!(a, b, "same region + same meta must compare equal regardless of region_id/other_invalid");
    }

    #[test]
    fn partial_eq_differs_on_region_content() {
        let a = issue("check", 0, vec![node(1)], vec![]);
        let b = issue("check", 0, vec![node(2)], vec![]);
        assert_ne!(a, b, "a different physical region must never compare equal, even with the same region_id");
    }

    #[test]
    fn partial_eq_differs_on_meta() {
        let a = issue("check_a", 0, vec![node(1)], vec![]);
        let b = issue("check_b", 0, vec![node(1)], vec![]);
        assert_ne!(a, b, "different source checks must not compare equal");
    }

    #[test]
    fn merge_keeps_each_source_checks_details_after_merge() {
        let mut a = issue("min_region_size", 0, vec![node(1)], vec![])
            .with_detail("min_region_size", "threshold", "10".to_string());
        let b = issue("min_region_ratio", 1, vec![node(2)], vec![])
            .with_detail("min_region_ratio", "threshold", "20".to_string());
        a.merge(b);

        assert_eq!(a.details().get("min_region_size").and_then(|kv| kv.get("threshold")), Some(&"10".to_string()));
        assert_eq!(a.details().get("min_region_ratio").and_then(|kv| kv.get("threshold")), Some(&"20".to_string()));
    }

    #[test]
    fn merge_keeps_self_region_as_the_leading_region() {
        let mut a = issue("min_region_size", 0, vec![node(1)], vec![]);
        let b = issue("min_region_ratio", 1, vec![node(2)], vec![]);
        a.merge(b);

        assert_eq!(a.region_id, 0, "self's region_id must survive the merge unchanged");
        assert_eq!(a.region, vec![node(1)], "self's region must survive the merge unchanged");
    }

    #[test]
    fn merge_folds_others_main_region_into_other_invalid() {
        let mut a = issue("min_region_size", 0, vec![node(1)], vec![]);
        let b = issue("min_region_ratio", 1, vec![node(2)], vec![]);
        a.merge(b);

        assert_eq!(a.other_invalid, vec![1], "other's own region_id becomes one of self's other_invalid entries");
    }

    #[test]
    fn merge_unions_and_dedups_other_invalid() {
        let mut a = issue("check_a", 0, vec![node(1)], vec![2, 3]);
        let b = issue("check_b", 4, vec![node(9)], vec![3, 5]);
        a.merge(b);

        assert_eq!(a.other_invalid, vec![2, 3, 4, 5]);
    }

    #[test]
    fn merge_removes_self_region_id_from_other_invalid() {
        let mut a = issue("check_a", 0, vec![node(1)], vec![]);
        let b = issue("check_b", 4, vec![node(9)], vec![0]);
        a.merge(b);

        assert!(!a.other_invalid.contains(&0));
    }

    #[test]
    fn merge_source_checks_has_no_duplicates() {
        let mut a = issue("min_region_size", 0, vec![node(1)], vec![]);
        let b = issue("min_region_size", 0, vec![node(1)], vec![]);
        a.merge(b);
        assert_eq!(a.source_checks(), vec!["min_region_size".to_string()], "merging the same source twice must not duplicate it");
    }
}
