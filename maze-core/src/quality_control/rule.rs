use std::collections::{HashMap, HashSet};
use rand::RngCore;
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::{
    RepairStrategy, RepairResult, NestedStrategyConfig, SnapshotStack,
    params::{build_params, StrategyParams},
};
use super::check::Check;
use super::issue::{Issue, IssueKind};
use super::issue_data::{canonical_cycle_key, IssueData};

/// One rule's strategy assignment — checks + strategy + param overrides, held together so `Rule`
/// can build `StrategyParams` and dispatch repair by itself. `None` on `Rule::strategy` (not this
/// type) means "no_fix".
struct RuleStrategy<T: Tessellation> {
    strategy: Box<dyn RepairStrategy<T>>,
    param_overrides: HashMap<String, String>,
    nested: Vec<NestedStrategyConfig<T>>,
}

/// A user-defined QC rule: a set of checks producing one `IssueKind`, driving its own check
/// dispatch, issue merge, and (if configured) repair dispatch — see `Specs/repair.md`'s "Rule,
/// Stage, and the unified QualityControlEngine" section (GitHub issue #106).
///
/// Composite routing ids (`{rule_id}:{local_id}`) are a DTO-protocol detail (issue #60), not a
/// concern of this type — `Rule` only stores each check's own `local_id`, unique within this
/// rule's `checks`. Composite id construction lives entirely in
/// `QualityControlEngine::check_id_to_rule` (the one place across the whole engine that needs it).
pub struct Rule<T: Tessellation> {
    pub id: String,
    pub kind: IssueKind,
    checks: Vec<(String, Box<dyn Check<T>>)>,
    strategy: Option<RuleStrategy<T>>,
}

impl<T: Tessellation> Rule<T> {
    pub fn new(
        id: String,
        kind: IssueKind,
        checks: Vec<(String, Box<dyn Check<T>>)>,
        strategy: Option<Box<dyn RepairStrategy<T>>>,
        param_overrides: HashMap<String, String>,
        nested: Vec<NestedStrategyConfig<T>>,
    ) -> Self {
        let strategy = strategy.map(|strategy| RuleStrategy { strategy, param_overrides, nested });
        Self { id, kind, checks, strategy }
    }

    /// `(local_id, &dyn Check<T>)` pairs, in the order checks were configured — the only way
    /// anything outside this module observes this rule's checks. Used by
    /// `QualityControlEngine::check_id_to_rule` to build composite ids on demand.
    pub fn checks(&self) -> impl Iterator<Item = (&str, &dyn Check<T>)> {
        self.checks.iter().map(|(local_id, check)| (local_id.as_str(), check.as_ref()))
    }

    pub fn has_strategy(&self) -> bool {
        self.strategy.is_some()
    }

    /// Runs every check in this rule via `Check::repair_check`, folding all raw issues into at
    /// most one merged `Issue` via `merge_issue` — the per-rule concern issue #106 calls out
    /// ("gives rule-level issue merging a natural home"). Returns `None` if no check in this rule
    /// found anything this call.
    pub fn run_checks(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: impl Fn() -> f64,
    ) -> Option<Issue> {
        let mut merged: Option<Issue> = None;
        for (_, check) in &self.checks {
            let issues = timed(timing, check.check_type_id(), &now_ms, || {
                let mut v = Vec::new();
                check.repair_check(maze, &mut v, rng);
                v
            });
            for issue in issues {
                match &mut merged {
                    None => merged = Some(issue),
                    Some(existing) => merge_issue(existing, issue),
                }
            }
        }
        merged
    }

    /// Runs every check in this rule via `Check::report_check` — one `Issue` per flagged problem
    /// instance, no merge (see GitHub issue #102). Used by both the final `build_maze` report and
    /// `build_analytics_snapshot`'s check-only path (issue #106 unifies these).
    pub fn report_checks(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: impl Fn() -> f64,
    ) -> Vec<Issue> {
        let mut issues = Vec::new();
        for (_, check) in &self.checks {
            let mut found = timed(timing, check.check_type_id(), &now_ms, || check.report_check(maze, rng));
            issues.append(&mut found);
        }
        issues
    }

