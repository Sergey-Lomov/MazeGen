use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind, Graph};
use crate::random::MazeRng;
use crate::repair::params::build_params;
use crate::repair::strategies::AddElevatorStrategy;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::collections::HashMap;
use std::sync::Arc;

fn no_params() -> StrategyParams {
    build_params(
        <AddElevatorStopStrategy as RepairStrategy<
            SquareTessellation,
            AreaMissingElevatorStopsIssue,
        >>::params(&AddElevatorStopStrategy),
        None,
    )
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    build_params(
        <AddElevatorStopStrategy as RepairStrategy<
            SquareTessellation,
            AreaMissingElevatorStopsIssue,
        >>::params(&AddElevatorStopStrategy),
        Some(&map),
    )
}

fn multi_floor_maze(
    floors: usize,
    side: usize,
) -> (Maze<SquareTessellation>, Vec<crate::space::LevelId>) {
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), std::iter::empty());
    let levels: Vec<_> = (0..floors)
        .map(|_| {
            mf.add_level(
                Field::<SquareTessellation>::new(Arc::default(), square_rect(side, side), &mut ids)
                    .unwrap(),
            )
        })
        .collect();
    let mut g = Graph::new();
    for node in mf.all_node_ids() {
        g.add_node(node);
    }
    (Maze::new(mf, g), levels)
}

fn add_elevator_nested<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(AddElevatorStrategy),
        param_overrides: HashMap::new(),
        nested: vec![],
    }]
}

fn missing_issue(missing: u32) -> AreaMissingElevatorStopsIssue {
    AreaMissingElevatorStopsIssue::new_from_check("min_elevator_stops_per_area_count", missing)
}

/// Wires a fully-connected 3-stop elevator at x=0 spanning floors 0..2 (of a `floors`-floor
/// maze), leaving every other column empty — a single reusable elevator with a well-defined span
/// for the reuse-branch tests.
fn maze_with_one_elevator_spanning_first_three_floors(
    floors: usize,
    side: usize,
) -> (Maze<SquareTessellation>, Vec<crate::space::LevelId>) {
    let (mut maze, levels) = multi_floor_maze(floors, side);
    let stops: Vec<_> = levels[..3.min(floors)]
        .iter()
        .map(|&l| maze.field.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
        .collect();
    for i in 0..stops.len() {
        for j in (i + 1)..stops.len() {
            maze.graph.add_edge(stops[i], stops[j], EdgeKind::Elevator);
            maze.graph.add_edge(stops[j], stops[i], EdgeKind::Elevator);
        }
    }
    (maze, levels)
}

#[test]
fn apply_succeeds_immediately_when_nothing_missing() {
    let (mut maze, _levels) = multi_floor_maze(4, 3);
    let issue = missing_issue(0);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
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
fn add_new_branch_delegates_to_the_nested_strategy() {
    let (mut maze, levels) = multi_floor_maze(6, 3);
    // Force the add-new branch every time (balance=0 -> roll never < 0).
    let params = params_with(&[("existing_reuse_balance", "0")]);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(5);
    let nested = add_elevator_nested();
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups.len(),
        1,
        "add-new branch must have built a brand-new elevator via the nested strategy"
    );
    let _ = levels;
}

#[test]
fn add_new_branch_injects_its_own_reserve_percent_into_the_nested_strategy() {
    // GitHub issue #486: AddElevatorStopStrategy suppresses reserve_percent/attempts_limit on its
    // nested add-elevator slot and resolves them itself (`standard_add_params::inherited_overrides`
    // -> `nested_dispatch::nested_params`), so its own `reserve_percent` must reach the nested
    // `AddElevatorStrategy` call -- not the nested strategy's own default (0).
    //
    // `try_add_new` always synthesizes a single-unit `missing: 1` issue per call; with
    // reserve_percent=100 on the *parent*, the nested strategy's own reserve_target computes
    // ceil(1 * 2.0) = 2, so a single add-new call must build 2 brand-new elevators, not 1.
    let (mut maze, _levels) = multi_floor_maze(10, 5);
    let params = params_with(&[("existing_reuse_balance", "0"), ("reserve_percent", "100")]);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(5);
    let nested = add_elevator_nested();
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups.len(),
        2,
        "the parent's reserve_percent=100 must reach the nested strategy, doubling the single synthetic deficit unit to 2 elevators"
    );
}

#[test]
fn a_stale_nested_reserve_percent_override_is_overridden_by_the_parent_value() {
    // Same mechanism as `priority_missing_loops`'s own stale-override regression test: a leftover
    // `reserve_percent` override on the nested config (no longer settable via the UI, since this
    // id is suppressed on a nested node) must not win over the parent's resolved value.
    let (mut maze, _levels) = multi_floor_maze(10, 5);
    // Parent's own reserve_percent stays at the unified default (0) -> nested must build exactly
    // 1 elevator, not 2, even though its own param_overrides still claims reserve_percent=100.
    let params = params_with(&[("existing_reuse_balance", "0")]);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(5);
    let stale = HashMap::from([("reserve_percent".to_string(), "100".to_string())]);
    let nested = vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(AddElevatorStrategy),
        param_overrides: stale,
        nested: vec![],
    }];
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups.len(),
        1,
        "stale nested reserve_percent must be stripped; parent's default 0% wins"
    );
}

