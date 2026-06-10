use maze_core::{Graph, IdGenerator, Maze};
use maze_core::space::{Field, SquareTessellation, square_rect};
use maze_core::quality_control::{
    QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MISSING_ENDPOINTS, UNREACHABLE_FINISH,
};
use maze_core::graph::EdgeKind;

fn make_empty_square_maze() -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(2, 2), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    Maze::new(field, graph)
}

#[test]
fn missing_endpoints_check_detects_when_both_missing() {
    let maze = make_empty_square_maze();
    let engine = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck)]);
    let issues = engine.run(&maze);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, MISSING_ENDPOINTS);
}

#[test]
fn missing_endpoints_check_detects_when_only_start_missing() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.finish = Some(nodes[1]);
    let engine = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck)]);
    let issues = engine.run(&maze);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, MISSING_ENDPOINTS);
}

#[test]
fn missing_endpoints_check_detects_when_only_finish_missing() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(nodes[0]);
    let engine = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck)]);
    let issues = engine.run(&maze);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, MISSING_ENDPOINTS);
}

#[test]
fn missing_endpoints_check_no_false_positive_when_both_set() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let engine = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck)]);
    let issues = engine.run(&maze);
    assert!(issues.is_empty());
}

#[test]
fn unreachable_finish_check_detects_when_not_reachable() {
    let mut ids = IdGenerator::new();
    let field = Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let nodes: Vec<_> = graph.nodes().map(|n| n.id).collect();
    let mut maze = Maze::new(field, graph);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let engine = QualityControlEngine::new(vec![Box::new(UnreachableFinishCheck)]);
    let issues = engine.run(&maze);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, UNREACHABLE_FINISH);
}

#[test]
fn unreachable_finish_check_skips_when_endpoints_missing() {
    let maze = make_empty_square_maze();
    let engine = QualityControlEngine::new(vec![Box::new(UnreachableFinishCheck)]);
    let issues = engine.run(&maze);
    assert!(issues.is_empty());
}

#[test]
fn unreachable_finish_check_no_false_positive_when_reachable() {
    let mut ids = IdGenerator::new();
    let field = Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let nodes: Vec<_> = graph.nodes().map(|n| n.id).collect();
    graph.add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let mut maze = Maze::new(field, graph);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let engine = QualityControlEngine::new(vec![Box::new(UnreachableFinishCheck)]);
    let issues = engine.run(&maze);
    assert!(issues.is_empty());
}
