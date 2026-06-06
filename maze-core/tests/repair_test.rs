use std::collections::HashMap;
use rand::SeedableRng;
use rand::rngs::SmallRng;
use maze_core::{Graph, IdGenerator, Maze, Field, NodeId};
use maze_core::graph::EdgeKind;
use maze_core::space::{SquareField, SquarePoint, SquareSize};
use maze_core::quality_control::{Issue, MISSING_ENDPOINTS};
use maze_core::repair::{
    RepairEngine, RepairResult, RepairStrategy, StrategyParams,
    RandomEndpointsStrategy, FarthestEndpointsStrategy,
};

fn make_maze(n_cols: usize, n_rows: usize) -> Maze<SquareField> {
    let mut ids = IdGenerator::new();
    let field = SquareField::new(SquareSize { width: n_cols, height: n_rows }, &mut ids);
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    Maze::new(field, graph)
}

/// Returns maze and nodes in stable left-to-right order: (0,0), (1,0), ..., (n-1,0).
fn make_connected_maze(n_cols: usize) -> (Maze<SquareField>, Vec<NodeId>) {
    let mut maze = make_maze(n_cols, 1);
    let ordered: Vec<NodeId> = (0..n_cols)
        .map(|x| maze.field.node_at(SquarePoint { x: x as i32, y: 0 }).unwrap())
        .collect();
    for i in 0..ordered.len() - 1 {
        maze.graph.add_bidirectional_edge(ordered[i], ordered[i + 1], EdgeKind::Basic);
    }
    (maze, ordered)
}

fn make_rng() -> SmallRng {
    SmallRng::seed_from_u64(42)
}

fn no_params() -> StrategyParams {
    StrategyParams::new()
}

// --- RandomEndpointsStrategy ---

#[test]
fn random_endpoints_sets_both_when_neither_set() {
    let (mut maze, _) = make_connected_maze(3);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Fixed));
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.start, maze.meta.finish);
}

#[test]
fn random_endpoints_sets_finish_when_only_start_set() {
    let (mut maze, ordered) = make_connected_maze(3);
    maze.meta.start = Some(ordered[0]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Fixed));
    assert_eq!(maze.meta.start, Some(ordered[0]));
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.finish, maze.meta.start);
}

#[test]
fn random_endpoints_sets_start_reachable_to_finish() {
    let (mut maze, ordered) = make_connected_maze(3);
    maze.meta.finish = Some(ordered[2]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Fixed));
    assert!(maze.meta.start.is_some());
    assert_ne!(maze.meta.start, maze.meta.finish);
}

#[test]
fn random_endpoints_idempotent_when_both_set() {
    let (mut maze, ordered) = make_connected_maze(3);
    maze.meta.start = Some(ordered[0]);
    maze.meta.finish = Some(ordered[2]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Fixed));
    assert_eq!(maze.meta.start, Some(ordered[0]));
    assert_eq!(maze.meta.finish, Some(ordered[2]));
}

#[test]
fn random_endpoints_empty_graph_returns_failed() {
    let mut ids = IdGenerator::new();
    let field = SquareField::new(SquareSize { width: 1, height: 1 }, &mut ids);
    let graph = Graph::new();
    let mut maze = Maze::new(field, graph);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn random_endpoints_isolated_start_returns_failed() {
    let mut maze = make_maze(3, 1);
    let start = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    maze.meta.start = Some(start);
    // no edges — start is isolated
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.meta.finish.is_none());
}

// --- FarthestEndpointsStrategy ---

#[test]
fn farthest_endpoints_sets_both_when_neither_set() {
    let (mut maze, _) = make_connected_maze(5);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Fixed));
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.start, maze.meta.finish);
}

#[test]
fn farthest_endpoints_sets_finish_when_only_start_set() {
    let (mut maze, ordered) = make_connected_maze(5);
    maze.meta.start = Some(ordered[0]); // leftmost = junction
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Fixed));
    assert_eq!(maze.meta.start, Some(ordered[0]));
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.finish, maze.meta.start);
}