    /// Dispatches this rule's strategy against `issue` (already merged by `run_checks`). Returns
    /// `None` if this rule has no registered strategy ("no_fix").
    pub fn dispatch_repair(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: impl Fn() -> f64,
    ) -> Option<RepairResult> {
        let rule_strategy = self.strategy.as_ref()?;
        let params: StrategyParams = build_params(rule_strategy.strategy.params(), Some(&rule_strategy.param_overrides));
        let mut snapshots = SnapshotStack::new();
        let start = now_ms();
        let result = rule_strategy.strategy.apply(issue, maze, &mut snapshots, rng, &params, preset_state, &rule_strategy.nested);
        let elapsed = now_ms() - start;
        let entry = timing.entry(rule_strategy.strategy.strategy_id()).or_insert((0.0, 0));
        entry.0 += elapsed;
        entry.1 += 1;
        Some(result)
    }
}

/// Times one `f` call, accumulating elapsed milliseconds and call count under `check_type_id` —
/// shared by `run_checks`/`report_checks`, the two call sites whose only difference is which
/// `Check` method they invoke (`repair_check`'s out-parameter vs `report_check`'s return value),
/// not worth unifying behind a generic per-check callback for just two call sites.
fn timed<R>(
    timing: &mut HashMap<&'static str, (f64, u32)>,
    check_type_id: &'static str,
    now_ms: &impl Fn() -> f64,
    f: impl FnOnce() -> R,
) -> R {
    let start = now_ms();
    let result = f();
    let elapsed = now_ms() - start;
    let entry = timing.entry(check_type_id).or_insert((0.0, 0));
    entry.0 += elapsed;
    entry.1 += 1;
    result
}

/// Merges `incoming` into `existing` — both share `existing.kind`. Used when two checks within
/// the same `Rule` (or, in principle, the same check twice) produce an issue of the same kind in
/// one QC pass. Always unions data rather than picking one side — there is no precedence between
/// sources, nothing is discarded (see `Specs/quality_control.md`'s "Dedup interaction" section).
pub(crate) fn merge_issue(existing: &mut Issue, mut incoming: Issue) {
    for source in incoming.source_checks() {
        existing.push_source(source);
    }
    existing.merge_details(incoming.take_details());
    match (&mut existing.data, incoming.data) {
        (Some(IssueData::InvalidLoops { all, invalid, invalid_sources }),
         Some(IssueData::InvalidLoops { all: incoming_all, invalid: incoming_invalid, invalid_sources: incoming_sources })) => {
            merge_invalid_loops(all, invalid, invalid_sources, incoming_all, incoming_invalid, incoming_sources);
        }
        (Some(IssueData::RegionsNeedingExpansion { invalid, invalid_sources }),
         Some(IssueData::RegionsNeedingExpansion { invalid: incoming_invalid, invalid_sources: incoming_sources })) => {
            merge_regions_needing_expansion(invalid, invalid_sources, incoming_invalid, incoming_sources);
        }
        (Some(IssueData::MissingRegions { balance_by_class }),
         Some(IssueData::MissingRegions { balance_by_class: incoming_by_class })) => {
            merge_missing_regions(balance_by_class, incoming_by_class);
        }
        (Some(IssueData::ExcessiveSccCount { max_scc_count }),
         Some(IssueData::ExcessiveSccCount { max_scc_count: incoming_max })) => {
            // In practice there is normally exactly one active `scc_count` instance (see
            // Specs/quality_control.md), so two differing thresholds reaching this merge would
            // be a caller configuration conflict, not a case this merge can meaningfully
            // resolve — same debug-only signal as `merge_missing_regions`'s analogous conflict.
            debug_assert_eq!(*max_scc_count, incoming_max,
                "merge_issue: two ExcessiveSccCount instances disagree on max_scc_count ({max_scc_count} vs {incoming_max})");
        }
        (Some(IssueData::InvalidTeleports { invalid }),
         Some(IssueData::InvalidTeleports { invalid: incoming_invalid })) => {
            // A teleport is a single edge, not a cycle of edges — unlike InvalidLoops there is no
            // index-into-`all` indirection to remap, just a dedup-union of flagged EdgeIds. Uses
            // a HashSet for the membership check (existing entries only) so the union stays
            // O(n + m) rather than O(n * m) for a linear-scan `.contains()` per incoming id.
            let seen: HashSet<EdgeId> = invalid.iter().copied().collect();
            invalid.extend(incoming_invalid.into_iter().filter(|id| !seen.contains(id)));
        }
        (Some(IssueData::TeleportProximityPairs { pairs }),
         Some(IssueData::TeleportProximityPairs { pairs: incoming_pairs })) => {
            // A pair's order carries no meaning (see IssueData::TeleportProximityPairs's doc
            // comment) — dedup by unordered identity so (a, b) and (b, a) from two different
            // checks collapse to one entry instead of being kept as duplicates.
            let mut seen: HashSet<(EdgeId, EdgeId)> = pairs.iter()
                .map(|&(a, b)| if a <= b { (a, b) } else { (b, a) })
                .collect();
            for (a, b) in incoming_pairs {
                let key = if a <= b { (a, b) } else { (b, a) };
                if seen.insert(key) {
                    pairs.push((a, b));
                }
            }
        }
        (None, None) => {}
        (existing_data, incoming_data) => {
            debug_assert!(false,
                "merge_issue: no merge rule for this IssueData combination (existing: {existing_data:?}, incoming: {incoming_data:?}) — \
                 silently keeping the existing side would reintroduce the dedup bug this function exists to fix");
        }
    }
}

