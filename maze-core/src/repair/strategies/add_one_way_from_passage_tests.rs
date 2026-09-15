use super::*;
use std::collections::HashMap;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::Graph;
use crate::{IdGenerator, NodeId};
use crate::space::{SquareTessellation, square_rect, MultiLevelField, SquarePoint};
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit_default;
use crate::meta::MazeMeta;

fn maze_grid(side: usize) -> Maze<SquareTessellation> {
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

#[test]
fn apply_downgrades_a_bidirectional_passage_to_one_way() {
    let mut maze = maze_grid(2);
    let nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    let src = nodes[0];
    let allowed = maze.field.neighbors(src);
    let edges_before = maze.graph.edges().count();

    let issue = MissingOneWayIssue::new(src, allowed);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromPassageStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), edges_before - 1);
}

#[test]
fn apply_only_considers_allowed_dsts_not_every_field_neighbor() {
    // 1x3 corridor: n0<->n1 has a passage, n1<->n2 does not (a wall). n1's allowed_dsts is
    // restricted to n2 only -- the strategy must fail rather than falling back to n0.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1, n2) = (p(0), p(1), p(2));
    g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    let edges_before = maze.graph.edges().count();

    let issue = MissingOneWayIssue::new(n1, vec![n2]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromPassageStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed), "the only allowed dst (n2) has no passage to downgrade");
    assert_eq!(maze.graph.edges().count(), edges_before);
}

#[test]
fn apply_downgrades_a_route_protected_passage_keeping_the_routes_own_direction() {
    // 1x3 corridor: the only passage is the entire start->finish route (n0 -> n1 -> n2).
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1, n2) = (p(0), p(1), p(2));
    g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
    g.add_bidirectional_edge(n1, n2, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta = MazeMeta { start: Some(n0), finish: Some(n2), route_score: None };

    let issue = MissingOneWayIssue::new(n1, vec![n0, n2]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromPassageStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert_eq!(maze.graph.edges().count(), 3, "only one of n1's two route hops must be downgraded");
    // Whichever hop was downgraded, the route's own direction must survive.
    assert!(maze.graph.edge_between(n0, n1).is_some(), "must keep the route's own n0->n1 direction");
    assert!(maze.graph.edge_between(n1, n2).is_some(), "must keep the route's own n1->n2 direction");
}

#[test]
fn apply_skips_a_route_hop_when_the_forced_direction_is_preset_protected() {
    // n0->n1 (the route's own direction) is a preset connection -- the strategy must never
    // remove n1->n0 instead (that would still downgrade the pair, just not in the direction the
    // route needs kept), so this hop must be skipped entirely.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1, _n2) = (p(0), p(1), p(2));
    g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta = MazeMeta { start: Some(n0), finish: Some(n1), route_score: None };

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((n1, n0));

    let issue = MissingOneWayIssue::new(n0, vec![n1]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit_default(&AddOneWayFromPassageStrategy, &issue, &mut maze, &mut rng, &preset_state);
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), edges_before, "the only candidate hop must be skipped, not downgraded in the wrong direction");
}

#[test]
fn apply_downgrades_a_route_protected_passage_when_protect_route_is_disabled() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1, _n2) = (p(0), p(1), p(2));
    g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta = MazeMeta { start: Some(n0), finish: Some(n1), route_score: None };

    let mut overrides = HashMap::new();
    overrides.insert(PARAM_PROTECT_ROUTE.to_string(), "false".to_string());
    let params = build_params(
        <AddOneWayFromPassageStrategy as RepairStrategy<SquareTessellation, MissingOneWayIssue>>::params(&AddOneWayFromPassageStrategy),
        Some(&overrides),
    );

    let issue = MissingOneWayIssue::new(n0, vec![n1]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before = maze.graph.edges().count();
    let result = crate::repair::strategies::test_utils::apply_and_commit(&AddOneWayFromPassageStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), edges_before - 1, "protect_route disabled must allow downgrading a route-critical passage");
}

#[test]
fn apply_does_not_pick_an_existing_one_way() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1) = (p(0), p(1));
    g.add_edge(n0, n1, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = MissingOneWayIssue::new(n0, vec![n1]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromPassageStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed), "no bidirectional passage exists to downgrade");
    assert_eq!(maze.graph.edges().count(), 1);
}

#[test]
fn apply_does_not_downgrade_a_preset_protected_passage() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let (n0, n1) = (p(0), p(1));
    g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((n0, n1));
    preset_state.preset_edges.insert((n1, n0));

    let issue = MissingOneWayIssue::new(n0, vec![n1]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromPassageStrategy, &issue, &mut maze, &mut rng, &preset_state);
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 2, "a fully preset-protected passage must survive untouched");
}
