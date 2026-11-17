use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind, Graph};
use crate::quality_control::checks::elevator_core::elevator_groups;
use crate::quality_control::issue_kinds::ElevatorNodes;
use crate::random::MazeRng;
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::sync::Arc;

fn no_params() -> StrategyParams {
    build_params(
        <AddElevatorStopCountStrategy as RepairStrategy<
            SquareTessellation,
            MissingElevatorStopCountIssue,
        >>::params(&AddElevatorStopCountStrategy),
        None,
    )
}

fn params_with(expand_elevator: &str) -> StrategyParams {
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(
        PARAM_EXPAND_ELEVATOR.to_string(),
        expand_elevator.to_string(),
    );
    build_params(
        <AddElevatorStopCountStrategy as RepairStrategy<
            SquareTessellation,
            MissingElevatorStopCountIssue,
        >>::params(&AddElevatorStopCountStrategy),
        Some(&overrides),
    )
}

fn maze_with_elevator(
    floor_count: usize,
    stop_floor_indices: &[usize],
) -> (
    Maze<SquareTessellation>,
    Vec<NodeId>,
    Vec<crate::space::LevelId>,
) {
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), std::iter::empty());
    let floors: Vec<_> = (0..floor_count)
        .map(|_| {
            mf.add_level(
                Field::<SquareTessellation>::new(Arc::default(), square_rect(1, 1), &mut ids)
                    .unwrap(),
            )
        })
        .collect();
    let mut g = Graph::new();
    for node in mf.all_node_ids() {
        g.add_node(node);
    }
    let nodes: Vec<_> = stop_floor_indices
        .iter()
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
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].stops.len(), 3);
    let new_node = maze
        .field
        .node_at(floors[3], SquarePoint { x: 0, y: 0 })
        .unwrap();
    assert!(maze.graph.edge_between(new_node, nodes[0]).is_some());
    assert!(maze.graph.edge_between(new_node, nodes[1]).is_some());
}

#[test]
fn partial_success_when_only_some_requested_stops_could_be_added() {
    let (mut maze, nodes, floors) = maze_with_elevator(5, &[0, 1]);
    let blocked = maze
        .field
        .node_at(floors[3], SquarePoint { x: 0, y: 0 })
        .unwrap();
    let decoy = maze
        .field
        .node_at(floors[2], SquarePoint { x: 0, y: 0 })
        .unwrap();
    maze.graph.add_edge(blocked, decoy, EdgeKind::Basic);
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(blocked);

    let issue = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(ElevatorNodes::new(nodes), 2, vec![floors[3], floors[4]])],
    );
    let mut rng = MazeRng::seed_from_u64(2);
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &preset_state,
        &[],
    );
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "adding at least one of two requested stops still counts as success"
    );
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups[0].stops.len(),
        3,
        "only floor 4 could be added; floor 3 is locked out"
    );
}

#[test]
fn apply_fails_when_no_stop_could_be_added_at_all() {
    let (mut maze, nodes, floors) = maze_with_elevator(4, &[0, 1]);
    let blocked = maze
        .field
        .node_at(floors[3], SquarePoint { x: 0, y: 0 })
        .unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(blocked);

    let issue = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(ElevatorNodes::new(nodes), 1, vec![floors[3]])],
    );
    let mut rng = MazeRng::seed_from_u64(3);
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &preset_state,
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(
        maze.graph.edges().count(),
        2,
        "only the original 2 elevator edges remain, nothing added"
    );
}

#[test]
fn apply_skips_an_entry_whose_elevator_no_longer_exists() {
    let (mut maze, nodes, floors) = maze_with_elevator(4, &[0, 1]);
    maze.graph
        .remove_edge(maze.graph.edge_between(nodes[0], nodes[1]).unwrap());
    maze.graph
        .remove_edge(maze.graph.edge_between(nodes[1], nodes[0]).unwrap());

    let issue = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(ElevatorNodes::new(nodes), 1, vec![floors[3]])],
    );
    let mut rng = MazeRng::seed_from_u64(4);
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let (mut maze_a, nodes_a, floors_a) = maze_with_elevator(6, &[0, 1]);
    let issue_a = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(
            ElevatorNodes::new(nodes_a),
            1,
            vec![floors_a[2], floors_a[3], floors_a[4], floors_a[5]],
        )],
    );
    let mut rng_a = MazeRng::seed_from_u64(99);
    apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue_a,
        &mut maze_a,
        &mut rng_a,
        &no_params(),
        &PresetState::empty(),
        &[],
    );

    let (mut maze_b, nodes_b, floors_b) = maze_with_elevator(6, &[0, 1]);
    let issue_b = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(
            ElevatorNodes::new(nodes_b),
            1,
            vec![floors_b[2], floors_b[3], floors_b[4], floors_b[5]],
        )],
    );
    let mut rng_b = MazeRng::seed_from_u64(99);
    apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue_b,
        &mut maze_b,
        &mut rng_b,
        &no_params(),
        &PresetState::empty(),
        &[],
    );

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
        vec![(
            ElevatorNodes::new(nodes),
            2,
            vec![floors[1], floors[2], floors[3], floors[5], floors[6]],
        )],
    );
    let mut rng = MazeRng::seed_from_u64(10);
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with("forbidden"),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let indices: Vec<usize> = elevator_groups(&maze)[0]
        .stops
        .iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    for i in &indices {
        assert!(
            *i == 0 || *i == 4 || (*i > 0 && *i < 4),
            "forbidden must never pick an outside floor, got index {i}"
        );
    }
}

