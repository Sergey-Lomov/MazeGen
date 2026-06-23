use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use rand::SeedableRng;
use rand::rngs::SmallRng;
use crate::{Graph, Maze};
use crate::ids::EdgeId;
use crate::space::{Field, Tessellation};
use crate::quality_control::{Issue, IssueData, IssueKind, QualityControlEngine};
use crate::repair::{RepairEngine, RepairResult};
use super::PresetState;

pub const MAX_REPAIR_ITERATIONS: usize = 8;

pub fn build_maze<T: Tessellation>(
    field: Field<T>,
    graph: Graph,
    seed: u64,
    qc_engine: QualityControlEngine<T>,
    repair_engine: RepairEngine<T>,
    preset_state: &PresetState,
) -> (Maze<T>, Vec<crate::quality_control::Issue>) {
    let mut maze = Maze::new(field, graph);
    let mut rng = SmallRng::seed_from_u64(seed);
    let mut failed: HashSet<IssueKind> = HashSet::new();
    let mut previous_fingerprint: Option<Vec<IssueKind>> = None;

    for _ in 0..MAX_REPAIR_ITERATIONS {
        let issues = qc_engine.run(&maze);
        // Merge (not drop) issues that share a kind — multiple checks may legitimately produce
        // the same IssueKind (e.g. several reasons a cycle can be invalid). See merge_issue.
        let mut by_kind: HashMap<IssueKind, Issue> = HashMap::new();
        for issue in issues {
            if failed.contains(&issue.kind) { continue; }
            match by_kind.entry(issue.kind) {
                Entry::Occupied(mut e) => merge_issue(e.get_mut(), issue),
                Entry::Vacant(e) => { e.insert(issue); }
            }
        }
        let active: Vec<Issue> = by_kind.into_values().collect();
        if active.is_empty() {
            break;
        }
        let mut fingerprint: Vec<IssueKind> = active.iter().map(|i| i.kind).collect();
        fingerprint.sort_unstable();
        if Some(&fingerprint) == previous_fingerprint.as_ref() {
            break;
        }
        previous_fingerprint = Some(fingerprint);

        let results = repair_engine.run(&active, &mut maze, &mut rng, preset_state);
        for (kind, result) in &results {
            match result {
                RepairResult::Failed => { failed.insert(*kind); }
                RepairResult::Fixed { score: Some(s) } => {
                    if maze.meta.route_score.is_none() {
                        maze.meta.route_score = Some(*s);
                    }
                }
                RepairResult::Fixed { score: None } => {}
            }
        }
    }

    let remaining = qc_engine.run(&maze);
    (maze, remaining)
}

