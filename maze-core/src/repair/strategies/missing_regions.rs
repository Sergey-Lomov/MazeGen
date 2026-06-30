use std::collections::HashSet;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::NodeId;
use crate::graph::scc::{ComponentId, ConnectedComponents};
use crate::graph::region_class::RegionClass;
use crate::space::Tessellation;
use crate::quality_control::{Issue, IssueData};
use crate::generation::{PresetState, try_add_directed_edge, try_remove_edge};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::RepairStrategy;
use crate::repair::snapshot::SnapshotStack;

pub const PARAM_LOCALITY: &str = "locality";
pub const PARAM_MIN_REGION_SIZE: &str = "min_region_size";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_LOCALITY,
        label: "Growth directionality",
        kind: StrategyParamKind::Float { default: 0.5, min: 0.0, max: 1.0 },
    },
    StrategyParam {
        id: PARAM_MIN_REGION_SIZE,
        // Value is a node count — rounded to usize before use (see `min_region_size`).
        label: "Minimum grown region size",
        kind: StrategyParamKind::Float { default: 2.0, min: 1.0, max: 64.0 },
    },
];

// Internal attempt-budget caps — not user-configurable (see Specs/repair.md's rationale for
// `MissingRegionsStrategy`): they exist purely as a circuit breaker against an unconvergeable
// graph/preset combination, not as an algorithm parameter like `locality`/`min_region_size`.
const MAX_REUSE_ATTEMPTS: u32 = 5;
const MAX_GROW_ATTEMPTS: u32 = 3;
const MAX_CONNECT_ATTEMPTS: u32 = 5;
const MAX_TOTAL_FAILURES: u32 = 10;

/// Handles `MISSING_REGIONS` — see GitHub issue #59. For each region class short of its
/// configured minimum (`issue.data`'s `missing_by_class`), tries to either reuse an existing
/// region or grow a new one (front-expansion from a seed inside an existing non-critical-path
/// region) and convert it into the target `RegionClass` by adding/removing one-way edges.
///
/// **`issue.data` is mandatory for this kind**, same contract as `InvalidLoopRandomStrategy`/
/// `ExpandRegionPassageStrategy`: `missing_by_class` is the producing check's result, there is
/// no other channel to learn it.
pub struct MissingRegionsStrategy;

impl<T: Tessellation> RepairStrategy<T> for MissingRegionsStrategy {
    fn strategy_id(&self) -> &'static str { "missing_regions" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &Issue,
        maze: &mut Maze<T>,
        snapshots: &mut SnapshotStack,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
    ) -> RepairResult {
        let Some(IssueData::MissingRegions { missing_by_class }) = &issue.data else {
            return RepairResult::Failed;
        };
        let (Some(start), Some(finish)) = (maze.meta.start, maze.meta.finish) else {
            return RepairResult::Failed;
        };

        let locality = params.get(PARAM_LOCALITY).and_then(|v| v.as_float()).unwrap_or(0.5);
        let min_region_size = params
            .get(PARAM_MIN_REGION_SIZE)
            .and_then(|v| v.as_float())
            .unwrap_or(2.0)
            .round()
            .max(1.0) as usize;

        // Sorted by class name for determinism — HashMap iteration order is randomized
        // per-process, same rationale as `expand_region_passage.rs`'s key-sorting.
        let mut classes: Vec<RegionClass> = missing_by_class.keys().copied().collect();
        classes.sort_by_key(|c| c.as_str());

        let mut committed_nodes: HashSet<NodeId> = HashSet::new();
        let mut total_failures: u32 = 0;
        let mut any_fixed = false;

        'classes: for class in classes {
            // `Path` is never a valid creation target (see Specs/repair.md) — skipped without
            // consuming attempt budget, doesn't block other classes.
            if class == RegionClass::Path {
                continue;
            }
            let mut remaining = *missing_by_class.get(&class).unwrap_or(&0);

            while remaining > 0 {
                if total_failures >= MAX_TOTAL_FAILURES {
                    break 'classes;
                }

                snapshots.snapshot(maze);
                let outcome = attempt_one_region(
                    maze, snapshots, class, start, finish, locality, min_region_size,
                    &committed_nodes, preset_state, rng,
                );

                match outcome {
                    Some(members) => {
                        committed_nodes.extend(members);
                        remaining -= 1;
                        any_fixed = true;
                    }
                    None => {
                        snapshots.restore(maze);
                        total_failures += 1;
                    }
                }
            }
        }

        if any_fixed {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        }
    }
}

/// One full region-item attempt: try reuse first, fall back to growth. Returns the committed
/// region's `members` on success (caller is responsible for NOT restoring the snapshot in that
/// case), or `None` on failure (caller restores).
#[allow(clippy::too_many_arguments)]
fn attempt_one_region<T: Tessellation>(
    maze: &mut Maze<T>,
    snapshots: &mut SnapshotStack,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    locality: f64,
    min_region_size: usize,
    committed_nodes: &HashSet<NodeId>,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    if let Some(members) = try_reuse(maze, snapshots, target, start, finish, committed_nodes, preset_state, rng) {
        return Some(members);
    }
    try_grow(maze, snapshots, target, start, finish, locality, min_region_size, committed_nodes, preset_state, rng)
}

/// Whether `source` can be converted into `target` per the transition table in
/// Specs/repair.md. `Path` is never a valid source (callers filter regions on the critical
/// path out before this is consulted) nor a valid target.
fn transition_allowed(source: RegionClass, target: RegionClass) -> bool {
    if source == RegionClass::Path || target == RegionClass::Path {
        return false;
    }
    true
}

// ---- Reuse ----

