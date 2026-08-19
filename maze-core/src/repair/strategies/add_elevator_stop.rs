use std::collections::{HashMap, HashSet};
use rand::{Rng, RngCore};
use rand::seq::SliceRandom;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::{LevelId, Tessellation};
use crate::quality_control::{AreaMissingElevatorStopsIssue, RepairArea, MISSING_ELEVATORS, MissingElevatorsIssue};
use crate::quality_control::checks::elevator_core::{elevator_groups, stop_floors, Elevator};
use crate::generation::{PresetState, bidirectional_edge_feasible};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams, build_params};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig, NestedDispatchKind};
use crate::repair::command::MutationCommand;
use super::remaining_deficits::RemainingDeficits;

pub const PARAM_EXISTING_REUSE_BALANCE: &str = "existing_reuse_balance";
pub const PARAM_ALLOW_SPAN_EXTENSION: &str = "allow_span_extension";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_EXISTING_REUSE_BALANCE,
        label: "Existing-reuse balance",
        kind: StrategyParamKind::Float { default: 0.5, min: 0.0, max: 1.0 },
    },
    StrategyParam {
        id: PARAM_ALLOW_SPAN_EXTENSION,
        label: "Allow span extension",
        kind: StrategyParamKind::Bool { default: true },
    },
];

/// Slot id for the nested strategy this strategy delegates the "add a brand-new elevator" branch
/// to — see `Specs/repair.md`'s nested-strategy pattern. Public: part of this strategy's
/// configuration API (`StrategyConfig.slot_id` in `maze-runner`), not an internal detail.
///
/// Named "add-elevator strategy", not "removal strategy" (unlike some other nested-strategy
/// params in this codebase) — this slot's nested strategy *adds* a new elevator, it removes
/// nothing, so a "removal"-flavored name here would mislead.
pub const SLOT_ADD_ELEVATOR_STRATEGY: &str = "add_elevator_strategy";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot { slot_id: SLOT_ADD_ELEVATOR_STRATEGY, kind: MISSING_ELEVATORS, min: 1, max: Some(1), dispatch_kind: NestedDispatchKind::Unordered },
];

/// Handles `AREA_MISSING_ELEVATOR_STOPS` (GitHub issue #408, epic #344) by either building a
/// brand-new elevator (delegating to a nested `MISSING_ELEVATORS` strategy, typically
/// `AddElevatorStrategy`) or adding one more stop to an elevator that already exists. Distinct
/// from `AddElevatorStrategy` itself: that strategy only ever adds whole new elevators; this one
/// primarily grows existing ones, only falling through to "add new" when growing fails (or the
/// `existing_reuse_balance` roll picks that branch first).
///
/// Per `(RepairArea, count)` pair (processed via `RemainingDeficits`, same floors-before-whole-
/// maze ordering every sibling deficit strategy uses): each unit of deficit rolls
/// `existing_reuse_balance` to pick "add new" vs. "reuse existing", falling back to the other
/// branch on failure. A pair that makes zero progress after both branches fail is abandoned (not
/// retried forever) — mirrors `AddElevatorStrategy`'s "infeasible slots don't abort the whole
/// repair" posture: the whole `apply()` call only reports `Failed` if literally nothing was added
/// across every pair.
///
/// **Add-new branch**: delegates to the nested `SLOT_ADD_ELEVATOR_STRATEGY` strategy with a
/// synthetic single-elevator `MissingElevatorsIssue`. Which floors the nested strategy actually
/// picked is read back from its returned `AddBidirectionalElevator` commands (the only way to
/// learn this, since the nested call's `RepairResult` carries no floor detail) — every floor
/// touched by at least one such command has its own deficit (and the whole-maze deficit)
/// decremented by one stop, per the issue's own accounting rule ("decrement... by the number of
/// stops added").
///
/// **Reuse-existing branch**: candidate elevators are every current elevator (`WholeMaze` scope)
/// or every elevator whose stop span could gain a stop landing on the target floor (`Level`
/// scope, gated by `allow_span_extension` — see `candidate_elevators_for_level`'s doc comment),
/// picked uniformly at random; `WholeMaze` scope then adds a stop on a random floor the picked
/// elevator doesn't already stop at, `Level` scope adds a stop on the pair's own floor.
pub struct AddElevatorStopStrategy;

