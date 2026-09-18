use crate::graph::scc::{ComponentId, ConnectedComponents};
use crate::ids::NodeId;
use crate::repair::command::MutationCommand;
use rand::{Rng, RngCore};
use std::collections::HashSet;

/// Shared `target_mode` param id/values/selection logic for every strategy that merges an
/// undersized SCC region into a neighboring region (`ExpandRegionPassageStrategy` — geometric
/// adjacency — and `TeleportRegionMergeStrategy` — any node pair, no adjacency requirement).
/// Each strategy owns its own candidate-discovery (what counts as a "neighbor" and how a
/// bridging connection is actually applied) — only region selection and the merge-loop
/// bookkeeping (`pending`/`merged_away`/`needy`) live here.
pub const PARAM_TARGET_MODE: &str = "target_mode";
pub const PARAM_PREFER_PARTIALLY_CONNECTED: &str = "prefer_partially_connected";

pub const MODE_LARGEST: &str = "largest";
pub const MODE_SMALLEST: &str = "smallest";
pub const MODE_RANDOM: &str = "random";
pub const MODE_PREFER_NEEDY: &str = "prefer_needy";

pub static MODE_OPTIONS: &[&str] = &[MODE_LARGEST, MODE_SMALLEST, MODE_RANDOM, MODE_PREFER_NEEDY];

/// Picks one component id from `pool` according to `mode`: `largest`/`smallest` by
/// `components[i].len()`, `prefer_needy` biased toward flagged (`needy`) neighbors (falling back
/// to the whole pool if none are needy), `random` (or any unrecognized mode — shouldn't happen,
/// `build_params` always falls back to the enum's default) uniform via `rng`. `pool`'s ids must
/// already be sorted by the caller for reproducible tie-breaking/`rng`-indexed picks (component
/// ids are typically collected from a `HashMap`'s randomized-per-process iteration order).
pub fn pick_by_mode(
    pool: &[ComponentId],
    scc: &ConnectedComponents,
    mode: &str,
    needy: &HashSet<ComponentId>,
    rng: &mut dyn RngCore,
) -> Option<ComponentId> {
    if pool.is_empty() {
        return None;
    }
    match mode {
        MODE_LARGEST => pool
            .iter()
            .copied()
            .max_by_key(|i| scc.components[*i].len()),
        MODE_SMALLEST => pool
            .iter()
            .copied()
            .min_by_key(|i| scc.components[*i].len()),
        MODE_PREFER_NEEDY => {
            let needy_candidates: Vec<ComponentId> =
                pool.iter().copied().filter(|i| needy.contains(i)).collect();
            let sub_pool = if needy_candidates.is_empty() {
                pool
            } else {
                &needy_candidates
            };
            Some(sub_pool[rng.random_range(0..sub_pool.len())])
        }
        _ => Some(pool[rng.random_range(0..pool.len())]),
    }
}

/// Given `prefer_partial` and a full `pool` of candidate neighbor ids plus a `partial` subset
/// (neighbors already carrying exactly one direction of a connection to the region), returns
/// whichever pool `target_mode` should then apply to: `partial` if preference is on and
/// non-empty, otherwise the full `pool`. Shared pre-filter step ahead of `pick_by_mode`, common
/// to every merge strategy with a `prefer_partially_connected`-style param.
pub fn narrow_to_partial<'a>(
    pool: &'a [ComponentId],
    partial: &'a [ComponentId],
    prefer_partial: bool,
) -> &'a [ComponentId] {
    if prefer_partial && !partial.is_empty() {
        partial
    } else {
        pool
    }
}