fn try_reuse<T: Tessellation>(
    maze: &mut Maze<T>,
    snapshots: &mut SnapshotStack,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    committed_nodes: &HashSet<NodeId>,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, start, finish);
    let route = maze.analysis.route_info(&maze.graph, start, finish);
    let critical: HashSet<NodeId> = route.as_ref().map(|r| r.path.iter().copied().collect()).unwrap_or_default();

    let mut candidates: Vec<ComponentId> = scc.components.iter().enumerate()
        .filter(|(idx, members)| {
            let Some(&class) = classes.get(idx) else { return false; };
            if !transition_allowed(class, target) {
                return false;
            }
            if members.iter().any(|n| critical.contains(n) || committed_nodes.contains(n)) {
                return false;
            }
            true
        })
        .map(|(idx, _)| idx)
        .collect();
    candidates.sort_unstable();

    if candidates.is_empty() {
        return None;
    }

    // Prioritize candidates that already have a geometric border with the reachability side
    // the conversion needs to bridge from/to — e.g. for `Unreachable -> Trap`/`Alternative`,
    // a region with zero field-adjacent neighbors in `reachable_from_start` can never gain
    // the required inbound edge no matter how many of `MAX_REUSE_ATTEMPTS` are spent on it.
    // Without this, a handful of small unrelated regions (or a large region whose only
    // touching boundary is a small fraction of its perimeter) can crowd out the one
    // candidate that's actually convertible, within a small fixed attempt budget. Sorting by
    // descending border-count (ties broken by id, for determinism) spends the budget on
    // candidates with a real chance first; the remaining randomness (`offset`) only picks
    // where among equally-good candidates to start.
    let reachable_from_start: HashSet<NodeId> = maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> = maze.graph.reachable_to(finish).into_iter().collect();
    let mut border_count: std::collections::HashMap<ComponentId, usize> = std::collections::HashMap::new();
    for &idx in &candidates {
        let class = classes[&idx];
        let needs_inbound = matches!((class, target),
            (RegionClass::Unreachable, RegionClass::Trap) | (RegionClass::Unreachable, RegionClass::Alternative));
        let needs_outbound = matches!((class, target),
            (RegionClass::Unreachable, RegionClass::Alternative) | (RegionClass::Trap, RegionClass::Alternative));
        if !needs_inbound && !needs_outbound {
            // Cut-transitions (Trap/Alternative -> Unreachable, Alternative -> Trap) don't
            // need a NEW geometric border — they cut an edge that already exists, so border
            // proximity to a reachability set isn't the limiting factor for them.
            continue;
        }
        let count = scc.components[idx].iter()
            .flat_map(|&n| maze.field.neighbors(n))
            .filter(|nb| {
                (needs_inbound && reachable_from_start.contains(nb))
                    || (needs_outbound && reachable_to_finish.contains(nb))
            })
            .count();
        border_count.insert(idx, count);
    }
    // Tie-break randomization within equal border_count groups: shuffle first (Fisher-Yates,
    // seeded from `rng` so the overall call stays deterministic for a fixed seed), THEN
    // stable-sort by descending border_count. A circular `(offset + i) % len` walk (the
    // pattern used elsewhere in this file for un-prioritized candidate lists) would undo the
    // prioritization here by wrapping back around to low-priority candidates within the
    // `take` window — this is a plain prefix-take instead, in priority order.
    for i in (1..candidates.len()).rev() {
        let j = rng.random_range(0..=i);
        candidates.swap(i, j);
    }
    candidates.sort_by_key(|&idx| std::cmp::Reverse(*border_count.get(&idx).unwrap_or(&usize::MAX)));

    let take = (MAX_REUSE_ATTEMPTS as usize).min(candidates.len());
    for &idx in candidates.iter().take(take) {
        let members: HashSet<NodeId> = scc.components[idx].iter().copied().collect();
        let source_class = classes[&idx];

        // Each candidate gets its own snapshot/restore — `convert_region` can perform more
        // than one mutation before its final membership-check fails (e.g. the inbound edge
        // in `Unreachable -> Alternative`, added before the outbound search even starts), so
        // a failed candidate is not guaranteed to leave the graph as it found it on its own.
        snapshots.snapshot(maze);
        if let Some(result) = convert_region(maze, snapshots, &members, source_class, target, start, finish, preset_state, rng) {
            return Some(result);
        }
        snapshots.restore(maze);
    }
    None
}

// ---- Growth ----

#[allow(clippy::too_many_arguments)]
fn try_grow<T: Tessellation>(
    maze: &mut Maze<T>,
    snapshots: &mut SnapshotStack,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    locality: f64,
    min_region_size: usize,
    committed_nodes: &HashSet<NodeId>,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let scc = maze.analysis.scc(&maze.graph);
    let route = maze.analysis.route_info(&maze.graph, start, finish);
    let critical: HashSet<NodeId> = route.as_ref().map(|r| r.path.iter().copied().collect()).unwrap_or_default();

    // Seed candidates: any node not on the critical path and not already committed this
    // `apply()` call — including nodes whose current region is `Path`, per Specs/repair.md's
    // "Region Growth" section ("seed MAY belong to the Pass region if it is not part of the
    // critical path"). Unlike reuse (which converts a whole existing region and therefore
    // can't touch a Path region at all), growth only carves a small subset out from around a
    // single seed node and then severs it (`sever_from_parent`) — so the seed's parent region
    // class is irrelevant; only the seed node itself must be off the critical path. This
    // matters in practice: a tree-shaped maze (e.g. `recursive_backtracker` with a low/zero
    // `one_way_chance`) has no cycles at all, so its single SCC covers every node and is
    // classified entirely as `Path` — without this, `try_grow` would have zero seed
    // candidates and could never create a Trap/Alternative/Unreachable region from scratch.
    let mut seed_candidates: Vec<NodeId> = scc.components.iter()
        .flat_map(|members| members.iter().copied())
        .filter(|n| !critical.contains(n) && !committed_nodes.contains(n))
        .collect();
    seed_candidates.sort_unstable();

    if seed_candidates.is_empty() {
        return None;
    }

    // Prioritize seeds that already sit on the geometric border of the reachability side the
    // target class needs a bridge to/from — e.g. a seed deep inside a large Unreachable
    // region, far from any start-reachable/finish-reachable neighbor, can grow to
    // `min_region_size` and sever cleanly but then still fail `convert_region`'s
    // membership-check (no edge can be found to the right side from anywhere in the grown
    // subset). Picking border-adjacent seeds first means the eventual `members` subset is
    // far more likely to actually border the side it needs, within the small fixed
    // `MAX_GROW_ATTEMPTS` budget. Same tie-break-by-shuffle-then-stable-sort approach as
    // `try_reuse`, for the same determinism reason.
    let reachable_from_start: HashSet<NodeId> = maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> = maze.graph.reachable_to(finish).into_iter().collect();
    let needs_inbound = matches!(target, RegionClass::Trap | RegionClass::Alternative);
    let needs_outbound = matches!(target, RegionClass::Alternative);
    let border_score = |n: NodeId| -> usize {
        if !needs_inbound && !needs_outbound {
            return 0;
        }
        maze.field.neighbors(n).into_iter()
            .filter(|nb| {
                (needs_inbound && reachable_from_start.contains(nb))
                    || (needs_outbound && reachable_to_finish.contains(nb))
            })
            .count()
    };
    for i in (1..seed_candidates.len()).rev() {
        let j = rng.random_range(0..=i);
        seed_candidates.swap(i, j);
    }
    seed_candidates.sort_by_key(|&n| std::cmp::Reverse(border_score(n)));

    let take = (MAX_GROW_ATTEMPTS as usize).min(seed_candidates.len());
    for &seed in seed_candidates.iter().take(take) {
        let Some(seed_component) = scc.component_of(seed) else { continue };

        // Each seed gets its own snapshot/restore — `sever_from_parent` mutates the graph
        // (cuts real edges) before `convert_region` even runs; if this seed's attempt fails
        // at any later step, that severance must not leak into the next seed's attempt or
        // into a later seed's eventual success.
        snapshots.snapshot(maze);

        if let Some(members) = grow_front(maze, seed, seed_component, &scc, locality, min_region_size, &critical, committed_nodes, rng) {
            // Sever members from the rest of their parent region before conversion — part of
            // this growth attempt's budget, not a separate connect step.
            if sever_from_parent(maze, &members, preset_state) {
                if let Some(result) = convert_region(maze, snapshots, &members, RegionClass::Unreachable, target, start, finish, preset_state, rng) {
                    return Some(result);
                }
            }
        }

        snapshots.restore(maze);
    }
    None
}

