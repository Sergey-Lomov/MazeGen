use std::collections::{HashMap, HashSet};
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::NodeId;
use crate::graph::scc::ComponentId;
use crate::graph::region_class::RegionClass;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::snapshot::SnapshotStack;

use super::MAX_REUSE_ATTEMPTS;
use super::convert::convert_region;
use crate::generation::{try_add_directed_edge, try_remove_edge};

#[allow(clippy::too_many_arguments)]
pub(super) fn try_reuse<T: Tessellation>(
    maze: &mut Maze<T>,
    snapshots: &mut SnapshotStack,
    target: RegionClass,
    min_region_size: usize,
    committed_nodes: &HashSet<NodeId>,
    excess_budget: &mut HashMap<RegionClass, i32>,
    inbound_requires_geometry: bool,
    outbound_requires_geometry: bool,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let route = maze.analysis.route_info(&maze.graph, &maze.meta);
    let critical: HashSet<NodeId> = route.as_ref().map(|r| r.path.iter().copied().collect()).unwrap_or_default();

    let mut candidates: Vec<ComponentId> = scc.components.iter().enumerate()
        .filter(|(idx, members)| {
            if classes.get(idx).is_none() {
                return false;
            }
            !members.iter().any(|n| critical.contains(n) || committed_nodes.contains(n))
        })
        .map(|(idx, _)| idx)
        .collect();
    candidates.sort_unstable();

    if candidates.is_empty() {
        return None;
    }

    // Filter out candidates that have zero geometric border with EVERY reachability side the
    // conversion needs to bridge from/to, and compute a border-count for the survivors (used
    // below to prioritize among them). See `filter_by_border` for the rationale.
    // `inbound_requires_geometry`/`outbound_requires_geometry` come from the caller (currently
    // always `true, true` — plain inbound/outbound edges need an actual field-adjacent bridge; a
    // future teleport-based bridging mechanism, with no geometric placement requirement, would
    // pass the corresponding flag(s) as `false` instead).
    let reachable_from_start = maze.analysis.reachable_from_start(&maze.graph, &maze.meta).unwrap_or_default();
    let reachable_to_finish = maze.analysis.reachable_to_finish(&maze.graph, &maze.meta).unwrap_or_default();
    let border_count = filter_by_border(
        maze, &mut candidates, target, &classes, &scc, &reachable_from_start, &reachable_to_finish,
        inbound_requires_geometry, outbound_requires_geometry,
    );

    if candidates.is_empty() {
        return None;
    }

    prioritize_candidates(&mut candidates, &scc, &border_count, min_region_size, rng);

    let take = (MAX_REUSE_ATTEMPTS as usize).min(candidates.len());
    for &idx in candidates.iter().take(take) {
        let mut members: HashSet<NodeId> = scc.components[idx].iter().copied().collect();

        // Each candidate gets its own snapshot/restore — `convert_region` can perform more
        // than one mutation before its final membership-check fails (e.g. the inbound edge
        // in `Unreachable -> Alternative`, added before the outbound search even starts), so
        // a failed candidate is not guaranteed to leave the graph as it found it on its own.
        // The absorption loop below is part of the same snapshot unit: a candidate too small
        // for `min_region_size` borrows excess-budgeted neighbors of ANY class with remaining
        // surplus (per GitHub issue #59's "Region Balance" model) before conversion is even
        // attempted, and a failed candidate must roll that borrowing back along with everything
        // else.
        snapshots.snapshot(maze);
        let budget_before = excess_budget.clone();

        absorb_until_min_size(
            maze, &mut members, idx, min_region_size, &scc, &classes, excess_budget, &critical, committed_nodes, preset_state, rng,
        );

        let converted = convert_region(maze, &members, target, preset_state, rng);

        if let Some(result) = converted {
            return Some(result);
        }
        snapshots.restore(maze);
        *excess_budget = budget_before;
    }
    None
}

