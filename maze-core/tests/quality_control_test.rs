use maze_core::{Graph, IdGenerator, Maze, RegionClass};
use maze_core::space::{Field, SquareTessellation, square_rect};
use maze_core::quality_control::{
    Rule, Check, Issue, IssueMerge, IssueRequirement, MissingEndpointsCheck, UnreachableFinishCheck, MinRegionCountCheck,
    MissingEndpointsIssue, UnreachableFinishIssue, MissingRegionsIssue,
};
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

fn now_ms_stub() -> f64 { 0.0 }

fn run_checks<T: maze_core::space::Tessellation, I: Issue + IssueMerge + IssueRequirement>(
    checks: Vec<(String, Box<dyn Check<T, I>>)>,
    maze: &Maze<T>,
) -> Vec<I> {
    let rule = Rule::new("r".to_string(), checks, None, HashMap::new(), vec![]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let mut timing = HashMap::new();
    rule.run_checks_typed(maze, &mut rng, &mut timing, &now_ms_stub, None).into_iter().collect::<Vec<_>>()
}

fn report_checks<T: maze_core::space::Tessellation, I: Issue + IssueMerge + IssueRequirement>(
    checks: Vec<(String, Box<dyn Check<T, I>>)>,
    maze: &Maze<T>,
) -> Vec<I> {
    let rule = Rule::new("r".to_string(), checks, None, HashMap::new(), vec![]);
    let mut rng = maze_core::random::MazeRng::seed_from_u64(0);
    let mut timing = HashMap::new();
    rule.report_checks_typed(maze, &mut rng, &mut timing, &now_ms_stub)
}

#[test]
fn missing_endpoints_check_detects_when_both_missing() {
    let maze = make_empty_square_maze();
    let issues: Vec<MissingEndpointsIssue> = run_checks(
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }))],
        &maze,
    );
    assert_eq!(issues.len(), 1);
}

#[test]
fn missing_endpoints_check_detects_when_only_start_missing() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.finish = Some(nodes[1]);
    let issues: Vec<MissingEndpointsIssue> = run_checks(
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }))],
        &maze,
    );
    assert_eq!(issues.len(), 1);
}

#[test]
fn missing_endpoints_check_detects_when_only_finish_missing() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(nodes[0]);
    let issues: Vec<MissingEndpointsIssue> = run_checks(
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }))],
        &maze,
    );
    assert_eq!(issues.len(), 1);
}

#[test]
fn missing_endpoints_check_no_false_positive_when_both_set() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let issues: Vec<MissingEndpointsIssue> = run_checks(
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }))],
        &maze,
    );
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
    let issues: Vec<UnreachableFinishIssue> = run_checks(
        vec![("unreachable_finish".to_string(), Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() }))],
        &maze,
    );
    assert_eq!(issues.len(), 1);
}

#[test]
fn unreachable_finish_check_skips_when_endpoints_missing() {
    let maze = make_empty_square_maze();
    let issues: Vec<UnreachableFinishIssue> = run_checks(
        vec![("unreachable_finish".to_string(), Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() }))],
        &maze,
    );
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
    let issues: Vec<UnreachableFinishIssue> = run_checks(
        vec![("unreachable_finish".to_string(), Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() }))],
        &maze,
    );
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

    let issues: Vec<MissingRegionsIssue> = run_checks(
        vec![("0".to_string(), Box::new(MinRegionCountCheck {
            instance_id: "rule_a:0".to_string(),
            min_counts: HashMap::from([(RegionClass::Trap, 2), (RegionClass::Alternative, 2)]),
        }))],
        &maze,
    );

    assert_eq!(issues.len(), 1, "one instance, one issue, even with multiple classes off-target");
    assert_eq!(issues[0].balance_by_class, HashMap::from([(RegionClass::Trap, -1), (RegionClass::Alternative, -1)]),
        "1 trap region found (2 required) and 1 alternative region found (2 required) -> both -1");
}

// --- Rule::run_checks merges multiple checks within the same rule ---

