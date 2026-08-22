use rand::RngCore;
use rand::seq::SliceRandom;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::{LevelId, Tessellation};
use crate::quality_control::MissingElevatorStopCountIssue;
use crate::generation::PresetState;
use crate::generation::edge_ops::bidirectional_edge_feasible;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams, PriorityLevel};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use super::elevator_utils::find_elevator_by_stop;

pub const PARAM_EXPAND_ELEVATOR: &str = "expand_elevator";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_EXPAND_ELEVATOR,
        label: "Expand elevator",
        kind: StrategyParamKind::Priority { default: PriorityLevel::Indifferent },
    },
];

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

impl<T: Tessellation> RepairStrategy<T, MissingElevatorStopCountIssue> for AddElevatorStopCountStrategy {
    fn strategy_id(&self) -> &'static str { "add_elevator_stop_count" }

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
        let expand_elevator = params.get(PARAM_EXPAND_ELEVATOR).and_then(|v| v.as_priority()).unwrap_or(PriorityLevel::Indifferent);

        let mut commands = Vec::new();
        let mut total_added: u32 = 0;

        for (elevator_key, count, available) in &issue.missing {
            if *count == 0 || available.is_empty() {
                continue;
            }
            let Some(&any_stop) = elevator_key.0.first() else { continue };
            let Some(elevator) = find_elevator_by_stop(maze, any_stop) else { continue };
            let Some(point) = elevator.stops.first().and_then(|&n| maze.field.point_of(n)) else { continue };

            let mut current_stops: Vec<NodeId> = elevator.stops.clone();

            let level_index: std::collections::HashMap<LevelId, usize> = maze.field.levels_ordered()
                .enumerate()
                .map(|(i, level)| (level, i))
                .collect();
            let existing_indices: Vec<usize> = current_stops.iter()
                .filter_map(|&n| maze.field.level_index_of(n))
                .collect();
            let (Some(&bottom), Some(&top)) = (existing_indices.iter().min(), existing_indices.iter().max()) else { continue };
            let is_inside = |level: &LevelId| {
                level_index.get(level).is_some_and(|&i| i > bottom && i < top)
            };

            let (mut inside, mut outside): (Vec<LevelId>, Vec<LevelId>) = available.iter().copied().partition(is_inside);
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
                    let Some(node) = maze.field.node_at(level, point) else { continue };
                    if current_stops.contains(&node) {
                        continue;
                    }
                    if !stop_feasible(maze, node, &current_stops, preset_state) {
                        continue;
                    }
                    for &other in &current_stops {
                        entry_commands.push(MutationCommand::AddBidirectionalElevator { a: node, b: other });
                    }
                    current_stops.push(node);
                    added_here += 1;
                }
            }

            let zone_locked = matches!(expand_elevator, PriorityLevel::Forbidden | PriorityLevel::Required);
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

