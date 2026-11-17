use super::elevator_utils::find_elevator_by_stop;
use crate::Maze;
use crate::generation::PresetState;
use crate::generation::edge_ops::bidirectional_edge_feasible;
use crate::ids::NodeId;
use crate::quality_control::MissingElevatorHeightIssue;
use crate::repair::command::MutationCommand;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{NestedStrategyConfig, RepairStrategy};
use crate::space::Tessellation;
use rand::RngCore;
use rand::seq::IndexedRandom;

pub const PARAM_BALANCED_GROWTH: &str = "balanced_growth";
pub const PARAM_ALLOW_INCOMPLETE: &str = "allow_incomplete";
pub const PARAM_MAX_COMPACTNESS: &str = "max_compactness";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_BALANCED_GROWTH,
        label: "Balanced growth",
        kind: StrategyParamKind::Bool { default: false },
    },
    StrategyParam {
        id: PARAM_ALLOW_INCOMPLETE,
        label: "Allow incomplete growth",
        kind: StrategyParamKind::Bool { default: true },
    },
    StrategyParam {
        id: PARAM_MAX_COMPACTNESS,
        label: "Max compactness",
        kind: StrategyParamKind::Bool { default: false },
    },
];

/// Handles `MISSING_ELEVATOR_HEIGHT` -- see GitHub issue #402, part of epic #344. A single added
/// stop can't always close a height deficit (e.g. stops at floors 3 and 5 of 7, `min_height` 6:
/// extending 6 floors up from 3 or down from 5 both overshoot the field). Instead this strategy
/// grows an inner window `[lo, hi]` (starting at `bottom+1, top-1`, strictly inside the elevator's
/// own existing bottom/top stops) one floor at a time until it spans `min_height - 2` floors --
/// adding the below/above edge stops afterward then contributes the remaining `+2`, reaching
/// `min_height`. Each step, a side is only eligible to grow if it has at least 2 "reserve" floors
/// further out: 1 to grow onto now, 1 held for the edge stop placed afterward -- a floor counts
/// toward that reserve if a new stop could actually go there *or* if it's already one of the
/// elevator's own existing stops (see `reserved_or_feasible`). Growth stops once the window is wide
/// enough or neither side is eligible (both ends have hit the field's own top/bottom floor *at this
/// elevator's point* -- never the maze's absolute top/bottom floor, since other points may extend
/// further). With `balanced_growth` on, each step that had both sides eligible biases the next step
/// to the opposite side; off (the default), every step picks a side at random when both are
/// eligible. Once the window is wide enough, one stop is picked from the pool below `lo` and one
/// from the pool above `hi` -- each pool includes existing-stop floors too (harmless: the pick step
/// skips adding a command when the picked floor already has a stop there).
///
/// `allow_incomplete` (default on) gates only on the grown window's *width*: with it off, an entry
/// whose window never reached `min_height - 2` is skipped entirely (contributes to `Failed` if every
/// entry stalls); with it on, the strategy still tries to add below/above stops for whatever window
/// it managed to grow to. Either way, once the width requirement is met (or `allow_incomplete` is
/// on), the entry commits however many of the two edge stops turn out reachable -- 0, 1, or 2 --
/// growth reaching the needed width never guarantees both edge floors are actually placeable (e.g.
/// one side may be preset-blocked, or entirely one-sided growth may leave the other side with no
/// room beyond its own existing stop). `max_compactness` (default off) changes which pool floor is
/// picked: off, a random floor anywhere in the pool; on, the floor immediately adjacent to the grown
/// window's own edge -- keeps the elevator's footprint as tight as the required height allows
/// instead of spreading across the whole range.
///
/// The elevator named by an entry is re-resolved against the live `maze` via
/// `elevator_utils::find_elevator_by_stop` rather than trusted from the issue's stale
/// `ElevatorNodes` snapshot -- an entry whose elevator no longer exists is skipped. **Partial
/// success counts as success** -- one entry failing doesn't fail the whole strategy.
pub struct AddElevatorHeightStopStrategy;