/// Front-expansion from `seed`, staying within `seed`'s original SCC component (snapshotted
/// before any mutation as `scc`/`seed_component` — growth never mutates edges itself, so this
/// stays valid throughout). `locality` blends uniform frontier choice (0) with directional
/// continuation along the parent's edge (1), via `field.is_straight`. Stops at `min_region_size`
/// or when the frontier is exhausted; the latter is a failed attempt (`None`).
#[allow(clippy::too_many_arguments)]
fn grow_front<T: Tessellation>(
    maze: &Maze<T>,
    seed: NodeId,
    seed_component: ComponentId,
    scc: &ConnectedComponents,
    locality: f64,
    min_region_size: usize,
    critical: &HashSet<NodeId>,
    committed_nodes: &HashSet<NodeId>,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let mut in_region: HashSet<NodeId> = HashSet::new();
    in_region.insert(seed);
    let mut frontier: Vec<(NodeId, Option<NodeId>)> = vec![(seed, None)];

    while in_region.len() < min_region_size {
        if frontier.is_empty() {
            return None;
        }
        let fi = rng.random_range(0..frontier.len());
        let (src, parent) = frontier.remove(fi);

        let mut candidates: Vec<NodeId> = maze.field.neighbors(src).into_iter()
            .filter(|n| !in_region.contains(n) && !critical.contains(n) && !committed_nodes.contains(n))
            .filter(|n| scc.component_of(*n) == Some(seed_component))
            .collect();
        candidates.sort_unstable();
        if candidates.is_empty() {
            continue;
        }

        let next = if let Some(p) = parent {
            if rng.random::<f64>() < locality {
                candidates.iter().copied().find(|&n| maze.field.is_straight(p, src, n))
                    .unwrap_or(candidates[rng.random_range(0..candidates.len())])
            } else {
                candidates[rng.random_range(0..candidates.len())]
            }
        } else {
            candidates[rng.random_range(0..candidates.len())]
        };

        in_region.insert(next);
        frontier.push((next, Some(src)));
    }

    Some(in_region)
}

/// Removes every edge (either direction) between `members` and the rest of their original SCC
/// component, so `members` becomes its own isolated (`Unreachable`) component before entering
/// `convert_region`. Returns false if any required cut is blocked by `preset_state` — caller
/// treats that as a failed growth attempt for this seed.
fn sever_from_parent<T: Tessellation>(maze: &mut Maze<T>, members: &HashSet<NodeId>, preset_state: &PresetState) -> bool {
    let mut to_cut: Vec<(NodeId, NodeId)> = Vec::new();
    for &n in members {
        for neighbor in maze.field.neighbors(n) {
            if members.contains(&neighbor) {
                continue;
            }
            if maze.graph.edge_between(n, neighbor).is_some() {
                to_cut.push((n, neighbor));
            }
            if maze.graph.edge_between(neighbor, n).is_some() {
                to_cut.push((neighbor, n));
            }
        }
    }
    to_cut.sort_unstable();
    to_cut.dedup();
    for (from, to) in to_cut {
        if maze.graph.edge_between(from, to).is_some() && !try_remove_edge(&mut maze.graph, from, to, preset_state) {
            return false;
        }
    }
    true
}

// ---- Conversion ----

