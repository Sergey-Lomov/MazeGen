use rand::{Rng, RngCore};
use std::collections::HashSet;
use crate::graph::scc::{ComponentId, ConnectedComponents};

/// Shared `target_mode` param id/values/selection logic for every strategy that merges an
/// undersized SCC region into a neighboring region (`ExpandRegionPassageStrategy` — geometric
/// adjacency — and `TeleportRegionMergeStrategy` — any node pair, no adjacency requirement).
/// Each strategy owns its own candidate-discovery (what counts as a "neighbor" and how a
/// bridging connection is actually applied) — only target selection lives here. Since GitHub
/// issue #99, one `apply()` call merges exactly one region (`issue.region_id`), so there is no
/// merge-loop batch bookkeeping to share any more — `needy` (below) is built from
/// `issue.other_invalid` instead of a same-call batch.
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