impl<T: Tessellation> RepairStrategy<T, MissingElevatorHeightIssue>
    for AddElevatorHeightStopStrategy
{
    fn strategy_id(&self) -> &'static str {
        "add_elevator_height_stop"
    }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &MissingElevatorHeightIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let balanced_growth = matches!(
            params.get(PARAM_BALANCED_GROWTH),
            Some(StrategyParamValue::Bool(true))
        );
        let allow_incomplete = !matches!(
            params.get(PARAM_ALLOW_INCOMPLETE),
            Some(StrategyParamValue::Bool(false))
        );
        let max_compactness = matches!(
            params.get(PARAM_MAX_COMPACTNESS),
            Some(StrategyParamValue::Bool(true))
        );

        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        // `issue.missing` can hold multiple entries for the same elevator -- e.g. several
        // `min_elevator_height` checks configured on the same Rule, each flagging it against its
        // own threshold (`MissingElevatorHeightIssue::merge` deliberately doesn't dedup, mirroring
        // `InvalidElevatorIssue`). Growing the same elevator once per entry would compound (e.g. 4
        // stops added instead of 2), so entries are folded down to one per elevator here, keeping
        // the largest `min_height` demanded of it.
        let mut by_elevator: Vec<(&crate::quality_control::issue_kinds::ElevatorNodes, u32)> =
            Vec::new();
        for (elevator_key, &min_height) in issue.missing.iter().map(|(k, h)| (k, h)) {
            match by_elevator.iter_mut().find(|(k, _)| k == &elevator_key) {
                Some((_, existing)) => *existing = (*existing).max(min_height),
                None => by_elevator.push((elevator_key, min_height)),
            }
        }

        for (elevator_key, min_height) in &by_elevator {
            let min_height = *min_height;
            let Some(&any_stop) = elevator_key.0.first() else {
                continue;
            };
            let Some(elevator) = find_elevator_by_stop(maze, any_stop) else {
                continue;
            };
            let Some(point) = elevator.stops.first().and_then(|&n| maze.field.cell_of(n)) else {
                continue;
            };

            let nodes_by_index: Vec<Option<NodeId>> = maze
                .field
                .levels_ordered()
                .map(|level| maze.field.node_at(level, point))
                .collect();
            let existing_indices: Vec<usize> = elevator
                .stops
                .iter()
                .filter_map(|&n| maze.field.level_index_of(n))
                .collect();
            let (Some(&bottom), Some(&top)) =
                (existing_indices.iter().min(), existing_indices.iter().max())
            else {
                continue;
            };
            let edge_bottom = match nodes_by_index.iter().position(|n| n.is_some()) {
                Some(i) => i,
                None => continue,
            };
            let edge_top = match nodes_by_index.iter().rposition(|n| n.is_some()) {
                Some(i) => i,
                None => continue,
            };

            let current_stops: Vec<NodeId> = elevator.stops.clone();

            // Grow a window strictly *inside* the existing stops (`[bottom+1, top-1]`). Each step
            // extends one side by exactly one floor, regardless of whether that floor has a cell --
            // a side only stays eligible while at least 2 floors further out on that side could
            // actually take a new stop (1 to grow onto now, 1 held in reserve for the edge stop
            // placed in the second pass below). `preferred_dir` biases which side is picked when
            // both are eligible; `balanced_growth` sets it to the opposite side after every step
            // (and clears it when growth wasn't forced by a single-eligible-side pick).
            let mut lo = bottom + 1;
            let mut hi = top.saturating_sub(1);
            let mut preferred_dir: Option<bool> = None; // Some(true) = up, Some(false) = down
            loop {
                if hi >= lo && hi - lo + 1 >= min_height.saturating_sub(2) as usize {
                    break;
                }
                let placeable_floors_below = |from: usize| {
                    (edge_bottom..from)
                        .rev()
                        .filter_map(|i| nodes_by_index[i])
                        .filter(|&n| reserved_or_feasible(maze, n, &current_stops, preset_state))
                        .take(2)
                        .count()
                };
                let placeable_floors_above = |from: usize| {
                    ((from + 1)..=edge_top)
                        .filter_map(|i| nodes_by_index[i])
                        .filter(|&n| reserved_or_feasible(maze, n, &current_stops, preset_state))
                        .take(2)
                        .count()
                };
                let down_eligible = lo > edge_bottom && placeable_floors_below(lo) >= 2;
                let up_eligible = hi < edge_top && placeable_floors_above(hi) >= 2;
                if !down_eligible && !up_eligible {
                    break;
                }
                let grow_up = match preferred_dir {
                    Some(true) if up_eligible => true,
                    Some(false) if down_eligible => false,
                    _ => {
                        if down_eligible && up_eligible {
                            rng.next_u32().is_multiple_of(2)
                        } else {
                            up_eligible
                        }
                    }
                };
                if grow_up {
                    hi += 1;
                } else {
                    lo -= 1;
                }
                preferred_dir = if balanced_growth {
                    Some(!grow_up)
                } else {
                    None
                };
            }

            let interval_len = if hi >= lo { hi - lo + 1 } else { 0 };
            if interval_len < min_height.saturating_sub(2) as usize && !allow_incomplete {
                continue;
            }

            let mut added_here = 0u32;
            let mut current_stops_grown = current_stops.clone();

            let below_pool: Vec<NodeId> = (edge_bottom..lo)
                .filter_map(|i| nodes_by_index[i])
                .filter(|&n| reserved_or_feasible(maze, n, &current_stops_grown, preset_state))
                .collect();
            let above_pool: Vec<NodeId> = ((hi + 1)..=edge_top)
                .filter_map(|i| nodes_by_index[i])
                .filter(|&n| reserved_or_feasible(maze, n, &current_stops_grown, preset_state))
                .collect();

            let below_pick = if max_compactness {
                below_pool.last().copied()
            } else {
                below_pool.choose(rng).copied()
            };
            if let Some(node) = below_pick
                && !current_stops_grown.contains(&node)
            {
                for &other in &current_stops_grown {
                    commands.push(MutationCommand::AddBidirectionalElevator { a: node, b: other });
                }
                current_stops_grown.push(node);
                added_here += 1;
            }
            let above_pool: Vec<NodeId> = above_pool
                .into_iter()
                .filter(|&n| reserved_or_feasible(maze, n, &current_stops_grown, preset_state))
                .collect();
            let above_pick = if max_compactness {
                above_pool.first().copied()
            } else {
                above_pool.choose(rng).copied()
            };
            if let Some(node) = above_pick
                && !current_stops_grown.contains(&node)
            {
                for &other in &current_stops_grown {
                    commands.push(MutationCommand::AddBidirectionalElevator { a: node, b: other });
                }
                added_here += 1;
            }

            total_added += added_here;
        }

        if total_added == 0 {
            return (RepairResult::Failed, vec![]);
        }
        (RepairResult::Fixed { score: None }, commands)
    }
}

crate::impl_erased_repair_strategy!(AddElevatorHeightStopStrategy, MissingElevatorHeightIssue);

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

/// A floor counts as a reserve/pool slot either if a new stop could actually go there, or if it's
/// already one of the elevator's own existing stops (that floor is "occupied", not "blocked" --
/// it doesn't need a new stop, but it still counts toward the 2-floor reserve growth needs, and
/// showing up in a placement pool is harmless since the pick step skips already-occupied floors).
fn reserved_or_feasible<T: Tessellation>(
    maze: &Maze<T>,
    candidate: NodeId,
    current_stops: &[NodeId],
    preset_state: &PresetState,
) -> bool {
    stop_feasible(maze, candidate, current_stops, preset_state)
        || current_stops.contains(&candidate)
}

#[cfg(test)]
#[path = "add_elevator_height_stop_tests.rs"]
mod tests;