impl<T: Tessellation> RepairStrategy<T, AreaMissingElevatorStopsIssue> for AddElevatorStopStrategy {
    fn strategy_id(&self) -> &'static str { "add_elevator_stop" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &AreaMissingElevatorStopsIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.missing.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let existing_reuse_balance = params.get(PARAM_EXISTING_REUSE_BALANCE).and_then(|v| v.as_float()).unwrap_or(0.5);
        let allow_span_extension = matches!(params.get(PARAM_ALLOW_SPAN_EXTENSION), Some(StrategyParamValue::Bool(true)) | None);

        let add_target = nested.iter().find(|n| n.slot.slot_id == SLOT_ADD_ELEVATOR_STRATEGY);

        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        let mut deficits = RemainingDeficits::new(&issue.missing);
        let areas: Vec<RepairArea> = deficits.areas().collect();
        for area in areas {
            // Re-read `deficits.live(area)` fresh every iteration (not a `target` captured once
            // before the loop) — the add-new branch can deliver a whole elevator's worth of stops
            // (several floors) from a single call, so one iteration can satisfy several units of
            // deficit at once; a stale pre-captured target would keep looping and over-build.
            while deficits.live(area) > 0 {
                let reuse_first = rng.random_range(0.0..1.0) < existing_reuse_balance;
                // Elevators built earlier in this same `apply()` call only exist as queued
                // `commands` -- `maze` itself is an immutable pre-mutation snapshot (the
                // MutationCommand contract) and never reflects them. Without this, the reuse
                // branch is blind to elevators it planned moments ago and keeps falling back to
                // add-new instead of growing them, over-building (see GitHub issue #408 follow-up).
                let planned = planned_elevator_pairs(&commands);

                let (mut ok, mut cmds) = if reuse_first {
                    try_reuse_existing(maze, &planned, area, allow_span_extension, preset_state, rng)
                } else {
                    try_add_new(maze, add_target, params, preset_state, rng, area)
                };
                if !ok {
                    (ok, cmds) = if reuse_first {
                        try_add_new(maze, add_target, params, preset_state, rng, area)
                    } else {
                        try_reuse_existing(maze, &planned, area, allow_span_extension, preset_state, rng)
                    };
                }

                if !ok {
                    break;
                }

                // One `consume` call per stop actually added (not one per branch call) — the
                // add-new branch's nested strategy can place several stops (several floors) in one
                // call, and each of those stops independently covers its own floor plus the
                // whole-maze total, per the issue's own accounting rule.
                let touched = touched_floors(maze, &commands, &cmds);
                for level in &touched {
                    deficits.consume(&[RepairArea::Level(*level), RepairArea::WholeMaze]);
                }
                total_added += touched.len() as u32;
                commands.append(&mut cmds);
            }
        }
        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(AddElevatorStopStrategy, AreaMissingElevatorStopsIssue);

/// Every distinct floor that gained a brand-new stop from `new_cmds` — the only way to learn
/// which floors a nested `AddElevatorStrategy` call actually placed stops on, since its
/// `RepairResult` carries no floor detail (see this strategy's own doc comment).
///
/// A single new stop is fanned out to every pre-existing stop of its elevator (one
/// `AddBidirectionalElevator` command per pair, see `add_stop_command_with_planned`), and a
/// brand-new elevator's stops are fanned out to each other (see `AddElevatorStrategy`) — either
/// way, counting both endpoints of every command would count a pre-existing stop's floor again on
/// every fan-out edge, inflating the touched-floor count far beyond the number of stops actually
/// added (and over-consuming `RemainingDeficits` to match). A node is a genuinely new stop iff it
/// is not already a stop in `maze` (the immutable pre-mutation snapshot) NOR in `prior_cmds`
/// (commands queued by earlier iterations of this same `apply()` call, per the planned-elevator
/// overlay `try_reuse_existing` also relies on — without folding those in too, a stop added last
/// iteration looks "new" again this iteration since it never touches the real `maze`).
fn touched_floors<T: Tessellation>(maze: &Maze<T>, prior_cmds: &[MutationCommand], new_cmds: &[MutationCommand]) -> Vec<LevelId> {
    let mut existing_stops: HashSet<NodeId> = elevator_groups(maze).into_iter()
        .flat_map(|e| e.stops)
        .collect();
    for cmd in prior_cmds {
        if let MutationCommand::AddBidirectionalElevator { a, b } = cmd {
            existing_stops.insert(*a);
            existing_stops.insert(*b);
        }
    }

    let mut floors: Vec<LevelId> = new_cmds.iter()
        .filter_map(|cmd| match cmd {
            MutationCommand::AddBidirectionalElevator { a, b } => Some([*a, *b]),
            _ => None,
        })
        .flatten()
        .filter(|n| !existing_stops.contains(n))
        .filter_map(|n| maze.field.level_of(n))
        .collect();
    floors.sort();
    floors.dedup();
    floors
}

/// Delegates to the nested `SLOT_ADD_ELEVATOR_STRATEGY` strategy with a synthetic single-elevator
/// `MissingElevatorsIssue { missing: [(area, 1)] }` — the synthetic issue is never published to
/// the shared issue pool, mirroring `ReduceSccCountStrategy`'s own synthesize-and-delegate
/// pattern. Fails outright if no nested strategy is configured for the slot.
fn try_add_new<T: Tessellation>(
    maze: &Maze<T>,
    add_target: Option<&NestedStrategyConfig<T>>,
    _params: &StrategyParams,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
    area: RepairArea,
) -> (bool, Vec<MutationCommand>) {
    let Some(add_target) = add_target else {
        return (false, vec![]);
    };
    let synthetic = MissingElevatorsIssue::new_from_check("add_elevator_stop", vec![(area, 1)]);
    let nested_params = build_params(add_target.strategy.params(), Some(&add_target.param_overrides));
    let (result, cmds) = add_target.strategy.apply(&synthetic as &dyn crate::quality_control::Issue, maze, rng, &nested_params, preset_state, &add_target.nested);
    (matches!(result, RepairResult::Fixed { .. }) && !cmds.is_empty(), cmds)
}

/// Every `AddBidirectionalElevator` pair queued so far this `apply()` call — the planned-elevator
/// overlay `try_reuse_existing` merges with `elevator_groups(maze)` so the reuse branch can see
/// (and grow) an elevator it built moments ago in this same call, not just what's already in
/// `maze`. See `apply()`'s own comment on why `maze` alone isn't enough.
fn planned_elevator_pairs(commands: &[MutationCommand]) -> Vec<(NodeId, NodeId)> {
    commands.iter()
        .filter_map(|cmd| match *cmd {
            MutationCommand::AddBidirectionalElevator { a, b } => Some((a, b)),
            _ => None,
        })
        .collect()
}

/// `elevator_groups(maze)`, plus every group reachable by additionally following `planned` pairs —
/// i.e. an elevator that only exists as queued commands so far this call still shows up as a full
/// candidate, merged with any real stops it's already connected to. `edges` is left empty for
/// groups that gained any planned member (real `EdgeId`s don't exist for a not-yet-applied pair,
/// and nothing in the reuse branch reads `.edges`).
fn groups_with_planned<T: Tessellation>(maze: &Maze<T>, planned: &[(NodeId, NodeId)]) -> Vec<Elevator> {
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

/// Same as `elevator_utils::add_stop_command`, but the collision check also rejects a `new_stop`
/// that already has a *planned* (queued this call, not yet in `maze.graph`) edge to any of
/// `elevator`'s stops — `maze.graph.edge_between` alone can't see those.
fn add_stop_command_with_planned<T: Tessellation>(
    maze: &Maze<T>,
    planned: &[(NodeId, NodeId)],
    elevator: &Elevator,
    target_level: LevelId,
    preset_state: &PresetState,
) -> Option<Vec<MutationCommand>> {
    let &existing = elevator.stops.first()?;
    let point = maze.field.point_of(existing)?;
    let new_stop = maze.field.node_at(target_level, point)?;

    if elevator.stops.contains(&new_stop) {
        return None;
    }

    for &stop in &elevator.stops {
        if maze.graph.edge_between(stop, new_stop).is_some() || maze.graph.edge_between(new_stop, stop).is_some() {
            return None;
        }
        if planned.iter().any(|&(a, b)| (a == stop && b == new_stop) || (a == new_stop && b == stop)) {
            return None;
        }
        if !bidirectional_edge_feasible(preset_state, stop, new_stop) {
            return None;
        }
    }

    Some(elevator.stops.iter().map(|&stop| MutationCommand::AddBidirectionalElevator { a: stop, b: new_stop }).collect())
}

/// Picks one candidate elevator at random and adds it a stop — `RepairArea::WholeMaze` picks any
/// elevator and, when `allow_span_extension` is false, only a floor strictly inside that
/// elevator's own span (a gap fill, same restriction `candidate_elevators_for_level` applies for
/// `RepairArea::Level`); when true, any floor it doesn't already stop at, span or no. `RepairArea
/// ::Level` restricts candidates via `candidate_elevators_for_level` and always targets that exact
/// floor. Fails (no candidates, or the picked candidate's stop turns out infeasible) rather than
/// trying every candidate in turn — mirrors `ElevatorGroupSelectStrategy`'s single-random-pick
/// posture; a failed attempt here just falls back to the "add new" branch at the call site, same
/// as the other direction's fallback.
///
/// `planned` — see `planned_elevator_pairs`/`groups_with_planned`: candidates include elevators
/// built earlier in this same `apply()` call, not just what's already in `maze`.
fn try_reuse_existing<T: Tessellation>(
    maze: &Maze<T>,
    planned: &[(NodeId, NodeId)],
    area: RepairArea,
    allow_span_extension: bool,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> (bool, Vec<MutationCommand>) {
    let all_elevators = groups_with_planned(maze, planned);
    if all_elevators.is_empty() {
        return (false, vec![]);
    }

    match area {
        RepairArea::WholeMaze => {
            let levels: Vec<LevelId> = maze.field.levels_ordered().collect();
            let mut candidates: Vec<usize> = (0..all_elevators.len()).collect();
            candidates.shuffle(rng);
            for idx in candidates {
                let elevator = &all_elevators[idx];
                let floors = stop_floors(elevator, maze);
                let stopped: std::collections::HashSet<usize> = floors.iter().copied().collect();
                let (min, max) = match (floors.first(), floors.last()) {
                    (Some(&min), Some(&max)) => (min, max),
                    _ => continue,
                };
                let mut free_floors: Vec<LevelId> = levels.iter().enumerate()
                    .filter(|&(i, _)| !stopped.contains(&i) && (allow_span_extension || (i > min && i < max)))
                    .map(|(_, &l)| l)
                    .collect();
                if free_floors.is_empty() {
                    continue;
                }
                free_floors.shuffle(rng);
                for target in free_floors {
                    if let Some(cmds) = add_stop_command_with_planned(maze, planned, elevator, target, preset_state) {
                        return (true, cmds);
                    }
                }
            }
            (false, vec![])
        }
        RepairArea::Level(target_level) => {
            let mut candidates = candidate_elevators_for_level(maze, &all_elevators, target_level, allow_span_extension);
            candidates.shuffle(rng);
            for elevator in candidates.drain(..) {
                if let Some(cmds) = add_stop_command_with_planned(maze, planned, elevator, target_level, preset_state) {
                    return (true, cmds);
                }
            }
            (false, vec![])
        }
    }
}

/// Elevators eligible to gain a stop on `target_level`, under `Level`-scoped reuse.
///
/// `allow_span_extension = true`: any elevator whose existing stop span (min..max floor index,
/// via `stop_floors`) already covers `target_level`'s index (a "gap" fill), OR whose span could be
/// extended by exactly one stop to cover it (`target_index == min_index - 1` or `target_index ==
/// max_index + 1`) — i.e. every elevator that could gain a stop landing on `target_level` at all.
///
/// `allow_span_extension = false`: restricted to gap-fills only — `target_index` strictly between
/// the elevator's own min and max (`min < target < max`, not `<=`: if `target_index` already
/// equals `min_index` or `max_index`, that floor already has a stop, nothing to add there).
fn candidate_elevators_for_level<'a, T: Tessellation>(
    maze: &Maze<T>,
    elevators: &'a [Elevator],
    target_level: LevelId,
    allow_span_extension: bool,
) -> Vec<&'a Elevator> {
    let Some(target_index) = maze.field.levels_ordered().position(|l| l == target_level) else {
        return vec![];
    };

    elevators.iter().filter(|elevator| {
        let floors = stop_floors(elevator, maze);
        let (Some(&min), Some(&max)) = (floors.first(), floors.last()) else { return false };
        if floors.contains(&target_index) {
            return false;
        }
        let is_gap = target_index > min && target_index < max;
        if allow_span_extension {
            is_gap || target_index + 1 == min || target_index == max + 1
        } else {
            is_gap
        }
    }).collect()
}

#[cfg(test)]
#[path = "add_elevator_stop_tests.rs"]
mod tests;
