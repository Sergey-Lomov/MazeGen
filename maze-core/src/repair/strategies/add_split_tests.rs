use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind, Graph};
use crate::random::MazeRng;
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::sync::Arc;

fn no_params() -> StrategyParams {
    build_params(
        <AddSplitStrategy as RepairStrategy<SquareTessellation, MissingSplitTilesIssue>>::params(
            &strategy_unconstrained(),
        ),
        None,
    )
}

fn maze_line(len: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(len, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    Maze::new(field, g)
}

fn maze_grid(width: usize, height: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(width, height), &mut ids)
            .unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    Maze::new(field, g)
}

fn missing_issue(missing: u32) -> MissingSplitTilesIssue {
    let entries = if missing == 0 {
        vec![]
    } else {
        vec![(RepairArea::WholeMaze, missing)]
    };
    MissingSplitTilesIssue::new_from_check("split_count", entries)
}

fn strategy_unconstrained() -> AddSplitStrategy {
    AddSplitStrategy {
        split_patterns: vec![],
        max_split_nodes: 2,
        pattern_weights: vec![],
        protect_route: true,
    }
}

#[test]
fn apply_succeeds_immediately_when_nothing_missing() {
    let mut maze = maze_line(3);
    let issue = missing_issue(0);
    let mut rng = MazeRng::seed_from_u64(1);
    let nodes_before = maze.field.node_count();
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.field.node_count(), nodes_before);
}

#[test]
fn apply_adds_split_tiles_in_unconstrained_mode() {
    let mut maze = maze_line(5);
    let issue = missing_issue(2);
    let mut rng = MazeRng::seed_from_u64(7);
    let nodes_before = maze.field.node_count();
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(
        maze.field.node_count(),
        nodes_before + 2,
        "2 split tiles must each mint exactly one new node (max_split_nodes=2)"
    );
}

#[test]
fn apply_mints_configured_sibling_count_per_tile() {
    let mut maze = maze_line(3);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(3);
    let strategy = AddSplitStrategy {
        split_patterns: vec![],
        max_split_nodes: 4,
        pattern_weights: vec![],
        protect_route: true,
    };
    let nodes_before = maze.field.node_count();
    let result = apply_and_commit(
        &strategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(
        maze.field.node_count(),
        nodes_before + 3,
        "max_split_nodes=4 must mint 3 new siblings for the one tile"
    );
}

/// Total real edges touching any node currently at `point` — used to check that
/// `plan_unconstrained_split`'s redistribution neither drops nor invents connections, only
/// reassigns them across the new node set (epic #246: slot-0 is on equal footing with every
/// other new node, so nothing about it is specifically preserved anymore — only the point's
/// total edge count is invariant).
fn edges_touching_point(maze: &Maze<SquareTessellation>, point: SquarePoint) -> usize {
    maze.field
        .nodes_at(maze.field.single_level_id(), point)
        .iter()
        .flat_map(|&n| {
            maze.graph
                .outgoing_neighbors(n)
                .chain(maze.graph.incoming_neighbors(n))
        })
        .count()
}

#[test]
fn apply_redistributes_every_existing_connection_without_losing_or_duplicating_it() {
    // Unconstrained mode: slot-0 is replaced along with any siblings, but the point's total
    // number of real connections must come out exactly the same as it went in — each one
    // lands on exactly one of the new nodes.
    let mut maze = maze_line(5);
    let nodes: Vec<NodeId> = (0..5)
        .map(|x| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y: 0 })
                .unwrap()
        })
        .collect();
    for w in nodes.windows(2) {
        maze.graph
            .add_bidirectional_edge(w[0], w[1], EdgeKind::Basic);
    }
    let points: Vec<SquarePoint> = (0..5).map(|x| SquarePoint { x, y: 0 }).collect();
    let edges_before: Vec<usize> = points
        .iter()
        .map(|&p| edges_touching_point(&maze, p))
        .collect();

    let issue = missing_issue(3);
    let mut rng = MazeRng::seed_from_u64(42);
    apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );

    for (i, &point) in points.iter().enumerate() {
        assert_eq!(
            edges_touching_point(&maze, point),
            edges_before[i],
            "point at x={i} must keep the same total edge count after redistribution, split or not"
        );
    }
}

/// 1x3 line with a start->finish route through all 3 nodes (mirrors
/// `route_protection::tests::maze_with_corridor_route`), needed for `protect_route` tests.
fn maze_line_with_route(len: usize) -> Maze<SquareTessellation> {
    let mut maze = maze_line(len);
    let nodes: Vec<NodeId> = (0..len as i32)
        .map(|x| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y: 0 })
                .unwrap()
        })
        .collect();
    for w in nodes.windows(2) {
        maze.graph
            .add_bidirectional_edge(w[0], w[1], EdgeKind::Basic);
    }
    maze.meta = crate::meta::MazeMeta {
        start: Some(nodes[0]),
        finish: Some(*nodes.last().unwrap()),
    };
    maze
}

