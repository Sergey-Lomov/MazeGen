use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use rand::SeedableRng;
use rand::rngs::SmallRng;
use crate::{Graph, Maze};
use crate::ids::EdgeId;
use crate::space::{Field, Tessellation};
use crate::quality_control::{Issue, IssueData, QualityControlEngine, REPAIR_LIMIT_REACHED, QC_NO_PROGRESS};
use crate::quality_control::issue_data::{canonical_cycle_key, RepairLimitKind};
use crate::repair::{RepairEngine, RepairResult};
use super::PresetState;

pub const MAX_REPAIR_ITERATIONS: usize = 10;

/// Caps on the repair fixpoint loop in `build_maze`. Both bounds are optional and independent —
/// whichever is hit first stops the loop. `None` for both means the loop only stops on
/// convergence (no active issues) or no-progress, with no hard cap; callers surfacing this to
/// users should treat "both None" as worth flagging, since an unconverging rule set can then loop
/// indefinitely.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RepairLimits {
    pub max_iterations: Option<usize>,
    pub time_budget_secs: Option<f64>,
}

impl Default for RepairLimits {
    fn default() -> Self {
        RepairLimits { max_iterations: Some(MAX_REPAIR_ITERATIONS), time_budget_secs: None }
    }
}

/// Milliseconds since an arbitrary epoch — only ever used for measuring elapsed duration within
/// one `build_maze` call, never compared across calls. `std::time::Instant` panics on
/// `wasm32-unknown-unknown` (no syscall backing it), so the wasm target reads `Performance.now()`
/// via `js-sys` instead; native (including `cargo test`) uses the monotonic `Instant` clock.
#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

