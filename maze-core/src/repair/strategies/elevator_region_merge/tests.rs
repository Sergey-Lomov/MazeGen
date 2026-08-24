use super::*;
use std::collections::HashMap as StdHashMap;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::{Graph, EdgeKind as EK};
use crate::IdGenerator;
use crate::space::{SquareTessellation, square_rect, MultiLevelField};
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit;

fn params_with(mode: &str, use_existing: PriorityLevel) -> StrategyParams {
    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_TARGET_MODE.to_string(), mode.to_string());
    overrides.insert(PARAM_USE_EXISTING_ELEVATORS.to_string(), use_existing.as_str().to_string());
    build_params(
        <ElevatorRegionMergeStrategy as RepairStrategy<SquareTessellation, RegionNeedsExpansionIssue>>::params(&ElevatorRegionMergeStrategy),
        Some(&overrides),
    )
}

fn default_params() -> StrategyParams {
    build_params(
        <ElevatorRegionMergeStrategy as RepairStrategy<SquareTessellation, RegionNeedsExpansionIssue>>::params(&ElevatorRegionMergeStrategy),
        None,
    )
}

fn build_multi_level(w: usize, h: usize, levels: usize) -> (Maze<SquareTessellation>, Vec<Vec<NodeId>>) {
    let mut ids = IdGenerator::new();
    let fields: Vec<_> = (0..levels).map(|_| crate::space::Field::new(square_rect(w, h), &mut ids).unwrap()).collect();
    let field = MultiLevelField::<SquareTessellation>::new(fields);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let level_ids: Vec<_> = field.levels_ordered().collect();
    let nodes_by_level: Vec<Vec<NodeId>> = level_ids.iter()
        .map(|&lvl| field.field_of(lvl).unwrap().all_points().map(|p| field.node_at(lvl, p).unwrap()).collect())
        .collect();
    (Maze::new(field, g), nodes_by_level)
}

fn maze_three_floors() -> (Maze<SquareTessellation>, Vec<Vec<NodeId>>) {
    build_multi_level(1, 1, 3)
}

fn issue_for(invalid: Vec<usize>) -> RegionNeedsExpansionIssue {
    RegionNeedsExpansionIssue::new_from_check("test", invalid, StdHashMap::new())
}

#[test]
fn apply_fixed_immediately_when_invalid_is_empty() {
    let (mut maze, _) = maze_three_floors();
    let issue = issue_for(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), edges_before);
}

#[test]
fn apply_fails_when_field_is_single_level() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::<SquareTessellation>::single_level(square_rect(1, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    let region_idx = maze.analysis.scc(&maze.graph).components.len() - 1;
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_builds_a_new_elevator_spanning_exactly_two_floors() {
    let (mut maze, nodes) = maze_three_floors();
    let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0][0]).unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Forbidden), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edges().all(|e| e.kind == EK::Elevator));

    let elevators = elevator_groups(&maze);
    assert_eq!(elevators.len(), 1);
    let floors: std::collections::HashSet<usize> = elevators[0].stops.iter()
        .map(|&n| maze.field.level_index_of(n).unwrap())
        .collect();
    assert_eq!(floors.len(), 2, "a brand new elevator must span exactly 2 floors");
}

