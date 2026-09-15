use super::*;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::{Graph, EdgeKind};
use crate::{IdGenerator, NodeId};
use crate::space::{SquareTessellation, square_rect, MultiLevelField};
use crate::repair::strategies::test_utils::apply_and_commit_default;

fn maze_grid(side: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(side, side), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    Maze::new(field, g)
}

#[test]
fn apply_adds_a_one_way_edge_to_an_allowed_wall_neighbor() {
    let maze = maze_grid(2);
    let nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    let src = nodes[0];
    let allowed = maze.field.neighbors(src);
    assert!(!allowed.is_empty());

    let issue = MissingOneWayIssue::new(src, allowed.clone());
    let mut maze = maze;
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromWallStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), 1);
    let edge = maze.graph.edges().next().unwrap();
    assert_eq!(edge.kind, EdgeKind::Basic);
    assert_eq!(edge.from, src);
    assert!(allowed.contains(&edge.to));
    assert!(maze.graph.edge_between(edge.to, edge.from).is_none(), "added edge must be one-way");
}

#[test]
fn apply_fails_when_every_allowed_dst_is_already_connected() {
    let mut maze = maze_grid(2);
    let nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    let src = nodes[0];
    let allowed = maze.field.neighbors(src);
    for &dst in &allowed {
        maze.graph.add_bidirectional_edge(src, dst, EdgeKind::Basic);
    }
    let edges_before = maze.graph.edges().count();

    let issue = MissingOneWayIssue::new(src, allowed);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromWallStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), edges_before);
}

#[test]
fn apply_only_considers_allowed_dsts_not_every_field_neighbor() {
    // src has 2 field neighbors, but allowed_dsts restricts to only one of them (already
    // connected) -- the strategy must fail rather than falling back to the other, unrestricted
    // neighbor.
    let mut maze = maze_grid(2);
    let nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    let src = nodes[0];
    let neighbors = maze.field.neighbors(src);
    assert!(neighbors.len() >= 2, "corner of a 2x2 grid must have 2 field neighbors");
    let restricted_dst = neighbors[0];
    let other_neighbor = neighbors[1];
    maze.graph.add_bidirectional_edge(src, restricted_dst, EdgeKind::Basic);
    let edges_before = maze.graph.edges().count();

    let issue = MissingOneWayIssue::new(src, vec![restricted_dst]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromWallStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed), "the only allowed dst is already connected");
    assert_eq!(maze.graph.edges().count(), edges_before);
    let _ = other_neighbor;
}

#[test]
fn apply_does_not_add_when_both_directions_locked() {
    let mut maze = maze_grid(2);
    let nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    let src = nodes[0];
    let allowed = maze.field.neighbors(src);
    let dst = allowed[0];

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((src, dst));
    preset_state.blocked.insert((dst, src));

    let issue = MissingOneWayIssue::new(src, vec![dst]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromWallStrategy, &issue, &mut maze, &mut rng, &preset_state);
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn apply_uses_the_only_free_direction_when_one_is_locked() {
    let mut maze = maze_grid(2);
    let nodes: Vec<NodeId> = maze.field.all_node_ids().collect();
    let src = nodes[0];
    let allowed = maze.field.neighbors(src);
    let dst = allowed[0];

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((src, dst));

    let issue = MissingOneWayIssue::new(src, vec![dst]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&AddOneWayFromWallStrategy, &issue, &mut maze, &mut rng, &preset_state);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(dst, src).is_some(), "must use the only unblocked direction");
    assert!(maze.graph.edge_between(src, dst).is_none());
}
