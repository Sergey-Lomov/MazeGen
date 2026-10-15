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

fn missing_issue(missing: Vec<(RepairArea, u32)>) -> AreaMissingElevatorStopsIssue {
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
    let issue = missing_issue(vec![]);
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
fn reuse_branch_adds_a_stop_to_an_existing_elevator_on_the_target_floor() {
    let (mut maze, levels) = maze_with_one_elevator_spanning_first_three_floors(4, 3);
    // Force the reuse branch every time (balance=1 -> roll always < 1 picks reuse first).
    let params = params_with(&[("existing_reuse_balance", "1")]);
    let issue = missing_issue(vec![(RepairArea::Level(levels[3]), 1)]);
    let mut rng = MazeRng::seed_from_u64(3);
    let edges_before = maze.graph.edges().count();
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
    // A new stop wired to the 3 existing stops -> 3 new unordered pairs -> 6 directed edges.
    assert_eq!(maze.graph.edges().count(), edges_before + 6);
    let groups = elevator_groups(&maze);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].stops.len(), 4);
    let stop_on_floor_3 = maze
        .field
        .node_at(levels[3], SquarePoint { x: 0, y: 0 })
        .unwrap();
    assert!(groups[0].stops.contains(&stop_on_floor_3));
}

#[test]
fn add_new_branch_delegates_to_the_nested_strategy() {
    let (mut maze, levels) = multi_floor_maze(6, 3);
    // Force the add-new branch every time (balance=0 -> roll never < 0).
    let params = params_with(&[("existing_reuse_balance", "0")]);
    let issue = missing_issue(vec![(RepairArea::WholeMaze, 1)]);
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
    let issue = missing_issue(vec![(RepairArea::WholeMaze, 1)]);
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
    let issue = missing_issue(vec![(RepairArea::WholeMaze, 1)]);
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
    let issue = missing_issue(vec![(RepairArea::WholeMaze, 1)]);
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
fn add_new_branch_failure_falls_back_to_reuse() {
    // Lock out every node except the existing elevator's own column -- AddElevatorStrategy can
    // never place a brand-new elevator (every candidate start is locked out), forcing fallback
    // to the reuse branch against the pre-seeded elevator, whose own stops stay usable (only
    // the *new-elevator* candidate pool reads locked_out; add_stop_command never checks it,
    // mirroring AddElevatorStrategy's own stops_feasible / preset-lock scope).
    let (mut maze, levels) = maze_with_one_elevator_spanning_first_three_floors(4, 3);
    let survivor_point = SquarePoint { x: 0, y: 0 };
    let mut preset_state = PresetState::empty();
    for level in maze.field.levels_ordered().collect::<Vec<_>>() {
        for node in maze
            .field
            .field_of(level)
            .unwrap()
            .all_points()
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

    let mut overrides = HashMap::new();
    overrides.insert("existing_reuse_balance".to_string(), "0".to_string());
    let params = build_params(
        <AddElevatorStopStrategy as RepairStrategy<
            SquareTessellation,
            AreaMissingElevatorStopsIssue,
        >>::params(&AddElevatorStopStrategy),
        Some(&overrides),
    );

    let nested = add_elevator_nested();

    let issue = missing_issue(vec![(RepairArea::Level(levels[3]), 1)]);
    let mut rng = MazeRng::seed_from_u64(2);
    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &preset_state,
        &nested,
    );
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "add-new fails (every start locked out) but must fall back to reuse"
    );
    assert!(
        maze.graph.edges().count() > edges_before,
        "reuse fallback must have added a stop"
    );
}

#[test]
fn allow_span_extension_true_permits_extending_the_span_outward() {
    // Elevator spans floors 0..2 (indices 0,1,2) of a 4-floor maze; floor index 3 is outside
    // the span but adjacent -- only reachable with allow_span_extension=true.
    let (mut maze, levels) = maze_with_one_elevator_spanning_first_three_floors(4, 3);
    let params = params_with(&[
        ("existing_reuse_balance", "0"),
        ("allow_span_extension", "true"),
    ]);
    let issue = missing_issue(vec![(RepairArea::Level(levels[3]), 1)]);
    let mut rng = MazeRng::seed_from_u64(4);
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "span extension must allow reaching floor 3"
    );
    let groups = elevator_groups(&maze);
    assert_eq!(groups[0].stops.len(), 4);
}