#[test]
fn forbidden_fails_the_entry_when_inside_alone_cannot_satisfy_count() {
    // Inside only has floor 1 free (stops at 0,2), but 2 stops requested.
    let (mut maze, nodes, floors) = maze_with_elevator(5, &[0, 2]);
    let issue = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(
            ElevatorNodes::new(nodes),
            2,
            vec![floors[1], floors[3], floors[4]],
        )],
    );
    let mut rng = MazeRng::seed_from_u64(11);
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with("forbidden"),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(
        maze.graph.edges().count(),
        2,
        "entry skipped entirely, nothing added"
    );
}

#[test]
fn required_only_adds_outside_floors() {
    let (mut maze, nodes, floors) = maze_with_elevator(7, &[0, 4]);
    let issue = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(
            ElevatorNodes::new(nodes),
            2,
            vec![floors[1], floors[2], floors[3], floors[5], floors[6]],
        )],
    );
    let mut rng = MazeRng::seed_from_u64(12);
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with("required"),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let indices: Vec<usize> = elevator_groups(&maze)[0]
        .stops
        .iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    assert!(
        indices.contains(&5) && indices.contains(&6),
        "required must add both outside floors 5,6"
    );
}

#[test]
fn required_fails_the_entry_when_outside_alone_cannot_satisfy_count() {
    let (mut maze, nodes, floors) = maze_with_elevator(5, &[0, 4]);
    let issue = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(
            ElevatorNodes::new(nodes),
            2,
            vec![floors[1], floors[2], floors[3]],
        )],
    );
    let mut rng = MazeRng::seed_from_u64(13);
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with("required"),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(
        maze.graph.edges().count(),
        2,
        "no outside floors exist at all, entry skipped"
    );
}

#[test]
fn discouraged_prefers_inside_then_falls_back_to_outside() {
    // Inside has only floor 1, but 2 stops requested -- must fall back to outside for the rest.
    let (mut maze, nodes, floors) = maze_with_elevator(7, &[0, 2]);
    let issue = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(
            ElevatorNodes::new(nodes),
            2,
            vec![floors[1], floors[3], floors[4], floors[5], floors[6]],
        )],
    );
    let mut rng = MazeRng::seed_from_u64(14);
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with("discouraged"),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let indices: Vec<usize> = elevator_groups(&maze)[0]
        .stops
        .iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    assert!(
        indices.contains(&1),
        "the one inside floor must be used first"
    );
    assert_eq!(
        indices.len(),
        4,
        "2 existing + 2 newly added (1 inside + 1 outside fallback)"
    );
}

#[test]
fn preferred_prefers_outside_then_falls_back_to_inside() {
    // Outside has only floor 6, but 2 stops requested -- must fall back to inside for the rest.
    let (mut maze, nodes, floors) = maze_with_elevator(7, &[0, 4]);
    let issue = MissingElevatorStopCountIssue::new_from_check(
        "min_elevator_stop_count",
        vec![(
            ElevatorNodes::new(nodes),
            2,
            vec![floors[1], floors[2], floors[3], floors[6]],
        )],
    );
    let mut rng = MazeRng::seed_from_u64(15);
    let result = apply_and_commit(
        &AddElevatorStopCountStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with("preferred"),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let indices: Vec<usize> = elevator_groups(&maze)[0]
        .stops
        .iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    assert!(
        indices.contains(&6),
        "the one outside floor must be used first"
    );
    assert_eq!(
        indices.len(),
        4,
        "2 existing + 2 newly added (1 outside + 1 inside fallback)"
    );
}
