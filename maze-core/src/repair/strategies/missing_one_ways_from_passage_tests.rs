use super::*;
use crate::IdGenerator;
use crate::graph::Graph;
use crate::meta::MazeMeta;
use crate::random::MazeRng;
use crate::repair::strategies::test_utils::{apply_and_commit, apply_and_commit_default};
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::sync::Arc;

fn missing_issue(missing: u32) -> MissingOneWaysIssue {
    MissingOneWaysIssue::new_from_check("min_one_way_count", missing)
}

fn maze_grid(side: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field =
        MultiLevelField::single_level(Arc::default(), square_rect(side, side), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    for y in 0..side as i32 {
        for x in 0..side as i32 {
            let here = field.node_at(field_level, SquarePoint { x, y }).unwrap();
            if x + 1 < side as i32 {
                let right = field
                    .node_at(field_level, SquarePoint { x: x + 1, y })
                    .unwrap();
                g.add_bidirectional_edge(here, right, EdgeKind::Basic);
            }
            if y + 1 < side as i32 {
                let up = field
                    .node_at(field_level, SquarePoint { x, y: y + 1 })
                    .unwrap();
                g.add_bidirectional_edge(here, up, EdgeKind::Basic);
            }
        }
    }
    Maze::new(field, g)
}

#[test]
fn apply_succeeds_immediately_when_nothing_missing() {
    let mut maze = maze_grid(3);
    let issue = missing_issue(0);
    let mut rng = MazeRng::seed_from_u64(7);
    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit_default(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), edges_before);
}

#[test]
fn apply_downgrades_bidirectional_passages_to_one_way() {
    let mut maze = maze_grid(4);
    let edges_before = maze.graph.edges().count();
    let issue = missing_issue(2);
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit_default(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), edges_before - 2);

    let one_way_count = maze
        .graph
        .edges()
        .filter(|e| e.kind == EdgeKind::Basic)
        .filter(|e| {
            maze.graph
                .edge_between_kind(e.to, e.from, &EdgeKind::Basic)
                .is_none()
        })
        .count();
    assert_eq!(one_way_count, 2);
}

#[test]
fn apply_downgrades_a_route_protected_passage_keeping_the_routes_own_direction() {
    // 1x3 corridor: the only passage is the entire start->finish route (n0 -> n1 -> n2).
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1, n2) = (p(0), p(1), p(2));
    g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
    g.add_bidirectional_edge(n1, n2, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta = MazeMeta {
        start: Some(n0),
        finish: Some(n2),
    };

    let issue = missing_issue(2);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // Both hops downgraded to one-way, but always in the start->finish direction — finish
    // must still be reachable from start via directed traversal.
    assert_eq!(maze.graph.edges().count(), 2);
    assert!(
        maze.graph.edge_between(n0, n1).is_some(),
        "must keep the route's own n0->n1 direction"
    );
    assert!(
        maze.graph.edge_between(n1, n2).is_some(),
        "must keep the route's own n1->n2 direction"
    );
    assert!(
        maze.graph.edge_between(n1, n0).is_none(),
        "must remove the non-route reverse direction"
    );
    assert!(
        maze.graph.edge_between(n2, n1).is_none(),
        "must remove the non-route reverse direction"
    );
}

#[test]
fn apply_skips_a_route_hop_when_the_forced_direction_is_preset_protected() {
    // Same corridor, but n0->n1 (the route's own direction) is a preset connection — the
    // strategy must never remove n1->n0 instead (that would still downgrade the pair, just
    // not in the direction the route needs kept), so this hop must be skipped entirely.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1, n2) = (p(0), p(1), p(2));
    g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta = MazeMeta {
        start: Some(n0),
        finish: Some(n1),
    };
    let _ = n2;

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((n1, n0));

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit_default(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &preset_state,
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(
        maze.graph.edges().count(),
        edges_before,
        "the only candidate hop must be skipped, not downgraded in the wrong direction"
    );
}

#[test]
fn apply_downgrades_a_route_protected_passage_when_protect_route_is_disabled() {
    use crate::repair::params::build_params;
    use std::collections::HashMap;

    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1, n2) = (p(0), p(1), p(2));
    g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
    g.add_bidirectional_edge(n1, n2, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta = MazeMeta {
        start: Some(n0),
        finish: Some(n2),
    };

    let mut overrides = HashMap::new();
    overrides.insert(PARAM_PROTECT_ROUTE.to_string(), "false".to_string());
    let params = build_params(
        <MissingOneWaysFromPassageStrategy as RepairStrategy<
            SquareTessellation,
            MissingOneWaysIssue,
        >>::params(&MissingOneWaysFromPassageStrategy),
        Some(&overrides),
    );

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(
        maze.graph.edges().count(),
        edges_before - 1,
        "protect_route disabled must allow downgrading a route-critical passage"
    );
}

#[test]
fn apply_does_not_pick_an_existing_one_way() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &PresetState::empty(),
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "no bidirectional passage exists to downgrade"
    );
    assert_eq!(maze.graph.edges().count(), 1);
}

#[test]
fn apply_does_not_downgrade_a_preset_protected_passage() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1) = (p(0), p(1));
    g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((n0, n1));
    preset_state.preset_edges.insert((n1, n0));

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &preset_state,
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(
        maze.graph.edges().count(),
        2,
        "a fully preset-protected passage must survive untouched"
    );
}

#[test]
fn reserve_percent_override_increases_the_number_of_downgrades() {
    use crate::repair::params::build_params;
    use std::collections::HashMap;
    let mut maze = maze_grid(4);
    let edges_before = maze.graph.edges().count();
    let issue = missing_issue(2);
    let overrides = HashMap::from([(
        standard_add_params::PARAM_RESERVE_PERCENT.to_string(),
        "100".to_string(),
    )]);
    let params = build_params(
        <MissingOneWaysFromPassageStrategy as RepairStrategy<
            SquareTessellation,
            MissingOneWaysIssue,
        >>::params(&MissingOneWaysFromPassageStrategy),
        Some(&overrides),
    );
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // 2 * (1 + 100%) = 4 passages downgraded, vs 2 with the unified 0 default.
    assert_eq!(maze.graph.edges().count(), edges_before - 4);
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let issue = missing_issue(2);

    let mut maze_a = maze_grid(4);
    let mut rng_a = MazeRng::seed_from_u64(123);
    apply_and_commit_default(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze_a,
        &mut rng_a,
        &PresetState::empty(),
    );

    let mut maze_b = maze_grid(4);
    let mut rng_b = MazeRng::seed_from_u64(123);
    apply_and_commit_default(
        &MissingOneWaysFromPassageStrategy,
        &issue,
        &mut maze_b,
        &mut rng_b,
        &PresetState::empty(),
    );

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_a, edges_b);
}