/// Canonical merge for `IssueData::InvalidLoops`, in three explicit steps so each step's
/// invariant stays locally checkable (normalize → dedup → remap), rather than one pass that
/// conflates "is this the same cycle" with "what's its new index" with "which indices are invalid".
/// A cycle from `existing`/`incoming` that's identical as an edge-set (regardless of `Vec` order —
/// cycles are sets of edges, not sequences, see `Specs/quality_control.md`) is kept once in the
/// merged `all`, so the same cycle found by two different checks doesn't appear twice or end up
/// with two different indices in `invalid`. `invalid_sources` is keyed by the same canonical key,
/// so unioning it needs no remap — unlike `invalid`, which is index-based and must be remapped.
fn merge_invalid_loops(
    all: &mut Vec<Vec<EdgeId>>,
    invalid: &mut Vec<usize>,
    invalid_sources: &mut HashMap<Vec<EdgeId>, Vec<String>>,
    incoming_all: Vec<Vec<EdgeId>>,
    incoming_invalid: Vec<usize>,
    incoming_sources: HashMap<Vec<EdgeId>, Vec<String>>,
) {
    // Step 1+2: dedup — build the merged `all`, mapping every old index (from both sides) to its
    // new index in the merged list; identical cycles (by canonical_cycle_key) collapse onto the
    // same new index.
    let mut canonical_to_new_index: HashMap<Vec<EdgeId>, usize> = HashMap::new();
    let mut merged_all: Vec<Vec<EdgeId>> = Vec::new();
    let mut existing_old_to_new: Vec<usize> = Vec::with_capacity(all.len());
    for cycle in all.iter() {
        let key = canonical_cycle_key(cycle);
        let new_index = *canonical_to_new_index.entry(key).or_insert_with(|| {
            merged_all.push(cycle.clone());
            merged_all.len() - 1
        });
        existing_old_to_new.push(new_index);
    }
    let mut incoming_old_to_new: Vec<usize> = Vec::with_capacity(incoming_all.len());
    for cycle in incoming_all.into_iter() {
        let key = canonical_cycle_key(&cycle);
        let new_index = *canonical_to_new_index.entry(key).or_insert_with(|| {
            merged_all.push(cycle);
            merged_all.len() - 1
        });
        incoming_old_to_new.push(new_index);
    }

    // Step 3: remap — translate both `invalid` index lists through the old->new mapping built
    // above, deduplicating (the same merged cycle may be invalid per both sides). Indexes via
    // `.get()`, not `[]` — a well-behaved `Check` only ever puts indices into `invalid` that are
    // valid for its own `all` (current producers assert this at construction time, see
    // `min_loop_length.rs`/`max_loop_length.rs`), but that's a caller contract, not something
    // this merge step can verify; an out-of-range index from a malformed future `Check` is
    // dropped (with a debug-build signal) rather than panicking the whole repair pipeline.
    let mut merged_invalid: Vec<usize> = Vec::new();
    let mut seen_invalid: HashSet<usize> = HashSet::new();
    for &old_idx in invalid.iter() {
        let Some(&new_idx) = existing_old_to_new.get(old_idx) else {
            debug_assert!(false, "merge_invalid_loops: invalid index {old_idx} out of range for existing.all (len {})", existing_old_to_new.len());
            continue;
        };
        if seen_invalid.insert(new_idx) {
            merged_invalid.push(new_idx);
        }
    }
    for &old_idx in incoming_invalid.iter() {
        let Some(&new_idx) = incoming_old_to_new.get(old_idx) else {
            debug_assert!(false, "merge_invalid_loops: invalid index {old_idx} out of range for incoming.all (len {})", incoming_old_to_new.len());
            continue;
        };
        if seen_invalid.insert(new_idx) {
            merged_invalid.push(new_idx);
        }
    }

    // invalid_sources: keyed by canonical key, no remap needed — union directly, deduplicating
    // per-check-id within each cycle's source list.
    for (key, sources) in incoming_sources {
        let entry = invalid_sources.entry(key).or_default();
        for source in sources {
            if !entry.contains(&source) {
                entry.push(source);
            }
        }
    }

    *all = merged_all;
    *invalid = merged_invalid;
}

