use super::*;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;

const TEST_ID: &str = "split_node_connection_per_face";

fn maze_with_split_and_neighbors() -> (Maze<SquareTessellation>, NodeId, NodeId, NodeId, NodeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
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
        MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = SplitNodeConnectionPerFaceCheck {
        instance_id: TEST_ID.to_string(),
        max: 1,
    };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn silent_when_each_face_direction_stays_at_or_below_max() {
    let (mut maze, slot0, extra, left, right) = maze_with_split_and_neighbors();
    // slot0 -> left (west face) and extra -> right (east face) -- distinct face directions, each
    // at the default max of 1, so nothing should fire.
    maze.graph.add_edge(slot0, left, EdgeKind::Basic);
    maze.graph.add_edge(extra, right, EdgeKind::Basic);

    let check = SplitNodeConnectionPerFaceCheck {
        instance_id: TEST_ID.to_string(),
        max: 1,
    };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn fires_when_two_split_nodes_connect_out_through_the_same_face_direction() {
    let (mut maze, slot0, extra, left, _right) = maze_with_split_and_neighbors();
    // Both slot0 and extra connect out through the west face (toward `left`) -- 2 connections
    // sharing one face direction, over max 1.
    maze.graph.add_edge(slot0, left, EdgeKind::Basic);
    maze.graph.add_edge(extra, left, EdgeKind::Basic);

    let check = SplitNodeConnectionPerFaceCheck {
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
fn fires_when_edges_to_two_different_neighbors_share_the_same_face_direction() {
    // The per-face check's own distinguishing behavior vs. per-neighbor: slot0 -> left and
    // extra -> another node at the SAME point as `left` (i.e. two distinct outside neighbor
    // NodeIds, same face direction) must still be bucketed together and fire, even though they
    // target different NodeIds. A regression that accidentally buckets by neighbor NodeId
    // instead of face index would miss this.
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 1 };
    let slot0 = field.node_at(level, p).unwrap();
    let extra = field.add_node_at(level, p, &mut ids);
    let left_point = SquarePoint { x: 0, y: 1 };
    let left0 = field.node_at(level, left_point).unwrap();
    let left1 = field.add_node_at(level, left_point, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let maze: Maze<SquareTessellation> = Maze::new(field, g);
    let mut maze = maze;
    maze.graph.add_edge(slot0, left0, EdgeKind::Basic);
    maze.graph.add_edge(extra, left1, EdgeKind::Basic);

    let check = SplitNodeConnectionPerFaceCheck {
        instance_id: TEST_ID.to_string(),
        max: 1,
    };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].groups.len(), 1);
    let (edges, to_remove) = &issues[0].groups[0];
    assert_eq!(
        edges.len(),
        2,
        "distinct neighbor NodeIds sharing one face direction must bucket together"
    );
    assert_eq!(*to_remove, 1);
}

#[test]
fn ignores_sibling_edges_between_nodes_of_the_same_split() {
    let (mut maze, slot0, extra, _left, _right) = maze_with_split_and_neighbors();
    maze.graph
        .add_bidirectional_edge(slot0, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionPerFaceCheck {
        instance_id: TEST_ID.to_string(),
        max: 1,
    };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}