/// Orders `candidates` in place by a two-level priority so `try_reuse`'s `MAX_REUSE_ATTEMPTS`
/// slots go to the candidates most likely to actually convert:
///
/// 1. Already at or above `min_region_size` sorts ahead of anything still needing absorption to
///    reach it — a candidate that can convert as-is shouldn't lose its slot to a smaller one
///    that merely has a bigger border-count, since the smaller one may still fail to absorb
///    enough budget to even reach `min_region_size` in the first place.
/// 2. Within each size tier, descending `border_count` — a candidate with more border has
///    better odds of landing the bridging edge within `MAX_CONNECT_ATTEMPTS`. Candidates absent
///    from `border_count` are cut-transitions (border irrelevant to them, see
///    `filter_by_border`) — treated as highest border-count (`usize::MAX`), since their success
///    odds never depended on border-count to begin with.
///
/// Tie-break randomization within equal-priority groups: shuffle first (Fisher-Yates, seeded
/// from `rng` so the overall call stays deterministic for a fixed seed), THEN stable-sort by
/// priority. A circular `(offset + i) % len` walk (the pattern used elsewhere in this file for
/// un-prioritized candidate lists) would undo the prioritization here by wrapping back around
/// to low-priority candidates within the `take` window — this is a plain prefix-take instead,
/// in priority order.
pub(super) fn prioritize_candidates(
    candidates: &mut [ComponentId],
    scc: &crate::graph::scc::ConnectedComponents,
    border_count: &HashMap<ComponentId, usize>,
    min_region_size: usize,
    rng: &mut dyn RngCore,
) {
    for i in (1..candidates.len()).rev() {
        let j = rng.random_range(0..=i);
        candidates.swap(i, j);
    }
    candidates.sort_by_key(|&idx| {
        let is_large_enough = scc.components[idx].len() >= min_region_size;
        (std::cmp::Reverse(is_large_enough), std::cmp::Reverse(*border_count.get(&idx).unwrap_or(&usize::MAX)))
    });
}

/// Best-effort absorption, not a hard requirement: a candidate already valid for `target` at its
/// current size is still tried even if it never reaches `min_region_size` (e.g. no excess budget
/// is available anywhere to grow it, or every bridging edge is preset-blocked) -- `try_reuse` has
/// never required a minimum size on its own (that's `try_grow`'s floor for newly grown regions),
/// and changing that would regress the common single-region reuse path.
///
/// Each round: collects every field-adjacent `(member_node, neighbor_node)` edge pair across ALL
/// bordering components whose `RegionClass` still has budget remaining (not restricted to the
/// candidate's own class — the budget bookkeeping is per-class regardless of what the candidate
/// itself converts into), into one shared pool. A random pair is drawn from the pool and a
/// bidirectional edge is attempted between its two nodes; if `preset_state` blocks it, that pair
/// alone is discarded and another is drawn — a single blocked edge no longer disqualifies its
/// whole bordering component, since a different edge to the same (or another) component might
/// still succeed. On the first successful bridge, the WHOLE bordering component (not just the
/// two bridged nodes) is folded into `members` — the component is one SCC, so once any of its
/// nodes joins `members` via a real edge, the rest follow through internal SCC connectivity —
/// and its full size is debited from its class's budget entry (`remaining = budget - size`; the
/// entry is removed once it reaches `<= 0`), same accounting rule as before. The outer loop then
/// restarts: recomputes size, re-scans for bordering components (which may now include new ones
/// exposed by the just-absorbed component), and continues until `members` reaches
/// `min_region_size` or the edge pool is exhausted with nothing left to try.
#[allow(clippy::too_many_arguments)]
pub(super) fn absorb_until_min_size<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &mut HashSet<NodeId>,
    candidate_idx: ComponentId,
    min_region_size: usize,
    scc: &crate::graph::scc::ConnectedComponents,
    classes: &HashMap<ComponentId, RegionClass>,
    excess_budget: &mut HashMap<RegionClass, i32>,
    critical: &HashSet<NodeId>,
    committed_nodes: &HashSet<NodeId>,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) {
    let mut allowed_components: HashSet<ComponentId> = HashSet::from([candidate_idx]);
    'outer: while members.len() < min_region_size {
        let mut edge_pool: Vec<(NodeId, NodeId, ComponentId)> = members.iter()
            .flat_map(|&m| maze.field.neighbors(m).into_iter().map(move |nb| (m, nb)))
            .filter(|(_, nb)| !critical.contains(nb) && !committed_nodes.contains(nb))
            .filter_map(|(m, nb)| {
                let component = scc.component_of(nb)?;
                if allowed_components.contains(&component) {
                    return None;
                }
                let class = *classes.get(&component)?;
                let budget = *excess_budget.get(&class)?;
                if budget <= 0 {
                    return None;
                }
                Some((m, nb, component))
            })
            .collect();
        edge_pool.sort_unstable();
        edge_pool.dedup();

        while !edge_pool.is_empty() {
            let i = rng.random_range(0..edge_pool.len());
            let (from, to, component) = edge_pool.remove(i);
            let forward_added = try_add_directed_edge(&mut maze.graph, from, to, preset_state);
            let bidirectional_added = forward_added && try_add_directed_edge(&mut maze.graph, to, from, preset_state);
            if !bidirectional_added {
                // Roll back a lone forward edge if only the return direction was blocked —
                // this pair is being discarded, so it must not leave a one-way edge behind
                // that a later pair (or the caller's own snapshot/restore) doesn't expect.
                if forward_added {
                    let _ = try_remove_edge(&mut maze.graph, from, to, &PresetState::empty());
                }
                continue;
            }
            allowed_components.insert(component);
            members.extend(scc.components[component].iter().copied());
            let class = classes[&component];
            let size = scc.components[component].len() as i32;
            let budget = excess_budget[&class];
            let remaining = budget - size;
            if remaining > 0 {
                excess_budget.insert(class, remaining);
            } else {
                excess_budget.remove(&class);
            }
            continue 'outer;
        }
        // Edge pool exhausted with nothing succeeding — no further absorption is possible.
        break;
    }
}

