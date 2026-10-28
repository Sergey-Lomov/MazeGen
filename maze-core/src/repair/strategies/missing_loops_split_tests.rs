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
    build_params(<MissingLoopsSplitStrategy as RepairStrategy<SquareTessellation, MissingLoopsIssue>>::params(&strategy_unconstrained()), None)
}

fn strategy_unconstrained() -> MissingLoopsSplitStrategy {
    MissingLoopsSplitStrategy {
        config: SplitGenerationConfig {
            pattern_mode: false,
            max_split_nodes: 2,
            patterns: vec![],
        },
    }
}

fn maze_grid(side: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field =
        MultiLevelField::single_level(Arc::default(), square_rect(side, side), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    Maze::new(field, g)
}

fn missing_issue(missing: u32) -> MissingLoopsIssue {
    let entries = if missing == 0 {
        vec![]
    } else {
        vec![(RepairArea::WholeMaze, missing)]
    };
    MissingLoopsIssue::new_from_check("min_loops_count", entries)
}

#[test]
fn apply_succeeds_immediately_when_nothing_missing() {
    let mut maze = maze_grid(3);
    let issue = missing_issue(0);
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
    assert_eq!(maze.field.node_count(), nodes_before);
}

#[test]
fn apply_creates_a_split_tile_carrying_the_new_bridge() {
    let mut maze = maze_grid(4);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(3);
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(
        crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
        "0".to_string(),
    );
    let params =
        build_params(
            <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&strategy_unconstrained()),
            Some(&overrides),
        );
    let nodes_before = maze.field.node_count();
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(
        maze.field.node_count(),
        nodes_before + 1,
        "one split tile must be minted for the one missing loop"
    );
}

#[test]
fn split_tile_bridge_node_has_at_least_two_edges() {
    // Every point starts fully isolated on a 4x4 grid, so the bridge-carrying node's second
    // edge must come from `pick_free_neighbor` (no pre-existing connections to redistribute).
    let mut maze = maze_grid(4);
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(11);
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(
        crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
        "0".to_string(),
    );
    let params =
        build_params(
            <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&strategy_unconstrained()),
            Some(&overrides),
        );
    apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );

    let split_point = (0..4)
        .flat_map(|x| (0..4).map(move |y| SquarePoint { x, y }))
        .find(|&p| maze.field.nodes_at(maze.field.single_level_id(), p).len() > 1)
        .expect("exactly one point must have been split");
    let tile_nodes = maze
        .field
        .nodes_at(maze.field.single_level_id(), split_point);
    let bridge_node = tile_nodes
        .iter()
        .find(|&&n| {
            maze.graph
                .outgoing_neighbors(n)
                .chain(maze.graph.incoming_neighbors(n))
                .any(|nb| maze.field.cell_of(nb) != Some(split_point))
        })
        .expect("one node must carry the outside bridge");
    let degree = maze
        .graph
        .outgoing_neighbors(*bridge_node)
        .chain(maze.graph.incoming_neighbors(*bridge_node))
        .count();
    assert!(
        degree >= 2,
        "bridge-carrying node must not be a dead end, got degree {degree}"
    );
}

#[test]
fn apply_never_targets_a_point_already_split_earlier_in_the_same_call() {
    // Dense 3x3 grid, several missing loops in one call: a candidate's `dst` must never be a
    // point that an earlier command in this same batch already turned into a split tile —
    // that node id would no longer exist by apply time (`ReplacePointNodes` is all-or-nothing
    // on stale edge targets), silently dropping the whole command instead of minting a tile.
    let mut maze = maze_grid(3);
    let issue = missing_issue(4);
    let mut rng = MazeRng::seed_from_u64(17);
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(
        crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
        "0".to_string(),
    );
    let params =
        build_params(
            <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&strategy_unconstrained()),
            Some(&overrides),
        );
    let nodes_before = maze.field.node_count();

    let (result, commands) = strategy_unconstrained().apply(
        &issue,
        &maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    crate::quality_control::apply_commands::apply_commands(
        &mut maze,
        &PresetState::empty(),
        commands.clone(),
        None,
        None,
    );

    let proposed = commands.len();
    let actually_split = maze.field.node_count() - nodes_before;
    assert_eq!(
        actually_split, proposed,
        "every proposed split must actually apply — none silently dropped for targeting an already-split neighbor"
    );
}

#[test]
fn src_mode_dead_end_priority_only_splits_a_dead_end() {
    // 4x4 grid with a single bidirectional passage between two nodes (both dead ends, degree
    // 1) — every other point is fully isolated (degree 0, not a dead end). With
    // `dead_end_priority`, the split candidate (`at`) must always be one of the two passage
    // endpoints.
    let mut maze = maze_grid(4);
    let coords: Vec<SquarePoint> = (0..4)
        .flat_map(|x| (0..4).map(move |y| SquarePoint { x, y }))
        .collect();
    let nodes: Vec<NodeId> = coords
        .iter()
        .map(|&p| maze.field.node_at(maze.field.single_level_id(), p).unwrap())
        .collect();
    maze.graph
        .add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let dead_end_points = [coords[0], coords[1]];

    let issue = missing_issue(1);
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(
        crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
        "0".to_string(),
    );
    overrides.insert("src_mode".to_string(), "dead_end_priority".to_string());
    let params =
        build_params(
            <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&strategy_unconstrained()),
            Some(&overrides),
        );
    let mut rng = MazeRng::seed_from_u64(2);
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let split_point = coords
        .iter()
        .copied()
        .find(|&p| maze.field.nodes_at(maze.field.single_level_id(), p).len() > 1)
        .expect("exactly one point must have been split");
    assert!(
        dead_end_points.contains(&split_point),
        "split must land on one of the two dead-end points, got {split_point:?}"
    );
}