#[test]
fn run_checks_merges_two_checks_producing_the_same_kind_into_one_issue() {
    // Two checks in the same rule both flagging MISSING_ENDPOINTS (data-less, so a plain
    // source_checks union) must collapse into one merged Issue with both source ids attributed —
    // Rule::run_checks's own responsibility since GitHub issue #106, tested directly here rather
    // than only transitively through pipeline_test.rs's full build_maze scenarios.
    let maze = make_empty_square_maze();
    let checks: Vec<(String, Box<dyn Check<SquareTessellation, MissingEndpointsIssue>>)> = vec![
        ("a".to_string(), Box::new(MissingEndpointsCheck { instance_id: "r:a".to_string() })),
        ("b".to_string(), Box::new(MissingEndpointsCheck { instance_id: "r:b".to_string() })),
    ];
    let issues = run_checks(checks, &maze);
    assert_eq!(issues.len(), 1, "two checks in one rule must merge into a single issue");
    assert_eq!(issues[0].source_checks(), vec!["r:a".to_string(), "r:b".to_string()]);
}

#[test]
fn run_checks_returns_none_when_no_check_in_the_rule_finds_anything() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let checks: Vec<(String, Box<dyn Check<SquareTessellation, MissingEndpointsIssue>>)> =
        vec![("a".to_string(), Box::new(MissingEndpointsCheck { instance_id: "r:a".to_string() }))];
    let issues = run_checks(checks, &maze);
    assert!(issues.is_empty(), "no check found anything -> run_checks returns None, collected as empty");
}

// --- Rule::report_checks does not merge (one Issue per flagged problem instance, issue #102) ---

#[test]
fn report_checks_does_not_merge_two_checks_into_one_issue() {
    // Same two-check-in-one-rule setup as run_checks_merges_two_checks_... above, but via
    // report_checks — must produce TWO separate issues instead of one merged issue, since
    // report_check's whole contract (GitHub issue #102) is one Issue per flagged instance.
    let maze = make_empty_square_maze();
    let checks: Vec<(String, Box<dyn Check<SquareTessellation, MissingEndpointsIssue>>)> = vec![
        ("a".to_string(), Box::new(MissingEndpointsCheck { instance_id: "r:a".to_string() })),
        ("b".to_string(), Box::new(MissingEndpointsCheck { instance_id: "r:b".to_string() })),
    ];
    let issues = report_checks(checks, &maze);
    assert_eq!(issues.len(), 2, "report_checks must not merge — one issue per check, not one merged issue");
    let sources: Vec<&str> = issues.iter().flat_map(|i| i.source_checks()).map(|s| s.as_str()).collect();
    assert!(sources.contains(&"r:a") && sources.contains(&"r:b"));
}

#[test]
fn report_checks_returns_empty_when_nothing_flagged() {
    let mut maze = make_empty_square_maze();
    let nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let checks: Vec<(String, Box<dyn Check<SquareTessellation, MissingEndpointsIssue>>)> =
        vec![("a".to_string(), Box::new(MissingEndpointsCheck { instance_id: "r:a".to_string() }))];
    assert!(report_checks(checks, &maze).is_empty());
}

// --- Rule::checks() / has_strategy() accessors ---

#[test]
fn checks_accessor_returns_local_ids_and_check_type_ids_in_configured_order() {
    let checks: Vec<(String, Box<dyn Check<SquareTessellation, MissingEndpointsIssue>>)> = vec![
        ("first".to_string(), Box::new(MissingEndpointsCheck { instance_id: "r:first".to_string() })),
    ];
    let rule = Rule::new("r".to_string(), checks, None, HashMap::new(), vec![]);
    let observed: Vec<(&str, &'static str)> = rule.checks().map(|(id, c)| (id, c.check_type_id())).collect();
    assert_eq!(observed, vec![("first", "missing_endpoints")]);
}

#[test]
fn has_strategy_reflects_constructor_argument() {
    let with_strategy: Rule<SquareTessellation, MissingEndpointsIssue> = Rule::new(
        "r1".to_string(), vec![],
        Some(Box::new(maze_core::repair::FarthestEndpointsStrategy)), HashMap::new(), vec![],
    );
    assert!(with_strategy.has_strategy());

    let without_strategy: Rule<SquareTessellation, MissingEndpointsIssue> = Rule::new("r2".to_string(), vec![], None, HashMap::new(), vec![]);
    assert!(!without_strategy.has_strategy());
}
