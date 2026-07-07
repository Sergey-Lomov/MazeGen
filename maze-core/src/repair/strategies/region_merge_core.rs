use rand::{Rng, RngCore};
use std::collections::HashSet;
use crate::graph::scc::{ComponentId, ConnectedComponents};

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
        MODE_LARGEST => pool.iter().copied().max_by_key(|i| scc.components[*i].len()),
        MODE_SMALLEST => pool.iter().copied().min_by_key(|i| scc.components[*i].len()),
        MODE_PREFER_NEEDY => {
            let needy_candidates: Vec<ComponentId> = pool.iter().copied().filter(|i| needy.contains(i)).collect();
            let sub_pool = if needy_candidates.is_empty() { pool } else { &needy_candidates };
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
    if prefer_partial && !partial.is_empty() { partial } else { pool }
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

        let needy: HashSet<ComponentId> =
            invalid.iter().copied().filter(|i| *i != region_idx && !merged_away.contains(i)).collect();

        let Some((neighbor_idx, applied)) = find_candidate(region_idx, &needy) else { continue };
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
