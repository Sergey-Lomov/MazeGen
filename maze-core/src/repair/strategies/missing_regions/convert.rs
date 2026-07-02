use std::collections::HashSet;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::NodeId;
use crate::graph::region_class::RegionClass;
use crate::space::Tessellation;
use crate::generation::{PresetState, try_add_directed_edge, try_remove_edge};

/// Converts `members` into `target` by auditing its existing inbound/outbound connectivity and
/// adjusting only what's actually wrong, then validating the result via membership-check
/// (Specs/repair.md's "Region conversion" section).
///
/// `target` alone determines what `members` needs on each side — `needs_inbound` (an edge from
/// `reachable_from_start` into `members`) is required for `Trap`/`Alternative`, `needs_outbound`
/// (an edge from `members` into `reachable_to_finish`) for `Alternative` only. This replaces the
/// old `source`-driven transition table: `members`' *actual* current class never has to be known
/// up front, because the audit step below inspects the real edges, not a cached class label
/// (which can go stale — e.g. `try_reuse`'s absorption mutates the graph after the caller
/// captured a class snapshot). `members` is assumed to already be a single coherent SCC by this
/// point — the caller (`try_reuse`'s absorption+bridge, `try_grow`'s sever+bridge) is responsible
/// for that; `convert_region` doesn't re-verify it up front, only implicitly via the final
/// membership-check.
///
/// 1. **Audit**: for each side `members` does NOT need, remove every existing edge of that kind
///    (e.g. `target = Trap` removes existing outbound edges into `reachable_to_finish` — a
///    region can hold such edges while still classified `Unreachable`/`Trap`, since nothing
///    could reach them to use them). A removal blocked by `preset_state` fails the whole
///    candidate immediately (`None`) — no partial audit is left half-applied silently.
/// 2. **Add**: for each side `members` DOES need but doesn't have after the audit, add one —
///    inbound first (if needed), then outbound (if needed). Each side tries every field-adjacent
///    candidate edge (shuffled, no attempt cap — unlike the old `MAX_CONNECT_ATTEMPTS`-bounded
///    search, every candidate is tried before giving up), each as a single add + membership-check
///    + undo-if-not-yet-matching unit.
/// 3. Final **membership-check**: every node in `members` must resolve to a single SCC classified
///    as `target`.
///
/// Returns `None` if any audit removal is preset-blocked, or if no combination of adds lands on
/// `target` (including the case where `members` was never coherent to begin with — the final
/// membership-check catches that too, just after doing the audit/add work first). `convert_region`
/// itself carries no snapshot/restore of its own — the caller (`try_reuse`/`try_grow`) is
/// responsible for a full snapshot before calling it and a restore on `None`; a failed call may
/// leave audit removals or partial adds in the graph.
pub(super) fn convert_region<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    target: RegionClass,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let needs_inbound = matches!(target, RegionClass::Trap | RegionClass::Alternative);
    let needs_outbound = matches!(target, RegionClass::Alternative);

    if !audit_connectivity(maze, members, needs_inbound, needs_outbound, preset_state) {
        return None;
    }

    // When both sides are needed (only `Alternative` today), adding an inbound and an outbound
    // edge can merge `members` into some other component's SCC — not just when both land in the
    // literal same component (a direct `members -> X -> members` cycle), but also when the
    // inbound neighbor's component and the outbound neighbor's component are different yet
    // already connected to each other in the existing graph (`members -> B -> ... -> A ->
    // members`, closing the cycle through a path that never touches `members`). Component-id
    // comparison alone can't catch the second case; only a real membership-check after each edge
    // lands can. If `needs_outbound`, the inbound step below is deferred and re-checked once
    // outbound already succeeded — if the inbound edge alone (before outbound) already leaves
    // `members` matching `target`, nothing else is attempted for that side.
    if needs_inbound && !needs_outbound {
        let reachable_from_start = maze.analysis.reachable_from_start(&maze.graph, &maze.meta).unwrap_or_default();
        if !has_inbound(maze, members, &reachable_from_start)
            && try_bridge(maze, members, &reachable_from_start, false, preset_state, rng).is_none() {
            return None;
        }
        return if membership_matches(maze, members, target) { Some(members.clone()) } else { None };
    }

    if needs_outbound {
        if !add_side_with_membership_retry(maze, members, false, preset_state, rng) {
            return None;
        }
        if !add_side_with_membership_retry(maze, members, true, preset_state, rng) {
            return None;
        }
    }

    if membership_matches(maze, members, target) {
        Some(members.clone())
    } else {
        None
    }
}