#[test]
fn allow_span_extension_false_forbids_extending_the_span_outward() {
    let (mut maze, levels) = maze_with_one_elevator_spanning_first_three_floors(4, 3);
    let params = params_with(&[
        ("existing_reuse_balance", "0"),
        ("allow_span_extension", "false"),
    ]);
    let issue = missing_issue(vec![(RepairArea::Level(levels[3]), 1)]);
    let mut rng = MazeRng::seed_from_u64(4);
    // No nested strategy configured -> add-new branch (the only fallback) fails too, so the
    // whole call must fail: reuse is blocked by allow_span_extension=false and there's nothing
    // else to try.
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "extending the span outward must be forbidden when allow_span_extension=false"
    );
    let groups = elevator_groups(&maze);
    assert_eq!(groups[0].stops.len(), 3, "no new stop must have been added");
}

#[test]
fn allow_span_extension_false_still_permits_filling_an_interior_gap() {
    // Elevator stops at floor indices 0 and 2 (skipping 1) of a 4-floor maze -- floor 1 is a
    // genuine interior gap, fillable regardless of allow_span_extension.
    let (mut maze, levels) = multi_floor_maze(4, 3);
    let a = maze
        .field
        .node_at(levels[0], SquarePoint { x: 0, y: 0 })
        .unwrap();
    let b = maze
        .field
        .node_at(levels[2], SquarePoint { x: 0, y: 0 })
        .unwrap();
    maze.graph.add_edge(a, b, EdgeKind::Elevator);
    maze.graph.add_edge(b, a, EdgeKind::Elevator);

    let params = params_with(&[
        ("existing_reuse_balance", "0"),
        ("allow_span_extension", "false"),
    ]);
    let issue = missing_issue(vec![(RepairArea::Level(levels[1]), 1)]);
    let mut rng = MazeRng::seed_from_u64(6);
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "an interior gap must always be fillable"
    );
    let groups = elevator_groups(&maze);
    assert_eq!(groups[0].stops.len(), 3);
}

