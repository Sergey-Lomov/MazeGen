use rand::RngCore;
use rand::seq::IndexedRandom;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::MissingElevatorHeightIssue;
use crate::generation::PresetState;
use crate::generation::edge_ops::bidirectional_edge_feasible;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::elevator_utils::find_elevator_by_stop;

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

impl<T: Tessellation> RepairStrategy<T, MissingElevatorHeightIssue> for AddElevatorHeightStopStrategy {
    fn strategy_id(&self) -> &'static str { "add_elevator_height_stop" }

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
        let balanced_growth = matches!(params.get(PARAM_BALANCED_GROWTH), Some(StrategyParamValue::Bool(true)));
        let allow_incomplete = !matches!(params.get(PARAM_ALLOW_INCOMPLETE), Some(StrategyParamValue::Bool(false)));
        let max_compactness = matches!(params.get(PARAM_MAX_COMPACTNESS), Some(StrategyParamValue::Bool(true)));

        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        // `issue.missing` can hold multiple entries for the same elevator -- e.g. several
        // `min_elevator_height` checks configured on the same Rule, each flagging it against its
        // own threshold (`MissingElevatorHeightIssue::merge` deliberately doesn't dedup, mirroring
        // `InvalidElevatorIssue`). Growing the same elevator once per entry would compound (e.g. 4
        // stops added instead of 2), so entries are folded down to one per elevator here, keeping
        // the largest `min_height` demanded of it.
        let mut by_elevator: Vec<(&crate::quality_control::issue_kinds::ElevatorNodes, u32)> = Vec::new();
        for (elevator_key, &min_height) in issue.missing.iter().map(|(k, h)| (k, h)) {
            match by_elevator.iter_mut().find(|(k, _)| k == &elevator_key) {
                Some((_, existing)) => *existing = (*existing).max(min_height),
                None => by_elevator.push((elevator_key, min_height)),
            }
        }

        for (elevator_key, min_height) in &by_elevator {
            let min_height = *min_height;
            let Some(&any_stop) = elevator_key.0.first() else { continue };
            let Some(elevator) = find_elevator_by_stop(maze, any_stop) else { continue };
            let Some(point) = elevator.stops.first().and_then(|&n| maze.field.point_of(n)) else { continue };

            let nodes_by_index: Vec<Option<NodeId>> = maze.field.levels_ordered()
                .map(|level| maze.field.node_at(level, point))
                .collect();
            let existing_indices: Vec<usize> = elevator.stops.iter()
                .filter_map(|&n| maze.field.level_index_of(n))
                .collect();
            let (Some(&bottom), Some(&top)) = (existing_indices.iter().min(), existing_indices.iter().max()) else { continue };
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
                let placeable_floors_below = |from: usize| (edge_bottom..from).rev()
                    .filter_map(|i| nodes_by_index[i])
                    .filter(|&n| reserved_or_feasible(maze, n, &current_stops, preset_state))
                    .take(2).count();
                let placeable_floors_above = |from: usize| ((from + 1)..=edge_top)
                    .filter_map(|i| nodes_by_index[i])
                    .filter(|&n| reserved_or_feasible(maze, n, &current_stops, preset_state))
                    .take(2).count();
                let down_eligible = lo > edge_bottom && placeable_floors_below(lo) >= 2;
                let up_eligible = hi < edge_top && placeable_floors_above(hi) >= 2;
                if !down_eligible && !up_eligible {
                    break;
                }
                let grow_up = match preferred_dir {
                    Some(true) if up_eligible => true,
                    Some(false) if down_eligible => false,
                    _ => if down_eligible && up_eligible { rng.next_u32() % 2 == 0 } else { up_eligible },
                };
                if grow_up {
                    hi += 1;
                } else {
                    lo -= 1;
                }
                preferred_dir = if balanced_growth { Some(!grow_up) } else { None };
            }

            let interval_len = if hi >= lo { hi - lo + 1 } else { 0 };
            if interval_len < min_height.saturating_sub(2) as usize && !allow_incomplete {
                continue;
            }

            let mut added_here = 0u32;
            let mut current_stops_grown = current_stops.clone();

            let below_pool: Vec<NodeId> = (edge_bottom..lo).filter_map(|i| nodes_by_index[i])
                .filter(|&n| reserved_or_feasible(maze, n, &current_stops_grown, preset_state))
                .collect();
            let above_pool: Vec<NodeId> = ((hi + 1)..=edge_top).filter_map(|i| nodes_by_index[i])
                .filter(|&n| reserved_or_feasible(maze, n, &current_stops_grown, preset_state))
                .collect();

