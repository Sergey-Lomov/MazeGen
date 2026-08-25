use rand::{Rng, RngCore};
use rand::seq::IteratorRandom;
use std::collections::{HashMap, HashSet};
use crate::Maze;
use crate::ids::NodeId;
use crate::graph::scc::{ComponentId, ConnectedComponents};
use crate::space::Tessellation;
use crate::quality_control::RegionNeedsExpansionIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams, StrategyParamValue, PriorityLevel};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::repair::strategies::region_merge_core::{self, PARAM_TARGET_MODE, MODE_OPTIONS, MODE_RANDOM};
use crate::quality_control::checks::elevator_core::{elevator_groups, Elevator};

#[cfg(test)]
mod tests;

pub const PARAM_USE_EXISTING_ELEVATORS: &str = "use_existing_elevators";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_TARGET_MODE,
        label: "Target selection mode",
        kind: StrategyParamKind::Enum { options: MODE_OPTIONS, default: MODE_RANDOM },
    },
    StrategyParam {
        id: PARAM_USE_EXISTING_ELEVATORS,
        label: "Use existing elevators",
        kind: StrategyParamKind::Priority { default: PriorityLevel::Indifferent },
    },
];

/// Handles `REGION_NEEDS_EXPANSION` — see GitHub issue #431. Merges each flagged undersized SCC
/// region into a neighboring region reachable **anywhere else on the field** (any other floor, not
/// just an adjacent one, unlike `VerticalPassageRegionMergeStrategy`) by placing an elevator that
/// always spans exactly 2 floors — the region's own floor and one chosen target floor.
///
/// **Candidate discovery**: for every node in the flagged region, every *other* floor is checked
/// for a same-point node (`field.node_at`); each such node's SCC component (if not the region's own
/// component) becomes a candidate target, and every point shared between the region and that
/// candidate component (across every floor the candidate touches, not just one) is collected —
/// unlike `VerticalPassageRegionMergeStrategy`, which only ever checks the two floors immediately
/// adjacent to a given node.
///
/// **Target selection**: `target_mode` (`region_merge_core::pick_by_mode`, same four-value
/// semantics as every other region-merge strategy) picks one candidate component from the full
/// pool. There is no `prefer_partially_connected`/`direction_balance` here — an elevator connection
/// is always fully bidirectional in one step (never partially completed the way a one-way vertical
/// passage can be), and "direction" has no meaning when any other floor is a candidate, not just
/// up/down — so neither concept from `VerticalPassageRegionMergeStrategy`'s param set applies.
///
/// **Branch selection** (`use_existing_elevators`, a `PriorityLevel`): once a target component is
/// chosen, existing elevators are searched for one with at least one stop belonging to the region
/// or the target component (a stop landing in *either* region, not necessarily at a shared point).
/// An elevator is one vertical shaft at a single fixed field point, so a candidate is only actually
/// reusable if that point is itself among the points shared between the region and the target —
/// the new stop then always lands at that exact point, never at some other shared point.
/// `Required`/`Preferred` favor reusing such an elevator (adding it a stop in whichever region it
/// doesn't already reach); `Discouraged`/`Forbidden` favor building a brand-new 2-stop elevator on a
/// shared point instead; `Indifferent` (default) picks whichever branch a single coin flip lands on,
/// falling back to the other if the first has no candidate. `Required`/`Forbidden` never fall back —
/// the region is skipped for this call if their sole allowed branch has no candidate.
pub struct ElevatorRegionMergeStrategy;

impl<T: Tessellation> RepairStrategy<T, RegionNeedsExpansionIssue> for ElevatorRegionMergeStrategy {
    fn strategy_id(&self) -> &'static str { "elevator_region_merge" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &RegionNeedsExpansionIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let invalid = &issue.invalid;
        if invalid.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let mode = match params.get(PARAM_TARGET_MODE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => MODE_RANDOM,
        };
        let use_existing = params.get(PARAM_USE_EXISTING_ELEVATORS).and_then(|v| v.as_priority()).unwrap_or(PriorityLevel::Indifferent);