/// Removes every existing edge LEAVING `members` on a side it doesn't need: outbound edges into
/// `reachable_to_finish` if `!needs_outbound`, inbound edges from `reachable_from_start` if
/// `!needs_inbound`. Only edges crossing the `members` boundary are ever audited — an edge into
/// an unrelated `Unreachable` region, say, doesn't affect classification either way and is left
/// alone, and neither does an edge between two `members` nodes even if one of them separately
/// qualifies for `reachable_to_finish`/`reachable_from_start` (e.g. a formerly-`Unreachable`
/// region can itself already reach finish internally, or reach a node reachable from start,
/// without ever having been reachable from start itself) — cutting an edge like that would
/// sever `members`' own internal connectivity instead of its boundary, breaking the caller's
/// "already a single coherent SCC" precondition. Returns `false` (candidate fails outright) if
/// any required removal is preset-blocked.
fn audit_connectivity<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    needs_inbound: bool,
    needs_outbound: bool,
    preset_state: &PresetState,
) -> bool {
    if !needs_outbound {
        let reachable_to_finish = maze.analysis.reachable_to_finish(&maze.graph, &maze.meta).unwrap_or_default();
        let mut to_cut: Vec<(NodeId, NodeId)> = members.iter()
            .flat_map(|&n| maze.graph.outgoing_neighbors(n).map(move |nb| (n, nb)))
            .filter(|(_, nb)| !members.contains(nb) && reachable_to_finish.contains(nb))
            .collect();
        to_cut.sort_unstable();
        to_cut.dedup();
        for (from, to) in to_cut {
            if !try_remove_edge(&mut maze.graph, from, to, preset_state) {
                return false;
            }
        }
    }
    if !needs_inbound {
        let reachable_from_start = maze.analysis.reachable_from_start(&maze.graph, &maze.meta).unwrap_or_default();
        let mut to_cut: Vec<(NodeId, NodeId)> = members.iter()
            .flat_map(|&n| maze.graph.incoming_neighbors(n).map(move |nb| (nb, n)))
            .filter(|(from, _)| !members.contains(from) && reachable_from_start.contains(from))
            .collect();
        to_cut.sort_unstable();
        to_cut.dedup();
        for (from, to) in to_cut {
            if !try_remove_edge(&mut maze.graph, from, to, preset_state) {
                return false;
            }
        }
    }
    true
}

fn has_inbound<T: Tessellation>(maze: &Maze<T>, members: &HashSet<NodeId>, reachable_from_start: &HashSet<NodeId>) -> bool {
    members.iter().any(|&n| maze.graph.incoming_neighbors(n).any(|nb| reachable_from_start.contains(&nb)))
}

fn has_outbound<T: Tessellation>(maze: &Maze<T>, members: &HashSet<NodeId>, reachable_to_finish: &HashSet<NodeId>) -> bool {
    members.iter().any(|&n| maze.graph.outgoing_neighbors(n).any(|nb| reachable_to_finish.contains(&nb)))
}

fn bridging_candidates<T: Tessellation>(maze: &Maze<T>, members: &HashSet<NodeId>, side: &HashSet<NodeId>, outbound: bool) -> Vec<(NodeId, NodeId)> {
    let mut candidates: Vec<(NodeId, NodeId)> = Vec::new();
    for &m in members {
        for neighbor in maze.field.neighbors(m) {
            if !side.contains(&neighbor) {
                continue;
            }
            candidates.push(if outbound { (m, neighbor) } else { (neighbor, m) });
        }
    }
    candidates.sort_unstable();
    candidates.dedup();
    candidates
}

