use maze_core::{Graph, IdGenerator, Maze, RegionClass};
use maze_core::space::{Field, SquareTessellation, square_rect};
use maze_core::quality_control::{
    QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MinRegionCountCheck, MISSING_ENDPOINTS, UNREACHABLE_FINISH, MISSING_REGIONS,
};
use maze_core::quality_control::IssueData;
use maze_core::graph::EdgeKind;
use rand::SeedableRng;
use std::collections::HashMap;

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
    let engine = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() })]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let issues = engine.run(&maze, &mut rng);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, MISSING_ENDPOINTS);
}

#[test]
fn missing_endpoints_check_detects_when_only_start_missing() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.finish = Some(nodes[1]);
    let engine = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() })]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let issues = engine.run(&maze, &mut rng);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, MISSING_ENDPOINTS);
}

#[test]
fn missing_endpoints_check_detects_when_only_finish_missing() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(nodes[0]);
    let engine = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() })]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let issues = engine.run(&maze, &mut rng);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, MISSING_ENDPOINTS);
}

#[test]
fn missing_endpoints_check_no_false_positive_when_both_set() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let engine = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() })]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let issues = engine.run(&maze, &mut rng);
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
    let engine = QualityControlEngine::new(vec![Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() })]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let issues = engine.run(&maze, &mut rng);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, UNREACHABLE_FINISH);
}

#[test]
fn unreachable_finish_check_skips_when_endpoints_missing() {
    let maze = make_empty_square_maze();
    let engine = QualityControlEngine::new(vec![Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() })]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let issues = engine.run(&maze, &mut rng);
    assert!(issues.is_empty());
}

#[test]
fn unreachable_finish_check_no_false_positive_when_reachable() {
    let mut ids = IdGenerator::new();
    let field = Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let nodes: Vec<_> = graph.nodes().map(|n| n.id).collect();
    graph.build_initial_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let mut maze = Maze::new(field, graph);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let engine = QualityControlEngine::new(vec![Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() })]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let issues = engine.run(&maze, &mut rng);
    assert!(issues.is_empty());
}

// A single `MinRegionCountCheck` instance evaluating two classes (Trap and Alternative) at once
// — GitHub issue #60's multi-instance design (one instance per `region_class`) is retired, since
// one instance now reports every off-target class's balance in one issue. Layout: start(0) -> 1
// -> finish(2), 1 -> 3 -> 2 (alternative route), 1 -> 6 (trap dead end) — same shape as
// region_class.rs's own `classifies_all_four_kinds` test.
#[test]
fn one_min_region_count_instance_reports_multiple_classes_at_once() {
    let mut ids = IdGenerator::new();
    let field = Field::<SquareTessellation>::new(square_rect(7, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let nodes: Vec<_> = graph.nodes().map(|n| n.id).collect();
    graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    graph.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
    graph.build_initial_edge(nodes[1], nodes[3], EdgeKind::Basic);
    graph.build_initial_edge(nodes[3], nodes[2], EdgeKind::Basic);
    graph.build_initial_edge(nodes[1], nodes[6], EdgeKind::Basic);
    let mut maze = Maze::new(field, graph);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);

    let engine = QualityControlEngine::new(vec![
        Box::new(MinRegionCountCheck {
            instance_id: "rule_a:0".to_string(),
            min_counts: HashMap::from([(RegionClass::Trap, 2), (RegionClass::Alternative, 2)]),
        }),
    ]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let issues = engine.run(&maze, &mut rng);

    assert_eq!(issues.len(), 1, "one instance, one issue, even with multiple classes off-target");
    assert_eq!(issues[0].kind, MISSING_REGIONS);
    match &issues[0].data {
        Some(IssueData::MissingRegions { balance_by_class }) =>
            assert_eq!(balance_by_class, &HashMap::from([(RegionClass::Trap, -1), (RegionClass::Alternative, -1)]),
                "1 trap region found (2 required) and 1 alternative region found (2 required) -> both -1"),
        other => panic!("expected rule_a:0 to report MissingRegions, got {other:?}"),
    }
}