/// Runs the shared "merge every flagged region into a chosen neighbor" loop: pops region ids
/// from `invalid` (LIFO), skips ones already absorbed by an earlier merge in this call
/// (`merged_away`), and calls `find_candidate` for each remaining one to pick a neighbor and
/// apply the actual connection. `find_candidate` receives the region's id and the current
/// `needy` set (every other still-unmerged flagged region) and returns `Some((neighbor_idx,
/// applied))` — `applied` is whether the connection actually succeeded (a candidate can be found
/// but fail to bridge, e.g. `one_way` mode needing a second distinct pair that doesn't exist) —
/// or `None` if the region has no eligible neighbor at all. If the chosen neighbor was itself a
/// needy region, it's marked `merged_away` so a later iteration doesn't try to expand it again.
///
/// Returns `true` if at least one region was successfully merged (caller maps this to
/// `Fixed`/`Failed`).
pub fn run_merge_loop(
    invalid: &[ComponentId],
    mut find_candidate: impl FnMut(ComponentId, &HashSet<ComponentId>) -> Option<(ComponentId, bool)>,
) -> bool {
    let mut pending: Vec<ComponentId> = invalid.to_vec();
    let mut merged_away: HashSet<ComponentId> = HashSet::new();
    let mut any_fixed = false;

    while let Some(region_idx) = pending.pop() {
        if merged_away.contains(&region_idx) {
            continue;
        }

        let needy: HashSet<ComponentId> = invalid
            .iter()
            .copied()
            .filter(|i| *i != region_idx && !merged_away.contains(i))
            .collect();

        let Some((neighbor_idx, applied)) = find_candidate(region_idx, &needy) else {
            continue;
        };
        if !applied {
            continue;
        }
        any_fixed = true;
        if needy.contains(&neighbor_idx) {
            merged_away.insert(neighbor_idx);
        }
    }

    any_fixed
}

/// Every `NodeId` a `MutationCommand` connects, if it's one of the "adds a connection between two
/// region nodes" kinds every `merge_target`-slot nested strategy can propose — used by dispatcher
/// strategies (`WeightedRegionMergeStrategy`, `PriorityRegionMergeStrategy`) to find which SCC
/// component a nested strategy's proposed command actually reached, so an already-merged neighbor
/// from the same batch can be skipped rather than re-dispatched. `SetStart`/`SetFinish`/
/// `RemoveEdge` (by opaque `EdgeId`, endpoints not recoverable without the graph) and
/// `AddBidirectionalElevator` (elevators aren't a `merge_target` mechanism) never arise from a
/// `merge_target` candidate, so they return `None` — same as every other command kind not listed.
///
/// Centralized here (GitHub issue #391 postmortem) after `WeightedRegionMergeStrategy` and
/// `PriorityRegionMergeStrategy` each carried their own copy of this match and both missed
/// `AddDirectedVerticalPassage`/`AddBidirectionalVerticalPassage` when
/// `VerticalPassageRegionMergeStrategy` was added to the `merge_target` slot's candidate pool —
/// the omission silently broke merged-away detection for vertical passages in *both* copies at
/// once, since neither could return an endpoint for those command kinds. A single shared function
/// means a future new merge mechanism's command kind only needs to be added once.
pub fn mutation_command_endpoints(command: &MutationCommand) -> Option<(NodeId, NodeId)> {
    match *command {
        MutationCommand::AddDirectedEdge { from, to } => Some((from, to)),
        MutationCommand::AddBidirectionalEdge { a, b } => Some((a, b)),
        MutationCommand::AddDirectedTeleport { from, to } => Some((from, to)),
        MutationCommand::AddBidirectionalTeleport { a, b } => Some((a, b)),
        MutationCommand::AddDirectedVerticalPassage { from, to } => Some((from, to)),
        MutationCommand::AddBidirectionalVerticalPassage { a, b } => Some((a, b)),
        MutationCommand::AddBidirectionalElevator { .. }
        | MutationCommand::RemoveEdge { .. }
        | MutationCommand::RemoveEdgeBetween { .. }
        | MutationCommand::RemoveEdgeWithReverse { .. }
        | MutationCommand::RemoveTeleportWithReverse { .. }
        | MutationCommand::RemoveVerticalPassageWithReverse { .. }
        | MutationCommand::SetStart(_)
        | MutationCommand::SetFinish(_)
        | MutationCommand::RemoveNode { .. }
        | MutationCommand::ReplacePointNodes { .. } => None,
    }
}

