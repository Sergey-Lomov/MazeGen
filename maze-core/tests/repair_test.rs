use std::collections::HashMap;
use rand::SeedableRng;
use rand::rngs::SmallRng;
use maze_core::{Graph, IdGenerator, Maze, Field};
use maze_core::graph::EdgeKind;
use maze_core::space::{SquareField, SquareSize};
use maze_core::quality_control::{Issue, MISSING_START, MISSING_FINISH};
use maze_core::repair::{
    RepairEngine, RepairResult, RepairStrategy,
    CreateStartStrategy, CreateFinishStrategy,
};

fn make_maze(n_cols: usize, n_rows: usize) -> Maze<SquareField> {
    let mut ids = IdGenerator::new();
    let field = SquareField::new(SquareSize { width: n_cols, height: n_rows }, &mut ids);
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    Maze::new(field, graph)
}

fn make_rng() -> SmallRng {
    SmallRng::seed_from_u64(42)
}

#[test]
fn create_start_sets_start() {
    let mut maze = make_maze(3, 1);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_START);
    let result = CreateStartStrategy.apply(&issue, &mut maze, &mut rng);
    assert!(matches!(result, RepairResult::Fixed));
    assert!(maze.meta.start.is_some());
}

#[test]
fn create_start_empty_graph_returns_failed() {
    let mut ids = IdGenerator::new();
    let field = SquareField::new(SquareSize { width: 1, height: 1 }, &mut ids);
    let graph = Graph::new();
    let mut maze = Maze::new(field, graph);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_START);
    let result = CreateStartStrategy.apply(&issue, &mut maze, &mut rng);
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.meta.start.is_none());
}

#[test]
fn create_finish_sets_finish_not_equal_start() {
    let mut maze = make_maze(3, 1);
    let node_ids: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.graph.add_bidirectional_edge(node_ids[0], node_ids[1], EdgeKind::Basic);
    maze.graph.add_bidirectional_edge(node_ids[1], node_ids[2], EdgeKind::Basic);
    maze.meta.start = Some(node_ids[0]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_FINISH);
    let result = CreateFinishStrategy.apply(&issue, &mut maze, &mut rng);
    assert!(matches!(result, RepairResult::Fixed));
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.finish, maze.meta.start);
}

#[test]
fn create_finish_deferred_when_no_start() {
    let mut maze = make_maze(2, 1);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_FINISH);
    let result = CreateFinishStrategy.apply(&issue, &mut maze, &mut rng);
    assert!(matches!(result, RepairResult::Deferred));
    assert!(maze.meta.finish.is_none());
}

#[test]
fn create_finish_single_node_returns_failed() {
    let mut maze = make_maze(1, 1);
    let node_ids: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(node_ids[0]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_FINISH);
    let result = CreateFinishStrategy.apply(&issue, &mut maze, &mut rng);
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.meta.finish.is_none());
}

#[test]
fn repair_engine_routes_by_kind() {
    let mut maze = make_maze(2, 1);
    let mut rng = make_rng();
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareField>>> = HashMap::new();
    strategies.insert(MISSING_START, Box::new(CreateStartStrategy));
    let engine = RepairEngine::new(strategies);
    let issues = vec![Issue::new(MISSING_START)];
    let results = engine.run(&issues, &mut maze, &mut rng);
    assert_eq!(results.len(), 1);
    assert!(matches!(results[0].1, RepairResult::Fixed));
    assert!(maze.meta.start.is_some());
}

#[test]
fn repair_engine_no_strategy_leaves_unresolved() {
    let mut maze = make_maze(2, 1);
    let mut rng = make_rng();
    let engine: RepairEngine<SquareField> = RepairEngine::new(HashMap::new());
    let issues = vec![Issue::new(MISSING_START)];
    let results = engine.run(&issues, &mut maze, &mut rng);
    assert!(results.is_empty());
    assert!(maze.meta.start.is_none());
}

#[test]
fn create_start_no_override() {
    let mut maze = make_maze(3, 1);
    let node_ids: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(node_ids[0]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_START);
    let result = CreateStartStrategy.apply(&issue, &mut maze, &mut rng);
    assert!(matches!(result, RepairResult::Fixed));
    assert_eq!(maze.meta.start, Some(node_ids[0]));
}

#[test]
fn create_finish_isolated_start_returns_failed() {
    let mut maze = make_maze(3, 1);
    let node_ids: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(node_ids[0]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_FINISH);
    let result = CreateFinishStrategy.apply(&issue, &mut maze, &mut rng);
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.meta.finish.is_none());
}

#[test]
fn repair_deterministic() {
    let make_engine_and_maze = || {
        let mut maze = make_maze(3, 1);
        let node_ids: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
        maze.graph.add_bidirectional_edge(node_ids[0], node_ids[1], EdgeKind::Basic);
        maze.graph.add_bidirectional_edge(node_ids[1], node_ids[2], EdgeKind::Basic);
        let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareField>>> = HashMap::new();
        strategies.insert(MISSING_START, Box::new(CreateStartStrategy));
        strategies.insert(MISSING_FINISH, Box::new(CreateFinishStrategy));
        (maze, RepairEngine::new(strategies))
    };
    let run = || {
        let (mut maze, engine) = make_engine_and_maze();
        let mut rng = SmallRng::seed_from_u64(99);
        engine.run(&[Issue::new(MISSING_START)], &mut maze, &mut rng);
        engine.run(&[Issue::new(MISSING_FINISH)], &mut maze, &mut rng);
        (maze.meta.start, maze.meta.finish)
    };
    let (s1, f1) = run();
    let (s2, f2) = run();
    assert_eq!(s1, s2);
    assert_eq!(f1, f2);
    assert!(f1.is_some());
}
