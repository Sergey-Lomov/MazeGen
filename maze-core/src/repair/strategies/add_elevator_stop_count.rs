use super::elevator_utils::find_elevator_by_stop;
use crate::Maze;
use crate::generation::PresetState;
use crate::generation::edge_ops::bidirectional_edge_feasible;
use crate::ids::NodeId;
use crate::quality_control::MissingElevatorStopCountIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{PriorityLevel, StrategyParam, StrategyParamKind, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;
use rand::seq::SliceRandom;

pub const PARAM_EXPAND_ELEVATOR: &str = "expand_elevator";

static PARAMS: &[StrategyParam] = &[StrategyParam {
    id: PARAM_EXPAND_ELEVATOR,
    label: "Expand elevator",
    kind: StrategyParamKind::Priority {
        default: PriorityLevel::Indifferent,
    },
}];

/// Handles `MISSING_ELEVATOR_STOP_COUNT` -- see GitHub issue #402, part of epic #344. For each
/// `missing` entry (one existing elevator, a stop count still needed, and every free floor at the
/// elevator's own point), tries to add that many stops by picking floors in random order -- each
/// newly-added stop is wired to every one of the elevator's *current* stops (existing ones and any
/// already added earlier in the same `apply` call), preserving the fully-connected two-way fan
/// convention every other elevator-consuming piece of code assumes (`elevator_core::Elevator`'s
/// own doc comment, mirrors `AddElevatorStrategy`'s own fan-wiring).
///
/// The elevator named by an entry is re-resolved against the live `maze` via
/// `elevator_utils::find_elevator_by_stop` (one of its own stop nodes) rather than trusted from the
/// issue's stale `ElevatorNodes` snapshot -- an earlier repair pass in the same fixpoint iteration
/// may already have changed it. An entry whose elevator no longer exists is skipped entirely.
///
/// A candidate floor is skipped if its node doesn't exist, already has an edge to any of the
/// elevator's current stops, or isn't `preset_state`-feasible for at least one of them -- mirrors
/// `AddElevatorStrategy::stops_feasible`. **Partial success counts as success** -- an entry that
/// adds fewer stops than requested (but at least one) still counts toward `Fixed`; only a complete
/// failure to add any stop, across every entry, is `Failed`.
///
/// `expand_elevator` (a `PriorityLevel`, default `Indifferent`) controls whether new stops are
/// picked from floors strictly between the elevator's current bottom and top stop ("inside",
/// `PriorityLevel`'s "other" group) or beyond either end ("outside", the "preferred" group) — see
/// `PriorityLevel::order_zones`. `Forbidden` only adds inside, skipping the whole entry if that
/// alone can't satisfy `count`; `Discouraged`/`Preferred` try one zone first and fall back to the
/// other only for floors still needed after the first zone is exhausted; `Indifferent` (default)
/// ignores the distinction and shuffles every candidate together; `Required` only adds outside,
/// failing the entry if that alone can't satisfy `count`.
pub struct AddElevatorStopCountStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingElevatorStopCountIssue>
    for AddElevatorStopCountStrategy
{
    fn strategy_id(&self) -> &'static str {
        "add_elevator_stop_count"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &MissingElevatorStopCountIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let expand_elevator = params
            .get(PARAM_EXPAND_ELEVATOR)
            .and_then(|v| v.as_priority())
            .unwrap_or(PriorityLevel::Indifferent);

        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        for (elevator_key, count, available) in &issue.missing {
            if *count == 0 || available.is_empty() {
                continue;
            }
            let Some(&any_stop) = elevator_key.0.first() else {
                continue;
            };
            let Some(elevator) = find_elevator_by_stop(maze, any_stop) else {
                continue;
            };
            let Some(point) = elevator.stops.first().and_then(|&n| maze.field.cell_of(n)) else {
                continue;
            };

            let mut current_stops: Vec<NodeId> = elevator.stops.clone();

            let level_index: std::collections::HashMap<LevelId, usize> = maze
                .field
                .levels_ordered()
                .enumerate()
                .map(|(i, level)| (level, i))
                .collect();
            let existing_indices: Vec<usize> = current_stops
                .iter()
                .filter_map(|&n| maze.field.level_index_of(n))
                .collect();
            let (Some(&bottom), Some(&top)) =
                (existing_indices.iter().min(), existing_indices.iter().max())
            else {
                continue;
            };
            let is_inside = |level: &LevelId| {
                level_index
                    .get(level)
                    .is_some_and(|&i| i > bottom && i < top)
            };

            let (mut inside, mut outside): (Vec<LevelId>, Vec<LevelId>) =
                available.iter().copied().partition(is_inside);
            inside.shuffle(rng);
            outside.shuffle(rng);

            // `outside` is the "preferred" group (`PriorityLevel::Preferred`/`Required` favor it),
            // `inside` is "other" -- see `PriorityLevel`.
            let ordered_zones = expand_elevator.order_zones(outside, inside, rng);

            let mut entry_commands = Vec::new();
            let mut added_here: u32 = 0;
            'zones: for zone in ordered_zones {
                for level in zone {
                    if added_here >= *count {
                        break 'zones;
                    }
                    let Some(node) = maze.field.node_at(level, point) else {
                        continue;
                    };
                    if current_stops.contains(&node) {
                        continue;
                    }
                    if !stop_feasible(maze, node, &current_stops, preset_state) {
                        continue;
                    }
                    for &other in &current_stops {
                        entry_commands
                            .push(MutationCommand::AddBidirectionalElevator { a: node, b: other });
                    }
                    current_stops.push(node);
                    added_here += 1;
                }
            }

            let zone_locked = matches!(
                expand_elevator,
                PriorityLevel::Forbidden | PriorityLevel::Required
            );
            if zone_locked && added_here < *count {
                continue;
            }
            commands.extend(entry_commands);
            total_added += added_here;
        }

        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(AddElevatorStopCountStrategy, MissingElevatorStopCountIssue);

fn stop_feasible<T: Tessellation>(
    maze: &Maze<T>,
    candidate: NodeId,
    current_stops: &[NodeId],
    preset_state: &PresetState,
) -> bool {
    current_stops.iter().all(|&other| {
        maze.graph.edge_between(candidate, other).is_none()
            && maze.graph.edge_between(other, candidate).is_none()
            && bidirectional_edge_feasible(preset_state, candidate, other)
    })
}

#[cfg(test)]
#[path = "add_elevator_stop_count_tests.rs"]
mod tests;
