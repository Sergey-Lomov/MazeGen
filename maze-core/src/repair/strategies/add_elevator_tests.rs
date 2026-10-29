use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind, Graph};
use crate::quality_control::checks::elevator_core::elevator_groups;
use crate::random::MazeRng;
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::collections::HashMap;
use std::sync::Arc;

fn no_params() -> StrategyParams {
    build_params(
        <AddElevatorStrategy as RepairStrategy<SquareTessellation, MissingElevatorsIssue>>::params(
            &AddElevatorStrategy,
        ),
        None,
    )
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    build_params(
        <AddElevatorStrategy as RepairStrategy<SquareTessellation, MissingElevatorsIssue>>::params(
            &AddElevatorStrategy,
        ),
        Some(&map),
    )
}

fn multi_floor_maze(floors: usize, side: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), std::iter::empty());
    for _ in 0..floors {
        mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(side, side), &mut ids)
                .unwrap(),
        );
    }
    let mut g = Graph::new();
    for node in mf.all_node_ids() {
        g.add_node(node);
    }
    Maze::new(mf, g)
}

fn missing_issue(missing: u32) -> MissingElevatorsIssue {
    let entries = if missing == 0 {
        vec![]
    } else {
        vec![(RepairArea::WholeMaze, missing)]
    };
    MissingElevatorsIssue::new_from_check("min_elevator_count", entries)
}

#[test]
fn apply_succeeds_immediately_when_nothing_missing() {
    let mut maze = multi_floor_maze(5, 3);
    let issue = missing_issue(0);
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(
        &AddElevatorStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn apply_builds_an_elevator_spanning_multiple_floors() {
    let mut maze = multi_floor_maze(6, 3);
    let issue = missing_issue(1);
    let params = params_with(&[("reserve_percent", "0")]);
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit(
        &AddElevatorStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(groups.len(), 1);
    assert!(groups[0].stops.len() >= 2);
    for edge in maze.graph.edges() {
        assert_eq!(edge.kind, EdgeKind::Elevator);
    }
}

#[test]
fn apply_builds_a_fully_connected_fan_between_every_stop_pair() {
    let mut maze = multi_floor_maze(6, 3);
    let issue = missing_issue(1);
    let params = params_with(&[
        ("stop_count", "4,4"),
        ("length_interval", "5,5"),
        ("skip", "0,10"),
        ("reserve_percent", "0"),
    ]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &AddElevatorStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].stops.len(), 4, "stop_count pinned to 4");
    // Fully-connected fan of 4 stops -> 6 unordered pairs -> 12 directed edges.
    assert_eq!(maze.graph.edges().count(), 12);
}

#[test]
fn apply_respects_the_length_range_as_the_stop_floor_span() {
    let mut maze = multi_floor_maze(8, 3);
    let issue = missing_issue(1);
    let params = params_with(&[
        ("length_interval", "3,3"),
        ("stop_count", "2,2"),
        ("reserve_percent", "0"),
    ]);
    let mut rng = MazeRng::seed_from_u64(3);
    let result = apply_and_commit(
        &AddElevatorStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(groups.len(), 1);
    let floors: Vec<usize> = groups[0]
        .stops
        .iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    let span = floors.iter().max().unwrap() - floors.iter().min().unwrap();
    assert_eq!(
        span, 2,
        "length=3 counts floors inclusively, so the index span is length-1=2"
    );
}

#[test]
fn apply_fails_on_a_single_level_field() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(3, 3), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &AddElevatorStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn apply_fails_when_the_field_has_too_few_floors_for_the_configured_length_minimum() {
    let mut maze = multi_floor_maze(2, 3);
    let issue = missing_issue(1);
    let params = params_with(&[("length_interval", "5,10")]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &AddElevatorStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "2 floors can never satisfy a length minimum of 5"
    );
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn attempts_limit_failure_on_one_slot_does_not_abort_remaining_slots() {
    let mut maze = multi_floor_maze(6, 3);
    // Lock out every node except one point's column -- most random starts fail outright
    // (their own point's fan gets blocked), forcing attempts_limit exhaustion on some slots
    // while the surviving column still lets others succeed.
    let survivor_point = SquarePoint { x: 0, y: 0 };
    let mut preset_state = PresetState::empty();
    for level in maze.field.levels_ordered() {
        for node in maze
            .field
            .field_of(level)
            .unwrap()
            .all_cells()
            .filter_map(|p| {
                if p == survivor_point {
                    None
                } else {
                    maze.field.node_at(level, p)
                }
            })
        {
            preset_state.locked_out.insert(node);
        }
    }

    let issue = missing_issue(3);
    let params = params_with(&[("reserve_percent", "0"), ("attempts_limit", "2")]);
    let mut rng = MazeRng::seed_from_u64(9);
    let result = apply_and_commit(
        &AddElevatorStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &preset_state,
        &[],
    );
    // Only one point's column is ever feasible, so at most 1 elevator can ever be built
    // (a second attempt on the same column always collides with the first's edges) -- the
    // point is that this still reports Fixed (not Failed) rather than aborting everything.
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(!elevator_groups(&maze).is_empty());
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let issue = missing_issue(2);

    let mut maze_a = multi_floor_maze(6, 3);
    let mut rng_a = MazeRng::seed_from_u64(123);
    apply_and_commit(
        &AddElevatorStrategy,
        &issue,
        &mut maze_a,
        &mut rng_a,
        &no_params(),
        &PresetState::empty(),
        &[],
    );

    let mut maze_b = multi_floor_maze(6, 3);
    let mut rng_b = MazeRng::seed_from_u64(123);
    apply_and_commit(
        &AddElevatorStrategy,
        &issue,
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
fn distribute_stops_places_endpoints_and_keeps_every_gap_in_the_skip_range() {
    // step in 1..=3 (skip 0..=2), 4 stops across a span of 9 -- multiple gap combinations are
    // valid, so different seeds exercise different backtracking paths through the same call.
    for seed in 0..30u64 {
        let mut rng = MazeRng::seed_from_u64(seed);
        let indices = distribute_stops(0, 9, 4, 0, 2, None, &mut rng)
            .expect("a valid placement always exists for this span/stop_count/skip combo");
        assert_eq!(indices.len(), 4);
        assert_eq!(indices[0], 0, "first stop is always the base index");
        assert_eq!(
            *indices.last().unwrap(),
            9,
            "last stop always lands exactly on the end index"
        );
        for pair in indices.windows(2) {
            let step = pair[1] - pair[0];
            assert!(
                (1..=3).contains(&step),
                "seed {seed}: step {step} outside the skip-derived 1..=3 range"
            );
        }
    }
}

#[test]
fn distribute_stops_returns_none_when_the_span_is_geometrically_unreachable() {
    // step fixed at exactly 1 (skip 0..=0), but a span of 5 can't be split into 2 gaps of 1 each.
    let mut rng = MazeRng::seed_from_u64(1);
    assert_eq!(distribute_stops(0, 5, 3, 0, 0, None, &mut rng), None);
}

#[test]
fn reserve_percent_zero_builds_exactly_the_missing_count() {
    let mut maze = multi_floor_maze(10, 4);
    let issue = missing_issue(2);
    let params = params_with(&[
        ("reserve_percent", "0"),
        ("length_interval", "2,2"),
        ("stop_count", "2,2"),
    ]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(
        &AddElevatorStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups.len(),
        2,
        "reserve_percent=0 must build exactly the 2 missing elevators, not more"
    );
}