/// Filters `candidates` in place, keeping only components that have a chance of ever reaching
/// `target` — dropping those with zero geometric border on EVERY reachability side the
/// transition needs AND still requires geometry for. Returns the border-count (inbound +
/// outbound, counting only sides that require geometry) for every surviving border-needing
/// candidate, for the caller's priority sort; cut-transition candidates (border irrelevant to
/// them) get no entry.
///
/// `inbound_requires_geometry`/`outbound_requires_geometry` gate whether that side's
/// field-adjacency is checked at all: a plain bridging edge needs an actual geometric border
/// (both flags `true`, the only mode `try_reuse` uses today), but a future teleport-based
/// bridging mechanism could satisfy a side without any geometric placement requirement — passing
/// `false` for that side skips its border computation entirely and treats it as automatically
/// satisfied (never a reason to filter the candidate out, never contributing to border_count).
/// Passing `false` for both means no filtering happens at all: every candidate whose class can
/// transition to `target` is kept, at border_count 0 (falling back to the `usize::MAX`
/// cut-transition priority in the caller's sort, since none of them have a border-driven
/// ranking reason either).
///
/// A candidate with zero border on a side it needs AND still requires geometry for can never
/// gain the required edge no matter how many attempts are spent on it, and no absorbed
/// same-class neighbor can change that — absorption only pulls in more members, but conversion
/// still bridges through whichever member borders the reachability side; a border-less region
/// absorbed BY a bordering one converts through the absorbing region's border, never grants one
/// to itself. For a transition needing both sides (`Unreachable -> Alternative`) with both
/// geometry-gated, a candidate is kept if it has EITHER border — the missing side can still be
/// reached later by absorbing a same-class neighbor that borders it, so requiring both up front
/// would wrongly reject a legitimately mergeable candidate.
#[allow(clippy::too_many_arguments)]
pub(super) fn filter_by_border<T: Tessellation>(
    maze: &Maze<T>,
    candidates: &mut Vec<ComponentId>,
    target: RegionClass,
    classes: &HashMap<ComponentId, RegionClass>,
    scc: &crate::graph::scc::ConnectedComponents,
    reachable_from_start: &HashSet<NodeId>,
    reachable_to_finish: &HashSet<NodeId>,
    inbound_requires_geometry: bool,
    outbound_requires_geometry: bool,
) -> HashMap<ComponentId, usize> {
    let mut border_count: HashMap<ComponentId, usize> = HashMap::new();
    candidates.retain(|&idx| {
        let class = classes[&idx];
        let needs_inbound = inbound_requires_geometry && matches!((class, target),
            (RegionClass::Unreachable, RegionClass::Trap) | (RegionClass::Unreachable, RegionClass::Alternative));
        let needs_outbound = outbound_requires_geometry && matches!((class, target),
            (RegionClass::Unreachable, RegionClass::Alternative) | (RegionClass::Trap, RegionClass::Alternative));
        if !needs_inbound && !needs_outbound {
            // Either a cut-transition (Trap/Alternative -> Unreachable, Alternative -> Trap,
            // which never needs a NEW geometric border — they cut an edge that already exists)
            // or a side whose geometry requirement is disabled by the caller: either way,
            // border proximity to a reachability set isn't the limiting factor here.
            return true;
        }
        let inbound_count = if needs_inbound {
            scc.components[idx].iter()
                .flat_map(|&n| maze.field.neighbors(n))
                .filter(|nb| reachable_from_start.contains(nb))
                .count()
        } else {
            0
        };
        let outbound_count = if needs_outbound {
            scc.components[idx].iter()
                .flat_map(|&n| maze.field.neighbors(n))
                .filter(|nb| reachable_to_finish.contains(nb))
                .count()
        } else {
            0
        };
        if inbound_count == 0 && outbound_count == 0 {
            return false;
        }
        border_count.insert(idx, inbound_count + outbound_count);
        true
    });
    border_count
}
