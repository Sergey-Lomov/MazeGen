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

fn params_with(balanced_growth: Option<&str>, allow_incomplete: Option<&str>) -> StrategyParams {
    params_with_compactness(balanced_growth, allow_incomplete, None)
}

fn params_with_compactness(
    balanced_growth: Option<&str>,
    allow_incomplete: Option<&str>,
    max_compactness: Option<&str>,
) -> StrategyParams {
    let mut overrides = std::collections::HashMap::new();
    if let Some(v) = balanced_growth {
        overrides.insert(PARAM_BALANCED_GROWTH.to_string(), v.to_string());
    }
    if let Some(v) = allow_incomplete {
        overrides.insert(PARAM_ALLOW_INCOMPLETE.to_string(), v.to_string());
    }
    if let Some(v) = max_compactness {
        overrides.insert(PARAM_MAX_COMPACTNESS.to_string(), v.to_string());
    }
    build_params(
        <AddElevatorHeightStopStrategy as RepairStrategy<
            SquareTessellation,
            MissingElevatorHeightIssue,
        >>::params(&AddElevatorHeightStopStrategy),
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
fn duplicate_entries_for_the_same_elevator_are_folded_to_a_single_growth() {
    // Two checks (e.g. differently-configured `min_elevator_height` instances) can both flag
    // the same elevator into one merged issue without deduping (see
    // `MissingElevatorHeightIssue::merge`'s doc comment). Growing it twice would add 4 stops
    // instead of 2 -- must fold to the max min_height and grow exactly once.
    let (mut maze, nodes, _floors) = maze_with_elevator(11, &[3, 5]);
    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![
            (ElevatorNodes::new(nodes.clone()), 4),
            (ElevatorNodes::new(nodes), 6),
        ],
    );
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(None, None),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups[0].stops.len(),
        4,
        "grown once (2 new stops), not twice (4 new stops)"
    );
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
        vec![
            (ElevatorNodes::new(nodes.clone()), 10),
            (ElevatorNodes::new(nodes), 8),
        ],
    );
    let mut rng = MazeRng::seed_from_u64(8);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(None, Some("false")),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups[0].stops.len(),
        2,
        "no stops added -- interval [0,2] already covers the whole 3-floor field, can't reach width 8"
    );
}

#[test]
fn grows_both_ends_when_a_single_stop_could_never_close_the_gap() {
    // Stops at 4,6 of 9 floors (0..=8), min_height 6 -- unreachable via one endpoint move, and
    // (unlike a field sized exactly to the required span) there's slack on both sides, so this
    // isolates the "needs both ends" growth path from the separate "runs out of field" case.
    let (mut maze, nodes, _floors) = maze_with_elevator(9, &[4, 6]);
    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![(ElevatorNodes::new(nodes), 6)],
    );
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(None, None),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    let indices: Vec<usize> = groups[0]
        .stops
        .iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    let span = indices.iter().max().unwrap() - indices.iter().min().unwrap() + 1;
    // Matches `MinElevatorHeightCheck`'s own `top - bottom + 1` span definition -- this is
    // the exact quantity that must reach `min_height` for the check to stop re-firing.
    assert!(
        span >= 6,
        "min_height 6 requires an inclusive floor span of at least 6, got {span}"
    );
    assert!(
        indices.iter().min().unwrap() < &4,
        "must have grown below the original bottom stop at floor 4"
    );
    assert!(
        indices.iter().max().unwrap() > &6,
        "must have grown above the original top stop at floor 6"
    );
}

#[test]
fn stops_growing_once_interval_is_wide_enough() {
    let (mut maze, nodes, _floors) = maze_with_elevator(10, &[4, 5]);
    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![(ElevatorNodes::new(nodes), 4)],
    );
    let mut rng = MazeRng::seed_from_u64(2);
    apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(None, None),
        &PresetState::empty(),
        &[],
    );
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups[0].stops.len(),
        4,
        "needed_len = min_height-2 = 2; interval [4,5] already wide enough, then adds one below + one above"
    );
}