/// Merges `incoming` into `existing` — both share `existing.kind`. Used when two checks
/// (or, in principle, the same check twice) produce an issue of the same kind in one QC pass.
/// Always unions data rather than picking one side — there is no precedence between sources,
/// nothing is discarded (see `Specs/quality_control.md`'s "Dedup interaction" section).
fn merge_issue(existing: &mut Issue, incoming: Issue) {
    for source in incoming.source_checks {
        if !existing.source_checks.contains(&source) {
            existing.source_checks.push(source);
        }
    }
    match (&mut existing.data, incoming.data) {
        (Some(IssueData::InvalidLoops { all, invalid }), Some(IssueData::InvalidLoops { all: incoming_all, invalid: incoming_invalid })) => {
            merge_invalid_loops(all, invalid, incoming_all, incoming_invalid);
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
/// with two different indices in `invalid`.
fn merge_invalid_loops(
    all: &mut Vec<Vec<EdgeId>>,
    invalid: &mut Vec<usize>,
    incoming_all: Vec<Vec<EdgeId>>,
    incoming_invalid: Vec<usize>,
) {
    // Step 1: normalize — canonical key per cycle (sorted edge set), computed once per cycle.
    fn canonical_key(cycle: &[EdgeId]) -> Vec<EdgeId> {
        let mut key = cycle.to_vec();
        key.sort_unstable();
        key
    }

    // Step 2: dedup — build the merged `all`, mapping every old index (from both sides) to its
    // new index in the merged list; identical cycles collapse onto the same new index.
    let mut canonical_to_new_index: HashMap<Vec<EdgeId>, usize> = HashMap::new();
    let mut merged_all: Vec<Vec<EdgeId>> = Vec::new();
    let mut existing_old_to_new: Vec<usize> = Vec::with_capacity(all.len());
    for cycle in all.iter() {
        let key = canonical_key(cycle);
        let new_index = *canonical_to_new_index.entry(key).or_insert_with(|| {
            merged_all.push(cycle.clone());
            merged_all.len() - 1
        });
        existing_old_to_new.push(new_index);
    }
    let mut incoming_old_to_new: Vec<usize> = Vec::with_capacity(incoming_all.len());
    for cycle in incoming_all.into_iter() {
        let key = canonical_key(&cycle);
        let new_index = *canonical_to_new_index.entry(key).or_insert_with(|| {
            merged_all.push(cycle);
            merged_all.len() - 1
        });
        incoming_old_to_new.push(new_index);
    }

    // Step 3: remap — translate both `invalid` index lists through the old->new mapping built
    // above, deduplicating (the same merged cycle may be invalid per both sides).
    let mut merged_invalid: Vec<usize> = Vec::new();
    let mut seen_invalid: HashSet<usize> = HashSet::new();
    for &old_idx in invalid.iter() {
        let new_idx = existing_old_to_new[old_idx];
        if seen_invalid.insert(new_idx) {
            merged_invalid.push(new_idx);
        }
    }
    for &old_idx in incoming_invalid.iter() {
        let new_idx = incoming_old_to_new[old_idx];
        if seen_invalid.insert(new_idx) {
            merged_invalid.push(new_idx);
        }
    }

    *all = merged_all;
    *invalid = merged_invalid;
}

#[cfg(test)]
mod merge_tests {
    use super::*;
    use crate::quality_control::INVALID_LOOP;

    fn issue(source_check: &'static str, all: Vec<Vec<EdgeId>>, invalid: Vec<usize>) -> Issue {
        Issue::with_data_from_check(INVALID_LOOP, IssueData::InvalidLoops { all, invalid }, source_check)
    }

    #[test]
    fn merge_disjoint_cycles_unions_all_and_invalid() {
        let mut a = issue("check_a", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("check_b", vec![vec![4, 5, 6]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid }) = &a.data else { panic!() };
        assert_eq!(all.len(), 2, "disjoint cycles must not collapse");
        assert_eq!(invalid.len(), 2, "both cycles are invalid, from different sources");
        assert_eq!(a.source_checks, vec!["check_a", "check_b"]);
    }

    #[test]
    fn merge_deduplicates_identical_cycle_found_by_both_sides() {
        // Same cycle, edges listed in a different order — must collapse to one entry in `all`.
        let mut a = issue("check_a", vec![vec![1, 2, 3]], vec![0]);
        let b = issue("check_b", vec![vec![3, 1, 2]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid }) = &a.data else { panic!() };
        assert_eq!(all.len(), 1, "identical cycle (as an edge set) must not be duplicated");
        assert_eq!(invalid, &vec![0], "both sides' invalid index must collapse onto the same merged index");
    }

    #[test]
    fn merge_keeps_valid_cycles_distinct_from_invalid_ones() {
        let mut a = issue("check_a", vec![vec![1, 2, 3], vec![7, 8, 9]], vec![0]); // second cycle valid
        let b = issue("check_b", vec![vec![4, 5, 6]], vec![0]);
        merge_issue(&mut a, b);

        let Some(IssueData::InvalidLoops { all, invalid }) = &a.data else { panic!() };
        assert_eq!(all.len(), 3);
        assert_eq!(invalid.len(), 2, "only the two flagged cycles are invalid; the valid one stays out of `invalid`");
    }

    #[test]
    fn merge_source_checks_has_no_duplicates() {
        let mut a = issue("check_a", vec![], vec![]);
        let b = issue("check_a", vec![], vec![]);
        merge_issue(&mut a, b);
        assert_eq!(a.source_checks, vec!["check_a"], "merging the same source twice must not duplicate it");
    }

    #[test]
    fn merge_none_data_is_noop() {
        let mut a = Issue::new_from_check(crate::quality_control::MISSING_ENDPOINTS, "missing_endpoints");
        let b = Issue::new_from_check(crate::quality_control::MISSING_ENDPOINTS, "missing_endpoints");
        merge_issue(&mut a, b);
        assert_eq!(a.data, None);
        assert_eq!(a.source_checks, vec!["missing_endpoints"]);
    }
}