#[test]
fn use_existing_forbidden_never_adds_a_stop_to_the_pre_existing_elevator() {
    // 2x1 field, 3 floors, each column pre-merged within its own floor so the region under
    // test spans both points. `forbidden` must never call `add_stop_command_checked` against
    // the pre-existing elevator -- it always builds a brand-new 2-stop elevator, even if that
    // new elevator happens to share a column (and thus, once grouped, a stop) with the old one.
    let (mut maze, nodes) = build_multi_level(2, 1, 3);
    for level in [0usize, 1, 2] {
        maze.graph.add_bidirectional_edge(nodes[level][0], nodes[level][1], EK::Basic);
    }
    // Pre-existing elevator spanning floors 0 and 2 at column 0.
    maze.graph.add_bidirectional_edge(nodes[0][0], nodes[2][0], EK::Elevator);
    let old_stop_count_at = |maze: &Maze<SquareTessellation>, a: NodeId, b: NodeId| {
        (maze.graph.edge_between(a, b).is_some(), maze.graph.edge_between(b, a).is_some())
    };
    assert_eq!(old_stop_count_at(&maze, nodes[0][0], nodes[2][0]), (true, true));

    let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[1][0]).unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(2);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Forbidden), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // Old pair (floor0-floor2, column 0) stays exactly as it was -- untouched by any added stop.
    assert_eq!(old_stop_count_at(&maze, nodes[0][0], nodes[2][0]), (true, true));
    // Exactly one new elevator edge pair was added, connecting the region to some other floor.
    let new_elevator_edges: Vec<_> = maze.graph.edges()
        .filter(|e| e.kind == EK::Elevator && !((e.from == nodes[0][0] && e.to == nodes[2][0]) || (e.from == nodes[2][0] && e.to == nodes[0][0])))
        .collect();
    assert_eq!(new_elevator_edges.len(), 2, "exactly one new bidirectional elevator pair expected");
    assert!(new_elevator_edges.iter().any(|e| e.from == nodes[1][0] || e.from == nodes[1][1] || e.to == nodes[1][0] || e.to == nodes[1][1]));
}

#[test]
fn use_existing_required_adds_a_stop_to_the_pre_existing_elevator() {
    let (mut maze, nodes) = maze_three_floors();
    // Elevator already reaches the region's floor (1) and the target floor (2) via a
    // different column would be needed for a real ambiguous case, but with a 1x1 field the
    // only point is shared -- so pre-build an elevator between floor 0 and floor 2 (which
    // does NOT include the region's own node), then require the region (floor 1) to join it.
    maze.graph.add_bidirectional_edge(nodes[0][0], nodes[2][0], EK::Elevator);

    let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[1][0]).unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(3);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Required), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let elevators = elevator_groups(&maze);
    assert_eq!(elevators.len(), 1, "the region's node must join the single pre-existing elevator, not create a new one");
    assert_eq!(elevators[0].stops.len(), 3);
    assert!(elevators[0].stops.contains(&nodes[1][0]));
}

#[test]
fn use_existing_required_fails_when_no_elevator_reaches_any_shared_column() {
    let (mut maze, nodes) = maze_three_floors();
    let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0][0]).unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(4);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Required), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn apply_respects_preset_blocked_pair_when_building_new_elevator() {
    let (mut maze, nodes) = build_multi_level(1, 1, 2);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((nodes[0][0], nodes[1][0]));
    preset_state.blocked.insert((nodes[1][0], nodes[0][0]));

    let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0][0]).unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Forbidden), &preset_state, &[]);
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

/// GitHub issue #431 follow-up: candidate pools built from `HashMap`/`HashSet` iteration
/// (`discover_target_candidates`, `try_reuse_existing_elevator`'s elevator pool,
/// `try_build_new_elevator`'s point pool) must be sorted before the `rng`-driven pick/shuffle --
/// otherwise the same seed can pick a different candidate depending on incidental bucket layout
/// (observed in practice as debug-narration-on vs. off giving different results, since the extra
/// `build_scc` call narration does elsewhere perturbs unrelated `HashMap` layouts). This test
/// builds the same logical topology via two different node/elevator insertion orders (which
/// perturbs `NodeId`-keyed `HashMap`/`HashSet` bucket layout even within one process) and asserts
/// `apply()` still picks the same target point and branch for a fixed seed.
#[test]
fn apply_picks_the_same_candidate_regardless_of_insertion_order() {
    fn run(reverse_elevator_build: bool) -> Maze<SquareTessellation> {
        let (mut maze, nodes) = build_multi_level(2, 1, 3);
        for level in [0usize, 1, 2] {
            maze.graph.add_bidirectional_edge(nodes[level][0], nodes[level][1], EK::Basic);
        }
        if reverse_elevator_build {
            maze.graph.add_bidirectional_edge(nodes[2][0], nodes[0][0], EK::Elevator);
        } else {
            maze.graph.add_bidirectional_edge(nodes[0][0], nodes[2][0], EK::Elevator);
        }

        let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[1][0]).unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(2);
        apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Required), &PresetState::empty(), &[]);
        maze
    }

    let maze_a = run(false);
    let maze_b = run(true);

    fn edge_points(maze: &Maze<SquareTessellation>) -> Vec<(usize, crate::space::SquarePoint, usize, crate::space::SquarePoint)> {
        let mut v: Vec<_> = maze.graph.edges()
            .map(|e| (
                maze.field.level_index_of(e.from).unwrap(), maze.field.point_of(e.from).unwrap(),
                maze.field.level_index_of(e.to).unwrap(), maze.field.point_of(e.to).unwrap(),
            ))
            .collect();
        v.sort_unstable_by_key(|&(fl, fp, tl, tp)| (fl, fp.x, fp.y, tl, tp.x, tp.y));
        v
    }

    assert_eq!(edge_points(&maze_a), edge_points(&maze_b));
}