#[test]
fn allow_incomplete_off_skips_entry_that_cannot_reach_needed_width() {
    let (mut maze, nodes, _floors) = maze_with_elevator(3, &[0, 2]);
    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![(ElevatorNodes::new(nodes), 10)],
    );
    let mut rng = MazeRng::seed_from_u64(3);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(None, Some("false")),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn allow_incomplete_on_still_adds_available_endpoints_when_width_unreachable() {
    let (mut maze, nodes, _floors) = maze_with_elevator(3, &[0, 2]);
    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![(ElevatorNodes::new(nodes), 10)],
    );
    let mut rng = MazeRng::seed_from_u64(4);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(None, Some("true")),
        &PresetState::empty(),
        &[],
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "interval [0,2] already covers every floor -- no below/above floor remains to add"
    );
}

#[test]
fn allow_incomplete_off_still_commits_when_width_is_met_even_if_one_side_is_infeasible() {
    // Stops at 2,5 of 7 floors (0..=6), min_height 6 -- needed_len 4, already met by [2,5]. But
    // floor 6 (the only "above" candidate) already has a preset-blocking edge to the bottom
    // stop, so only the "below" stop (floor 1) can be added. `allow_incomplete` gates on the
    // grown interval's *width* only (already reached needed_len here) -- it says nothing about
    // how many edge stops end up placeable, so this is a full success with a 1-stop addition.
    let (mut maze, nodes, floors) = maze_with_elevator(7, &[2, 5]);
    let blocked_node = maze
        .field
        .node_at(floors[6], SquarePoint { x: 0, y: 0 })
        .unwrap();
    maze.graph.add_node(blocked_node);
    maze.graph
        .add_edge(nodes[0], blocked_node, EdgeKind::Elevator);
    maze.graph
        .add_edge(blocked_node, nodes[0], EdgeKind::Elevator);

    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![(ElevatorNodes::new(nodes), 6)],
    );
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(None, Some("false")),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups[0].stops.len(),
        4,
        "needed_len already met -- below stop (floor 1) added despite the above side being preset-blocked"
    );
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
    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![(ElevatorNodes::new(nodes), 5)],
    );
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(None, Some("false")),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    assert_eq!(
        groups[0].stops.len(),
        3,
        "one edge stop added above (floor 6); below pool had no room since bottom (floor 0) is already the field edge"
    );
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
    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![(ElevatorNodes::new(nodes), 4)],
    );
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with_compactness(None, None, Some("true")),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    let mut indices: Vec<usize> = groups[0]
        .stops
        .iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    indices.sort();
    assert_eq!(
        indices,
        vec![9, 10, 12],
        "below edge stop (9) lands directly adjacent to the grown window's lower bound (10); no new above stop since floor 12 (the window's upper neighbor) is already the original top stop"
    );
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
    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![(ElevatorNodes::new(nodes), 12)],
    );
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(Some("true"), None),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let groups = elevator_groups(&maze);
    let indices: Vec<usize> = groups[0]
        .stops
        .iter()
        .filter_map(|&n| maze.field.level_index_of(n))
        .collect();
    let below_reach = 7 - indices.iter().min().unwrap();
    let above_reach = indices.iter().max().unwrap() - 9;
    assert!(
        below_reach.abs_diff(above_reach) <= 1,
        "balanced growth must keep both sides within 1 floor of each other, got below={below_reach} above={above_reach}"
    );
}

#[test]
fn apply_skips_an_entry_whose_elevator_no_longer_exists() {
    let (mut maze, nodes, _floors) = maze_with_elevator(7, &[3, 5]);
    maze.graph
        .remove_edge(maze.graph.edge_between(nodes[0], nodes[1]).unwrap());
    maze.graph
        .remove_edge(maze.graph.edge_between(nodes[1], nodes[0]).unwrap());

    let issue = MissingElevatorHeightIssue::new_from_check(
        "min_elevator_height",
        vec![(ElevatorNodes::new(nodes), 6)],
    );
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(
        &AddElevatorHeightStopStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(None, None),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
}