/// Converts `members` (currently classified as `source`) into `target`, validating the result
/// via membership-check (Specs/repair.md's "Region conversion" section). Each bridging-edge
/// candidate is tried as its own snapshot/restore unit; returns `Some(members)` on the first
/// candidate (or the no-op case) that lands the whole region in `target`, `None` if every
/// candidate (up to `MAX_CONNECT_ATTEMPTS`) fails. The `Unreachable -> Alternative` transition
/// additionally wraps its inbound edge in its own snapshot, since that edge is added before the
/// outbound candidate search even starts and must not linger if that search exhausts every
/// candidate — callers must not assume a failed `convert_region` call leaves the graph
/// untouched purely from the inner candidate-loop undos; the caller is still responsible for
/// its own snapshot/restore around the whole call (see `try_reuse`/`try_grow`).
#[allow(clippy::too_many_arguments)]
fn convert_region<T: Tessellation>(
    maze: &mut Maze<T>,
    snapshots: &mut SnapshotStack,
    members: &HashSet<NodeId>,
    source: RegionClass,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    if !transition_allowed(source, target) {
        return None;
    }
    if source == target {
        // Already the target class — no-op commit, still must pass membership-check in case
        // the caller's `source` snapshot is stale (defensive; should already hold).
        if membership_matches(maze, members, target, start, finish) {
            return Some(members.clone());
        }
        return None;
    }

    let reachable_from_start: HashSet<NodeId> = maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> = maze.graph.reachable_to(finish).into_iter().collect();

    match (source, target) {
        (RegionClass::Unreachable, RegionClass::Trap) => {
            // A region can be `Unreachable` (nothing reaches IN) while already holding
            // outgoing edges that reach finish-reachable territory (nobody could use them
            // because nothing could get in) — once an inbound edge is added, the region
            // becomes reachable both ways and lands on `Alternative`, not `Trap`. If the
            // direct single-edge bridge doesn't land on `Trap`, fall back to severing every
            // existing outbound edge from `members` into finish-reachable territory first
            // (same idea as `sever_from_parent`, but targeted at the finish-reachable side
            // specifically), then retry the inbound bridge.
            if let Some(result) = try_bridge_in(maze, members, &reachable_from_start, target, start, finish, preset_state, rng) {
                Some(result)
            } else {
                try_bridge_in_after_severing_outbound(maze, snapshots, members, &reachable_from_start, &reachable_to_finish, target, start, finish, preset_state, rng)
            }
        }
        (RegionClass::Unreachable, RegionClass::Alternative) => {
            // Needs both an inbound (start-reachable -> region) and outbound
            // (region -> finish-reachable) edge. Add inbound first (deterministic, no
            // candidate search needed beyond one bridge), then run the bridging-candidate
            // search for the outbound edge under the same membership-check contract. Own
            // snapshot around the inbound edge specifically — if the outbound search then
            // exhausts every candidate, the inbound edge must not linger; `try_bridge_out`'s
            // own per-candidate undo only covers the outbound edge it tried, not this one.
            snapshots.snapshot(maze);
            let inbound = first_bridge(maze, &reachable_from_start, members);
            let result = match inbound {
                None => None,
                Some((src, dst)) => {
                    if try_add_directed_edge(&mut maze.graph, src, dst, preset_state) {
                        let reachable_to_finish: HashSet<NodeId> = maze.graph.reachable_to(finish).into_iter().collect();
                        try_bridge_out(maze, members, &reachable_to_finish, target, start, finish, preset_state, rng)
                    } else {
                        None
                    }
                }
            };
            if result.is_none() {
                snapshots.restore(maze);
            }
            result
        }
        (RegionClass::Trap, RegionClass::Alternative) => {
            try_bridge_out(maze, members, &reachable_to_finish, target, start, finish, preset_state, rng)
        }
        (RegionClass::Trap, RegionClass::Unreachable) => {
            try_cut_in(maze, members, &reachable_from_start, target, start, finish, preset_state, rng)
        }
        (RegionClass::Alternative, RegionClass::Trap) => {
            try_cut_out(maze, members, &reachable_to_finish, target, start, finish, preset_state, rng)
        }
        (RegionClass::Alternative, RegionClass::Unreachable) => {
            try_cut_in(maze, members, &reachable_from_start, target, start, finish, preset_state, rng)
        }
        _ => None,
    }
}

/// Fallback for `Unreachable -> Trap` when the region already holds existing outbound edges
/// into `reachable_to_finish` — a single inbound bridge alone can't land it on `Trap` in that
/// case (it becomes `Alternative` instead, since the region can already reach finish through
/// those pre-existing edges). Severs every such existing outbound edge from `members` first
/// (own snapshot, since this is a real graph mutation distinct from the bridging-candidate
/// search), then retries the inbound bridge. If `members` turns out to have no edges to sever
/// (the direct bridge's failure had some other cause, e.g. preset blocking every inbound
/// candidate), this is a no-op fallback that still fails — same `None` result either way.
#[allow(clippy::too_many_arguments)]
fn try_bridge_in_after_severing_outbound<T: Tessellation>(
    maze: &mut Maze<T>,
    snapshots: &mut SnapshotStack,
    members: &HashSet<NodeId>,
    reachable_from_start: &HashSet<NodeId>,
    reachable_to_finish: &HashSet<NodeId>,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let mut to_cut: Vec<(NodeId, NodeId)> = members.iter()
        .flat_map(|&n| maze.graph.outgoing_neighbors(n).map(move |nb| (n, nb)))
        .filter(|(_, nb)| reachable_to_finish.contains(nb))
        .collect();
    to_cut.sort_unstable();
    to_cut.dedup();
    if to_cut.is_empty() {
        return None;
    }

    snapshots.snapshot(maze);
    for (from, to) in &to_cut {
        if !try_remove_edge(&mut maze.graph, *from, *to, preset_state) {
            snapshots.restore(maze);
            return None;
        }
    }
    let result = try_bridge_in(maze, members, reachable_from_start, target, start, finish, preset_state, rng);
    if result.is_none() {
        snapshots.restore(maze);
    }
    result
}

fn first_bridge<T: Tessellation>(maze: &Maze<T>, side: &HashSet<NodeId>, members: &HashSet<NodeId>) -> Option<(NodeId, NodeId)> {
    let mut candidates: Vec<(NodeId, NodeId)> = Vec::new();
    for &m in members {
        for neighbor in maze.field.neighbors(m) {
            if side.contains(&neighbor) {
                candidates.push((neighbor, m));
            }
        }
    }
    candidates.sort_unstable();
    candidates.into_iter().next()
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

fn membership_matches<T: Tessellation>(maze: &Maze<T>, members: &HashSet<NodeId>, target: RegionClass, start: NodeId, finish: NodeId) -> bool {
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, start, finish);
    let result_classes: HashSet<RegionClass> = members.iter()
        .filter_map(|n| scc.component_of(*n))
        .filter_map(|idx| classes.get(&idx).copied())
        .collect();
    result_classes.len() == 1 && result_classes.contains(&target)
}

#[allow(clippy::too_many_arguments)]
fn try_bridge_in<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    side: &HashSet<NodeId>,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    try_with_candidates(maze, members, side, false, target, start, finish, preset_state, rng)
}

#[allow(clippy::too_many_arguments)]
fn try_bridge_out<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    side: &HashSet<NodeId>,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    try_with_candidates(maze, members, side, true, target, start, finish, preset_state, rng)
}

/// Cuts a single candidate edge from `side` into `members` (inbound) — used for transitions
/// that need to sever connectivity from a reachability set, not add to it.
#[allow(clippy::too_many_arguments)]
fn try_cut_in<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    side: &HashSet<NodeId>,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    try_cut_candidates(maze, members, side, false, target, start, finish, preset_state, rng)
}

