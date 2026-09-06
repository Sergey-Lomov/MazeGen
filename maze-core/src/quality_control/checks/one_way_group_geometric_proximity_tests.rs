use super::*;
use rand::SeedableRng;
use crate::graph::EdgeKind;
use crate::ids::EdgeId;
use crate::{Graph, IdGenerator};
use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
use crate::meta::MazeMeta;

const TEST_ID: &str = "one_way_group_geometric_proximity";

fn check(distance: f64, protect_route: bool) -> OneWayGroupGeometricProximityCheck {
    OneWayGroupGeometricProximityCheck { instance_id: TEST_ID.to_string(), distance, protect_route, floor_mode: GeometricFloorMode::Ignore }
}

/// Two disjoint one-way edges on a single row: A(0)->B(1) and C(cx)->D(cx+1).
fn maze_with_two_one_ways(cx: i32) -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    let mut ids = IdGenerator::new();
    let width = (cx + 2).max(4) as usize;
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let e1 = g.add_edge(p(0), p(1), EdgeKind::Basic);
    let e2 = g.add_edge(p(cx), p(cx + 1), EdgeKind::Basic);
    let maze = Maze::new(field, g);
    (maze, e1, e2)
}

#[test]
fn fires_when_two_one_ways_closer_than_threshold() {
    let (maze, e1, e2) = maze_with_two_one_ways(2);
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
fn measures_edge_position_not_node_endpoints() {
    // Two one-ways sharing a `from` node (0->1 and 1->2, on a square grid): edge_position
    // midpoints are (0.5,0) and (1.5,0), distance 1.0 -- the pre-#199-followup node-based `min`
    // would have found node 1 shared between them and reported distance 0.0. This distinguishes
    // the two: a threshold that only fires under the old node-based metric must stay silent here.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let e1 = g.add_edge(p(0), p(1), EdgeKind::Basic);
    let e2 = g.add_edge(p(1), p(2), EdgeKind::Basic);
    let maze = Maze::new(field, g);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);

    check(0.5, true).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "edge-position distance is 1.0, not < 0.5 -- old node-based metric would have wrongly reported 0.0 here");

    issues.clear();
    check(1.5, true).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "edge-position distance 1.0 < 1.5 must fire");
    let (mut group, to_remove) = issues[0].groups[0].clone();
    group.sort_unstable();
    let mut expected = vec![e1, e2];
    expected.sort_unstable();
    assert_eq!(group, expected);
    assert_eq!(to_remove, 1);
}

#[test]
fn silent_when_farther_than_threshold() {
    let (maze, _, _) = maze_with_two_one_ways(10);
    let c = check(2.0, true);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn silent_when_threshold_is_zero() {
    let (maze, _, _) = maze_with_two_one_ways(1);
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
    let (mut maze, e1, e2) = maze_with_two_one_ways(1);
    // Both one-ways sit on the only start->finish route: start(0)->1 (e1), 1->2(e2) is not
    // contiguous since e2 is a separate edge; build a maze where both edges are route hops.
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
    let (mut maze, _, _) = maze_with_two_one_ways(1);
    let nodes: Vec<_> = maze.field.field_of(maze.field.single_level_id()).unwrap().all_points().map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap()).collect();
    maze.meta = MazeMeta { start: Some(nodes[0]), finish: Some(nodes[2]), route_score: None };

    let c = check(1000.0, false);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "protect_route disabled must flag the pair exactly like before");
}

/// Two floors, same x-y coordinates: A(0)->B(1) on the bottom floor, C(0)->D(1) on the top floor —
/// isolates floor-mode behavior from x-y edge-position distance itself (both edges have the same
/// edge_position midpoint, 0.5, in their own floor's coordinate system).
fn maze_with_cross_floor_one_ways() -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
    let bottom = field.single_level_id();
    let top = field.add_level(crate::space::Field::<SquareTessellation>::new(square_rect(4, 1), &mut ids).unwrap());
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let a = field.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
    let b = field.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
    let c = field.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
    let d = field.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
    let e1 = g.add_edge(a, b, EdgeKind::Basic);
    let e2 = g.add_edge(c, d, EdgeKind::Basic);
    let maze = Maze::new(field, g);
    (maze, e1, e2)
}

#[test]
fn ignore_mode_measures_plain_edge_position_distance_across_floors() {
    let (maze, _, _) = maze_with_cross_floor_one_ways(); // same edge_position each floor -> distance 0.0
    let c = OneWayGroupGeometricProximityCheck { instance_id: TEST_ID.to_string(), distance: 0.5, protect_route: true, floor_mode: GeometricFloorMode::Ignore };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "Ignore mode measures x-y edge_position only (0.0 < 0.5), floor difference has no effect");
}

#[test]
fn as_coordinate_mode_folds_floor_difference_into_the_distance() {
    let (maze, _, _) = maze_with_cross_floor_one_ways(); // x-y distance 0.0, one floor apart -> 1.0
    let c = OneWayGroupGeometricProximityCheck { instance_id: TEST_ID.to_string(), distance: 0.5, protect_route: true, floor_mode: GeometricFloorMode::AsCoordinate };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "floor-folded distance is 1.0, not < 0.5, unlike the plain x-y distance of 0.0");

    issues.clear();
    let c = OneWayGroupGeometricProximityCheck { instance_id: TEST_ID.to_string(), distance: 1.5, protect_route: true, floor_mode: GeometricFloorMode::AsCoordinate };
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "floor-folded distance 1.0 < 1.5 must fire");
}

#[test]
fn same_floor_only_mode_never_flags_a_cross_floor_pair() {
    let (maze, _, _) = maze_with_cross_floor_one_ways();
    let c = OneWayGroupGeometricProximityCheck { instance_id: TEST_ID.to_string(), distance: 1000.0, protect_route: true, floor_mode: GeometricFloorMode::SameFloorOnly };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "cross-floor pair must never be flagged under SameFloorOnly, regardless of threshold");
}

#[test]
fn same_floor_only_mode_still_flags_a_same_floor_pair() {
    let (maze, e1, e2) = maze_with_two_one_ways(2); // same floor, distance < 5.0
    let c = OneWayGroupGeometricProximityCheck { instance_id: TEST_ID.to_string(), distance: 5.0, protect_route: true, floor_mode: GeometricFloorMode::SameFloorOnly };
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "SameFloorOnly still evaluates same-floor pairs normally");
    let _ = (e1, e2);
}
