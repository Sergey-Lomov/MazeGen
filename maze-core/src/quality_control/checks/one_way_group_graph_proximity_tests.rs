use super::*;
use rand::SeedableRng;
use crate::{Graph, IdGenerator};
use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
use crate::meta::MazeMeta;

const TEST_ID: &str = "one_way_group_graph_proximity";

fn check(distance: f64, protect_route: bool) -> OneWayGroupGraphProximityCheck {
    OneWayGroupGraphProximityCheck { instance_id: TEST_ID.to_string(), distance, protect_route }
}

/// Two one-way edges bridged by a bidirectional corridor of `gap` hops: A(0)->B(1), then a
/// bidirectional chain of `gap` hops, then C->D (the second one-way).
fn maze_with_two_one_ways_gapped(gap: usize) -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    let mut ids = IdGenerator::new();
    let width = gap + 4;
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let e1 = g.add_edge(p(0), p(1), EdgeKind::Basic);
    for i in 1..(1 + gap as i32) {
        g.add_bidirectional_edge(p(i), p(i + 1), EdgeKind::Basic);
    }
    let c_x = 1 + gap as i32;
    let e2 = g.add_edge(p(c_x), p(c_x + 1), EdgeKind::Basic);
    let maze = Maze::new(field, g);
    (maze, e1, e2)
}

#[test]
fn fires_when_two_one_ways_closer_than_threshold() {
    let (maze, e1, e2) = maze_with_two_one_ways_gapped(1);
    let c = check(5.0, true);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    // Each edge is scanned independently and finds the other -- own=e1/other=e2 and
    // own=e2/other=e1 both fire, same "symmetric pair recorded from both sides" shape
    // `TeleportGroupProximityCheck` produces.
    assert_eq!(issues[0].groups.len(), 2);
    for (group, to_remove) in &issues[0].groups {
        let mut sorted = group.clone();
        sorted.sort_unstable();
        let mut expected = vec![e1, e2];
        expected.sort_unstable();
        assert_eq!(sorted, expected);
        assert_eq!(*to_remove, 1, "fixing either edge in the pair resolves it");
    }
}

#[test]
fn silent_when_farther_than_threshold() {
    let (maze, _, _) = maze_with_two_one_ways_gapped(20);
    let c = check(2.0, true);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn shared_from_node_counts_as_distance_one_not_zero() {
    // Two one-ways sharing a `from` node (gap=0: e1=0->1, e2=1->2) -- raw node distance is 0,
    // but the +1 offset must make this compare as 1, matching the user-facing intuition that a
    // shared node is "adjacent" (distance 1), not "the same place" (distance 0).
    let (maze, e1, e2) = maze_with_two_one_ways_gapped(0);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);

    check(1.0, true).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "threshold 1.0 must not fire -- offset distance is exactly 1, not < 1");

    issues.clear();
    check(2.0, true).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "threshold 2.0 must fire -- offset distance 1 < 2");
    let (mut group, to_remove) = issues[0].groups[0].clone();
    group.sort_unstable();
    let mut expected = vec![e1, e2];
    expected.sort_unstable();
    assert_eq!(group, expected);
    assert_eq!(to_remove, 1);
}

#[test]
fn silent_when_threshold_is_zero() {
    let (maze, _, _) = maze_with_two_one_ways_gapped(0);
    let c = check(0.0, true);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "a threshold of 0 should never flag any pair");
}

#[test]
fn silent_with_fewer_than_two_one_ways() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic);
    let maze = Maze::new(field, g);

    let c = check(1000.0, true);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn ignores_bidirectional_passage() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
    let one_way = g.add_edge(p(2), p(3), EdgeKind::Basic);
    let maze = Maze::new(field, g);

    let c = check(1000.0, true);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "only one genuine one-way exists -- a bidirectional passage must not count as a second candidate");
    let _ = one_way;
}

#[test]
fn protect_route_excludes_a_pair_fully_on_route() {
    let (mut maze, e1, e2) = maze_with_two_one_ways_gapped(0);
    let nodes: Vec<_> = maze.field.field_of(maze.field.single_level_id()).unwrap().all_points().map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap()).collect();
    maze.meta = MazeMeta { start: Some(nodes[0]), finish: Some(nodes[2]), route_score: None };

    let c = check(1000.0, true);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "a pair where both edges are route-critical must not be flagged when protect_route is enabled");
    let _ = (e1, e2);
}

#[test]
fn protect_route_disabled_flags_the_route_pair_as_before() {
    let (mut maze, _, _) = maze_with_two_one_ways_gapped(0);
    let nodes: Vec<_> = maze.field.field_of(maze.field.single_level_id()).unwrap().all_points().map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap()).collect();
    maze.meta = MazeMeta { start: Some(nodes[0]), finish: Some(nodes[2]), route_score: None };

    let c = check(1000.0, false);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "protect_route disabled must flag the pair exactly like before");
}