        // One fixed snapshot for the whole apply() call — same immutable-snapshot contract every
        // other region-merge strategy follows (`Specs/repair.md`).
        let scc = maze.analysis.scc(&maze.graph);
        let mut commands = Vec::new();
        let mut planned: Vec<(NodeId, NodeId)> = Vec::new();
        // Union-find over `scc`'s frozen component ids, merged by every `planned` elevator pair's
        // endpoints as they're queued this call. `scc` itself never reflects `planned` (it's a
        // fixed snapshot from before the call started), so two components a moments-ago elevator
        // already bridged still look like distinct, unconnected candidates to any lookup that
        // reads `scc` directly. Mirrors the "existing + planned" pattern in
        // `add_elevator_stop::groups_with_planned`, applied to component identity instead of
        // elevator-stop adjacency. Resolving every candidate/target lookup through this overlay
        // (instead of a raw already-chosen-id blacklist) is what actually implements "remove from
        // the queue those who already got a connection": once two components are unioned, a region
        // in either one immediately maps its own side out (`target_idx == region's own root`) and
        // any other region that reaches into that merged blob resolves to the very same root.
        let mut planned_union = PlannedUnion::new(&scc);

        let any_fixed = region_merge_core::run_merge_loop(invalid, |region_idx, needy| {
            let region = scc.components.get(region_idx)?;
            let region_root = planned_union.find(region_idx);
            let candidates = discover_target_candidates(region, region_root, &scc, &mut planned_union, maze);
            if candidates.is_empty() {
                return None;
            }

            let mut keys: Vec<ComponentId> = candidates.keys().copied().collect();
            keys.sort_unstable();
            let chosen = region_merge_core::pick_by_mode(&keys, &scc, mode, needy, rng)?;
            let shared_points = &candidates[&chosen];

            let target_region = scc.components.get(chosen).map(Vec::as_slice).unwrap_or(&[]);
            let before = commands.len();
            let applied = try_merge_via_elevator(maze, region, target_region, shared_points, use_existing, preset_state, rng, &planned, &mut commands);
            for cmd in &commands[before..] {
                if let MutationCommand::AddBidirectionalElevator { a, b } = *cmd {
                    planned.push((a, b));
                    if let (Some(ca), Some(cb)) = (scc.component_of(a), scc.component_of(b)) {
                        planned_union.union(ca, cb);
                    }
                }
            }
            Some((chosen, applied))
        });