pub fn build_maze<T: Tessellation>(
    field: Field<T>,
    graph: Graph,
    seed: u64,
    qc_engine: QualityControlEngine<T>,
    repair_engine: RepairEngine<T>,
    preset_state: &PresetState,
    limits: RepairLimits,
) -> (Maze<T>, Vec<crate::quality_control::Issue>) {
    let mut maze = Maze::new(field, graph);
    let mut rng = SmallRng::seed_from_u64(seed);
    let mut failed: HashSet<String> = HashSet::new();
    let mut previous_active: Option<Vec<(String, Issue)>> = None;
    let check_id_to_rule = repair_engine.check_id_to_rule();
    let start_ms = now_ms();

    let mut iterations_done = 0usize;
    let mut limit_reached: Option<RepairLimitKind> = None;
    let mut no_progress_rules: Option<Vec<String>> = None;
    loop {
        if let Some(max) = limits.max_iterations {
            if iterations_done >= max { limit_reached = Some(RepairLimitKind::MaxIterations); break; }
        }
        if let Some(budget_secs) = limits.time_budget_secs {
            if now_ms() - start_ms >= budget_secs * 1000.0 { limit_reached = Some(RepairLimitKind::TimeBudget); break; }
        }
        iterations_done += 1;

        let issues = qc_engine.run(&maze, &mut rng);
        // Merge (not drop) issues that share a rule — multiple checks in the same rule may
        // legitimately produce the same IssueKind (e.g. several reasons a cycle can be invalid).
        // See merge_issue. An issue this loop can't route to any rule (zero source checks, e.g.
        // CYCLE_ANALYSIS_OVERFLOWED, or a check id with no configured rule) is dropped from this
        // iteration's `by_rule` map entirely — it plays no part in this iteration's repair pass.
        // It is not lost from the maze's perspective: the final `qc_engine.run` call after the
        // loop (see `remaining` below) recomputes issues fresh and will surface it there if it's
        // still present, the same way CYCLE_ANALYSIS_OVERFLOWED (never routed, never repaired)
        // does today.
        let mut by_rule: HashMap<String, Issue> = HashMap::new();
        for issue in issues {
            // `single_source_check` returns `None` both for the legitimate zero-source case and
            // for a malformed 2+-source raw issue (debug_assert below catches the latter in
            // debug builds) — either way, routing as "no rule" is the safe outcome: a release
            // build never silently misroutes by an arbitrary first source.
            debug_assert!(issue.source_checks().len() <= 1,
                "raw issue must have at most one source check before merge — \
                 Issue::new_from_check/with_data_from_check always set exactly one, \
                 Issue::new/with_data set none");
            let Some(rule_id) = issue.single_source_check()
                .and_then(|check_id| check_id_to_rule.get(&check_id))
            else { continue };
            if failed.contains(rule_id) { continue; }
            match by_rule.entry(rule_id.clone()) {
                Entry::Occupied(mut e) => merge_issue(e.get_mut(), issue),
                Entry::Vacant(e) => { e.insert(issue); }
            }
        }
        // Rules with no registered strategy still merge their issues (for attribution), but
        // must not participate in fingerprint/progress-tracking or repair dispatch — same final
        // effect as today's "kind without a strategy is skipped", just keyed by rule now.
        let strategy_rule_ids = repair_engine.strategy_rule_ids();
        let mut active: Vec<(String, Issue)> = by_rule.into_iter()
            .filter(|(rule_id, _)| strategy_rule_ids.contains(rule_id.as_str()))
            .collect();
        if active.is_empty() {
            break;
        }
        active.sort_unstable_by(|(a, _), (b, _)| a.cmp(b));
        // Progress guard compares full (rule_id, Issue) content, not just the set of active rule
        // ids — two iterations producing the same rule with genuinely different issue data (e.g.
        // different cycles flagged invalid) must not look like a no-progress oscillation. See
        // https://github.com/Sergey-Lomov/MazeGen/issues/27.
        if Some(&active) == previous_active.as_ref() {
            no_progress_rules = Some(active.iter().map(|(rule_id, _)| rule_id.clone()).collect());
            break;
        }
        previous_active = Some(active.clone());

        let results = repair_engine.run(&active, &mut maze, &mut rng, preset_state);
        for outcome in &results {
            match &outcome.result {
                RepairResult::Failed => { failed.insert(outcome.rule_id.clone()); }
                RepairResult::Fixed { score: Some(s) } => {
                    if maze.meta.route_score.is_none() {
                        maze.meta.route_score = Some(*s);
                    }
                }
                RepairResult::Fixed { score: None } => {}
            }
        }
    }

    let mut remaining = qc_engine.run(&maze, &mut rng);
    // `limit_reached` is only `Some` when the loop's own cap (not convergence, not no-progress)
    // cut the repair short — surfaced as its own issue (rather than silently folded into
    // whatever QC issues remain) so the user can tell "still broken because the cap fired" apart
    // from "still broken because no strategy could fix it". Not a toggleable `Check<T>`, so —
    // like `CYCLE_ANALYSIS_OVERFLOWED` — it carries no source check.
    if let Some(limit) = limit_reached {
        remaining.push(Issue::with_data(REPAIR_LIMIT_REACHED, IssueData::RepairLimitReached { limit }));
    }
    // Mirrors the `limit_reached` push above — surfaces *why* the loop stopped early as its own
    // issue, distinct from "ran out of iterations/time" (`REPAIR_LIMIT_REACHED`). Naming the
    // stuck rule(s) makes a structural conflict (e.g. contradictory min/max thresholds on the
    // same metric) visible without having to infer it from the leftover QC issues alone.
    if let Some(rule_ids) = no_progress_rules {
        remaining.push(Issue::with_data(QC_NO_PROGRESS, IssueData::QcNoProgress { rule_ids }));
    }
    (maze, remaining)
}

