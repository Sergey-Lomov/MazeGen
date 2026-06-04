use maze_core::{Graph, IdGenerator, Maze, Field};
use maze_core::space::{SquareField, SquareSize};
use maze_core::quality_control::{
    QualityControlEngine, MissingStartCheck, MissingFinishCheck, MISSING_START, MISSING_FINISH,
};

fn make_empty_square_maze() -> Maze<SquareField> {
    let mut ids = IdGenerator::new();
    let field = SquareField::new(SquareSize { width: 2, height: 2 }, &mut ids);
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    Maze::new(field, graph)
}

#[test]
fn missing_start_check_detects_missing() {
    let maze = make_empty_square_maze();
    let engine = QualityControlEngine::new(vec![Box::new(MissingStartCheck)]);
    let issues = engine.run(&maze);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, MISSING_START);
}

#[test]
fn missing_finish_check_detects_missing() {
    let maze = make_empty_square_maze();
    let engine = QualityControlEngine::new(vec![Box::new(MissingFinishCheck)]);
    let issues = engine.run(&maze);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, MISSING_FINISH);
}

#[test]
fn missing_start_check_no_false_positive() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(nodes[0]);
    let engine = QualityControlEngine::new(vec![Box::new(MissingStartCheck)]);
    let issues = engine.run(&maze);
    assert!(issues.is_empty());
}

#[test]
fn missing_finish_check_no_false_positive() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.finish = Some(nodes[1]);
    let engine = QualityControlEngine::new(vec![Box::new(MissingFinishCheck)]);
    let issues = engine.run(&maze);
    assert!(issues.is_empty());
}
