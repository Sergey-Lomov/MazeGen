use super::*;
use std::collections::HashMap;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::{Graph, EdgeKind};
use crate::{IdGenerator, NodeId};
use crate::space::{SquareTessellation, square_rect, MultiLevelField, SquarePoint};
use crate::repair::params::build_params;
use crate::repair::strategies::add_one_way_from_wall::AddOneWayFromWallStrategy;
use crate::repair::strategies::add_one_way_from_passage::AddOneWayFromPassageStrategy;
use crate::repair::strategies::test_utils::apply_and_commit;

fn no_params() -> StrategyParams {
    build_params(<AddOneWayBatchStrategy as RepairStrategy<SquareTessellation, MissingOneWaysIssue>>::params(&AddOneWayBatchStrategy), None)
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    build_params(<AddOneWayBatchStrategy as RepairStrategy<SquareTessellation, MissingOneWaysIssue>>::params(&AddOneWayBatchStrategy), Some(&map))
}

fn nested_with_wall_child<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(AddOneWayFromWallStrategy),
        param_overrides: HashMap::new(),
        nested: vec![],
    }]
}

fn nested_with_passage_child<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(AddOneWayFromPassageStrategy),
        param_overrides: HashMap::new(),
        nested: vec![],
    }]
}

fn maze_grid(side: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(side, side), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    Maze::new(field, g)
}

// Fully-connected grid: every neighbor pair has a bidirectional passage, so every node is a
// downgrade candidate for `AddOneWayFromPassageStrategy`.
fn maze_grid_connected(side: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(side, side), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    for y in 0..side as i32 {
        for x in 0..side as i32 {
            let here = field.node_at(field.single_level_id(), SquarePoint { x, y }).unwrap();
            if x + 1 < side as i32 {
                let right = field.node_at(field.single_level_id(), SquarePoint { x: x + 1, y }).unwrap();
                g.add_bidirectional_edge(here, right, EdgeKind::Basic);
            }
            if y + 1 < side as i32 {
                let up = field.node_at(field.single_level_id(), SquarePoint { x, y: y + 1 }).unwrap();
                g.add_bidirectional_edge(here, up, EdgeKind::Basic);
            }
        }
    }
    Maze::new(field, g)
}

fn missing_issue(missing: u32) -> MissingOneWaysIssue {
    let entries = if missing == 0 { vec![] } else { vec![(RepairArea::WholeMaze, missing)] };
    MissingOneWaysIssue::new_from_check("min_one_way_count", entries)
}

#[test]
fn apply_succeeds_immediately_when_nothing_missing() {
    let mut maze = maze_grid(3);
    let issue = missing_issue(0);
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_wall_child());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn apply_with_wall_child_adds_one_way_edges_between_walled_pairs() {
    let mut maze = maze_grid(4);
    let issue = missing_issue(2);
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_wall_child());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), 2);
    for edge in maze.graph.edges() {
        assert_eq!(edge.kind, EdgeKind::Basic);
        assert!(maze.graph.edge_between(edge.to, edge.from).is_none(), "each added edge must be one-way");
    }
}

#[test]
fn apply_with_passage_child_downgrades_passages_to_one_ways_on_a_grid() {
    let mut maze = maze_grid_connected(4);
    let edges_before = maze.graph.edges().count();
    let issue = missing_issue(2);
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_passage_child());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), edges_before - 2);
}

#[test]
fn apply_fails_when_no_nested_candidate_fills_the_slot() {
    let mut maze = maze_grid(4);
    let issue = missing_issue(2);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn apply_does_not_pick_an_already_connected_pair() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    g.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_wall_child());
    assert!(matches!(result, RepairResult::Failed), "only pair on the field is already connected");
    assert_eq!(maze.graph.edges().count(), 2);
}

#[test]
fn apply_restricts_candidates_to_the_named_level() {
    let mut ids = IdGenerator::new();
    let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
    let level_b = mf.add_level(field_b);
    let mut g = Graph::new();
    for node in mf.all_node_ids() { g.add_node(node); }
    let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);

    let issue = MissingOneWaysIssue::new_from_check("min_one_way_count", vec![(RepairArea::Level(level_b), 2)]);
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_wall_child());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edges().count() > 0);
    for edge in maze.graph.edges() {
        assert_eq!(maze.field.level_of(edge.from), Some(level_b));
        assert_eq!(maze.field.level_of(edge.to), Some(level_b));
    }
}

#[test]
fn apply_does_not_double_count_a_whole_maze_entry_already_satisfied_by_per_floor_entries() {
    // GitHub issue #369 follow-up: per-floor + whole-maze entries on the same rule must not
    // stack — 1 per floor on 3 floors + 3 whole-maze must add 3 edges total, not 6.
    let mut ids = IdGenerator::new();
    let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let field_c = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
    let level_b = mf.add_level(field_b);
    let level_c = mf.add_level(field_c);
    let level_a = mf.levels_ordered().next().unwrap();
    let mut g = Graph::new();
    for node in mf.all_node_ids() { g.add_node(node); }
    let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);

    let issue = MissingOneWaysIssue::new_from_check("min_one_way_count", vec![
        (RepairArea::Level(level_a), 1),
        (RepairArea::Level(level_b), 1),
        (RepairArea::Level(level_c), 1),
        (RepairArea::WholeMaze, 3),
    ]);
    let mut rng = MazeRng::seed_from_u64(11);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_wall_child());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), 3, "3 edges total, not 6");
}