/// GitHub issue #431 follow-up: `discover_target_candidates` must exclude a raw `scc` target
/// component that this call's own `planned` elevators have already merged with the region's own
/// side -- the frozen `scc` snapshot never reflects `planned`, so without the `PlannedUnion`
/// overlay a target that's really just the region's own side (reached via a `planned` pair queued
/// moments ago) would still look like fresh, unconnected territory.
#[test]
fn discover_target_candidates_excludes_a_target_merged_via_a_planned_pair() {
    let (maze, nodes) = build_multi_level(2, 1, 3);
    // 2 columns x 3 floors, nothing connected. Column 1's floor-1 node is the region under test;
    // its candidate targets (same column, other floors) are column 1's floor-0 and floor-2 nodes.
    // Without any `planned` pair, both are valid candidates. A `planned` pair bridging column 1's
    // floor-0 node to the region itself must make that floor-0 component indistinguishable from
    // the region's own side -- excluded from the candidate pool -- while floor-2 (a genuinely
    // different, still-unconnected component) remains offered.
    let scc = maze.analysis.scc(&maze.graph);
    let region = scc.components.iter().find(|c| c.contains(&nodes[1][1])).unwrap();
    let region_idx = scc.component_of(nodes[1][1]).unwrap();
    let floor0_idx = scc.component_of(nodes[0][1]).unwrap();
    let floor2_idx = scc.component_of(nodes[2][1]).unwrap();

    let mut union_before = PlannedUnion::new(&scc);
    let candidates_before = discover_target_candidates(region, union_before.find(region_idx), &scc, &mut union_before, &maze);
    assert!(candidates_before.contains_key(&floor0_idx), "column 1's floor-0 component must be a candidate before any planned union");
    assert!(candidates_before.contains_key(&floor2_idx), "column 1's floor-2 component must be a candidate before any planned union");

    let mut union_after = PlannedUnion::new(&scc);
    union_after.union(floor0_idx, region_idx);
    let region_root_after = union_after.find(region_idx);
    let candidates_after = discover_target_candidates(region, region_root_after, &scc, &mut union_after, &maze);
    assert!(!candidates_after.contains_key(&floor0_idx), "floor-0 component must be excluded once planned-unioned with the region's own side");
    assert!(candidates_after.contains_key(&floor2_idx), "floor-2 component (a genuinely different candidate) must still be offered");
}