#[test]
fn farthest_endpoints_sets_start_when_only_finish_set() {
    let (mut maze, ordered) = make_connected_maze(5);
    maze.meta.finish = Some(ordered[4]); // rightmost = junction
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Fixed));
    assert!(maze.meta.start.is_some());
    assert_ne!(maze.meta.start, maze.meta.finish);
}

#[test]
fn farthest_endpoints_idempotent_when_both_set() {
    let (mut maze, ordered) = make_connected_maze(5);
    maze.meta.start = Some(ordered[0]);
    maze.meta.finish = Some(ordered[4]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Fixed));
    assert_eq!(maze.meta.start, Some(ordered[0]));
    assert_eq!(maze.meta.finish, Some(ordered[4]));
}

#[test]
fn farthest_endpoints_deterministic() {
    let run = || {
        let (mut maze, _) = make_connected_maze(5);
        let mut rng = SmallRng::seed_from_u64(99);
        let issue = Issue::new(MISSING_ENDPOINTS);
        FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
        (maze.meta.start, maze.meta.finish)
    };
    let (s1, f1) = run();
    let (s2, f2) = run();
    assert_eq!(s1, s2);
    assert_eq!(f1, f2);
    assert!(f1.is_some());
}

// Two separate 2-node components: (0,0)↔(1,0) and (2,0)↔(3,0), no edges between them.
// Returns maze and nodes in stable order.
fn make_disconnected_maze() -> (Maze<SquareField>, Vec<NodeId>) {
    let mut maze = make_maze(4, 1);
    let ordered: Vec<NodeId> = (0..4)
        .map(|x| maze.field.node_at(SquarePoint { x: x as i32, y: 0 }).unwrap())
        .collect();
    maze.graph.add_bidirectional_edge(ordered[0], ordered[1], EdgeKind::Basic);
    maze.graph.add_bidirectional_edge(ordered[2], ordered[3], EdgeKind::Basic);
    (maze, ordered)
}

#[test]
fn farthest_endpoints_disconnected_graph_stays_in_same_component() {
    let (mut maze, ordered) = make_disconnected_maze();
    maze.meta.start = Some(ordered[0]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Fixed));
    let finish = maze.meta.finish.expect("finish must be set");
    // finish must be in the same component as start (nodes 0 and 1)
    assert!(finish == ordered[0] || finish == ordered[1],
        "finish {finish} must be in same component as start {}", ordered[0]);
    assert_ne!(maze.meta.finish, maze.meta.start);
}

#[test]
fn farthest_endpoints_isolated_nav_node_returns_failed() {
    // Single nav node (no edges) — farthest == source → Failed
    let mut maze = make_maze(1, 1);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params());
    assert!(matches!(result, RepairResult::Failed));
}

// --- RepairEngine routing ---

#[test]
fn repair_engine_routes_by_kind() {
    let (mut maze, _) = make_connected_maze(3);
    let mut rng = make_rng();
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareField>>> = HashMap::new();
    strategies.insert(MISSING_ENDPOINTS, Box::new(RandomEndpointsStrategy));
    let engine = RepairEngine::new(strategies, HashMap::new());
    let issues = vec![Issue::new(MISSING_ENDPOINTS)];
    let results = engine.run(&issues, &mut maze, &mut rng);
    assert_eq!(results.len(), 1);
    assert!(matches!(results[0].1, RepairResult::Fixed));
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
}

#[test]
fn repair_engine_no_strategy_leaves_unresolved() {
    let mut maze = make_maze(2, 1);
    let mut rng = make_rng();
    let engine: RepairEngine<SquareField> = RepairEngine::new(HashMap::new(), HashMap::new());
    let issues = vec![Issue::new(MISSING_ENDPOINTS)];
    let results = engine.run(&issues, &mut maze, &mut rng);
    assert!(results.is_empty());
    assert!(maze.meta.start.is_none());
}
