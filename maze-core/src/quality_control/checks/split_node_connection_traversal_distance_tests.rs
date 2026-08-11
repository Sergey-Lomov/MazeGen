use super::*;
use rand::SeedableRng;
use crate::graph::EdgeKind;
use crate::{Graph, IdGenerator};
use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

const TEST_ID: &str = "split_node_connection_traversal_distance";

fn rng() -> crate::random::MazeRng {
    crate::random::MazeRng::seed_from_u64(0)
}

fn maze_with_split() -> (Maze<SquareTessellation>, NodeId, NodeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 2, y: 0 };
    let slot0 = field.node_at(level, p).unwrap();
    let extra = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let maze = Maze::new(field, g);
    (maze, slot0, extra)
}

#[test]
fn silent_when_no_split_points() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let check = SplitNodeConnectionTraversalDistanceCheck { instance_id: TEST_ID.to_string(), min_detour: 3 };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(issues.is_empty());
}

#[test]
fn silent_when_split_nodes_are_disconnected() {
    let (maze, _slot0, _extra) = maze_with_split();
    // No edges at all -- no path either way, must not fire.
    let check = SplitNodeConnectionTraversalDistanceCheck { instance_id: TEST_ID.to_string(), min_detour: 3 };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(issues.is_empty());
}

#[test]
fn fires_when_a_direct_edge_connects_the_two_split_nodes() {
    let (mut maze, slot0, extra) = maze_with_split();
    // Direct edge: a path of 1 step, far below min_detour - 1 = 2.
    let edge = maze.graph.build_initial_edge(slot0, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionTraversalDistanceCheck { instance_id: TEST_ID.to_string(), min_detour: 3 };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].routes.len(), 1);
    // The single edge is incident to both split nodes -- it's a split edge either way.
    assert_eq!(issues[0].routes[0], vec![(edge, true)]);
}

#[test]
fn silent_when_only_path_meets_the_minimum_detour() {
    let (mut maze, slot0, extra) = maze_with_split();
    // Build an explicit path of exactly min_detour steps between slot0 and extra via outside
    // nodes -- must NOT fire (min_detour itself is allowed, only strictly shorter is flagged).
    let level = maze.field.single_level_id();
    let a = maze.field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
    let b = maze.field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
    let c = maze.field.node_at(level, SquarePoint { x: 3, y: 0 }).unwrap();
    let d = maze.field.node_at(level, SquarePoint { x: 4, y: 0 }).unwrap();
    // Path: slot0 -> a -> b -> c -> d -> extra == 5 steps.
    maze.graph.build_initial_edge(slot0, a, EdgeKind::Basic);
    maze.graph.build_initial_edge(a, b, EdgeKind::Basic);
    maze.graph.build_initial_edge(b, c, EdgeKind::Basic);
    maze.graph.build_initial_edge(c, d, EdgeKind::Basic);
    maze.graph.build_initial_edge(d, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionTraversalDistanceCheck { instance_id: TEST_ID.to_string(), min_detour: 5 };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(issues.is_empty(), "a path of exactly min_detour steps must not be flagged as too short");
}

#[test]
fn fires_only_for_the_direction_that_has_a_short_path() {
    let (mut maze, slot0, extra) = maze_with_split();
    // slot0 -> extra directly (1 step, short). extra -> slot0 has no path at all.
    let edge = maze.graph.build_initial_edge(slot0, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionTraversalDistanceCheck { instance_id: TEST_ID.to_string(), min_detour: 3 };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].routes.len(), 1, "only the slot0 -> extra direction has a short path");
    assert_eq!(issues[0].routes[0], vec![(edge, true)]);
}