            let below_pick = if max_compactness {
                below_pool.last().copied()
            } else {
                below_pool.choose(rng).copied()
            };
            if let Some(node) = below_pick {
                if !current_stops_grown.contains(&node) {
                    for &other in &current_stops_grown {
                        commands.push(MutationCommand::AddBidirectionalElevator { a: node, b: other });
                    }
                    current_stops_grown.push(node);
                    added_here += 1;
                }
            }
            let above_pool: Vec<NodeId> = above_pool.into_iter()
                .filter(|&n| reserved_or_feasible(maze, n, &current_stops_grown, preset_state))
                .collect();
            let above_pick = if max_compactness {
                above_pool.first().copied()
            } else {
                above_pool.choose(rng).copied()
            };
            if let Some(node) = above_pick {
                if !current_stops_grown.contains(&node) {
                    for &other in &current_stops_grown {
                        commands.push(MutationCommand::AddBidirectionalElevator { a: node, b: other });
                    }
                    added_here += 1;
                }
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

fn stop_feasible<T: Tessellation>(maze: &Maze<T>, candidate: NodeId, current_stops: &[NodeId], preset_state: &PresetState) -> bool {
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
fn reserved_or_feasible<T: Tessellation>(maze: &Maze<T>, candidate: NodeId, current_stops: &[NodeId], preset_state: &PresetState) -> bool {
    stop_feasible(maze, candidate, current_stops, preset_state) || current_stops.contains(&candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::quality_control::issue_kinds::ElevatorNodes;
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;
    use crate::quality_control::checks::elevator_core::elevator_groups;

    fn params_with(balanced_growth: Option<&str>, allow_incomplete: Option<&str>) -> StrategyParams {
        params_with_compactness(balanced_growth, allow_incomplete, None)
    }

    fn params_with_compactness(balanced_growth: Option<&str>, allow_incomplete: Option<&str>, max_compactness: Option<&str>) -> StrategyParams {
        let mut overrides = std::collections::HashMap::new();
        if let Some(v) = balanced_growth { overrides.insert(PARAM_BALANCED_GROWTH.to_string(), v.to_string()); }
        if let Some(v) = allow_incomplete { overrides.insert(PARAM_ALLOW_INCOMPLETE.to_string(), v.to_string()); }
        if let Some(v) = max_compactness { overrides.insert(PARAM_MAX_COMPACTNESS.to_string(), v.to_string()); }
        build_params(
            <AddElevatorHeightStopStrategy as RepairStrategy<SquareTessellation, MissingElevatorHeightIssue>>::params(&AddElevatorHeightStopStrategy),
            Some(&overrides),
        )
    }

    fn maze_with_elevator(floor_count: usize, stop_floor_indices: &[usize]) -> (Maze<SquareTessellation>, Vec<NodeId>, Vec<crate::space::LevelId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..floor_count)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = stop_floor_indices.iter()
            .map(|&i| mf.node_at(floors[i], SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        (Maze::new(mf, g), nodes, floors)
    }

    #[test]
    fn duplicate_entries_for_the_same_elevator_are_folded_to_a_single_growth() {
        // Two checks (e.g. differently-configured `min_elevator_height` instances) can both flag
        // the same elevator into one merged issue without deduping (see
        // `MissingElevatorHeightIssue::merge`'s doc comment). Growing it twice would add 4 stops
        // instead of 2 -- must fold to the max min_height and grow exactly once.
        let (mut maze, nodes, _floors) = maze_with_elevator(11, &[3, 5]);
        let issue = MissingElevatorHeightIssue::new_from_check(
            "min_elevator_height",
            vec![(ElevatorNodes::new(nodes.clone()), 4), (ElevatorNodes::new(nodes.clone()), 6)],
        );
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(None, None), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        assert_eq!(groups[0].stops.len(), 4, "grown once (2 new stops), not twice (4 new stops)");
    }

    #[test]
    fn duplicate_entries_with_allow_incomplete_off_still_skip_when_width_unreachable() {
        // Same dedup concern as above, but for the allow_incomplete=false path: with duplicate
        // entries un-folded, the first pass could add partial stops before a later duplicate
        // entry's incomplete-width check kicks in, making the strategy look like it ignored the
        // param. Folding to one entry means the check applies exactly once, correctly.
        let (mut maze, nodes, _floors) = maze_with_elevator(3, &[0, 2]);
        let issue = MissingElevatorHeightIssue::new_from_check(
            "min_elevator_height",
            vec![(ElevatorNodes::new(nodes.clone()), 10), (ElevatorNodes::new(nodes.clone()), 8)],
        );
        let mut rng = MazeRng::seed_from_u64(8);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(None, Some("false")), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
        let groups = elevator_groups(&maze);
        assert_eq!(groups[0].stops.len(), 2, "no stops added -- interval [0,2] already covers the whole 3-floor field, can't reach width 8");
    }

    #[test]
    fn grows_both_ends_when_a_single_stop_could_never_close_the_gap() {
        // Stops at 4,6 of 9 floors (0..=8), min_height 6 -- unreachable via one endpoint move, and
        // (unlike a field sized exactly to the required span) there's slack on both sides, so this
        // isolates the "needs both ends" growth path from the separate "runs out of field" case.
        let (mut maze, nodes, _floors) = maze_with_elevator(9, &[4, 6]);
        let issue = MissingElevatorHeightIssue::new_from_check("min_elevator_height", vec![(ElevatorNodes::new(nodes.clone()), 6)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(None, None), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        let indices: Vec<usize> = groups[0].stops.iter().filter_map(|&n| maze.field.level_index_of(n)).collect();
        let span = indices.iter().max().unwrap() - indices.iter().min().unwrap() + 1;
        // Matches `MinElevatorHeightCheck`'s own `top - bottom + 1` span definition -- this is
        // the exact quantity that must reach `min_height` for the check to stop re-firing.
        assert!(span >= 6, "min_height 6 requires an inclusive floor span of at least 6, got {span}");
        assert!(indices.iter().min().unwrap() < &4, "must have grown below the original bottom stop at floor 4");
        assert!(indices.iter().max().unwrap() > &6, "must have grown above the original top stop at floor 6");
    }

    #[test]
    fn stops_growing_once_interval_is_wide_enough() {
        let (mut maze, nodes, _floors) = maze_with_elevator(10, &[4, 5]);
        let issue = MissingElevatorHeightIssue::new_from_check("min_elevator_height", vec![(ElevatorNodes::new(nodes.clone()), 4)]);
        let mut rng = MazeRng::seed_from_u64(2);
        apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(None, None), &PresetState::empty(), &[]);
        let groups = elevator_groups(&maze);
        assert_eq!(groups[0].stops.len(), 4, "needed_len = min_height-2 = 2; interval [4,5] already wide enough, then adds one below + one above");
    }

    #[test]
    fn allow_incomplete_off_skips_entry_that_cannot_reach_needed_width() {
        let (mut maze, nodes, _floors) = maze_with_elevator(3, &[0, 2]);
        let issue = MissingElevatorHeightIssue::new_from_check("min_elevator_height", vec![(ElevatorNodes::new(nodes.clone()), 10)]);
        let mut rng = MazeRng::seed_from_u64(3);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(None, Some("false")), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn allow_incomplete_on_still_adds_available_endpoints_when_width_unreachable() {
        let (mut maze, nodes, _floors) = maze_with_elevator(3, &[0, 2]);
        let issue = MissingElevatorHeightIssue::new_from_check("min_elevator_height", vec![(ElevatorNodes::new(nodes.clone()), 10)]);
        let mut rng = MazeRng::seed_from_u64(4);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(None, Some("true")), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed), "interval [0,2] already covers every floor -- no below/above floor remains to add");
    }

    #[test]
    fn allow_incomplete_off_still_commits_when_width_is_met_even_if_one_side_is_infeasible() {
        // Stops at 2,5 of 7 floors (0..=6), min_height 6 -- needed_len 4, already met by [2,5]. But
        // floor 6 (the only "above" candidate) already has a preset-blocking edge to the bottom
        // stop, so only the "below" stop (floor 1) can be added. `allow_incomplete` gates on the
        // grown interval's *width* only (already reached needed_len here) -- it says nothing about
        // how many edge stops end up placeable, so this is a full success with a 1-stop addition.
        let (mut maze, nodes, floors) = maze_with_elevator(7, &[2, 5]);
        let blocked_node = maze.field.node_at(floors[6], SquarePoint { x: 0, y: 0 }).unwrap();
        maze.graph.add_node(blocked_node);
        maze.graph.add_edge(nodes[0], blocked_node, EdgeKind::Elevator);
        maze.graph.add_edge(blocked_node, nodes[0], EdgeKind::Elevator);

        let issue = MissingElevatorHeightIssue::new_from_check("min_elevator_height", vec![(ElevatorNodes::new(nodes.clone()), 6)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(None, Some("false")), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        assert_eq!(groups[0].stops.len(), 4, "needed_len already met -- below stop (floor 1) added despite the above side being preset-blocked");
    }

    #[test]
    fn one_sided_growth_still_commits_the_reachable_edge_stop_when_the_other_side_has_no_room() {
        // Stops at 0,3 of 7 floors (0..=6), min_height 5 -- needed_len 3. `bottom` (floor 0) is
        // already the field's own edge_bottom here, so the down side can never grow or gain a
        // below stop; growth is forced entirely upward (hi: 2 -> 4 -> 5), and the below pool
        // (floors below lo, i.e. below bottom+1=1) is empty. `allow_incomplete=false` must still
        // commit the single reachable above stop (floor 6) instead of discarding the whole entry,
        // since the width requirement is met.
        let (mut maze, nodes, _floors) = maze_with_elevator(7, &[0, 3]);
        let issue = MissingElevatorHeightIssue::new_from_check("min_elevator_height", vec![(ElevatorNodes::new(nodes.clone()), 5)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(None, Some("false")), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        assert_eq!(groups[0].stops.len(), 3, "one edge stop added above (floor 6); below pool had no room since bottom (floor 0) is already the field edge");
    }

    #[test]
    fn max_compactness_picks_the_pool_floor_closest_to_the_grown_window_edge() {
        // Stops at 10,12 of 25 floors (0..=24), min_height 4 -- needed_len 2. The inner window
        // starts at [11,11] (width 1, one short of needed_len 2), so exactly one growth step
        // happens -- with seed 1 it grows downward to [10,11]. The below pool (floors below the
        // window's lo=10) has plenty of untouched field beneath it (down to edge_bottom=0);
        // max_compactness there must pick the single closest one (9, directly below the window),
        // not a farther one. The above pool (floors above hi=11) starts at floor 12 -- the
        // elevator's own existing top stop -- so the "closest" pick there is a no-op: the floor
        // right past the window is already a stop, not a new one to add.
        let (mut maze, nodes, _floors) = maze_with_elevator(25, &[10, 12]);
        let issue = MissingElevatorHeightIssue::new_from_check("min_elevator_height", vec![(ElevatorNodes::new(nodes.clone()), 4)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with_compactness(None, None, Some("true")), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        let mut indices: Vec<usize> = groups[0].stops.iter().filter_map(|&n| maze.field.level_index_of(n)).collect();
        indices.sort();
        assert_eq!(indices, vec![9, 10, 12], "below edge stop (9) lands directly adjacent to the grown window's lower bound (10); no new above stop since floor 12 (the window's upper neighbor) is already the original top stop");
    }

    #[test]
    fn balanced_growth_alternates_sides_once_both_are_eligible() {
        // Stops at 7,9 of 21 floors (0..=20), min_height 12 -- needed_len 10, requiring several
        // growth steps on both sides (plenty of field on both ends, so eligibility never forces a
        // single-sided step). With balanced_growth on, once both sides are eligible the strategy
        // must alternate: after seed 1's first (random) step, every next eligible-on-both-sides
        // step is forced to the opposite side, so growth away from the initial stops must reach
        // roughly symmetric distances rather than drifting entirely to one side.
        let (mut maze, nodes, _floors) = maze_with_elevator(21, &[7, 9]);
        let issue = MissingElevatorHeightIssue::new_from_check("min_elevator_height", vec![(ElevatorNodes::new(nodes.clone()), 12)]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(Some("true"), None), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        let indices: Vec<usize> = groups[0].stops.iter().filter_map(|&n| maze.field.level_index_of(n)).collect();
        let below_reach = 7 - indices.iter().min().unwrap();
        let above_reach = indices.iter().max().unwrap() - 9;
        assert!(below_reach.abs_diff(above_reach) <= 1, "balanced growth must keep both sides within 1 floor of each other, got below={below_reach} above={above_reach}");
    }

    #[test]
    fn apply_skips_an_entry_whose_elevator_no_longer_exists() {
        let (mut maze, nodes, _floors) = maze_with_elevator(7, &[3, 5]);
        maze.graph.remove_edge(maze.graph.edge_between(nodes[0], nodes[1]).unwrap());
        maze.graph.remove_edge(maze.graph.edge_between(nodes[1], nodes[0]).unwrap());

        let issue = MissingElevatorHeightIssue::new_from_check("min_elevator_height", vec![(ElevatorNodes::new(nodes.clone()), 6)]);
        let mut rng = MazeRng::seed_from_u64(5);
        let result = apply_and_commit(&AddElevatorHeightStopStrategy, &issue, &mut maze, &mut rng, &params_with(None, None), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }
}