/// GitHub issue #431 follow-up: `try_reuse_existing_elevator` must grow a reusable elevator at its
/// own fixed field point only -- never at some other point `target_points` merely also offers. A
/// pre-existing elevator's own point (column 0) must be among `target_points` for it to be reused
/// at all; the new stop then lands at that exact point, on the target floor.
#[test]
fn use_existing_grows_the_elevator_at_its_own_point_not_some_other_shared_point() {
    let (mut maze, nodes) = build_multi_level(2, 1, 3);
    // Column 0 and column 1 share a basic edge on every floor, so each floor's two columns are one
    // component -- floor 0 is the only candidate target, offering both columns as shared points.
    maze.graph.add_bidirectional_edge(nodes[0][0], nodes[0][1], EK::Basic);
    maze.graph.add_bidirectional_edge(nodes[1][0], nodes[1][1], EK::Basic);
    maze.graph.add_bidirectional_edge(nodes[2][0], nodes[2][1], EK::Basic);
    // Pre-existing elevator: floor 1 (column 0) <-> floor 2 (column 0). Its own point is column 0.
    maze.graph.add_bidirectional_edge(nodes[1][0], nodes[2][0], EK::Elevator);

    let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[1][0]).unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(6);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Required), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let elevators = elevator_groups(&maze);
    assert_eq!(elevators.len(), 1, "the pre-existing elevator must be grown, not duplicated by a new one");
    assert_eq!(elevators[0].stops.len(), 3, "the existing elevator must gain a 3rd stop on floor 0");
    assert!(elevators[0].stops.contains(&nodes[2][0]), "original floor-2 stop must remain untouched");
    assert!(elevators[0].stops.contains(&nodes[1][0]), "original region-side stop must remain untouched");
    assert!(elevators[0].stops.contains(&nodes[0][0]), "the new stop must land on floor 0 at the elevator's own point (column 0)");
    assert!(!elevators[0].stops.contains(&nodes[0][1]), "the new stop must not land on a different column than the elevator's own point");
}

/// `elevator_groups_with_planned`'s non-empty-`planned` branch (adjacency merge across committed
/// elevator stops + queued-this-call pairs, then DFS) -- the exact mechanism `try_reuse_existing_
/// elevator` relies on to see an elevator built moments ago in the same `apply()` call. Direct unit
/// test rather than going through `apply()`, so the merge behavior is pinned regardless of which
/// branch/RNG path `apply()` happens to take.
#[test]
fn elevator_groups_with_planned_merges_a_committed_elevator_with_a_same_call_planned_pair() {
    let (mut maze, nodes) = build_multi_level(1, 1, 3);
    // Committed elevator: floor 0 <-> floor 1.
    maze.graph.add_bidirectional_edge(nodes[0][0], nodes[1][0], EK::Elevator);
    // Planned (not yet committed) pair extending it to floor 2.
    let planned = vec![(nodes[1][0], nodes[2][0])];

    let groups = elevator_groups_with_planned(&maze, &planned);
    assert_eq!(groups.len(), 1, "the committed elevator and the planned pair must merge into a single group");
    let mut stops = groups[0].stops.clone();
    stops.sort_unstable();
    let mut expected = vec![nodes[0][0], nodes[1][0], nodes[2][0]];
    expected.sort_unstable();
    assert_eq!(stops, expected);
}

/// A planned pair connecting two nodes with no pre-existing elevator at all must still form its own
/// group -- `elevator_groups_with_planned` must not require a committed elevator to seed the merge.
#[test]
fn elevator_groups_with_planned_forms_a_group_from_a_planned_pair_alone() {
    let (maze, nodes) = build_multi_level(1, 1, 2);
    let planned = vec![(nodes[0][0], nodes[1][0])];

    let groups = elevator_groups_with_planned(&maze, &planned);
    assert_eq!(groups.len(), 1);
    let mut stops = groups[0].stops.clone();
    stops.sort_unstable();
    let mut expected = vec![nodes[0][0], nodes[1][0]];
    expected.sort_unstable();
    assert_eq!(stops, expected);
}