#[test]
fn apply_creates_a_split_tile_matching_the_configured_pattern() {
    // Regression coverage for the pattern-mode `allow_lose`/`allow_add` bug fixed earlier in
    // this strategy's development: `plan_split` must actually pass `true, true` through to
    // `plan_pattern_split`, not silently read unregistered params as `None`/`false` and reject
    // every candidate outright.
    use crate::generation::{SplitFaceRequirement, SplitPattern, SplitPatternFace};
    let pattern = SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 2,
        faces: vec![
            vec![],
            vec![
                SplitPatternFace {
                    face_index: 0,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                },
                SplitPatternFace {
                    face_index: 1,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                },
            ],
        ],
        weight: 1.0,
    };
    let strategy = MissingLoopsSplitStrategy {
        config: SplitGenerationConfig {
            pattern_mode: true,
            max_split_nodes: 2,
            patterns: vec![pattern],
        },
    };
    let mut maze = maze_grid(4);
    let issue = missing_issue(1);
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(
        crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
        "0".to_string(),
    );
    let params =
        build_params(
            <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&strategy),
            Some(&overrides),
        );
    let mut rng = MazeRng::seed_from_u64(5);
    let nodes_before = maze.field.node_count();
    let result = apply_and_commit(
        &strategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(
        maze.field.node_count(),
        nodes_before + 1,
        "pattern mode must actually mint the split tile, not fail every candidate"
    );
}

#[test]
fn apply_fails_when_no_split_eligible_candidate_exists() {
    let mut maze = maze_grid(1);
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
    let field_a = crate::space::Field::new(Arc::default(), square_rect(4, 4), &mut ids).unwrap();
    let field_b = crate::space::Field::new(Arc::default(), square_rect(4, 4), &mut ids).unwrap();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), [field_a]);
    let level_b = mf.add_level(field_b);
    let mut g = Graph::new();
    for node in mf.all_node_ids() {
        g.add_node(node);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);
    let nodes_before = maze.field.node_count();

    let issue =
        MissingLoopsIssue::new_from_check("min_loops_count", vec![(RepairArea::Level(level_b), 1)]);
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(
        crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
        "0".to_string(),
    );
    let params =
        build_params(
            <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&strategy_unconstrained()),
            Some(&overrides),
        );
    let mut rng = MazeRng::seed_from_u64(11);
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.field.node_count(), nodes_before + 1);
    let split_points: std::collections::HashSet<_> = maze.field.split_cells().collect();
    assert_eq!(split_points.len(), 1);
    assert_eq!(
        split_points.iter().next().unwrap().0,
        level_b,
        "the split tile must land on the reported level"
    );
}

#[test]
fn apply_does_not_double_count_a_whole_maze_entry_already_satisfied_by_per_floor_entries() {
    // GitHub issue #369 follow-up: a per-floor deficit and a whole-maze deficit on the same
    // rule both land in one issue's `missing` — the whole-maze entry is the same requirement
    // measured differently, not independent on top. 1 per floor on 3 floors + 3 whole-maze
    // must add 3 split tiles total, not 6.
    let mut ids = IdGenerator::new();
    let field_a = crate::space::Field::new(Arc::default(), square_rect(4, 4), &mut ids).unwrap();
    let field_b = crate::space::Field::new(Arc::default(), square_rect(4, 4), &mut ids).unwrap();
    let field_c = crate::space::Field::new(Arc::default(), square_rect(4, 4), &mut ids).unwrap();
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

    let issue = MissingLoopsIssue::new_from_check(
        "min_loops_count",
        vec![
            (RepairArea::Level(level_a), 1),
            (RepairArea::Level(level_b), 1),
            (RepairArea::Level(level_c), 1),
            (RepairArea::WholeMaze, 3),
        ],
    );
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(
        crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
        "0".to_string(),
    );
    let params =
        build_params(
            <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&strategy_unconstrained()),
            Some(&overrides),
        );
    let mut rng = MazeRng::seed_from_u64(11);
    let result = apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(
        maze.field.node_count(),
        nodes_before + 3,
        "3 split tiles total, not 6"
    );
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let issue = missing_issue(1);
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(
        crate::repair::strategies::standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
        "0".to_string(),
    );
    let params =
        build_params(
            <MissingLoopsSplitStrategy as RepairStrategy<
                SquareTessellation,
                MissingLoopsIssue,
            >>::params(&strategy_unconstrained()),
            Some(&overrides),
        );

    let mut maze_a = maze_grid(4);
    let mut rng_a = MazeRng::seed_from_u64(123);
    apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze_a,
        &mut rng_a,
        &params,
        &PresetState::empty(),
        &[],
    );

    let mut maze_b = maze_grid(4);
    let mut rng_b = MazeRng::seed_from_u64(123);
    apply_and_commit(
        &strategy_unconstrained(),
        &issue,
        &mut maze_b,
        &mut rng_b,
        &params,
        &PresetState::empty(),
        &[],
    );

    assert_eq!(maze_a.field.node_count(), maze_b.field.node_count());
}
