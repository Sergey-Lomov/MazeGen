use super::standard_add_params::{self, attempts_limit, reserve_target};
use crate::Maze;
use crate::generation::{PresetState, bidirectional_edge_feasible};
use crate::ids::NodeId;
use crate::quality_control::checks::elevator_core::{Elevator, elevator_groups, stop_floors};
use crate::quality_control::{
    AreaMissingElevatorStopsIssue, MISSING_ELEVATORS, MissingElevatorsIssue,
};
use crate::repair::command::MutationCommand;
use crate::repair::nested_dispatch::nested_params;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{
    NestedDispatchKind, NestedSlot, NestedStrategyConfig, RepairStrategy,
};
use crate::space::{LevelId, Tessellation};
use rand::seq::SliceRandom;
use rand::{Rng, RngCore};
use std::collections::{HashMap, HashSet};

pub const PARAM_EXISTING_REUSE_BALANCE: &str = "existing_reuse_balance";
pub const PARAM_ALLOW_SPAN_EXTENSION: &str = "allow_span_extension";

const EXISTING_REUSE_BALANCE_PARAM: StrategyParam = StrategyParam {
    id: PARAM_EXISTING_REUSE_BALANCE,
    label: "Existing-reuse balance",
    kind: StrategyParamKind::Float {
        default: 0.5,
        min: 0.0,
        max: 1.0,
    },
};

const ALLOW_SPAN_EXTENSION_PARAM: StrategyParam = StrategyParam {
    id: PARAM_ALLOW_SPAN_EXTENSION,
    label: "Allow span extension",
    kind: StrategyParamKind::Bool { default: true },
};

// Elevator-pool source, not a node pool -> `no_src_mode`: dead-end priority has no meaning here.
static PARAMS: [StrategyParam; 4] = crate::add_strategy_params!(no_src_mode:
    EXISTING_REUSE_BALANCE_PARAM,
    ALLOW_SPAN_EXTENSION_PARAM,
);

/// Slot id for the nested strategy this strategy delegates the "add a brand-new elevator" branch
/// to — see `Specs/repair.md`'s nested-strategy pattern. Public: part of this strategy's
/// configuration API (`StrategyConfig.slot_id` in `maze-runner`), not an internal detail.
///
/// Named "add-elevator strategy", not "removal strategy" (unlike some other nested-strategy
/// params in this codebase) — this slot's nested strategy *adds* a new elevator, it removes
/// nothing, so a "removal"-flavored name here would mislead.
pub const SLOT_ADD_ELEVATOR_STRATEGY: &str = "add_elevator_strategy";

static NESTED_SLOTS: &[NestedSlot] = &[NestedSlot {
    slot_id: SLOT_ADD_ELEVATOR_STRATEGY,
    kind: MISSING_ELEVATORS,
    min: 1,
    max: Some(1),
    dispatch_kind: NestedDispatchKind::Unordered,
}];

/// Handles `AREA_MISSING_ELEVATOR_STOPS` (GitHub issue #408, epic #344) by either building a
/// brand-new elevator (delegating to a nested `MISSING_ELEVATORS` strategy, typically
/// `AddElevatorStrategy`) or adding one more stop to an elevator that already exists. Distinct
/// from `AddElevatorStrategy` itself: that strategy only ever adds whole new elevators; this one
/// primarily grows existing ones, only falling through to "add new" when growing fails (or the
/// `existing_reuse_balance` roll picks that branch first).
///
/// Each unit of deficit rolls `existing_reuse_balance` to pick "add new" vs. "reuse existing",
/// falling back to the other branch on failure. Once `attempts_limit` consecutive attempts fail
/// the deficit is abandoned (not retried forever) — mirrors `AddElevatorStrategy`'s "infeasible
/// slots don't abort the whole repair" posture: the whole `apply()` call only reports `Failed` if
/// literally nothing was added.
///
/// **Add-new branch**: delegates to the nested `SLOT_ADD_ELEVATOR_STRATEGY` strategy with a
/// synthetic single-elevator `MissingElevatorsIssue`. How many stops the nested strategy actually
/// placed is read back from its returned `AddBidirectionalElevator` commands (the only way to
/// learn this, since the nested call's `RepairResult` carries no such detail) — the deficit is
/// decremented by the number of stops added.
///
/// **Reuse-existing branch**: candidates are every current elevator (including ones planned
/// earlier in the same call), picked uniformly at random; a stop is added on a random floor the
/// picked elevator doesn't already stop at (restricted to floors strictly inside its span unless
/// `allow_span_extension`).
pub struct AddElevatorStopStrategy;