        if any_fixed {
            (RepairResult::Fixed { score: None }, commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(ElevatorRegionMergeStrategy, RegionNeedsExpansionIssue);

/// Every candidate target SCC component reachable from `region` via a shared field point on some
/// other floor, mapped to the full set of points shared between `region` and that component (across
/// every floor the candidate touches — not just the one floor a given region node happened to find
/// it through). Deterministic: every region node is checked against every other floor
/// (`maze.field.node_at`), never `rng`-gated.
///
/// `region_root` is `region`'s own id in `planned_union` (the frozen `scc` snapshot, overlaid with
/// every elevator pair queued so far this call) — a raw-`scc` target component is excluded not only
/// when it's literally `region`'s own component, but whenever `planned_union` has already merged it
/// with `region`'s side (i.e. some earlier region this call already connected the two, whether via a
/// brand-new elevator or by growing an existing one). Without this, a target that's only "still
/// separate" in the frozen `scc` snapshot — because the snapshot predates this call's own queued
/// commands — looks like fresh, unconnected territory to a second flagged region.
fn discover_target_candidates<T: Tessellation>(
    region: &[NodeId],
    region_root: ComponentId,
    scc: &ConnectedComponents,
    planned_union: &mut PlannedUnion,
    maze: &Maze<T>,
) -> HashMap<ComponentId, HashSet<T::Point>> {
    let levels: Vec<_> = maze.field.levels_ordered().collect();
    let mut by_component: HashMap<ComponentId, HashSet<T::Point>> = HashMap::new();

    for &node in region {
        let Some(point) = maze.field.point_of(node) else { continue };
        let Some(own_level) = maze.field.level_of(node) else { continue };
        for &level in &levels {
            if level == own_level {
                continue;
            }
            let Some(target_node) = maze.field.node_at(level, point) else { continue };
            let Some(target_idx) = scc.component_of(target_node) else { continue };
            if planned_union.find(target_idx) == region_root {
                continue;
            }
            by_component.entry(target_idx).or_default().insert(point);
        }
    }

    by_component
}

/// Union-find over `ConnectedComponents`' own `ComponentId` space, used to overlay this `apply()`
/// call's own `planned` elevator pairs onto an otherwise-frozen `scc` snapshot — see
/// `discover_target_candidates`'s doc comment for why this is necessary.
struct PlannedUnion {
    parent: Vec<ComponentId>,
}

impl PlannedUnion {
    fn new(scc: &ConnectedComponents) -> Self {
        Self { parent: (0..scc.components.len()).collect() }
    }

    fn find(&mut self, id: ComponentId) -> ComponentId {
        if self.parent[id] != id {
            self.parent[id] = self.find(self.parent[id]);
        }
        self.parent[id]
    }

    fn union(&mut self, a: ComponentId, b: ComponentId) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.parent[ra] = rb;
        }
    }
}

/// Applies the chosen branch (`use_existing_elevators`) for a region merging into `target_points`
/// (the field points shared between the region and the chosen target component). Returns whether a
/// merge command was actually queued; on success, appends to `commands` and `planned` in place.
#[allow(clippy::too_many_arguments)]
fn try_merge_via_elevator<T: Tessellation>(
    maze: &Maze<T>,
    region: &[NodeId],
    target_region: &[NodeId],
    target_points: &HashSet<T::Point>,
    use_existing: PriorityLevel,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
    planned: &[(NodeId, NodeId)],
    commands: &mut Vec<MutationCommand>,
) -> bool {
    let region_set: HashSet<NodeId> = region.iter().copied().collect();
    let target_set: HashSet<NodeId> = target_region.iter().copied().collect();

    let existing_first = match use_existing {
        PriorityLevel::Required => true,
        PriorityLevel::Forbidden => false,
        PriorityLevel::Preferred => true,
        PriorityLevel::Discouraged => false,
        PriorityLevel::Indifferent => rng.random_bool(0.5),
    };
    let allow_existing = !matches!(use_existing, PriorityLevel::Forbidden);
    let allow_new = !matches!(use_existing, PriorityLevel::Required);

    if existing_first {
        (allow_existing && try_reuse_existing_elevator(maze, &region_set, &target_set, target_points, preset_state, rng, planned, commands))
            || (allow_new && try_build_new_elevator(maze, &region_set, &target_set, target_points, preset_state, rng, commands))
    } else {
        (allow_new && try_build_new_elevator(maze, &region_set, &target_set, target_points, preset_state, rng, commands))
            || (allow_existing && try_reuse_existing_elevator(maze, &region_set, &target_set, target_points, preset_state, rng, planned, commands))
    }
}

/// Finds every current elevator (including ones already queued as `planned` commands this call)
/// with at least one stop belonging to `region_set` or `target_set` — a stop anywhere in either
/// region, not just at a field point the two regions happen to share — and, if it doesn't already
/// have a stop in *both*, adds it one on whichever side is missing. Finding elevators by region
/// membership (not by shared-point overlap) matters because a region can already have a stop from
/// an earlier merge this call at a point that has nothing to do with the *current* target -- that
/// stop still belongs to the region, so growing it (rather than starting a brand-new elevator) is
/// exactly what `use_existing_elevators` is supposed to prefer.
///
/// An elevator is one vertical shaft at a single fixed field point — every stop must land on that
/// same point. A candidate elevator is skipped entirely (not reused) unless its own point is
/// itself among `target_points`; the new stop is then placed at that exact point, never at some
/// other point `target_points` merely happens to also offer.
fn try_reuse_existing_elevator<T: Tessellation>(
    maze: &Maze<T>,
    region_set: &HashSet<NodeId>,
    target_set: &HashSet<NodeId>,
    target_points: &HashSet<T::Point>,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
    planned: &[(NodeId, NodeId)],
    commands: &mut Vec<MutationCommand>,
) -> bool {
    let elevators = elevator_groups_with_planned(maze, planned);
    let mut candidates: Vec<&Elevator> = elevators.iter()
        .filter(|e| e.stops.iter().any(|&s| region_set.contains(&s) || target_set.contains(&s)))
        .collect();
    // `elevator_groups_with_planned` walks a `HashMap`'s keys, so its output order isn't stable
    // across runs -- sorted here (by each elevator's own already-sorted `stops`) before the
    // `rng`-driven shuffle so `apply()` stays deterministic for a fixed seed regardless of hasher
    // state (GitHub issue #431 follow-up: this strategy gave different results with/without
    // narration turned on, because narration's extra `build_scc` call perturbed the allocator/
    // hasher enough to change unrelated `HashMap` iteration order elsewhere in the same call).
    candidates.sort_unstable_by_key(|e| e.stops.clone());
    use rand::seq::SliceRandom;
    candidates.shuffle(rng);

    for elevator in candidates {
        let has_region_stop = elevator.stops.iter().any(|&s| region_set.contains(&s));
        let has_target_stop = elevator.stops.iter().any(|&s| target_set.contains(&s));
        if has_region_stop && has_target_stop {
            continue; // already spans both sides
        }

        // An elevator is a single vertical shaft at one fixed field point -- every stop must sit
        // at that same point (`elevator_point`), never merely somewhere in `target_points`.
        let Some(elevator_point) = elevator.stops.first().and_then(|&s| maze.field.point_of(s)) else { continue };
        if !target_points.contains(&elevator_point) {
            continue;
        }

        // Missing side: if the elevator already has a region stop, it needs a target-side stop
        // (and vice versa) -- placed on the elevator's own point, the only point the new stop can
        // legally join the shaft at.
        let need_region_side = !has_region_stop;
        let mut candidate_nodes: Vec<NodeId> = maze.field.levels_ordered()
            .filter_map(|level| maze.field.node_at(level, elevator_point))
            .filter(|n| !elevator.stops.contains(n))
            .filter(|n| if need_region_side { region_set.contains(n) } else { target_set.contains(n) })
            .collect();
        candidate_nodes.sort_unstable();

        if let Some(&new_stop) = candidate_nodes.iter().choose(rng) {
            if let Some(cmds) = add_stop_command_checked(maze, elevator, new_stop, preset_state, planned) {
                commands.extend(cmds);
                return true;
            }
        }
    }

    false
}

/// Commands to add `new_stop` to `elevator`'s fan, rejecting the pair if blocked by preset state or
/// already connected — mirrors `elevator_utils::add_stop_command`, generalized to a caller-picked
/// `new_stop` (rather than one derived from a single `target_level`) and aware of same-call planned
/// pairs (mirrors `add_elevator_stop::add_stop_command_with_planned`).
fn add_stop_command_checked<T: Tessellation>(
    maze: &Maze<T>,
    elevator: &Elevator,
    new_stop: NodeId,
    preset_state: &PresetState,
    planned: &[(NodeId, NodeId)],
) -> Option<Vec<MutationCommand>> {
    for &stop in &elevator.stops {
        if maze.graph.edge_between(stop, new_stop).is_some() || maze.graph.edge_between(new_stop, stop).is_some() {
            return None;
        }
        if planned.iter().any(|&(a, b)| (a == stop && b == new_stop) || (a == new_stop && b == stop)) {
            return None;
        }
        if !crate::generation::bidirectional_edge_feasible(preset_state, stop, new_stop) {
            return None;
        }
    }
    Some(elevator.stops.iter().map(|&stop| MutationCommand::AddBidirectionalElevator { a: stop, b: new_stop }).collect())
}

/// Builds a brand-new 2-stop elevator on a random shared point: one stop on the region's own floor,
/// one on the target component's floor at that same point — ignoring any other elevator already on
/// that column, per the strategy's own "always spans exactly 2 floors" contract. The far stop must
/// belong to `target_set` (the actually-`chosen` target component), not merely be some other
/// unconnected node that happens to sit at a shared point — a point can be shared with more than one
/// candidate component, and only the chosen one is a legal target for this call.
fn try_build_new_elevator<T: Tessellation>(
    maze: &Maze<T>,
    region_set: &HashSet<NodeId>,
    target_set: &HashSet<NodeId>,
    target_points: &HashSet<T::Point>,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
    commands: &mut Vec<MutationCommand>,
) -> bool {
    // Resolved to `(region_node, point)` pairs and sorted by `region_node` (an `Ord` `NodeId`,
    // unlike `T::Point` which has no such bound) before shuffling -- `target_points` is a
    // `HashSet`, whose iteration order isn't stable across runs/hasher states, so sorting first
    // keeps `apply()` deterministic for a fixed seed regardless of that (see the matching fix in
    // `try_reuse_existing_elevator` for the full GitHub issue #431 follow-up rationale).
    let mut region_points: Vec<(NodeId, T::Point)> = target_points.iter()
        .filter_map(|&point| region_set.iter().find(|&&n| maze.field.point_of(n) == Some(point)).map(|&n| (n, point)))
        .collect();
    region_points.sort_unstable_by_key(|&(n, _)| n);
    use rand::seq::SliceRandom;
    region_points.shuffle(rng);

    for (region_node, point) in region_points {
        let Some(region_level) = maze.field.level_of(region_node) else { continue };

        for level in maze.field.levels_ordered() {
            if level == region_level {
                continue;
            }
            let Some(target_node) = maze.field.node_at(level, point) else { continue };
            if !target_set.contains(&target_node) {
                continue;
            }
            if maze.graph.edge_between(region_node, target_node).is_some() || maze.graph.edge_between(target_node, region_node).is_some() {
                continue;
            }
            if !crate::generation::bidirectional_edge_feasible(preset_state, region_node, target_node) {
                continue;
            }
            commands.push(MutationCommand::AddBidirectionalElevator { a: region_node, b: target_node });
            return true;
        }
    }

    false
}

/// `elevator_groups(maze)`, overlaid with every pair already queued this `apply()` call
/// (`planned`) — mirrors `add_elevator_stop::groups_with_planned` so an elevator built moments ago
/// in this same call is still visible to the reuse branch, not just what's already committed to
/// `maze`.
fn elevator_groups_with_planned<T: Tessellation>(maze: &Maze<T>, planned: &[(NodeId, NodeId)]) -> Vec<Elevator> {
    if planned.is_empty() {
        return elevator_groups(maze);
    }

    let mut adjacency: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    for elevator in elevator_groups(maze) {
        for &a in &elevator.stops {
            for &b in &elevator.stops {
                if a != b {
                    adjacency.entry(a).or_default().push(b);
                }
            }
        }
    }
    for &(a, b) in planned {
        adjacency.entry(a).or_default().push(b);
        adjacency.entry(b).or_default().push(a);
    }

    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut groups = Vec::new();
    for &start in adjacency.keys() {
        if visited.contains(&start) {
            continue;
        }
        let mut stack = vec![start];
        let mut component: HashSet<NodeId> = HashSet::new();
        while let Some(node) = stack.pop() {
            if !component.insert(node) {
                continue;
            }
            visited.insert(node);
            for &neighbor in adjacency.get(&node).into_iter().flatten() {
                if !component.contains(&neighbor) {
                    stack.push(neighbor);
                }
            }
        }
        let mut stops: Vec<NodeId> = component.into_iter().collect();
        stops.sort_unstable();
        groups.push(Elevator { stops, edges: Vec::new() });
    }
    groups
}