/// Direct unit tests for `region_merge_core`'s pure logic — no `Maze`/`Graph`/`Field` setup
/// needed, unlike the (much heavier) tests in the two strategies that consume this module
/// (`ExpandRegionPassageStrategy`, `TeleportRegionMergeStrategy`), which only exercise it
/// transitively. `ConnectedComponents`/`build_scc` aren't constructible from bare component
/// sizes, so `pick_by_mode`'s `largest`/`smallest` arms (which read `scc.components[i].len()`)
/// are covered by those strategies' own tests instead — this module covers everything that
/// doesn't need a real `ConnectedComponents`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::random::MazeRng;
    use rand::SeedableRng;

    /// `pick_by_mode`'s `random`/`prefer_needy`/unrecognized-mode arms never read
    /// `scc.components` (only `largest`/`smallest` do) -- a trivial empty `ConnectedComponents`
    /// is enough for every test in this module, avoiding a real `Graph`/`build_scc` setup.
    fn empty_scc() -> ConnectedComponents {
        ConnectedComponents {
            components: vec![],
            node_component: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn narrow_to_partial_returns_partial_when_preferred_and_nonempty() {
        let pool = vec![0, 1, 2];
        let partial = vec![1];
        assert_eq!(narrow_to_partial(&pool, &partial, true), &[1]);
    }

    #[test]
    fn narrow_to_partial_falls_back_to_pool_when_partial_is_empty() {
        let pool = vec![0, 1, 2];
        let partial: Vec<ComponentId> = vec![];
        assert_eq!(narrow_to_partial(&pool, &partial, true), &pool[..]);
    }

    #[test]
    fn narrow_to_partial_returns_full_pool_when_preference_is_off() {
        let pool = vec![0, 1, 2];
        let partial = vec![1];
        assert_eq!(narrow_to_partial(&pool, &partial, false), &pool[..]);
    }

    #[test]
    fn pick_by_mode_empty_pool_returns_none() {
        let mut rng = MazeRng::seed_from_u64(1);
        let needy = HashSet::new();
        assert_eq!(
            pick_by_mode(&[], &empty_scc(), MODE_RANDOM, &needy, &mut rng),
            None
        );
    }

    #[test]
    fn pick_by_mode_random_picks_uniformly_from_pool() {
        let mut rng = MazeRng::seed_from_u64(1);
        let needy = HashSet::new();
        let pool = vec![0, 1, 2];
        let picked = pick_by_mode(&pool, &empty_scc(), MODE_RANDOM, &needy, &mut rng);
        assert!(picked.is_some_and(|p| pool.contains(&p)));
    }

    #[test]
    fn pick_by_mode_unrecognized_mode_falls_back_to_random_pick_from_pool() {
        let mut rng = MazeRng::seed_from_u64(1);
        let needy = HashSet::new();
        let pool = vec![0, 1, 2];
        let picked = pick_by_mode(&pool, &empty_scc(), "not_a_real_mode", &needy, &mut rng);
        assert!(picked.is_some_and(|p| pool.contains(&p)));
    }

    #[test]
    fn pick_by_mode_prefer_needy_picks_only_from_needy_subset_when_available() {
        let needy: HashSet<ComponentId> = [1].into_iter().collect();
        let pool = vec![0, 1, 2];
        for seed in 0..20 {
            let mut rng = MazeRng::seed_from_u64(seed);
            let picked = pick_by_mode(&pool, &empty_scc(), MODE_PREFER_NEEDY, &needy, &mut rng);
            assert_eq!(
                picked,
                Some(1),
                "seed {seed}: must always pick the sole needy candidate"
            );
        }
    }

    #[test]
    fn pick_by_mode_prefer_needy_falls_back_to_whole_pool_when_none_needy() {
        let needy: HashSet<ComponentId> = HashSet::new();
        let pool = vec![0, 1, 2];
        for seed in 0..20 {
            let mut rng = MazeRng::seed_from_u64(seed);
            let picked = pick_by_mode(&pool, &empty_scc(), MODE_PREFER_NEEDY, &needy, &mut rng);
            assert!(
                picked.is_some_and(|p| pool.contains(&p)),
                "seed {seed}: must fall back to the whole pool when nothing is needy"
            );
        }
    }

    #[test]
    fn run_merge_loop_returns_false_when_nothing_merges() {
        let invalid = vec![0, 1, 2];
        let any_fixed = run_merge_loop(&invalid, |_region, _needy| None);
        assert!(!any_fixed);
    }

    #[test]
    fn run_merge_loop_returns_true_when_at_least_one_region_merges() {
        let invalid = vec![0, 1];
        let any_fixed = run_merge_loop(
            &invalid,
            |region, _needy| {
                if region == 0 { Some((99, true)) } else { None }
            },
        );
        assert!(any_fixed);
    }

    #[test]
    fn run_merge_loop_does_not_count_a_found_but_unapplied_candidate() {
        // find_candidate returns Some((neighbor, applied: false)) for every region -- a
        // candidate was found but the connection itself failed to apply (e.g. one_way mode
        // needing a second distinct pair that doesn't exist) -- must not count as any_fixed.
        let invalid = vec![0, 1];
        let any_fixed = run_merge_loop(&invalid, |_region, _needy| Some((99, false)));
        assert!(!any_fixed);
    }

    #[test]
    fn run_merge_loop_skips_a_region_already_merged_away_as_someone_elses_neighbor() {
        // Region 0 merges into region 1 (itself in `invalid`, hence "needy") -- region 1 must
        // then be marked merged_away and skipped when its own turn comes up in the LIFO pop
        // order, never calling find_candidate for it a second time.
        use std::cell::RefCell;
        let invalid = vec![1, 0]; // pop order: 0 first, then 1
        let calls: RefCell<Vec<ComponentId>> = RefCell::new(Vec::new());
        let any_fixed = run_merge_loop(&invalid, |region, _needy| {
            calls.borrow_mut().push(region);
            if region == 0 {
                Some((1, true))
            } else {
                Some((99, true))
            }
        });
        assert!(any_fixed);
        assert_eq!(
            calls.into_inner(),
            vec![0],
            "region 1 must never be dispatched -- it was merged away as region 0's neighbor"
        );
    }

    #[test]
    fn run_merge_loop_passes_the_correct_needy_set_excluding_self_and_merged_away() {
        // 3 flagged regions: 0, 1, 2. When region 2 (popped first, LIFO) is dispatched, needy
        // must be {0, 1} (everyone else in `invalid`, excluding itself). Region 2 merges into
        // region 1 (needy), marking it merged_away; when region 0 is dispatched next (region 1
        // popped in between but skipped since merged_away, never reaching find_candidate),
        // needy must be {2} -- region 1 excluded (merged_away), region 2 still included (it
        // was processed itself, but processing doesn't merge it away; only being *chosen as
        // someone else's neighbor* does). Captures the needy set seen at each dispatched call.
        use std::cell::RefCell;
        let invalid = vec![0, 1, 2]; // pop order: 2, 1, 0
        let seen: RefCell<Vec<(ComponentId, Vec<ComponentId>)>> = RefCell::new(Vec::new());
        run_merge_loop(&invalid, |region, needy| {
            let mut sorted: Vec<ComponentId> = needy.iter().copied().collect();
            sorted.sort_unstable();
            seen.borrow_mut().push((region, sorted));
            if region == 2 { Some((1, true)) } else { None }
        });
        let seen = seen.into_inner();
        assert_eq!(
            seen[0],
            (2, vec![0, 1]),
            "region 2's needy set is every other flagged region"
        );
        assert_eq!(
            seen[1],
            (0, vec![2]),
            "region 1 is now merged_away and excluded, but region 2 (not merged_away itself) still counts as needy"
        );
    }

    #[test]
    fn mutation_command_endpoints_extracts_both_nodes_for_every_connecting_command_kind() {
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::AddDirectedEdge { from: 1, to: 2 }),
            Some((1, 2))
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::AddBidirectionalEdge { a: 1, b: 2 }),
            Some((1, 2))
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::AddDirectedTeleport { from: 1, to: 2 }),
            Some((1, 2))
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::AddBidirectionalTeleport { a: 1, b: 2 }),
            Some((1, 2))
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::AddDirectedVerticalPassage {
                from: 1,
                to: 2
            }),
            Some((1, 2))
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::AddBidirectionalVerticalPassage {
                a: 1,
                b: 2
            }),
            Some((1, 2))
        );
    }

    #[test]
    fn mutation_command_endpoints_returns_none_for_every_non_connecting_command_kind() {
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::AddBidirectionalElevator { a: 1, b: 2 }),
            None
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::RemoveEdge { id: 7 }),
            None
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::RemoveEdgeBetween { from: 1, to: 2 }),
            None
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::RemoveEdgeWithReverse { id: 7 }),
            None
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::RemoveTeleportWithReverse { id: 7 }),
            None
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::RemoveVerticalPassageWithReverse {
                id: 7
            }),
            None
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::SetStart(1)),
            None
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::SetFinish(1)),
            None
        );
        assert_eq!(
            mutation_command_endpoints(&MutationCommand::RemoveNode { node: 1 }),
            None
        );
    }
}