impl<T: Tessellation> RepairStrategy<T, AreaMissingElevatorStopsIssue> for AddElevatorStopStrategy {
    fn strategy_id(&self) -> &'static str {
        "add_elevator_stop"
    }

    fn params(&self) -> &'static [StrategyParam] {
        &PARAMS
    }

    fn nested_suppressed_params(&self) -> &'static [&'static str] {
        standard_add_params::NESTED_SUPPRESSED_ADD_PARAMS
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
        if issue.missing == 0 {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let existing_reuse_balance = params
            .get(PARAM_EXISTING_REUSE_BALANCE)
            .and_then(|v| v.as_float())
            .unwrap_or(0.5);
        let allow_span_extension = matches!(
            params.get(PARAM_ALLOW_SPAN_EXTENSION),
            Some(StrategyParamValue::Bool(true)) | None
        );
        let max_failed_attempts = attempts_limit(params);

        // Standard add params owned for the nested add-elevator strategy (GitHub issue #486): it
        // suppresses `reserve_percent`/`attempts_limit`, so this strategy resolves them once and
        // injects them into every nested call via `nested_params`.
        let inherited_overrides = standard_add_params::inherited_overrides(params);

        let add_target = nested
            .iter()
            .find(|n| n.slot.slot_id == SLOT_ADD_ELEVATOR_STRATEGY);

        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        // `reserve_percent` scales the reported deficit up front so the reuse/add loop keeps going
        // past the bare deficit when asked to over-provision (GitHub issue #486).
        let mut remaining = reserve_target(params, issue.missing);
        // `attempts_limit` bounds the failed attempts in a row (GitHub issue #486).
        let mut failed_attempts: usize = 0;
        // `remaining` is re-read fresh every iteration — the add-new branch can deliver a whole
        // elevator's worth of stops (several floors) from a single call, so one iteration can
        // satisfy several units of deficit at once; a stale pre-captured target would keep
        // looping and over-build.
        while remaining > 0 && failed_attempts < max_failed_attempts {
            let reuse_first = rng.random_range(0.0..1.0) < existing_reuse_balance;
            // Elevators built earlier in this same `apply()` call only exist as queued
            // `commands` -- `maze` itself is an immutable pre-mutation snapshot (the
            // MutationCommand contract) and never reflects them. Without this, the reuse
            // branch is blind to elevators it planned moments ago and keeps falling back to
            // add-new instead of growing them, over-building (see GitHub issue #408 follow-up).
            let planned = planned_elevator_pairs(&commands);

            let (mut ok, mut cmds) = if reuse_first {
                try_reuse_existing(maze, &planned, allow_span_extension, preset_state, rng)
            } else {
                try_add_new(maze, add_target, &inherited_overrides, preset_state, rng)
            };
            if !ok {
                (ok, cmds) = if reuse_first {
                    try_add_new(maze, add_target, &inherited_overrides, preset_state, rng)
                } else {
                    try_reuse_existing(maze, &planned, allow_span_extension, preset_state, rng)
                };
            }

            if !ok {
                // Retry (a fresh reuse-first coin flip, fresh candidates) rather than bailing
                // outright — `attempts_limit` is the budget that governs when to give up, not
                // "the very first failure".
                failed_attempts += 1;
                continue;
            }

            let added = new_stop_count(maze, &commands, &cmds);
            remaining = remaining.saturating_sub(added);
            total_added += added;
            commands.append(&mut cmds);
        }
        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(AddElevatorStopStrategy, AreaMissingElevatorStopsIssue);

/// Number of brand-new stops in `new_cmds` — the only way to learn how many stops a nested
/// `AddElevatorStrategy` call actually placed, since its `RepairResult` carries no such detail
/// (see this strategy's own doc comment).
///
/// A single new stop is fanned out to every pre-existing stop of its elevator (one
/// `AddBidirectionalElevator` command per pair, see `add_stop_command_with_planned`), and a
/// brand-new elevator's stops are fanned out to each other (see `AddElevatorStrategy`) — either
/// way, counting both endpoints of every command would count a pre-existing stop again on every
/// fan-out edge, inflating the count far beyond the number of stops actually added. A node is a
/// genuinely new stop iff it is not already a stop in `maze` (the immutable pre-mutation
/// snapshot) NOR in `prior_cmds` (commands queued by earlier iterations of this same `apply()`
/// call, per the planned-elevator overlay `try_reuse_existing` also relies on — without folding
/// those in too, a stop added last iteration looks "new" again this iteration since it never
/// touches the real `maze`).
fn new_stop_count<T: Tessellation>(
    maze: &Maze<T>,
    prior_cmds: &[MutationCommand],
    new_cmds: &[MutationCommand],
) -> u32 {
    let mut existing_stops: HashSet<NodeId> = elevator_groups(maze)
        .into_iter()
        .flat_map(|e| e.stops)
        .collect();
    for cmd in prior_cmds {
        if let MutationCommand::AddBidirectionalElevator { a, b } = cmd {
            existing_stops.insert(*a);
            existing_stops.insert(*b);
        }
    }

    let new_stops: HashSet<NodeId> = new_cmds
        .iter()
        .filter_map(|cmd| match cmd {
            MutationCommand::AddBidirectionalElevator { a, b } => Some([*a, *b]),
            _ => None,
        })
        .flatten()
        .filter(|n| !existing_stops.contains(n))
        .collect();
    new_stops.len() as u32
}

/// Delegates to the nested `SLOT_ADD_ELEVATOR_STRATEGY` strategy with a synthetic single-elevator
/// `MissingElevatorsIssue { missing: 1 }` — the synthetic issue is never published to
/// the shared issue pool, mirroring `ReduceSccCountStrategy`'s own synthesize-and-delegate
/// pattern. Fails outright if no nested strategy is configured for the slot.
fn try_add_new<T: Tessellation>(
    maze: &Maze<T>,
    add_target: Option<&NestedStrategyConfig<T>>,
    inherited_overrides: &std::collections::HashMap<String, String>,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> (bool, Vec<MutationCommand>) {
    let Some(add_target) = add_target else {
        return (false, vec![]);
    };
    let synthetic = MissingElevatorsIssue::new_from_check("add_elevator_stop", 1);
    let nested_params = nested_params(add_target, inherited_overrides);
    let (result, cmds) = add_target.strategy.apply(
        &synthetic as &dyn crate::quality_control::Issue,
        maze,
        rng,
        &nested_params,
        preset_state,
        &add_target.nested,
    );
    (
        matches!(result, RepairResult::Fixed { .. }) && !cmds.is_empty(),
        cmds,
    )
}

/// Every `AddBidirectionalElevator` pair queued so far this `apply()` call — the planned-elevator
/// overlay `try_reuse_existing` merges with `elevator_groups(maze)` so the reuse branch can see
/// (and grow) an elevator it built moments ago in this same call, not just what's already in
/// `maze`. See `apply()`'s own comment on why `maze` alone isn't enough.
fn planned_elevator_pairs(commands: &[MutationCommand]) -> Vec<(NodeId, NodeId)> {
    commands
        .iter()
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
pub(crate) fn groups_with_planned<T: Tessellation>(
    maze: &Maze<T>,
    planned: &[(NodeId, NodeId)],
) -> Vec<Elevator> {
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
        groups.push(Elevator {
            stops,
            edges: Vec::new(),
        });
    }
    // `adjacency.keys()` has no stable order; sort so callers that shuffle the groups with a
    // seeded RNG stay deterministic for a fixed seed.
    groups.sort_unstable_by(|a, b| a.stops.cmp(&b.stops));
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
    let point = maze.field.cell_of(existing)?;
    let new_stop = maze.field.node_at(target_level, point)?;

    if elevator.stops.contains(&new_stop) {
        return None;
    }

    for &stop in &elevator.stops {
        if maze.graph.edge_between(stop, new_stop).is_some()
            || maze.graph.edge_between(new_stop, stop).is_some()
        {
            return None;
        }
        if planned
            .iter()
            .any(|&(a, b)| (a == stop && b == new_stop) || (a == new_stop && b == stop))
        {
            return None;
        }
        if !bidirectional_edge_feasible(preset_state, stop, new_stop) {
            return None;
        }
    }

    Some(
        elevator
            .stops
            .iter()
            .map(|&stop| MutationCommand::AddBidirectionalElevator {
                a: stop,
                b: new_stop,
            })
            .collect(),
    )
}

/// Picks one candidate elevator at random and adds it a stop — any elevator, and a floor strictly
/// inside that elevator's own span when `allow_span_extension` is false (a gap fill); when true,
/// any floor it doesn't already stop at, span or no. Fails (no candidates, or the picked
/// candidate's stop turns out infeasible) rather than trying every candidate in turn — mirrors
/// `ElevatorGroupSelectStrategy`'s single-random-pick posture; a failed attempt here just falls
/// back to the "add new" branch at the call site, same as the other direction's fallback.
///
/// `planned` — see `planned_elevator_pairs`/`groups_with_planned`: candidates include elevators
/// built earlier in this same `apply()` call, not just what's already in `maze`.
fn try_reuse_existing<T: Tessellation>(
    maze: &Maze<T>,
    planned: &[(NodeId, NodeId)],
    allow_span_extension: bool,
    preset_state: &PresetState,
    rng: &mut dyn RngCore,
) -> (bool, Vec<MutationCommand>) {
    let all_elevators = groups_with_planned(maze, planned);
    if all_elevators.is_empty() {
        return (false, vec![]);
    }

    let levels: Vec<LevelId> = maze.field.levels_ordered().collect();
    let mut candidates: Vec<usize> = (0..all_elevators.len()).collect();
    candidates.shuffle(rng);
    for idx in candidates {
        let elevator = &all_elevators[idx];
        let floors = stop_floors(elevator, maze);
        let stopped: HashSet<usize> = floors.iter().copied().collect();
        let (min, max) = match (floors.first(), floors.last()) {
            (Some(&min), Some(&max)) => (min, max),
            _ => continue,
        };
        let mut free_floors: Vec<LevelId> = levels
            .iter()
            .enumerate()
            .filter(|&(i, _)| {
                !stopped.contains(&i) && (allow_span_extension || (i > min && i < max))
            })
            .map(|(_, &l)| l)
            .collect();
        if free_floors.is_empty() {
            continue;
        }
        free_floors.shuffle(rng);
        for target in free_floors {
            if let Some(cmds) =
                add_stop_command_with_planned(maze, planned, elevator, target, preset_state)
            {
                return (true, cmds);
            }
        }
    }
    (false, vec![])
}
#[cfg(test)]
#[path = "add_elevator_stop_tests.rs"]
mod tests;
