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

// Two independent `MinRegionCountCheck` instances (different `region_class` each) active in the
// same `QualityControlEngine` run — the real-check end-to-end counterpart to GitHub issue #60,
// not just the synthetic-issue merge unit tests in pipeline.rs's `merge_tests` module. Layout:
// start(0) -> 1 -> finish(2), 1 -> 3 -> 2 (alternative route), 1 -> 6 (trap dead end) — same
// shape as region_class.rs's own `classifies_all_four_kinds` test.
#[test]
fn two_min_region_count_instances_with_different_classes_both_fire_independently() {
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
        Box::new(MinRegionCountCheck { instance_id: "rule_a:0".to_string(), region_class: RegionClass::Trap, min_count: 2 }),
        Box::new(MinRegionCountCheck { instance_id: "rule_b:0".to_string(), region_class: RegionClass::Alternative, min_count: 2 }),
    ]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let issues = engine.run(&maze, &mut rng);

    assert_eq!(issues.len(), 2, "each instance fires its own issue, not deduplicated by type");
    for issue in &issues {
        assert_eq!(issue.kind, MISSING_REGIONS);
    }
    let by_source: HashMap<String, &IssueData> = issues.iter()
        .map(|i| (i.single_source_check().unwrap().to_string(), i.data.as_ref().unwrap()))
        .collect();
    match by_source.get("rule_a:0") {
        Some(IssueData::MissingRegions { missing_by_class }) =>
            assert_eq!(missing_by_class, &HashMap::from([(RegionClass::Trap, 1)]), "1 trap region found, 2 required"),
        other => panic!("expected rule_a:0 to report MissingRegions, got {other:?}"),
    }
    match by_source.get("rule_b:0") {
        Some(IssueData::MissingRegions { missing_by_class }) =>
            assert_eq!(missing_by_class, &HashMap::from([(RegionClass::Alternative, 1)]), "1 alternative region found, 2 required"),
        other => panic!("expected rule_b:0 to report MissingRegions, got {other:?}"),
    }
}