/// GitHub issue #431 follow-up: a preset-blocked pair must make `try_reuse_existing_elevator` skip
/// that elevator (via `add_stop_command_checked`'s `bidirectional_edge_feasible` check) rather than
/// silently adding a blocked edge -- with `Required` and no other elevator/point available, the
/// whole region must fail rather than growing the elevator through a blocked connection.
#[test]
fn use_existing_required_fails_when_the_only_reusable_elevator_is_preset_blocked() {
    let (mut maze, nodes) = maze_three_floors();
    // Pre-existing elevator: floor 0 <-> floor 2 (doesn't include the region's own floor-1 node).
    maze.graph.add_bidirectional_edge(nodes[0][0], nodes[2][0], EK::Elevator);

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((nodes[1][0], nodes[0][0]));
    preset_state.blocked.insert((nodes[0][0], nodes[1][0]));

    let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[1][0]).unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Required), &preset_state, &[]);
    assert!(matches!(result, RepairResult::Failed), "the blocked pair must not be silently added -- Required has no fallback branch to try instead");
    let elevators = elevator_groups(&maze);
    assert_eq!(elevators.len(), 1);
    assert_eq!(elevators[0].stops.len(), 2, "the pre-existing elevator must stay untouched");
}

/// GitHub issue #431 follow-up: `Preferred` tries the reuse branch first, but must fall back to
/// building a brand-new elevator when no reusable elevator exists -- unlike `Required`, which has
/// no fallback and simply fails in this same topology (see
/// `use_existing_required_fails_when_no_elevator_reaches_any_shared_column`).
#[test]
fn use_existing_preferred_falls_back_to_building_a_new_elevator_when_none_is_reusable() {
    let (mut maze, nodes) = maze_three_floors();
    let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[0][0]).unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(8);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Preferred), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let elevators = elevator_groups(&maze);
    assert_eq!(elevators.len(), 1, "must have built exactly one new elevator via the fallback branch");
    assert_eq!(elevators[0].stops.len(), 2);
}

/// GitHub issue #431 follow-up: `Discouraged` tries the new-elevator branch first, but must fall
/// back to reusing the pre-existing elevator when no free point remains to build a new one on --
/// here the only shared point (the 1x1 field's single column) is already fully connected by the
/// pre-existing elevator (floor 0 <-> floor 2), so `try_build_new_elevator` has nothing left to
/// offer and the region must be merged via the reuse branch instead.
#[test]
fn use_existing_discouraged_falls_back_to_reusing_the_pre_existing_elevator() {
    let (mut maze, nodes) = maze_three_floors();
    maze.graph.add_bidirectional_edge(nodes[0][0], nodes[2][0], EK::Elevator);

    let region_idx = maze.analysis.scc(&maze.graph).component_of(nodes[1][0]).unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(9);
    let result = apply_and_commit(&ElevatorRegionMergeStrategy, &issue, &mut maze, &mut rng, &params_with(MODE_RANDOM, PriorityLevel::Discouraged), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let elevators = elevator_groups(&maze);
    assert_eq!(elevators.len(), 1, "the region's node must join the pre-existing elevator via the fallback branch, not create a second one");
    assert_eq!(elevators[0].stops.len(), 3);
    assert!(elevators[0].stops.contains(&nodes[1][0]));
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let (mut maze_a, nodes_a) = maze_three_floors();
    let region_idx_a = maze_a.analysis.scc(&maze_a.graph).component_of(nodes_a[0][0]).unwrap();
    let issue_a = issue_for(vec![region_idx_a]);
    let mut rng_a = MazeRng::seed_from_u64(99);
    apply_and_commit(&ElevatorRegionMergeStrategy, &issue_a, &mut maze_a, &mut rng_a, &default_params(), &PresetState::empty(), &[]);

    let (mut maze_b, nodes_b) = maze_three_floors();
    let region_idx_b = maze_b.analysis.scc(&maze_b.graph).component_of(nodes_b[0][0]).unwrap();
    let issue_b = issue_for(vec![region_idx_b]);
    let mut rng_b = MazeRng::seed_from_u64(99);
    apply_and_commit(&ElevatorRegionMergeStrategy, &issue_b, &mut maze_b, &mut rng_b, &default_params(), &PresetState::empty(), &[]);

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_a, edges_b);
}