#[test]
fn reuse_branch_failure_falls_back_to_add_new() {
    // No existing elevator to reuse -> the reuse branch must fail and fall back to add-new.
    let (mut maze, _levels) = multi_floor_maze(6, 3);
    let params = params_with(&[("existing_reuse_balance", "1")]);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(11);
    let nested = add_elevator_nested();
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &nested,
    );
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "reuse fails (no elevators exist) but must fall back to add-new"
    );
    assert_eq!(elevator_groups(&maze).len(), 1);
}

#[test]
fn whole_maze_reuse_picks_a_floor_the_elevator_does_not_already_stop_at() {
    let (mut maze, levels) = maze_with_one_elevator_spanning_first_three_floors(5, 3);
    let params = params_with(&[("existing_reuse_balance", "0")]);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(8);
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
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
    assert_eq!(
        groups[0].stops.len(),
        4,
        "exactly one new stop must have been added"
    );
    let stopped_floors: std::collections::HashSet<usize> =
        stop_floors(&groups[0], &maze).into_iter().collect();
    assert_eq!(
        stopped_floors.len(),
        4,
        "every stop must be on a distinct floor, including the newly added one"
    );
    let _ = levels;
}

#[test]
fn add_new_branch_delivering_several_stops_at_once_does_not_overshoot_the_deficit() {
    // AddElevatorStrategy's default stop_count range (min 2) can place several stops on one
    // brand-new elevator in a single call. Deficit only asks for 2 -- if the loop counted "one
    // branch call = one unit consumed" instead of "one stop = one unit consumed", it would keep
    // looping past a first elevator that already covered the whole deficit and build a second one.
    let (mut maze, _levels) = multi_floor_maze(8, 3);
    let params = params_with(&[("existing_reuse_balance", "1")]);
    let issue = missing_issue(2);
    let mut rng = MazeRng::seed_from_u64(42);
    let nested = add_elevator_nested();
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups.len(),
        1,
        "one elevator with >=2 stops already covers a deficit of 2 -- must not build a second one"
    );
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let issue = missing_issue(2);

    let (mut maze_a, _) = maze_with_one_elevator_spanning_first_three_floors(6, 3);
    let mut rng_a = MazeRng::seed_from_u64(123);
    let nested_a = add_elevator_nested();
    apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze_a,
        &mut rng_a,
        &no_params(),
        &PresetState::empty(),
        &nested_a,
    );

    let (mut maze_b, _) = maze_with_one_elevator_spanning_first_three_floors(6, 3);
    let mut rng_b = MazeRng::seed_from_u64(123);
    let nested_b = add_elevator_nested();
    apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze_b,
        &mut rng_b,
        &no_params(),
        &PresetState::empty(),
        &nested_b,
    );

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_a, edges_b);
}

#[test]
fn add_stop_command_with_planned_rejects_a_stop_already_wired_via_a_planned_pair() {
    // `maze.graph.edge_between` alone can't see an edge queued earlier in this same `apply()` call
    // (only real, committed edges) -- this is exactly what `planned` exists to catch. Without this
    // check, a stop that's already been wired to `elevator` via a not-yet-applied command could be
    // "added" again, producing a duplicate AddBidirectionalElevator pair.
    let (mut maze, levels) = multi_floor_maze(3, 3);
    let a = maze
        .field
        .node_at(levels[0], SquarePoint { x: 0, y: 0 })
        .unwrap();
    let b = maze
        .field
        .node_at(levels[1], SquarePoint { x: 0, y: 0 })
        .unwrap();
    maze.graph.add_edge(a, b, EdgeKind::Elevator);
    maze.graph.add_edge(b, a, EdgeKind::Elevator);

    let elevator = Elevator {
        stops: vec![a, b],
        edges: Vec::new(),
    };
    let target_level = levels[2];
    let new_stop = maze
        .field
        .node_at(target_level, SquarePoint { x: 0, y: 0 })
        .unwrap();

    // Not yet a real edge in `maze.graph` -- only planned, as if an earlier iteration of this same
    // `apply()` call already queued a command wiring `a` to `new_stop`.
    let planned = vec![(a, new_stop)];

    assert!(
        add_stop_command_with_planned(
            &maze,
            &planned,
            &elevator,
            target_level,
            &PresetState::empty()
        )
        .is_none(),
        "must reject a new_stop that already has a planned (not yet committed) edge to one of the elevator's stops"
    );
}