fn stop_feasible<T: Tessellation>(maze: &Maze<T>, candidate: NodeId, current_stops: &[NodeId], preset_state: &PresetState) -> bool {
    current_stops.iter().all(|&other| {
        maze.graph.edge_between(candidate, other).is_none()
            && maze.graph.edge_between(other, candidate).is_none()
            && bidirectional_edge_feasible(preset_state, candidate, other)
    })
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

    fn no_params() -> StrategyParams {
        build_params(<AddElevatorStopCountStrategy as RepairStrategy<SquareTessellation, MissingElevatorStopCountIssue>>::params(&AddElevatorStopCountStrategy), None)
    }

    fn params_with(expand_elevator: &str) -> StrategyParams {
        let mut overrides = std::collections::HashMap::new();
        overrides.insert(PARAM_EXPAND_ELEVATOR.to_string(), expand_elevator.to_string());
        build_params(<AddElevatorStopCountStrategy as RepairStrategy<SquareTessellation, MissingElevatorStopCountIssue>>::params(&AddElevatorStopCountStrategy), Some(&overrides))
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
    fn apply_adds_requested_stop_and_wires_it_to_every_existing_stop() {
        let (mut maze, nodes, floors) = maze_with_elevator(4, &[0, 1]);
        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 1, vec![floors[3]])],
        );
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let groups = elevator_groups(&maze);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].stops.len(), 3);
        let new_node = maze.field.node_at(floors[3], SquarePoint { x: 0, y: 0 }).unwrap();
        assert!(maze.graph.edge_between(new_node, nodes[0]).is_some());
        assert!(maze.graph.edge_between(new_node, nodes[1]).is_some());
    }

    #[test]
    fn partial_success_when_only_some_requested_stops_could_be_added() {
        let (mut maze, nodes, floors) = maze_with_elevator(5, &[0, 1]);
        let blocked = maze.field.node_at(floors[3], SquarePoint { x: 0, y: 0 }).unwrap();
        let decoy = maze.field.node_at(floors[2], SquarePoint { x: 0, y: 0 }).unwrap();
        maze.graph.add_edge(blocked, decoy, EdgeKind::Basic);
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(blocked);

        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 2, vec![floors[3], floors[4]])],
        );
        let mut rng = MazeRng::seed_from_u64(2);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }), "adding at least one of two requested stops still counts as success");
        let groups = elevator_groups(&maze);
        assert_eq!(groups[0].stops.len(), 3, "only floor 4 could be added; floor 3 is locked out");
    }

    #[test]
    fn apply_fails_when_no_stop_could_be_added_at_all() {
        let (mut maze, nodes, floors) = maze_with_elevator(4, &[0, 1]);
        let blocked = maze.field.node_at(floors[3], SquarePoint { x: 0, y: 0 }).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(blocked);

        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 1, vec![floors[3]])],
        );
        let mut rng = MazeRng::seed_from_u64(3);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 2, "only the original 2 elevator edges remain, nothing added");
    }

    #[test]
    fn apply_skips_an_entry_whose_elevator_no_longer_exists() {
        let (mut maze, nodes, floors) = maze_with_elevator(4, &[0, 1]);
        maze.graph.remove_edge(maze.graph.edge_between(nodes[0], nodes[1]).unwrap());
        maze.graph.remove_edge(maze.graph.edge_between(nodes[1], nodes[0]).unwrap());

        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 1, vec![floors[3]])],
        );
        let mut rng = MazeRng::seed_from_u64(4);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
    }

    #[test]
    fn apply_is_deterministic_for_fixed_seed() {
        let (mut maze_a, nodes_a, floors_a) = maze_with_elevator(6, &[0, 1]);
        let issue_a = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes_a.clone()), 1, vec![floors_a[2], floors_a[3], floors_a[4], floors_a[5]])],
        );
        let mut rng_a = MazeRng::seed_from_u64(99);
        apply_and_commit(&AddElevatorStopCountStrategy, &issue_a, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &[]);

        let (mut maze_b, nodes_b, floors_b) = maze_with_elevator(6, &[0, 1]);
        let issue_b = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes_b.clone()), 1, vec![floors_b[2], floors_b[3], floors_b[4], floors_b[5]])],
        );
        let mut rng_b = MazeRng::seed_from_u64(99);
        apply_and_commit(&AddElevatorStopCountStrategy, &issue_b, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &[]);

        let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
        let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
        assert_eq!(edges_a, edges_b);
    }

    #[test]
    fn forbidden_only_adds_inside_floors() {
        // Stops at 0,4 of 7 floors -- inside = {1,2,3}, outside = {5,6}.
        let (mut maze, nodes, floors) = maze_with_elevator(7, &[0, 4]);
        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 2, vec![floors[1], floors[2], floors[3], floors[5], floors[6]])],
        );
        let mut rng = MazeRng::seed_from_u64(10);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &params_with("forbidden"), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let indices: Vec<usize> = elevator_groups(&maze)[0].stops.iter().filter_map(|&n| maze.field.level_index_of(n)).collect();
        for i in &indices {
            assert!(*i == 0 || *i == 4 || (*i > 0 && *i < 4), "forbidden must never pick an outside floor, got index {i}");
        }
    }

    #[test]
    fn forbidden_fails_the_entry_when_inside_alone_cannot_satisfy_count() {
        // Inside only has floor 1 free (stops at 0,2), but 2 stops requested.
        let (mut maze, nodes, floors) = maze_with_elevator(5, &[0, 2]);
        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 2, vec![floors[1], floors[3], floors[4]])],
        );
        let mut rng = MazeRng::seed_from_u64(11);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &params_with("forbidden"), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 2, "entry skipped entirely, nothing added");
    }

    #[test]
    fn required_only_adds_outside_floors() {
        let (mut maze, nodes, floors) = maze_with_elevator(7, &[0, 4]);
        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 2, vec![floors[1], floors[2], floors[3], floors[5], floors[6]])],
        );
        let mut rng = MazeRng::seed_from_u64(12);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &params_with("required"), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let indices: Vec<usize> = elevator_groups(&maze)[0].stops.iter().filter_map(|&n| maze.field.level_index_of(n)).collect();
        assert!(indices.contains(&5) && indices.contains(&6), "required must add both outside floors 5,6");
    }

    #[test]
    fn required_fails_the_entry_when_outside_alone_cannot_satisfy_count() {
        let (mut maze, nodes, floors) = maze_with_elevator(5, &[0, 4]);
        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 2, vec![floors[1], floors[2], floors[3]])],
        );
        let mut rng = MazeRng::seed_from_u64(13);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &params_with("required"), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert_eq!(maze.graph.edges().count(), 2, "no outside floors exist at all, entry skipped");
    }

    #[test]
    fn discouraged_prefers_inside_then_falls_back_to_outside() {
        // Inside has only floor 1, but 2 stops requested -- must fall back to outside for the rest.
        let (mut maze, nodes, floors) = maze_with_elevator(7, &[0, 2]);
        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 2, vec![floors[1], floors[3], floors[4], floors[5], floors[6]])],
        );
        let mut rng = MazeRng::seed_from_u64(14);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &params_with("discouraged"), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let indices: Vec<usize> = elevator_groups(&maze)[0].stops.iter().filter_map(|&n| maze.field.level_index_of(n)).collect();
        assert!(indices.contains(&1), "the one inside floor must be used first");
        assert_eq!(indices.len(), 4, "2 existing + 2 newly added (1 inside + 1 outside fallback)");
    }

    #[test]
    fn preferred_prefers_outside_then_falls_back_to_inside() {
        // Outside has only floor 6, but 2 stops requested -- must fall back to inside for the rest.
        let (mut maze, nodes, floors) = maze_with_elevator(7, &[0, 4]);
        let issue = MissingElevatorStopCountIssue::new_from_check(
            "min_elevator_stop_count",
            vec![(ElevatorNodes::new(nodes.clone()), 2, vec![floors[1], floors[2], floors[3], floors[6]])],
        );
        let mut rng = MazeRng::seed_from_u64(15);
        let result = apply_and_commit(&AddElevatorStopCountStrategy, &issue, &mut maze, &mut rng, &params_with("preferred"), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
        let indices: Vec<usize> = elevator_groups(&maze)[0].stops.iter().filter_map(|&n| maze.field.level_index_of(n)).collect();
        assert!(indices.contains(&6), "the one outside floor must be used first");
        assert_eq!(indices.len(), 4, "2 existing + 2 newly added (1 outside + 1 inside fallback)");
    }
}