/// Merges `incoming` into `existing` — both share `existing.kind`. Used when two checks
/// (or, in principle, the same check twice) produce an issue of the same kind in one QC pass.
/// Always unions data rather than picking one side — there is no precedence between sources,
/// nothing is discarded (see `Specs/quality_control.md`'s "Dedup interaction" section).
fn merge_issue(existing: &mut Issue, mut incoming: Issue) {
    for &source in incoming.source_checks() {
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
    invalid_sources: &mut HashMap<Vec<EdgeId>, Vec<crate::repair::CheckId>>,
    incoming_all: Vec<Vec<EdgeId>>,
    incoming_invalid: Vec<usize>,
    incoming_sources: HashMap<Vec<EdgeId>, Vec<crate::repair::CheckId>>,
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
    invalid_sources: &mut HashMap<usize, Vec<crate::repair::CheckId>>,
    incoming_invalid: Vec<usize>,
    incoming_sources: HashMap<usize, Vec<crate::repair::CheckId>>,
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

#[cfg(test)]
mod merge_tests {
    use super::*;
    use crate::quality_control::INVALID_LOOP;
    use crate::repair::CheckId;

    fn issue(source_check: CheckId, all: Vec<Vec<EdgeId>>, invalid: Vec<usize>) -> Issue {
        let mut invalid_sources: HashMap<Vec<EdgeId>, Vec<CheckId>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources.entry(canonical_cycle_key(&all[idx])).or_default().push(source_check);
        }
        Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid, invalid_sources }, source_check)
    }

    #[test]
    fn merge_keeps_each_source_checks_details_after_merge() {
        let mut a = issue(CheckId::MinLoopLength, vec![vec![1, 2, 3]], vec![0])
            .with_detail(CheckId::MinLoopLength, "threshold", "10".to_string());
        let b = issue(CheckId::MaxLoopLength, vec![vec![4, 5, 6]], vec![0])
            .with_detail(CheckId::MaxLoopLength, "threshold", "100".to_string());
        merge_issue(&mut a, b);

        assert_eq!(a.details().get(&CheckId::MinLoopLength).and_then(|kv| kv.get("threshold")), Some(&"10".to_string()));
        assert_eq!(a.details().get(&CheckId::MaxLoopLength).and_then(|kv| kv.get("threshold")), Some(&"100".to_string()));
    }

    #[test]
    fn merge_disjoint_cycles_unions_all_and_invalid() {
        let mut a = issue(CheckId::MissingEndpoints, vec![vec![1, 2, 3]], vec![0]);
        let b = issue(CheckId::UnreachableFinish, vec![vec![4, 5, 6]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid, .. }) = &a.data else { panic!() };
        assert_eq!(all.len(), 2, "disjoint cycles must not collapse");
        assert_eq!(invalid.len(), 2, "both cycles are invalid, from different sources");
        assert_eq!(a.source_checks(), vec![CheckId::MissingEndpoints, CheckId::UnreachableFinish]);
    }

    #[test]
    fn merge_deduplicates_identical_cycle_found_by_both_sides() {
        // Same cycle, edges listed in a different order — must collapse to one entry in `all`.
        let mut a = issue(CheckId::MissingEndpoints, vec![vec![1, 2, 3]], vec![0]);
        let b = issue(CheckId::UnreachableFinish, vec![vec![3, 1, 2]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid, .. }) = &a.data else { panic!() };
        assert_eq!(all.len(), 1, "identical cycle (as an edge set) must not be duplicated");
        assert_eq!(invalid, &vec![0], "both sides' invalid index must collapse onto the same merged index");
    }

    #[test]
    fn merge_keeps_valid_cycles_distinct_from_invalid_ones() {
        let mut a = issue(CheckId::MissingEndpoints, vec![vec![1, 2, 3], vec![7, 8, 9]], vec![0]); // second cycle valid
        let b = issue(CheckId::UnreachableFinish, vec![vec![4, 5, 6]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid, .. }) = &a.data else { panic!() };
        assert_eq!(all.len(), 3);
        assert_eq!(invalid.len(), 2, "only the two flagged cycles are invalid; the valid one stays out of `invalid`");
    }

    #[test]
    fn merge_source_checks_has_no_duplicates() {
        let mut a = issue(CheckId::MissingEndpoints, vec![], vec![]);
        let b = issue(CheckId::MissingEndpoints, vec![], vec![]);
        merge_issue(&mut a, b);
        assert_eq!(a.source_checks(), vec![CheckId::MissingEndpoints], "merging the same source twice must not duplicate it");
    }

    #[test]
    fn merge_none_data_is_noop() {
        let mut a = Issue::new_from_check(crate::quality_control::MISSING_ENDPOINTS, CheckId::MissingEndpoints);
        let b = Issue::new_from_check(crate::quality_control::MISSING_ENDPOINTS, CheckId::MissingEndpoints);
        merge_issue(&mut a, b);
        assert_eq!(a.data, None);
        assert_eq!(a.source_checks(), vec![CheckId::MissingEndpoints]);
    }

    #[test]
    fn merge_invalid_sources_unions_check_ids_for_same_cycle() {
        // Same cycle (different edge order), flagged invalid by two different checks — both
        // check ids must end up attributed to it, not just one side's.
        let mut a = issue(CheckId::MinLoopLength, vec![vec![1, 2, 3]], vec![0]);
        let b = issue(CheckId::MaxLoopLength, vec![vec![3, 1, 2]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { invalid_sources, .. }) = &a.data else { panic!() };
        let key = canonical_cycle_key(&[1, 2, 3]);
        let sources = invalid_sources.get(&key).expect("merged cycle must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&CheckId::MinLoopLength));
        assert!(sources.contains(&CheckId::MaxLoopLength));
    }

    #[test]
    fn merge_invalid_sources_no_duplicate_for_repeated_check() {
        let mut a = issue(CheckId::MissingEndpoints, vec![vec![1, 2, 3]], vec![0]);
        let b = issue(CheckId::MissingEndpoints, vec![vec![1, 2, 3]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { invalid_sources, .. }) = &a.data else { panic!() };
        let key = canonical_cycle_key(&[1, 2, 3]);
        assert_eq!(invalid_sources.get(&key), Some(&vec![CheckId::MissingEndpoints]));
    }

    #[test]
    fn merge_invalid_sources_associative_regardless_of_merge_order() {
        let a = issue(CheckId::MissingEndpoints, vec![vec![1, 2, 3]], vec![0]);
        let b = issue(CheckId::UnreachableFinish, vec![vec![1, 2, 3]], vec![0]);
        let c = issue(CheckId::MinLoopsCount, vec![vec![1, 2, 3]], vec![0]);

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
        assert_eq!(extract_sorted(&left_first), vec![CheckId::MissingEndpoints, CheckId::UnreachableFinish, CheckId::MinLoopsCount]);
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
            CheckId::MissingEndpoints,
        );
        let b = issue(CheckId::UnreachableFinish, vec![vec![4, 5, 6]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid, .. }) = &a.data else { panic!() };
        assert_eq!(all.len(), 2, "both cycles still end up in the merged all");
        assert_eq!(invalid, &vec![1], "the out-of-range index is dropped; only check_b's valid index survives");
    }

    fn region_needs_expansion_issue(source_check: CheckId, invalid: Vec<usize>) -> Issue {
        let mut invalid_sources: HashMap<usize, Vec<CheckId>> = HashMap::new();
        for &idx in &invalid {
            invalid_sources.entry(idx).or_default().push(source_check);
        }
        Issue::with_data_from_check(
            crate::quality_control::REGION_NEEDS_EXPANSION,
            IssueData::RegionsNeedingExpansion { invalid, invalid_sources },
            source_check,
        )
    }

    #[test]
    fn merge_regions_needing_expansion_unions_disjoint_indices() {
        let mut a = region_needs_expansion_issue(CheckId::MinRegionSize, vec![0]);
        let b = region_needs_expansion_issue(CheckId::MinRegionRatio, vec![1]);
        merge_issue(&mut a, b);

        let Some(IssueData::RegionsNeedingExpansion { invalid, .. }) = &a.data else { panic!() };
        assert_eq!(invalid.len(), 2);
        assert!(invalid.contains(&0));
        assert!(invalid.contains(&1));
    }

    #[test]
    fn merge_regions_needing_expansion_deduplicates_shared_index() {
        let mut a = region_needs_expansion_issue(CheckId::MinRegionSize, vec![0]);
        let b = region_needs_expansion_issue(CheckId::MinRegionRatio, vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::RegionsNeedingExpansion { invalid, invalid_sources }) = &a.data else { panic!() };
        assert_eq!(invalid, &vec![0], "the same region index found by both checks must not be duplicated");
        let sources = invalid_sources.get(&0).expect("region 0 must have recorded sources");
        assert!(sources.contains(&CheckId::MinRegionSize));
        assert!(sources.contains(&CheckId::MinRegionRatio));
    }
}