/// Adds the needed edge for one side (`outbound = false` for inbound, `true` for outbound) when
/// `target` needs BOTH sides (`Alternative`) — tries every field-adjacent candidate in turn
/// (shuffled), and after each one actually lands, re-checks whether `members` is still a single
/// coherent SCC (`current_class(..).is_some()`). A candidate that merges `members` into some
/// other component — directly (same component on both sides) or indirectly (the two sides'
/// components were already connected to each other through the existing graph, outside
/// `members`) — is rolled back and the next candidate is tried instead; component-id comparison
/// alone can't distinguish "safe" from "will merge" ahead of time, since indirect merges depend
/// on the rest of the graph's existing connectivity, so this checks the real outcome after each
/// attempt rather than predicting it. Returns `false` if every candidate is preset-blocked or
/// merges `members`, or if `members` doesn't already have this side pre-existing without one of
/// these problems.
fn add_side_with_membership_retry<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    outbound: bool,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> bool {
    let side = if outbound {
        maze.analysis.reachable_to_finish(&maze.graph, &maze.meta).unwrap_or_default()
    } else {
        maze.analysis.reachable_from_start(&maze.graph, &maze.meta).unwrap_or_default()
    };
    let already_has = if outbound { has_outbound(maze, members, &side) } else { has_inbound(maze, members, &side) };
    if already_has {
        return current_class(maze, members).is_some();
    }

    let mut candidates = bridging_candidates(maze, members, &side, outbound);
    if candidates.is_empty() {
        return false;
    }
    for i in (1..candidates.len()).rev() {
        let j = rng.random_range(0..=i);
        candidates.swap(i, j);
    }
    for (from, to) in candidates {
        if maze.graph.edge_between(from, to).is_some() {
            continue;
        }
        if !try_add_directed_edge(&mut maze.graph, from, to, preset_state) {
            continue;
        }
        // `members` must still be a single coherent SCC AND not have become `Path` — `Path` is
        // never a valid outcome for this strategy's targets (`Trap`/`Alternative`), and reaching
        // it here means this candidate merged `members` into the start/finish component (directly
        // or by closing a cycle through the existing graph), which is exactly the failure mode
        // this retry loop exists to route around.
        if !matches!(current_class(maze, members), None | Some(RegionClass::Path)) {
            return true;
        }
        let _ = try_remove_edge(&mut maze.graph, from, to, &PresetState::empty());
    }
    false
}

/// The single `RegionClass` every node in `members` currently resolves to, or `None` if
/// `members` spans more than one class (or is empty) — i.e. `members` isn't a single coherent
/// region right now.
fn current_class<T: Tessellation>(maze: &Maze<T>, members: &HashSet<NodeId>) -> Option<RegionClass> {
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let result_classes: HashSet<RegionClass> = members.iter()
        .filter_map(|n| scc.component_of(*n))
        .filter_map(|idx| classes.get(&idx).copied())
        .collect();
    let mut iter = result_classes.into_iter();
    let only = iter.next()?;
    if iter.next().is_some() {
        return None;
    }
    Some(only)
}

pub(super) fn membership_matches<T: Tessellation>(maze: &Maze<T>, members: &HashSet<NodeId>, target: RegionClass) -> bool {
    current_class(maze, members) == Some(target)
}

/// Tries every field-adjacent candidate edge between `members` and `side` (shuffled, no attempt
/// cap — every candidate is tried before giving up) until one is actually added. `outbound`
/// selects direction: `true` for `members -> side`, `false` for `side -> members`. Returns
/// `Some(members)` on the first candidate `try_add_directed_edge` accepts (an edge that already
/// existed counts as immediate success too — nothing to add), `None` if every candidate is
/// preset-blocked. Used only for the single-side case (`Trap`, needs inbound only) — the
/// both-sides case (`Alternative`) goes through `add_side_with_membership_retry` instead, which
/// also needs a real membership-check after each candidate (see its own doc comment for why).
fn try_bridge<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    side: &HashSet<NodeId>,
    outbound: bool,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let mut candidates = bridging_candidates(maze, members, side, outbound);
    if candidates.is_empty() {
        return None;
    }
    for i in (1..candidates.len()).rev() {
        let j = rng.random_range(0..=i);
        candidates.swap(i, j);
    }
    for (from, to) in candidates {
        if maze.graph.edge_between(from, to).is_some() || try_add_directed_edge(&mut maze.graph, from, to, preset_state) {
            return Some(members.clone());
        }
    }
    None
}