#[test]
fn apply_refuses_a_route_node_as_a_split_candidate_by_default() {
    // Every node in a 1x3 line sits on the start->finish route — with protect_route defaulted
    // to true, there is no eligible candidate at all.
    let mut maze = maze_line_with_route(3);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "every candidate point sits on the route, protect_route defaults to true"
    );
}

#[test]
fn apply_splits_a_route_node_when_protect_route_is_disabled() {
    let mut maze = maze_line_with_route(3);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let strategy = AddSplitStrategy {
        split_patterns: vec![],
        max_split_nodes: 2,
        pattern_weights: vec![],
        protect_route: false,
    };
    let nodes_before = maze.field.node_count();
    let result = apply_and_commit(
        &strategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.field.node_count(), nodes_before + 1);
}

#[test]
fn apply_reports_failed_when_no_eligible_point_exists() {
    // A single-node field where the only point is locked — no eligible candidate at all.
    let mut maze = maze_line(1);
    let node = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 })
        .unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(node);
    preset_state.locked_in.insert(node);

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &preset_state,
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_restricts_candidates_to_the_named_level() {
    let mut ids = IdGenerator::new();
    let field_a = crate::space::Field::new(Arc::default(), square_rect(5, 1), &mut ids).unwrap();
    let field_b = crate::space::Field::new(Arc::default(), square_rect(5, 1), &mut ids).unwrap();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), [field_a]);
    let level_b = mf.add_level(field_b);
    let mut g = Graph::new();
    for node in mf.all_node_ids() {
        g.add_node(node);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
    let nodes_before = maze.field.node_count();

    let issue = MissingSplitTilesIssue::new_from_check(
        "split_count",
        vec![(RepairArea::Level(level_b), 2)],
    );
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.field.node_count(), nodes_before + 2);
    let split_points: std::collections::HashSet<_> = maze.field.split_cells().collect();
    assert_eq!(split_points.len(), 2);
    for (level, _) in split_points {
        assert_eq!(
            level, level_b,
            "every new split tile must be on the reported level"
        );
    }
}

#[test]
fn apply_does_not_double_count_a_whole_maze_entry_already_satisfied_by_per_floor_entries() {
    // GitHub issue #369 follow-up: a per-floor deficit ("3 per floor" on 3 floors) and a
    // whole-maze deficit on the same rule ("12 whole-maze") both land in one issue's
    // `missing` — the whole-maze entry is the same requirement measured differently, not an
    // independent 12 on top. Total added must be 12 (3+3+3, whole-maze already satisfied by
    // then), not 21.
    let mut ids = IdGenerator::new();
    let field_a = crate::space::Field::new(Arc::default(), square_rect(6, 6), &mut ids).unwrap();
    let field_b = crate::space::Field::new(Arc::default(), square_rect(6, 6), &mut ids).unwrap();
    let field_c = crate::space::Field::new(Arc::default(), square_rect(6, 6), &mut ids).unwrap();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), [field_a]);
    let level_b = mf.add_level(field_b);
    let level_c = mf.add_level(field_c);
    let level_a = mf.levels_ordered().next().unwrap();
    let mut g = Graph::new();
    for node in mf.all_node_ids() {
        g.add_node(node);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
    let nodes_before = maze.field.node_count();

    let issue = MissingSplitTilesIssue::new_from_check(
        "split_count",
        vec![
            (RepairArea::Level(level_a), 3),
            (RepairArea::Level(level_b), 3),
            (RepairArea::Level(level_c), 3),
            (RepairArea::WholeMaze, 12),
        ],
    );
    let mut rng = MazeRng::seed_from_u64(11);
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(
        maze.field.node_count(),
        nodes_before + 12,
        "12 split tiles total, not 21"
    );
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let issue = missing_issue(2);

    let mut maze_a = maze_line(5);
    let mut rng_a = MazeRng::seed_from_u64(123);
    apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze_a,
        &mut rng_a,
        &no_params(),
        &PresetState::empty(),
        &[],
    );

    let mut maze_b = maze_line(5);
    let mut rng_b = MazeRng::seed_from_u64(123);
    apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze_b,
        &mut rng_b,
        &no_params(),
        &PresetState::empty(),
        &[],
    );

    assert_eq!(maze_a.field.node_count(), maze_b.field.node_count());
}

#[path = "add_split/tests/add_split_pattern_tests.rs"]
mod add_split_pattern_tests;
