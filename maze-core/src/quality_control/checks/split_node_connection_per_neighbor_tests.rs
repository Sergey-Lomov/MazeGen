use super::*;
use crate::graph::EdgeKind;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;
use std::sync::Arc;

const TEST_ID: &str = "split_node_connection_per_neighbor";

fn maze_with_split_and_neighbors() -> (Maze<SquareTessellation>, NodeId, NodeId, NodeId, NodeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 3), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 1 };
    let slot0 = field.node_at(level, p).unwrap();
    let extra = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let left = field.node_at(level, SquarePoint { x: 0, y: 1 }).unwrap();
    let right = field.node_at(level, SquarePoint { x: 2, y: 1 }).unwrap();
    let maze = Maze::new(field, g);
    (maze, slot0, extra, left, right)
}

#[test]
fn silent_when_no_split_points() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 3), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = SplitNodeConnectionPerNeighborCheck {
        instance_id: TEST_ID.to_string(),
        max: 1,
    };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn silent_when_neighbor_connection_count_at_or_below_max() {
    let (mut maze, slot0, extra, left, right) = maze_with_split_and_neighbors();
    // slot0 -> left and extra -> right are different neighbors -- each neighbor receives exactly
    // one connection, at the default max of 1, so nothing should fire.
    maze.graph.add_edge(slot0, left, EdgeKind::Basic);
    maze.graph.add_edge(extra, right, EdgeKind::Basic);

    let check = SplitNodeConnectionPerNeighborCheck {
        instance_id: TEST_ID.to_string(),
        max: 1,
    };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn fires_when_two_split_nodes_connect_to_the_same_outside_neighbor() {
    let (mut maze, slot0, extra, left, _right) = maze_with_split_and_neighbors();
    // Both slot0 and extra connect to `left` -- 2 connections to the same neighbor, over max 1.
    maze.graph.add_edge(slot0, left, EdgeKind::Basic);
    maze.graph.add_edge(extra, left, EdgeKind::Basic);

    let check = SplitNodeConnectionPerNeighborCheck {
        instance_id: TEST_ID.to_string(),
        max: 1,
    };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].groups.len(), 1);
    let (edges, to_remove) = &issues[0].groups[0];
    assert_eq!(edges.len(), 2);
    assert_eq!(*to_remove, 1);
}

#[test]
fn ignores_sibling_edges_between_nodes_of_the_same_split() {
    let (mut maze, slot0, extra, _left, _right) = maze_with_split_and_neighbors();
    // slot0 <-> extra is a sibling edge within the same split point -- must never count as an
    // "outside neighbor" connection.
    maze.graph
        .add_bidirectional_edge(slot0, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionPerNeighborCheck {
        instance_id: TEST_ID.to_string(),
        max: 1,
    };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn ignores_incoming_edges_from_the_neighbor() {
    let (mut maze, slot0, extra, left, _right) = maze_with_split_and_neighbors();
    // Both edges point INTO the split nodes (incoming), not out -- must not count under this
    // check's outgoing-only rule.
    maze.graph.add_edge(left, slot0, EdgeKind::Basic);
    maze.graph.add_edge(left, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionPerNeighborCheck {
        instance_id: TEST_ID.to_string(),
        max: 1,
    };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}