#[test]
fn reserve_percent_override_increases_the_target() {
    let mut maze = maze_grid(4);
    let issue = missing_issue(2);
    let params = params_with(&[(standard_add_params::PARAM_RESERVE_PERCENT, "100")]);
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &nested_with_wall_child());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // 2 * (1 + 100%) = 4 one-way edges, vs 2 with the unified 0 default.
    assert_eq!(maze.graph.edges().count(), 4);
}

#[test]
fn attempts_limit_failure_on_one_area_does_not_abort_remaining_areas() {
    let mut ids = IdGenerator::new();
    // Level A: no passages -- every attempt on it fails immediately.
    let field_a = crate::space::Field::new(square_rect(2, 1), &mut ids).unwrap();
    let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
    let level_b = mf.add_level(field_b);
    let mut g = Graph::new();
    for node in mf.all_node_ids() { g.add_node(node); }
    for y in 0..4i32 {
        for x in 0..4i32 {
            let here = mf.node_at(level_b, SquarePoint { x, y }).unwrap();
            if x + 1 < 4 {
                let right = mf.node_at(level_b, SquarePoint { x: x + 1, y }).unwrap();
                g.add_bidirectional_edge(here, right, EdgeKind::Basic);
            }
            if y + 1 < 4 {
                let up = mf.node_at(level_b, SquarePoint { x, y: y + 1 }).unwrap();
                g.add_bidirectional_edge(here, up, EdgeKind::Basic);
            }
        }
    }
    let level_a = mf.levels_ordered().next().unwrap();
    let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
    let edges_before = maze.graph.edges().count();

    let issue = MissingOneWaysIssue::new_from_check("min_one_way_count", vec![
        (RepairArea::Level(level_a), 1),
        (RepairArea::Level(level_b), 1),
    ]);
    let params = params_with(&[(standard_add_params::PARAM_ATTEMPTS_LIMIT, "2")]);
    let mut rng = MazeRng::seed_from_u64(3);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &nested_with_passage_child());
    assert!(matches!(result, RepairResult::Fixed { score: None }), "level B must still succeed despite level A's failure");
    assert_eq!(maze.graph.edges().count(), edges_before - 1);
}

#[test]
fn src_mode_dead_end_priority_prefers_dead_end_sources() {
    // 4x4 grid, one existing bidirectional passage: its two endpoints are the only dead ends.
    let mut maze = maze_grid(4);
    let n = |x: i32, y: i32| maze.field.node_at(maze.field.single_level_id(), SquarePoint { x, y }).unwrap();
    let (d0, d1) = (n(0, 0), n(1, 0));
    maze.graph.add_bidirectional_edge(d0, d1, EdgeKind::Basic);
    let dead_ends = [d0, d1];

    let issue = missing_issue(1);
    let params = params_with(&[(crate::repair::strategies::dead_end_priority::PARAM_SRC_MODE, crate::repair::strategies::dead_end_priority::SRC_MODE_DEAD_END_PRIORITY)]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &nested_with_wall_child());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let new_edges: Vec<_> = maze.graph.edges()
        .filter(|e| !(dead_ends.contains(&e.from) && dead_ends.contains(&e.to)))
        .collect();
    assert!(!new_edges.is_empty());
    for e in &new_edges {
        assert!(dead_ends.contains(&e.from) || dead_ends.contains(&e.to), "new one-way must grow from a dead end");
    }
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let issue = missing_issue(2);

    let mut maze_a = maze_grid(4);
    let mut rng_a = MazeRng::seed_from_u64(123);
    apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &nested_with_wall_child());

    let mut maze_b = maze_grid(4);
    let mut rng_b = MazeRng::seed_from_u64(123);
    apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &nested_with_wall_child());

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_a, edges_b);
}

/// A given `src` pool candidate is drawn at most once (`Pool::take`), so the same direction can
/// never be proposed twice within one `apply()` call. With the wall child, both directions of a
/// pair are independently valid, so up to 2 edges may legitimately be added on a 2-node field --
/// what must never happen is the same direction added twice.
#[test]
fn apply_with_wall_child_never_duplicates_a_direction_on_a_two_node_field() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = missing_issue(2);
    let params = params_with(&[(standard_add_params::PARAM_RESERVE_PERCENT, "0")]);
    let mut rng = MazeRng::seed_from_u64(1);
    apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &nested_with_wall_child());
    let edges: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    let mut unique = edges.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(edges.len(), unique.len(), "no direction added twice");
    assert!(edges.len() <= 2, "at most 2 directions exist on a 2-node field");
}

/// Regression test for a bug found while unifying the two series into one: with the passage
/// child, two different pool `src` candidates that are each other's only neighbor could each
/// independently see the same original bidirectional passage (an immutable snapshot for the whole
/// `apply()` call) and each downgrade a *different* direction of it, fully severing the pair
/// instead of leaving one direction standing. `excluded_pairs` must prevent this: once one `src`
/// downgrades the pair, the other `src`'s attempt on the same pair must be rejected by the child,
/// not silently remove the remaining direction too.
#[test]
fn apply_with_passage_child_never_fully_severs_a_pair_via_two_different_src_attempts() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    // Target 2: the pool has exactly 2 candidates (n0, n1), both neighbors of each other --
    // without excluded_pairs both would successfully downgrade the same passage.
    let issue = missing_issue(2);
    let params = params_with(&[(standard_add_params::PARAM_RESERVE_PERCENT, "0")]);
    let mut rng = MazeRng::seed_from_u64(1);
    apply_and_commit(&AddOneWayBatchStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &nested_with_passage_child());
    assert_eq!(maze.graph.edges().count(), 1, "the pair must end up a one-way, never fully disconnected");
}