/// Canonical merge for `IssueData::RegionsNeedingExpansion`. Unlike `merge_invalid_loops`, no
/// index remapping is needed: both sides' indices are into the same `maze.analysis.scc(&maze.graph)`
/// cache entry for this QC pass, so a given component index means the same region on both sides.
fn merge_regions_needing_expansion(
    invalid: &mut Vec<usize>,
    invalid_sources: &mut HashMap<usize, Vec<String>>,
    incoming_invalid: Vec<usize>,
    incoming_sources: HashMap<usize, Vec<String>>,
) {
    let mut seen: HashSet<usize> = invalid.iter().copied().collect();
    for idx in incoming_invalid {
        if seen.insert(idx) {
            invalid.push(idx);
        }
    }
    for (key, sources) in incoming_sources {
        let entry = invalid_sources.entry(key).or_default();
        for source in sources {
            if !entry.contains(&source) {
                entry.push(source);
            }
        }
    }
}

/// Canonical merge for `IssueData::MissingRegions`. A single `MinRegionCountCheck` instance now
/// reports every off-target class's balance in one issue (see GitHub issue #60's multi-instance
/// design, retired — there is normally exactly one active instance, so this merge rarely runs in
/// practice), but stays defined for the rare case of two instances active at once. Two entries
/// for the same class take the value **further from zero** (the stricter demand/surplus): for a
/// shared shortfall (`-N`) that's the more negative value; a shortfall and a surplus on the same
/// class in the same pass is a configuration conflict between instances, not something this
/// merge can resolve — `debug_assert!` against it rather than silently picking one side.
fn merge_missing_regions(
    balance_by_class: &mut HashMap<crate::graph::region_class::RegionClass, i32>,
    incoming: HashMap<crate::graph::region_class::RegionClass, i32>,
) {
    for (class, balance) in incoming {
        balance_by_class.entry(class)
            .and_modify(|b| {
                debug_assert!(
                    (*b < 0) == (balance < 0),
                    "merge_missing_regions: class {class:?} has conflicting-sign balances ({b} vs {balance}) from two instances in one rule"
                );
                *b = if b.abs() >= balance.abs() { *b } else { balance };
            })
            .or_insert(balance);
    }
}

#[cfg(test)]
mod merge_tests {
    use super::*;
    use crate::quality_control::INVALID_LOOP;