/// Cuts a single candidate edge from `members` into `side` (outbound).
#[allow(clippy::too_many_arguments)]
fn try_cut_out<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    side: &HashSet<NodeId>,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    try_cut_candidates(maze, members, side, true, target, start, finish, preset_state, rng)
}

#[allow(clippy::too_many_arguments)]
fn try_with_candidates<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    side: &HashSet<NodeId>,
    outbound: bool,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let candidates = bridging_candidates(maze, members, side, outbound);
    if candidates.is_empty() {
        return None;
    }
    let take = (MAX_CONNECT_ATTEMPTS as usize).min(candidates.len());
    let offset = rng.random_range(0..candidates.len());
    for i in 0..take {
        let (from, to) = candidates[(offset + i) % candidates.len()];
        // Track whether THIS attempt actually added the edge — a candidate pair can already
        // be connected before we get here (e.g. an earlier candidate's add happened to also
        // satisfy this pair, or it was just always there). Unconditionally removing it after
        // a failed membership-check would destroy a pre-existing edge that had nothing to do
        // with this attempt, silently corrupting `members`' internal connectivity for every
        // subsequent candidate in this same loop (and any later reuse/grow attempt reusing
        // the same `members`) — this was a real bug, not a hypothetical.
        let already_present = maze.graph.edge_between(from, to).is_some();
        if !already_present && !try_add_directed_edge(&mut maze.graph, from, to, preset_state) {
            continue;
        }
        let mm = membership_matches(maze, members, target, start, finish);
        if mm {
            return Some(members.clone());
        }
        // Undo this candidate's edge before trying the next one — but only if we were the
        // ones who added it.
        if !already_present {
            let _ = try_remove_edge(&mut maze.graph, from, to, &PresetState::empty());
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn try_cut_candidates<T: Tessellation>(
    maze: &mut Maze<T>,
    members: &HashSet<NodeId>,
    side: &HashSet<NodeId>,
    outbound: bool,
    target: RegionClass,
    start: NodeId,
    finish: NodeId,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> Option<HashSet<NodeId>> {
    let candidates: Vec<(NodeId, NodeId)> = bridging_candidates(maze, members, side, outbound).into_iter()
        .filter(|&(from, to)| maze.graph.edge_between(from, to).is_some())
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let take = (MAX_CONNECT_ATTEMPTS as usize).min(candidates.len());
    let offset = rng.random_range(0..candidates.len());
    for i in 0..take {
        let (from, to) = candidates[(offset + i) % candidates.len()];
        if !try_remove_edge(&mut maze.graph, from, to, preset_state) {
            continue;
        }
        if membership_matches(maze, members, target, start, finish) {
            return Some(members.clone());
        }
        // Re-add to restore state before trying the next candidate — best-effort; if this is
        // a preset edge it would never have been removed above, so this can't violate presets.
        let _ = try_add_directed_edge(&mut maze.graph, from, to, &PresetState::empty());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;
    use rand::SeedableRng;
    use rand::rngs::SmallRng;
    use crate::graph::{Graph as G, EdgeKind as EK};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::repair::params::build_params;
    use crate::quality_control::issue::MISSING_REGIONS;

    fn default_params() -> StrategyParams {
        build_params(
            <MissingRegionsStrategy as RepairStrategy<SquareTessellation>>::params(&MissingRegionsStrategy),
            None,
        )
    }

    fn issue_for(missing: Vec<(RegionClass, u32)>) -> Issue {
        Issue::with_data(MISSING_REGIONS, IssueData::MissingRegions {
            missing_by_class: missing.into_iter().collect(),
        })
    }

    /// 1x6 row: start(0) -> 1 -> finish(2), each a singleton; nodes 3,4,5 unconnected (each a
    /// singleton Unreachable region) and geometrically adjacent in a chain.
    fn maze_with_path_and_unreachables() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        g.add_edge(nodes[1], nodes[2], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);
        (maze, nodes)
    }

    #[test]
    fn apply_fails_on_missing_data() {
        let (mut maze, _) = maze_with_path_and_unreachables();
        let issue = Issue::new(MISSING_REGIONS);
        let mut rng = SmallRng::seed_from_u64(1);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_fails_without_start_or_finish() {
        let (mut maze, _) = maze_with_path_and_unreachables();
        maze.meta.start = None;
        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(1);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_reuses_unreachable_region_into_trap() {
        let (mut maze, nodes) = maze_with_path_and_unreachables();
        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(7);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let classes = maze.analysis.region_classes(&maze.graph, nodes[0], nodes[2]);
        let scc = maze.analysis.scc(&maze.graph);
        let has_trap = [nodes[3], nodes[4], nodes[5]].iter().any(|&n| {
            scc.component_of(n).and_then(|idx| classes.get(&idx)).copied() == Some(RegionClass::Trap)
        });
        assert!(has_trap, "expected one of the unreachable singletons to become a Trap region");
    }

    #[test]
    fn apply_path_class_is_skipped_not_failed() {
        let (mut maze, _) = maze_with_path_and_unreachables();
        let issue = issue_for(vec![(RegionClass::Path, 1)]);
        let mut rng = SmallRng::seed_from_u64(1);
        let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
        let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_before, edges_after, "Path-only request must not mutate the graph");
    }

    #[test]
    fn apply_fails_when_no_candidates_at_all() {
        // Path-only maze with no spare nodes to reuse or grow from.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        g.add_edge(nodes[1], nodes[2], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);

        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(1);
        let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
        let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_before, edges_after, "failed attempts must leave the graph untouched");
    }

    #[test]
    fn apply_respects_preset_blocked_pairs_during_reuse() {
        let (mut maze, nodes) = maze_with_path_and_unreachables();
        let mut preset_state = PresetState::empty();
        // Block every possible bridge from the path into the unreachable singletons.
        for &from in &[nodes[0], nodes[1], nodes[2]] {
            for &to in &[nodes[3], nodes[4], nodes[5]] {
                preset_state.blocked.insert((from, to));
                preset_state.blocked.insert((to, from));
            }
        }
        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(3);
        let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &preset_state);
        assert!(matches!(result, RepairResult::Failed));
        let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_before, edges_after);
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let (mut maze_a, _) = maze_with_path_and_unreachables();
        let issue_a = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng_a = SmallRng::seed_from_u64(99);
        MissingRegionsStrategy.apply(&issue_a, &mut maze_a, &mut SnapshotStack::new(), &mut rng_a, &default_params(), &PresetState::empty());

        let (mut maze_b, _) = maze_with_path_and_unreachables();
        let issue_b = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng_b = SmallRng::seed_from_u64(99);
        MissingRegionsStrategy.apply(&issue_b, &mut maze_b, &mut SnapshotStack::new(), &mut rng_b, &default_params(), &PresetState::empty());

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }

    #[test]
    fn apply_never_uses_critical_path_nodes_as_seed_or_bridge_target() {
        let (mut maze, nodes) = maze_with_path_and_unreachables();
        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(11);
        MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        // Critical path nodes (0,1,2) must keep their original outgoing edges only to each
        // other -- they should not have been absorbed into the new Trap region's component.
        let classes = maze.analysis.region_classes(&maze.graph, nodes[0], nodes[2]);
        let scc = maze.analysis.scc(&maze.graph);
        for &n in &[nodes[0], nodes[1], nodes[2]] {
            let class = scc.component_of(n).and_then(|idx| classes.get(&idx)).copied();
            assert_eq!(class, Some(RegionClass::Path));
        }
    }

    #[test]
    fn apply_grows_when_no_reusable_unreachable_region_exists() {
        // 1x2 path (start/finish) plus a 1x3 strip of unconnected nodes geometrically
        // adjacent to each other but not to the path -- forces growth (front expansion)
        // since reuse alone (a single singleton) still works, so use min_region_size=2
        // to force growth to actually expand the frontier.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[1]);

        let mut overrides = StdHashMap::new();
        overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "2".to_string());
        let params = build_params(
            <MissingRegionsStrategy as RepairStrategy<SquareTessellation>>::params(&MissingRegionsStrategy),
            Some(&overrides),
        );

        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(5);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_grows_from_a_tree_shaped_maze_with_no_non_path_regions_at_all() {
        // Regression test: a tree-shaped maze (no cycles, e.g. the typical
        // recursive_backtracker output with a low/zero one_way_chance) has exactly one SCC
        // covering every node, classified entirely as Path -- there is no pre-existing
        // Unreachable/Trap/Alternative region anywhere to reuse or seed growth from. Growth
        // must still be able to carve a Trap region out of a non-critical-path branch.
        //
        // Layout: a 3x3 grid, every node connected into one all-bidirectional spanning tree
        // (no cycles):
        //   (0,0)-(1,0)-(2,0)
        //           |     |
        //         (1,1) (2,1)-(2,2)
        //           |
        //   (0,1)-(0,2)   (1,2) (leaf off (0,1) and (1,1) respectively)
        // start=(0,0), finish=(2,0): critical path is (0,0)-(1,0)-(2,0). Every other node is
        // reachable both ways through the tree's single connecting path but NOT on the
        // critical path -- a valid growth seed.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 3), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let all_coords: Vec<(i32, i32)> = (0..3).flat_map(|y| (0..3).map(move |x| (x, y))).collect();
        let nodes: StdHashMap<(i32, i32), NodeId> = all_coords.iter()
            .map(|&(x, y)| ((x, y), field.node_at(crate::space::SquarePoint { x, y }).unwrap()))
            .collect();
        g.add_bidirectional_edge(nodes[&(0, 0)], nodes[&(1, 0)], EK::Basic);
        g.add_bidirectional_edge(nodes[&(1, 0)], nodes[&(2, 0)], EK::Basic);
        g.add_bidirectional_edge(nodes[&(1, 0)], nodes[&(1, 1)], EK::Basic);
        g.add_bidirectional_edge(nodes[&(1, 1)], nodes[&(1, 2)], EK::Basic);
        g.add_bidirectional_edge(nodes[&(1, 1)], nodes[&(0, 1)], EK::Basic);
        g.add_bidirectional_edge(nodes[&(0, 1)], nodes[&(0, 2)], EK::Basic);
        g.add_bidirectional_edge(nodes[&(2, 0)], nodes[&(2, 1)], EK::Basic);
        g.add_bidirectional_edge(nodes[&(2, 1)], nodes[&(2, 2)], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let start = nodes[&(0, 0)];
        let finish = nodes[&(2, 0)];
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);

        // Sanity check the fixture: confirm there is exactly one SCC (the whole tree) and it
        // has zero Unreachable/Trap regions to reuse or seed growth from (every node is
        // either on the shortest path -- Path -- or reachable both ways through the tree's
        // single connecting path -- Alternative).
        let classes_before = maze.analysis.region_classes(&maze.graph, start, finish);
        assert!(
            classes_before.values().all(|&c| c == RegionClass::Path || c == RegionClass::Alternative),
            "fixture must start with zero Unreachable/Trap regions, got: {:?}", classes_before.values().collect::<Vec<_>>()
        );

        let mut overrides = StdHashMap::new();
        overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "1".to_string());
        let params = build_params(
            <MissingRegionsStrategy as RepairStrategy<SquareTessellation>>::params(&MissingRegionsStrategy),
            Some(&overrides),
        );

        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(5);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }), "growth must succeed even with zero pre-existing non-Path regions");

        let classes_after = maze.analysis.region_classes(&maze.graph, start, finish);
        assert!(classes_after.values().any(|&c| c == RegionClass::Trap), "expected a Trap region to have been created");
    }

    /// 1x8 row: start(0) -> 1 -> finish(2), then four singleton Unreachable regions (3,4,5,6)
    /// geometrically chained, and one more singleton (7) chained after them -- enough spare
    /// regions for multi-item scenarios.
    fn maze_with_many_unreachables() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(8, 1), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        g.add_edge(nodes[1], nodes[2], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);
        (maze, nodes)
    }

    #[test]
    fn apply_two_trap_regions_both_succeed_via_reuse() {
        let (mut maze, nodes) = maze_with_many_unreachables();
        let issue = issue_for(vec![(RegionClass::Trap, 2)]);
        let mut rng = SmallRng::seed_from_u64(13);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let classes = maze.analysis.region_classes(&maze.graph, nodes[0], nodes[2]);
        let scc = maze.analysis.scc(&maze.graph);
        let trap_count = [nodes[3], nodes[4], nodes[5], nodes[6], nodes[7]].iter()
            .filter(|&&n| scc.component_of(n).and_then(|idx| classes.get(&idx)).copied() == Some(RegionClass::Trap))
            .count();
        assert_eq!(trap_count, 2, "exactly 2 distinct singletons should have become separate Trap regions");
    }

    #[test]
    fn apply_second_item_never_reuses_first_items_committed_nodes() {
        let (mut maze, nodes) = maze_with_many_unreachables();
        let issue = issue_for(vec![(RegionClass::Trap, 2)]);
        let mut rng = SmallRng::seed_from_u64(13);
        MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());

        let classes = maze.analysis.region_classes(&maze.graph, nodes[0], nodes[2]);
        let scc = maze.analysis.scc(&maze.graph);
        let trap_components: HashSet<ComponentId> = [nodes[3], nodes[4], nodes[5], nodes[6], nodes[7]].iter()
            .filter_map(|&n| scc.component_of(n))
            .filter(|idx| classes.get(idx).copied() == Some(RegionClass::Trap))
            .collect();
        // Two Trap regions were created -- they must be two distinct components, not the same
        // component re-grown/re-converted (which would mean the second item touched the
        // first's already-committed nodes instead of finding a fresh region).
        assert_eq!(trap_components.len(), 2);
    }

    #[test]
    fn apply_partial_success_within_one_class_is_fixed() {
        // 2 Trap regions requested but only enough spare singletons for partial progress
        // before a later item in the same class runs out of fresh (non-committed) candidates
        // and fails -- overall result must still be `Fixed` because at least one item in the
        // whole call succeeded, not `Failed` just because the full `missing` count wasn't met.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        // Only nodes[2],nodes[3] left as Unreachable singletons -- but they are geometrically
        // adjacent to each other (node[2]-node[3]), so once one becomes Trap (and is added to
        // committed_nodes) the other still has its own neighbor (node[1]=finish) to bridge
        // from, so this remains a 2-region scenario, not a contrived deadlock.
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[1]);

        let issue = issue_for(vec![(RegionClass::Trap, 2)]);
        let mut rng = SmallRng::seed_from_u64(21);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }

    #[test]
    fn apply_max_total_failures_aborts_remaining_classes() {
        // `Alternative` is processed first (sorted by class name, "alternative" < "trap") and
        // is unreachable here (no outbound-to-finish bridge exists from the unreachable
        // singletons without looping back through the Path region in this 1x6 strip) -- it
        // burns through `MAX_TOTAL_FAILURES` before `Trap` ever gets a turn, so `Trap`'s
        // `missing` count must remain fully untouched (0 committed) and the overall result is
        // `Failed` (nothing committed at all).
        let (mut maze, _) = maze_with_path_and_unreachables();
        let issue = issue_for(vec![(RegionClass::Trap, 1), (RegionClass::Alternative, 1)]);
        let mut rng = SmallRng::seed_from_u64(21);
        let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Failed));
        let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_before, edges_after, "every attempted mutation must have been rolled back");
    }

    #[test]
    fn apply_growth_never_crosses_into_a_different_scc_component() {
        // Path: 0 -> 1 (start -> finish). A 3-node Unreachable SCC (2<->3<->4, cyclic, all
        // mutually reachable) sits geometrically adjacent to a *separate* singleton
        // Unreachable node 5 (5 is a field-neighbor of 4, but no edge connects them, so it's
        // its own SCC). With min_region_size=2, growth seeded inside the 3-node component
        // must stay within {2,3,4} and never pull in node 5 from the neighboring component.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        g.add_bidirectional_edge(nodes[2], nodes[3], EK::Basic);
        g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[1]);

        let mut overrides = StdHashMap::new();
        overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "2".to_string());
        let params = build_params(
            <MissingRegionsStrategy as RepairStrategy<SquareTessellation>>::params(&MissingRegionsStrategy),
            Some(&overrides),
        );

        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(17);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        // node 5 must remain its own untouched Unreachable singleton -- not absorbed into the
        // grown/converted Trap region, and not connected to anything.
        assert!(maze.graph.edge_between(nodes[4], nodes[5]).is_none());
        assert!(maze.graph.edge_between(nodes[5], nodes[4]).is_none());
        let classes = maze.analysis.region_classes(&maze.graph, nodes[0], nodes[1]);
        let scc = maze.analysis.scc(&maze.graph);
        assert_eq!(scc.component_of(nodes[5]).and_then(|idx| classes.get(&idx)).copied(), Some(RegionClass::Unreachable));
    }

    #[test]
    fn apply_does_not_leak_inbound_edge_from_a_failed_unreachable_to_alternative_candidate() {
        // Two Unreachable singletons (3 and 5), each geometrically adjacent to the path.
        // Node 3's only route to finish-reachable territory is blocked by preset, so any
        // candidate that tries to convert node 3 into Alternative must add its inbound edge
        // (from the path) and then fail the outbound search -- that inbound edge must not
        // survive into the final graph once node 5 succeeds instead. Regression test for the
        // mutation-leak bug in convert_region's (Unreachable -> Alternative) transition.
        // Try many seeds to make the candidate ordering exercise node 3 first at least once
        // regardless of rng -- the bug only manifests when a failing candidate is tried before
        // a succeeding one in the same call.
        for seed in 0..30u64 {
            let mut ids = IdGenerator::new();
            let field = Field::new(square_rect(6, 1), &mut ids).unwrap();
            let mut g = G::new();
            field.build_nodes(&mut g);
            let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
            g.add_edge(nodes[0], nodes[1], EK::Basic);
            g.add_edge(nodes[1], nodes[2], EK::Basic);
            let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
            maze.meta.start = Some(nodes[0]);
            maze.meta.finish = Some(nodes[2]);

            let mut preset_state = PresetState::empty();
            // Block every outgoing edge from node 3 -- it can receive an inbound edge but can
            // never get an outbound edge to finish-reachable territory, so
            // Unreachable->Alternative must fail for it specifically after adding the inbound
            // edge.
            for &to in &[nodes[2], nodes[4]] {
                preset_state.blocked.insert((nodes[3], to));
            }

            let issue = issue_for(vec![(RegionClass::Alternative, 1)]);
            let mut rng = SmallRng::seed_from_u64(seed);
            let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &preset_state);
            if matches!(result, RepairResult::Fixed { score: None }) {
                // Whatever succeeded, node 3 must never have gained an inbound edge unless it
                // is itself the final committed Alternative region (in which case it would also
                // need a valid outbound edge, which preset forbids) -- so node 3 must have
                // exactly its original zero edges.
                assert!(maze.graph.edge_between(nodes[1], nodes[3]).is_none(), "seed {seed}: leaked inbound edge into node 3");
                assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_none(), "seed {seed}: leaked inbound edge into node 3");
            }
        }
    }

    /// 1x17 row: 0-1-2 is the path (start=0, finish=2). Node 2 borders node 3, which heads a
    /// 6-node connected Unreachable region (3..8) -- the only candidate actually convertible
    /// into Trap. A gap at node 9 (left disconnected) separates it from 7 decoy Unreachable
    /// singletons at nodes 10..16, with zero adjacency to the path or to the big region.
    fn maze_with_one_bordering_region_and_decoys() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(17, 1), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        g.add_edge(nodes[1], nodes[2], EK::Basic);
        for i in 3..8 {
            g.add_bidirectional_edge(nodes[i], nodes[i + 1], EK::Basic);
        }
        // nodes[9] stays a disconnected gap; nodes[10..17] are 7 decoy singletons.
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);
        (maze, nodes)
    }

    #[test]
    fn apply_reuse_prioritizes_the_region_actually_bordering_the_path() {
        // Regression test for "growth/reuse picks a region with no border to the path":
        // with MAX_REUSE_ATTEMPTS=5 candidates out of 8 Unreachable components total, an
        // unprioritized random pick has a real chance of exhausting the budget on decoys and
        // failing outright. Border-prioritization must always try the actually-convertible
        // region first regardless of seed.
        let (maze, _) = maze_with_one_bordering_region_and_decoys();
        let classes = maze.analysis.region_classes(&maze.graph, maze.meta.start.unwrap(), maze.meta.finish.unwrap());
        let unreachable_count = classes.values().filter(|&&c| c == RegionClass::Unreachable).count();
        assert!(unreachable_count > MAX_REUSE_ATTEMPTS as usize, "fixture must have more candidates than the attempt budget");

        for seed in 0..30u64 {
            let (mut maze, _) = maze_with_one_bordering_region_and_decoys();
            let issue = issue_for(vec![(RegionClass::Trap, 1)]);
            let mut rng = SmallRng::seed_from_u64(seed);
            let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
            assert!(matches!(result, RepairResult::Fixed { score: None }), "seed {seed}: must succeed by prioritizing the bordering region over decoys");
        }
    }

    #[test]
    fn apply_makes_trap_from_unreachable_region_with_existing_outbound_edge_to_finish() {
        // Regression test for a real user-reported bug: an Unreachable region (nothing
        // reaches IN) can still already hold an outgoing edge into finish-reachable
        // territory, since nothing being able to enter doesn't mean nothing can leave. Once
        // a plain single-edge inbound bridge is added (the old behavior), the region
        // immediately becomes reachable both ways -> Alternative, not Trap, and the bridge
        // attempt is rejected by membership-check every time. The fix must detect this and
        // sever the pre-existing outbound edge before retrying the inbound bridge.
        //
        // Layout (1x5 row): 0 -> 1 -> 2 is the path (start=0, finish=2). Node 3 is an
        // Unreachable singleton (nobody can reach it) with a directed edge 3 -> 2 already
        // present -- so node 3 already "reaches" finish, it's just unreachable FROM start.
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        g.add_edge(nodes[1], nodes[2], EK::Basic);
        g.add_edge(nodes[3], nodes[2], EK::Basic); // pre-existing outbound edge to finish-reachable
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);

        // Sanity: node 3 starts Unreachable despite already reaching finish.
        let classes_before = maze.analysis.region_classes(&maze.graph, nodes[0], nodes[2]);
        let scc_before = maze.analysis.scc(&maze.graph);
        assert_eq!(scc_before.component_of(nodes[3]).and_then(|idx| classes_before.get(&idx)).copied(), Some(RegionClass::Unreachable));

        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(990043);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let classes_after = maze.analysis.region_classes(&maze.graph, nodes[0], nodes[2]);
        let scc_after = maze.analysis.scc(&maze.graph);
        assert_eq!(scc_after.component_of(nodes[3]).and_then(|idx| classes_after.get(&idx)).copied(), Some(RegionClass::Trap));
    }

    #[test]
    fn apply_undo_does_not_destroy_a_pre_existing_edge_shared_by_two_candidates() {
        // Regression test for a real user-reported bug: `try_with_candidates`'s per-candidate
        // undo unconditionally removed the candidate edge after a failed membership-check,
        // even when that edge had already existed BEFORE this attempt (e.g. two different
        // bridging candidates resolve to coordinates that turn out to already be connected).
        // That silently destroyed a pre-existing edge unrelated to this conversion attempt,
        // corrupting `members`' internal connectivity for every subsequent candidate in the
        // same loop -- manifesting as `membership_matches` seeing a region split into
        // multiple classes (e.g. {Unreachable, Trap}) no matter which candidate was tried,
        // even though a clean attempt would have succeeded.
        //
        // Large region (10x10 grid, fully bidirectional internally -- like the interior of a
        // real recursive_backtracker maze, not an artificially one-way-heavy structure) with
        // a single pre-existing one-way edge from one corner into the path row, matching the
        // real-world shape: "Unreachable region that already happens to reach finish through
        // one existing edge" rather than many.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(10, 11), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();

        for x in 0..9 {
            g.add_bidirectional_edge(n(x, 0), n(x + 1, 0), EK::Basic);
        }
        // Region (rows 1..11): fully bidirectional grid block, no artificial one-way mesh.
        for y in 1..11 {
            for x in 0..9 {
                g.add_bidirectional_edge(n(x, y), n(x + 1, y), EK::Basic);
            }
        }
        for y in 1..10 {
            for x in 0..10 {
                g.add_bidirectional_edge(n(x, y), n(x, y + 1), EK::Basic);
            }
        }
        // Single pre-existing one-way edge from the region into the path row.
        g.add_edge(n(0, 1), n(0, 0), EK::Basic);

        let start = n(0, 0);
        let finish = n(9, 0);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);

        let mut overrides = StdHashMap::new();
        overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "10".to_string());
        let params = build_params(
            <MissingRegionsStrategy as RepairStrategy<SquareTessellation>>::params(&MissingRegionsStrategy),
            Some(&overrides),
        );

        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = SmallRng::seed_from_u64(990043);
        let result = MissingRegionsStrategy.apply(&issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &params, &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