#[test]
fn whole_maze_reuse_picks_a_floor_the_elevator_does_not_already_stop_at() {
    let (mut maze, levels) = maze_with_one_elevator_spanning_first_three_floors(5, 3);
    let params = params_with(&[("existing_reuse_balance", "0")]);
    let issue = missing_issue(vec![(RepairArea::WholeMaze, 1)]);
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
fn whole_maze_reuse_forbids_extending_the_span_outward_when_span_extension_is_disabled() {
    // Regression: WholeMaze-scoped reuse used to add a stop to any free floor on the picked
    // elevator, ignoring `allow_span_extension` entirely -- only the RepairArea::Level branch
    // (via candidate_elevators_for_level) respected the flag. A preset elevator spanning floors
    // 0 and 4 (indices) of a 6-floor maze has floor 5 strictly outside its span (an extension),
    // floors 1..3 strictly inside (gap fills) -- with span extension forbidden and a WholeMaze
    // deficit of 4 (one per free floor), only the 3 interior gaps may be filled; floor 5 must be
    // left alone, forcing the 4th unit to fail reuse and fall back to add-new instead.
    let (mut maze, levels) = multi_floor_maze(6, 3);
    let stops: Vec<_> = [levels[0], levels[4]]
        .iter()
        .map(|&l| maze.field.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
        .collect();
    maze.graph.add_edge(stops[0], stops[1], EdgeKind::Elevator);
    maze.graph.add_edge(stops[1], stops[0], EdgeKind::Elevator);

    let params = params_with(&[
        ("existing_reuse_balance", "1"),
        ("allow_span_extension", "false"),
    ]);
    let issue = missing_issue(vec![(RepairArea::WholeMaze, 3)]);
    let mut rng = MazeRng::seed_from_u64(21);
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
    assert_eq!(
        groups.len(),
        1,
        "no nested add-new strategy configured -- only the preset elevator can gain stops"
    );
    let floors = stop_floors(&groups[0], &maze);
    assert_eq!(
        floors,
        vec![0, 1, 2, 3, 4],
        "must have filled exactly the 3 interior gaps, never floor 5 (an extension)"
    );
}

#[test]
fn level_scoped_reuse_forbids_extending_the_span_outward_when_span_extension_is_disabled() {
    // Same regression as the WholeMaze test, but RepairArea::Level-scoped (per-floor deficit) --
    // a preset elevator spans floors 0..4 (indices) of an 8-floor maze; floors 5,6,7 are strictly
    // outside its span (extensions), forbidden when allow_span_extension=false. Each of those
    // floors' own per-floor deficit must fail reuse against the preset elevator and fall back to
    // building a brand-new one instead of growing the preset elevator past its original span.
    let (mut maze, levels) = multi_floor_maze(8, 3);
    let stops: Vec<_> = [levels[0], levels[4]]
        .iter()
        .map(|&l| maze.field.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
        .collect();
    maze.graph.add_edge(stops[0], stops[1], EdgeKind::Elevator);
    maze.graph.add_edge(stops[1], stops[0], EdgeKind::Elevator);

    let params = params_with(&[
        ("existing_reuse_balance", "1"),
        ("allow_span_extension", "false"),
    ]);
    let issue = missing_issue(vec![
        (RepairArea::Level(levels[5]), 1),
        (RepairArea::Level(levels[6]), 1),
        (RepairArea::Level(levels[7]), 1),
    ]);
    let mut rng = MazeRng::seed_from_u64(3);
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
    let preset_group = groups.iter().find(|g| g.stops.contains(&stops[0])).unwrap();
    let preset_floors = stop_floors(preset_group, &maze);
    assert_eq!(
        preset_floors,
        vec![0, 4],
        "the preset elevator's span must stay exactly 0..4 -- span extension is forbidden"
    );
}

#[test]
fn per_floor_and_whole_maze_deficits_are_both_decremented_by_one_addition() {
    // Same requirement measured two ways (per-floor + whole-maze), same rationale
    // RemainingDeficits itself documents -- one addition on the named floor must satisfy both.
    let (mut maze, levels) = maze_with_one_elevator_spanning_first_three_floors(4, 3);
    let params = params_with(&[("existing_reuse_balance", "0")]);
    let issue = missing_issue(vec![
        (RepairArea::Level(levels[3]), 1),
        (RepairArea::WholeMaze, 1),
    ]);
    let mut rng = MazeRng::seed_from_u64(9);
    let edges_before = maze.graph.edges().count();
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
    // Only 1 stop should have been added in total (6 new directed edges), not 2 (one per
    // deficit entry) -- the whole-maze entry is the same requirement as the per-floor one.
    assert_eq!(maze.graph.edges().count(), edges_before + 6);
}

#[test]
fn add_new_branch_for_a_per_floor_deficit_always_lands_a_stop_on_the_requested_floor() {
    // The regression this guards: AddElevatorStrategy used to ignore which RepairArea it was
    // asked for and build a new elevator wherever it happened to fit, so a per-floor deficit's
    // add-new branch could keep missing the target floor forever, spawning elevator after
    // elevator without ever satisfying the deficit.
    // Deficit of 1 (not 2): distinct elevators are separate columns, so a per-floor deficit of N
    // can legitimately take N separate elevators, each contributing one stop on that floor -- the
    // regression this test guards against is a *single* add-new call missing the target floor
    // entirely (spawning elevator after elevator that never touches it), not the count of
    // elevators built overall. A deficit of 1 isolates that: exactly one elevator must be built,
    // and it must stop on the target floor.
    let params = params_with(&[("existing_reuse_balance", "0")]);
    let nested = add_elevator_nested();
    for seed in 0..20u64 {
        let (mut maze, levels) = multi_floor_maze(6, 3);
        let target_level = levels[2];
        let issue = missing_issue(vec![(RepairArea::Level(target_level), 1)]);
        let mut rng = MazeRng::seed_from_u64(seed);
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
            "seed {seed}: must succeed"
        );
        let groups = elevator_groups(&maze);
        assert_eq!(
            groups.len(),
            1,
            "seed {seed}: a per-floor deficit of 1 must be covered by exactly one elevator"
        );
        let floors = stop_floors(&groups[0], &maze);
        let target_idx = levels.iter().position(|&l| l == target_level).unwrap();
        assert!(
            floors.contains(&target_idx),
            "seed {seed}: the built elevator must stop on the requested floor"
        );
    }
}

#[test]
fn add_new_branch_delivering_several_stops_at_once_does_not_overshoot_the_deficit() {
    // AddElevatorStrategy's default stop_count range (min 2) can place several stops on one
    // brand-new elevator in a single call. Deficit only asks for 2 -- if the loop counted "one
    // branch call = one unit consumed" instead of "one stop = one unit consumed", it would keep
    // looping past a first elevator that already covered the whole deficit and build a second one.
    let (mut maze, _levels) = multi_floor_maze(8, 3);
    let params = params_with(&[("existing_reuse_balance", "1")]);
    let issue = missing_issue(vec![(RepairArea::WholeMaze, 2)]);
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
fn reuse_branch_grows_an_elevator_planned_earlier_in_the_same_call_instead_of_building_a_new_one() {
    // Regression: a per-floor deficit of 2 on every floor of an empty maze, with reuse forced
    // first and span extension allowed, should settle on exactly 2 elevators, each fanning out to
    // every floor -- the first elevator gets built (nothing to reuse yet), then every subsequent
    // deficit unit should grow either that elevator or a second one, never spin up a third+.
    // Before this fix, the reuse branch only ever looked at `elevator_groups(maze)`, which never
    // reflects commands queued earlier in this same `apply()` call (the MutationCommand contract:
    // `maze` is an immutable pre-mutation snapshot) -- so reuse kept reporting "nothing to reuse"
    // and every deficit unit fell back to building a brand-new elevator.
    let (mut maze, levels) = multi_floor_maze(3, 3);
    let params = params_with(&[
        ("existing_reuse_balance", "1"),
        ("allow_span_extension", "true"),
    ]);
    let issue = missing_issue(vec![
        (RepairArea::Level(levels[0]), 2),
        (RepairArea::Level(levels[1]), 2),
        (RepairArea::Level(levels[2]), 2),
    ]);
    let mut rng = MazeRng::seed_from_u64(7);
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
        "a per-floor deficit of 2 on every floor must settle on 2 elevators, not spin up a new one per unit"
    );
    for g in &groups {
        assert_eq!(
            stop_floors(g, &maze).len(),
            3,
            "each elevator must stop on every floor"
        );
    }
}

#[test]
fn reuse_branch_grows_both_preset_elevators_across_every_interior_floor() {
    // Two preset elevators already span floor 0..7 (8 floors), at distinct columns. Every floor
    // needs 2 stops -- floors 0 and 7 already have 1 each (from the presets), floors 1..6 have
    // none. With reuse forced first and span extension allowed, every deficit unit should be a
    // gap-fill on one of the two existing elevators (every interior floor is strictly inside both
    // elevators' spans) -- no third+ elevator should ever be needed.
    let (mut maze, levels) = multi_floor_maze(8, 3);
    let a_point = SquarePoint { x: 0, y: 0 };
    let b_point = SquarePoint { x: 1, y: 0 };
    let a_stops: Vec<_> = [levels[0], levels[7]]
        .iter()
        .map(|&l| maze.field.node_at(l, a_point).unwrap())
        .collect();
    let b_stops: Vec<_> = [levels[0], levels[7]]
        .iter()
        .map(|&l| maze.field.node_at(l, b_point).unwrap())
        .collect();
    for stops in [&a_stops, &b_stops] {
        for i in 0..stops.len() {
            for j in (i + 1)..stops.len() {
                maze.graph.add_edge(stops[i], stops[j], EdgeKind::Elevator);
                maze.graph.add_edge(stops[j], stops[i], EdgeKind::Elevator);
            }
        }
    }

    let params = params_with(&[
        ("existing_reuse_balance", "1"),
        ("allow_span_extension", "true"),
    ]);
    // Floors 0 and 7 already have 2 stops each (one from each preset elevator) -- deficit there
    // is 0, already satisfied (mirrors what `MinElevatorStopsPerAreaCountCheck` would actually
    // report: `min - existing`). Only the interior floors 1..6 need anything.
    let issue = missing_issue(
        levels
            .iter()
            .enumerate()
            .filter(|&(i, _)| i != 0 && i != 7)
            .map(|(_, &l)| (RepairArea::Level(l), 2))
            .collect(),
    );
    let mut rng = MazeRng::seed_from_u64(13);
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
        "every deficit unit is a gap-fill reachable by one of the 2 preset elevators -- no new elevator should be built"
    );
    for g in &groups {
        assert_eq!(
            stop_floors(g, &maze).len(),
            8,
            "each preset elevator must end up stopping on every floor"
        );
    }
}

#[test]
fn attempts_limit_is_a_per_area_budget_not_shared_across_areas() {
    // GitHub issue #486 regression: `attempts_limit` failed attempts used to be a running total
    // across the whole `apply()` call (a single `failed_attempts` declared before the `for area`
    // loop) -- an unfillable area at the front of `issue.missing` could exhaust the budget before
    // a perfectly fillable area later in the list ever got a chance. `failed_attempts` must reset
    // for every area.
    //
    // Preset elevator spans floors 1 and 5 (indices) of a 6-floor maze -- floor 3 is a genuine
    // interior gap (always fillable), floor 0 is strictly outside the span (an extension,
    // forbidden). `RemainingDeficits` processes areas in `LevelId` order (floors created in index
    // order), so floor 0 -- the unfillable one -- is processed *first*, before floor 3: exactly the
    // ordering that would starve a shared (not per-area) attempts budget. With span extension
    // forbidden and no nested add-new strategy configured, every attempt on floor 0 fails
    // deterministically (mirrors `allow_span_extension_false_forbids_extending_the_span_outward`).
    // With attempts_limit=1, floor 0's single guaranteed failure must not consume a budget that
    // floor 3's fillable deficit also needs.
    let (mut maze, levels) = multi_floor_maze(6, 3);
    let stops: Vec<_> = [levels[1], levels[5]]
        .iter()
        .map(|&l| maze.field.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
        .collect();
    maze.graph.add_edge(stops[0], stops[1], EdgeKind::Elevator);
    maze.graph.add_edge(stops[1], stops[0], EdgeKind::Elevator);

    let params = params_with(&[
        ("existing_reuse_balance", "1"),
        ("allow_span_extension", "false"),
        ("attempts_limit", "1"),
    ]);
    let issue = missing_issue(vec![
        (RepairArea::Level(levels[0]), 1),
        (RepairArea::Level(levels[3]), 1),
    ]);
    let mut rng = MazeRng::seed_from_u64(4);
    let result = apply_and_commit(
        &AddElevatorStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "floor 3's fillable deficit must not be starved by floor 0's exhausted budget"
    );
    let groups = elevator_groups(&maze);
    let floors = stop_floors(&groups[0], &maze);
    assert!(
        floors.contains(&3),
        "floor 3 (a genuine interior gap) must have gained a stop"
    );
    assert!(
        !floors.contains(&0),
        "floor 0 (an out-of-span extension) must never gain a stop with allow_span_extension=false"
    );
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let issue = missing_issue(vec![(RepairArea::WholeMaze, 2)]);

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