    fn issue(source_check: &str, all: Vec<Vec<EdgeId>>, invalid: Vec<usize>) -> Issue {
        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<String>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources.entry(canonical_cycle_key(&all[idx])).or_default().push(source_check.to_string());
        }
        Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid, invalid_sources }, source_check)
    }

    #[test]
    fn merge_keeps_each_source_checks_details_after_merge() {
        let mut a = issue("min_loop_length", vec![vec![1, 2, 3]], vec![0])
            .with_detail("min_loop_length", "threshold", "10".to_string());
        let b = issue("max_loop_length", vec![vec![4, 5, 6]], vec![0])
            .with_detail("max_loop_length", "threshold", "100".to_string());
        merge_issue(&mut a, b);

        assert_eq!(a.details().get("min_loop_length").and_then(|kv| kv.get("threshold")), Some(&"10".to_string()));
        assert_eq!(a.details().get("max_loop_length").and_then(|kv| kv.get("threshold")), Some(&"100".to_string()));
    }

    #[test]
    fn merge_disjoint_cycles_unions_all_and_invalid() {
        let mut a = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("unreachable_finish", vec![vec![4, 5, 6]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid, .. }) = &a.data else { panic!() };
        assert_eq!(all.len(), 2, "disjoint cycles must not collapse");
        assert_eq!(invalid.len(), 2, "both cycles are invalid, from different sources");
        assert_eq!(a.source_checks(), vec!["missing_endpoints".to_string(), "unreachable_finish".to_string()]);
    }

    #[test]
    fn merge_deduplicates_identical_cycle_found_by_both_sides() {
        // Same cycle, edges listed in a different order — must collapse to one entry in `all`.
        let mut a = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("unreachable_finish", vec![vec![3, 1, 2]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid, .. }) = &a.data else { panic!() };
        assert_eq!(all.len(), 1, "identical cycle (as an edge set) must not be duplicated");
        assert_eq!(invalid, &vec![0], "both sides' invalid index must collapse onto the same merged index");
    }

    #[test]
    fn merge_keeps_valid_cycles_distinct_from_invalid_ones() {
        let mut a = issue("missing_endpoints", vec![vec![1, 2, 3], vec![7, 8, 9]], vec![0]); // second cycle valid
        let b = issue("unreachable_finish", vec![vec![4, 5, 6]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid, .. }) = &a.data else { panic!() };
        assert_eq!(all.len(), 3);
        assert_eq!(invalid.len(), 2, "only the two flagged cycles are invalid; the valid one stays out of `invalid`");
    }

    #[test]
    fn merge_source_checks_has_no_duplicates() {
        let mut a = issue("missing_endpoints", vec![], vec![]);
        let b = issue("missing_endpoints", vec![], vec![]);
        merge_issue(&mut a, b);
        assert_eq!(a.source_checks(), vec!["missing_endpoints".to_string()], "merging the same source twice must not duplicate it");
    }

    #[test]
    fn merge_none_data_is_noop() {
        let mut a = Issue::new_from_check(crate::quality_control::MISSING_ENDPOINTS, "missing_endpoints");
        let b = Issue::new_from_check(crate::quality_control::MISSING_ENDPOINTS, "missing_endpoints");
        merge_issue(&mut a, b);
        assert_eq!(a.data, None);
        assert_eq!(a.source_checks(), vec!["missing_endpoints".to_string()]);
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_cycle() {
        // Same cycle (different edge order), flagged invalid by two different checks — both
        // check ids must end up attributed to it, not just one side's.
        let mut a = issue("min_loop_length", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("max_loop_length", vec![vec![3, 1, 2]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { invalid_sources, .. }) = &a.data else { panic!() };
        let key = canonical_cycle_key(&[1, 2, 3]);
        let sources = invalid_sources.get(&key).expect("merged cycle must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"min_loop_length".to_string()));
        assert!(sources.contains(&"max_loop_length".to_string()));
    }

    #[test]
    fn merge_invalid_sources_no_duplicate_for_repeated_check() {
        let mut a = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { invalid_sources, .. }) = &a.data else { panic!() };
        let key = canonical_cycle_key(&[1, 2, 3]);
        assert_eq!(invalid_sources.get(&key), Some(&vec!["missing_endpoints".to_string()]));
    }

    #[test]
    fn merge_invalid_sources_associative_regardless_of_merge_order() {
        let a = issue("missing_endpoints", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("unreachable_finish", vec![vec![1, 2, 3]], vec![0]);
        let c = issue("min_loops_count", vec![vec![1, 2, 3]], vec![0]);

        let mut left_first = a.clone();
        merge_issue(&mut left_first, b.clone());
        merge_issue(&mut left_first, c.clone());

        let mut right_first = b.clone();
        merge_issue(&mut right_first, c.clone());
        merge_issue(&mut right_first, a.clone());

        let key = canonical_cycle_key(&[1, 2, 3]);
        let extract_sorted = |issue: &Issue| {
            let Some(IssueData::InvalidLoops { invalid_sources, .. }) = &issue.data else { panic!() };
            let mut sources = invalid_sources.get(&key).cloned().unwrap_or_default();
            sources.sort_unstable();
            sources
        };
        assert_eq!(extract_sorted(&left_first), extract_sorted(&right_first));
        assert_eq!(extract_sorted(&left_first), vec!["min_loops_count".to_string(), "missing_endpoints".to_string(), "unreachable_finish".to_string()]);
    }

    #[test]
    #[cfg_attr(debug_assertions, should_panic(expected = "out of range"))]
    fn merge_drops_out_of_range_invalid_index_instead_of_panicking() {
        // A malformed `Check` impl could put an index into `invalid` that's out of range for its
        // own `all`. `merge_invalid_loops`'s remap step uses `.get()`, not `[]`, so the actual
        // (release-build) behavior is "drop the bad index, keep going" — never an array-index
        // panic. In a debug build the `debug_assert!` deliberately still fires (loud signal for
        // whoever's developing a new `Check` and got this wrong); this test asserts on that
        // debug-only panic message rather than disabling debug_assertions to exercise the
        // release path, since `cargo test` always builds with them on.
        let mut a = Issue::with_data_from_check(
            INVALID_LOOP,
            IssueData::InvalidLoops { all: vec![vec![1, 2, 3]], invalid: vec![99], invalid_sources: HashMap::new() },
            "missing_endpoints",
        );
        let b = issue("unreachable_finish", vec![vec![4, 5, 6]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid, .. }) = &a.data else { panic!() };
        assert_eq!(all.len(), 2, "both cycles still end up in the merged all");
        assert_eq!(invalid, &vec![1], "the out-of-range index is dropped; only check_b's valid index survives");
    }

    fn region_needs_expansion_issue(source_check: &str, invalid: Vec<usize>) -> Issue {
        let mut invalid_sources: HashMap<usize, Vec<String>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources.entry(idx).or_default().push(source_check.to_string());
        }
        Issue::with_data_from_check(
            crate::quality_control::REGION_NEEDS_EXPANSION,
            IssueData::RegionsNeedingExpansion { invalid, invalid_sources },
            source_check,
        )
    }

    #[test]
    fn merge_regions_needing_expansion_unions_disjoint_indices() {
        let mut a = region_needs_expansion_issue("min_region_size", vec![0]);
        let b = region_needs_expansion_issue("min_region_ratio", vec![1]);
        merge_issue(&mut a, b);

        let Some(IssueData::RegionsNeedingExpansion { invalid, .. }) = &a.data else { panic!() };
        assert_eq!(invalid.len(), 2);
        assert!(invalid.contains(&0));
        assert!(invalid.contains(&1));
    }

    #[test]
    fn merge_regions_needing_expansion_deduplicates_shared_index() {
        let mut a = region_needs_expansion_issue("min_region_size", vec![0]);
        let b = region_needs_expansion_issue("min_region_ratio", vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::RegionsNeedingExpansion { invalid, invalid_sources }) = &a.data else { panic!() };
        assert_eq!(invalid, &vec![0], "the same region index found by both checks must not be duplicated");
        let sources = invalid_sources.get(&0).expect("region 0 must have recorded sources");
        assert!(sources.contains(&"min_region_size".to_string()));
        assert!(sources.contains(&"min_region_ratio".to_string()));
    }

    fn missing_regions_issue(source_check: &str, class: crate::graph::region_class::RegionClass, balance: i32) -> Issue {
        Issue::with_data_from_check(
            crate::quality_control::MISSING_REGIONS,
            IssueData::MissingRegions { balance_by_class: HashMap::from([(class, balance)]) },
            source_check,
        )
    }

    #[test]
    fn merge_missing_regions_unions_different_classes() {
        use crate::graph::region_class::RegionClass;
        let mut a = missing_regions_issue("min_region_count_1", RegionClass::Trap, -2);
        let b = missing_regions_issue("min_region_count_2", RegionClass::Alternative, 1);
        merge_issue(&mut a, b);

        let Some(IssueData::MissingRegions { balance_by_class }) = &a.data else { panic!() };
        assert_eq!(balance_by_class, &HashMap::from([(RegionClass::Trap, -2), (RegionClass::Alternative, 1)]));
    }

    #[test]
    fn merge_missing_regions_takes_stricter_for_same_class() {
        use crate::graph::region_class::RegionClass;
        let mut a = missing_regions_issue("min_region_count_1", RegionClass::Trap, -2);
        let b = missing_regions_issue("min_region_count_2", RegionClass::Trap, -5);
        merge_issue(&mut a, b);

        let Some(IssueData::MissingRegions { balance_by_class }) = &a.data else { panic!() };
        assert_eq!(balance_by_class, &HashMap::from([(RegionClass::Trap, -5)]),
            "same-class shortfalls describe one underlying demand — take the stricter (further from zero), not the sum");
    }

    fn invalid_teleports_issue(source_check: &str, invalid: Vec<crate::ids::EdgeId>) -> Issue {
        Issue::with_data_from_check(
            crate::quality_control::INVALID_TELEPORT,
            IssueData::InvalidTeleports { invalid },
            source_check,
        )
    }

    #[test]
    fn merge_invalid_teleports_unions_disjoint_edge_ids() {
        // e.g. teleport_duplicates_connection flags edge 0, teleport_waypoint_distance flags a
        // different edge 1 in the same pass — both must survive in the merged issue.
        let mut a = invalid_teleports_issue("teleport_duplicates_connection", vec![0]);
        let b = invalid_teleports_issue("teleport_waypoint_distance", vec![1]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidTeleports { invalid }) = &a.data else { panic!() };
        assert_eq!(invalid.len(), 2);
        assert!(invalid.contains(&0));
        assert!(invalid.contains(&1));
    }

    #[test]
    fn merge_invalid_teleports_deduplicates_shared_edge_id() {
        // The same teleport edge flagged by two different checks (e.g. both duplicates a
        // connection AND sits too close to start) must appear once in the merged issue.
        let mut a = invalid_teleports_issue("teleport_duplicates_connection", vec![0]);
        let b = invalid_teleports_issue("teleport_waypoint_distance", vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidTeleports { invalid }) = &a.data else { panic!() };
        assert_eq!(invalid, &vec![0], "the same edge id flagged by both checks must not be duplicated");
    }

    fn teleport_proximity_pairs_issue(source_check: &str, pairs: Vec<(crate::ids::EdgeId, crate::ids::EdgeId)>) -> Issue {
        Issue::with_data_from_check(
            crate::quality_control::TELEPORT_GROUP_PROXIMITY,
            IssueData::TeleportProximityPairs { pairs },
            source_check,
        )
    }

    #[test]
    fn merge_teleport_proximity_pairs_unions_disjoint_pairs() {
        let mut a = teleport_proximity_pairs_issue("rule_1:a", vec![(0, 1)]);
        let b = teleport_proximity_pairs_issue("rule_1:b", vec![(2, 3)]);
        merge_issue(&mut a, b);

        let Some(IssueData::TeleportProximityPairs { pairs }) = &a.data else { panic!() };
        assert_eq!(pairs.len(), 2);
        assert!(pairs.contains(&(0, 1)));
        assert!(pairs.contains(&(2, 3)));
    }

    #[test]
    fn merge_teleport_proximity_pairs_deduplicates_identical_pair() {
        let mut a = teleport_proximity_pairs_issue("rule_1:a", vec![(0, 1)]);
        let b = teleport_proximity_pairs_issue("rule_1:b", vec![(0, 1)]);
        merge_issue(&mut a, b);

        let Some(IssueData::TeleportProximityPairs { pairs }) = &a.data else { panic!() };
        assert_eq!(pairs, &vec![(0, 1)], "the same pair flagged by both checks must not be duplicated");
    }

    #[test]
    fn merge_teleport_proximity_pairs_deduplicates_reversed_pair() {
        // (a, b) and (b, a) are the same pair (order carries no meaning) -- must collapse to one
        // entry, not be kept as two "different" pairs.
        let mut a = teleport_proximity_pairs_issue("rule_1:a", vec![(0, 1)]);
        let b = teleport_proximity_pairs_issue("rule_1:b", vec![(1, 0)]);
        merge_issue(&mut a, b);

        let Some(IssueData::TeleportProximityPairs { pairs }) = &a.data else { panic!() };
        assert_eq!(pairs.len(), 1, "(0,1) and (1,0) must collapse to a single unordered pair: {pairs:?}");
    }
}