#[test]
fn route_carries_full_ordered_path_with_split_edge_flags() {
    let (mut maze, slot0, extra) = maze_with_split();
    let level = maze.field.single_level_id();
    let a = maze.field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
    // slot0 -> a -> extra: 2 steps, below min_detour - 1 = 3.
    let e0 = maze.graph.build_initial_edge(slot0, a, EdgeKind::Basic);
    let e1 = maze.graph.build_initial_edge(a, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionTraversalDistanceCheck { instance_id: TEST_ID.to_string(), min_detour: 4 };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].routes.len(), 1);
    // e0 leaves the split tile (slot0) -- split edge. e1 arrives at the split tile (extra) -- also
    // split edge (both endpoints of a 2-step path here are incident to the split point).
    assert_eq!(issues[0].routes[0], vec![(e0, true), (e1, true)]);
}

#[test]
fn middle_edge_of_a_longer_route_is_not_marked_a_split_edge() {
    let (mut maze, slot0, extra) = maze_with_split();
    let level = maze.field.single_level_id();
    let a = maze.field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
    let b = maze.field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
    // slot0 -> a -> b -> extra: 3 steps, below min_detour - 1 = 4.
    let e0 = maze.graph.build_initial_edge(slot0, a, EdgeKind::Basic);
    let e1 = maze.graph.build_initial_edge(a, b, EdgeKind::Basic);
    let e2 = maze.graph.build_initial_edge(b, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionTraversalDistanceCheck { instance_id: TEST_ID.to_string(), min_detour: 5 };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].routes[0], vec![(e0, true), (e1, false), (e2, true)],
        "only the edges touching the split tile itself (e0, e2) are marked split edges; e1 (a -> b) is neither");
}

#[test]
fn min_detour_default_is_ten() {
    assert_eq!(SPLIT_NODE_CONNECTION_TRAVERSAL_DISTANCE_MIN_DETOUR_DEFAULT, 10);
}

#[test]
fn min_detour_of_one_never_fires_even_for_a_direct_edge() {
    // min_detour: 1 -> max_steps = 0 (capped_path's degenerate-cap early return) -- the minimum
    // user-configurable value (checks_catalog.rs's ParamDescriptor min: 1), so this must be a
    // silent no-op, not a panic or an unbounded search.
    let (mut maze, slot0, extra) = maze_with_split();
    maze.graph.build_initial_edge(slot0, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionTraversalDistanceCheck { instance_id: TEST_ID.to_string(), min_detour: 1 };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert!(issues.is_empty(), "min_detour: 1 must never flag anything, not even a direct edge");
}

#[test]
fn finds_the_shorter_of_two_paths_between_split_nodes() {
    // Diamond shape: slot0 -> a -> extra (2 steps) and slot0 -> b -> c -> extra (3 steps). BFS
    // must find the 2-step path and must not get stuck on `b`/`c` from a stale/duplicate visit
    // of a node already reached via the shorter branch.
    let (mut maze, slot0, extra) = maze_with_split();
    let level = maze.field.single_level_id();
    let a = maze.field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
    let b = maze.field.node_at(level, SquarePoint { x: 1, y: 0 }).unwrap();
    let c = maze.field.node_at(level, SquarePoint { x: 3, y: 0 }).unwrap();
    let e0 = maze.graph.build_initial_edge(slot0, a, EdgeKind::Basic);
    let e1 = maze.graph.build_initial_edge(a, extra, EdgeKind::Basic);
    maze.graph.build_initial_edge(slot0, b, EdgeKind::Basic);
    maze.graph.build_initial_edge(b, c, EdgeKind::Basic);
    maze.graph.build_initial_edge(c, extra, EdgeKind::Basic);

    let check = SplitNodeConnectionTraversalDistanceCheck { instance_id: TEST_ID.to_string(), min_detour: 4 };
    let mut issues = Vec::new();
    check.repair_check(&maze, &mut issues, &mut rng(), ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].routes.len(), 1, "only the shorter path must be flagged as one route");
    assert_eq!(issues[0].routes[0], vec![(e0, true), (e1, true)], "BFS must find the shorter 2-step path, not the 3-step detour");
}
