use std::collections::HashMap;
use rand::SeedableRng;
use rand::rngs::SmallRng;
use maze_core::{Graph, IdGenerator, Maze, NodeId};
use maze_core::generation::PresetState;
use maze_core::graph::EdgeKind;
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::quality_control::{Issue, MISSING_ENDPOINTS};
use maze_core::repair::{
    QcRule, RepairEngine, RepairRuleConfig, RepairResult, RepairStrategy, StrategyParams,
    RandomEndpointsStrategy, FarthestEndpointsStrategy,
};

fn make_maze(n_cols: usize, n_rows: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(n_cols, n_rows), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    Maze::new(field, graph)
}

fn make_connected_maze(n_cols: usize) -> (Maze<SquareTessellation>, Vec<NodeId>) {
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
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
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
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
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
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
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
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
    assert_eq!(maze.meta.start, Some(ordered[0]));
    assert_eq!(maze.meta.finish, Some(ordered[2]));
}

#[test]
fn random_endpoints_empty_graph_returns_failed() {
    let mut ids = IdGenerator::new();
    let field = Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap();
    let graph = Graph::new();
    let mut maze = Maze::new(field, graph);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn random_endpoints_isolated_start_returns_failed() {
    let mut maze = make_maze(3, 1);
    let start = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    maze.meta.start = Some(start);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = RandomEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.meta.finish.is_none());
}

// --- FarthestEndpointsStrategy ---

#[test]
fn farthest_endpoints_sets_both_when_neither_set() {
    let (mut maze, _) = make_connected_maze(5);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.start, maze.meta.finish);
}

#[test]
fn farthest_endpoints_sets_finish_when_only_start_set() {
    let (mut maze, ordered) = make_connected_maze(5);
    maze.meta.start = Some(ordered[0]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
    assert_eq!(maze.meta.start, Some(ordered[0]));
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.finish, maze.meta.start);
}

#[test]
fn farthest_endpoints_sets_start_when_only_finish_set() {
    let (mut maze, ordered) = make_connected_maze(5);
    maze.meta.finish = Some(ordered[4]);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
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
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
    assert_eq!(maze.meta.start, Some(ordered[0]));
    assert_eq!(maze.meta.finish, Some(ordered[4]));
}

#[test]
fn farthest_endpoints_deterministic() {
    let run = || {
        let (mut maze, _) = make_connected_maze(5);
        let mut rng = SmallRng::seed_from_u64(99);
        let issue = Issue::new(MISSING_ENDPOINTS);
        FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
        (maze.meta.start, maze.meta.finish)
    };
    let (s1, f1) = run();
    let (s2, f2) = run();
    assert_eq!(s1, s2);
    assert_eq!(f1, f2);
    assert!(f1.is_some());
}

fn make_disconnected_maze() -> (Maze<SquareTessellation>, Vec<NodeId>) {
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
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
    let finish = maze.meta.finish.expect("finish must be set");
    assert!(finish == ordered[0] || finish == ordered[1],
        "finish {finish} must be in same component as start {}", ordered[0]);
    assert_ne!(maze.meta.finish, maze.meta.start);
}

#[test]
fn farthest_endpoints_isolated_nav_node_returns_failed() {
    let mut maze = make_maze(1, 1);
    let mut rng = make_rng();
    let issue = Issue::new(MISSING_ENDPOINTS);
    let result = FarthestEndpointsStrategy.apply(&issue, &mut maze, &mut rng, &no_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
}

// --- RepairEngine routing ---

fn rule(id: &str, kind: maze_core::quality_control::IssueKind, checks: &[&str]) -> QcRule {
    QcRule { id: id.to_string(), kind, checks: checks.iter().map(|s| s.to_string()).collect() }
}

#[test]
fn repair_engine_routes_by_rule() {
    let (mut maze, _) = make_connected_maze(3);
    let mut rng = make_rng();
    let engine: RepairEngine<SquareTessellation> = RepairEngine::new(
        vec![RepairRuleConfig {
            rule: rule("g1", MISSING_ENDPOINTS, &["missing_endpoints"]),
            strategy: Box::new(RandomEndpointsStrategy),
            param_overrides: HashMap::new(),
        }],
        vec![rule("g1", MISSING_ENDPOINTS, &["missing_endpoints"])],
    );
    let issues = vec![("g1".to_string(), Issue::new(MISSING_ENDPOINTS))];
    let results = engine.run(&issues, &mut maze, &mut rng, &PresetState::empty());
    assert_eq!(results.len(), 1);
    assert!(matches!(results[0].result, RepairResult::Fixed { score: _ }));
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
}

#[test]
fn repair_engine_no_strategy_leaves_unresolved() {
    let mut maze = make_maze(2, 1);
    let mut rng = make_rng();
    let engine: RepairEngine<SquareTessellation> = RepairEngine::new(vec![], vec![]);
    let issues = vec![("g1".to_string(), Issue::new(MISSING_ENDPOINTS))];
    let results = engine.run(&issues, &mut maze, &mut rng, &PresetState::empty());
    assert!(results.is_empty());
    assert!(maze.meta.start.is_none());
}

#[test]
fn repair_engine_two_rules_same_kind_get_different_strategies() {
    // Two rules producing the same IssueKind (MISSING_ENDPOINTS here, standing in for the
    // real-world min/max loop length case) must dispatch to their own strategy independently.
    let (mut maze_a, _) = make_connected_maze(3);
    let (mut maze_b, _) = make_connected_maze(5);
    let mut rng_a = make_rng();
    let mut rng_b = make_rng();
    let engine: RepairEngine<SquareTessellation> = RepairEngine::new(
        vec![
            RepairRuleConfig {
                rule: rule("g_random", MISSING_ENDPOINTS, &["missing_endpoints"]),
                strategy: Box::new(RandomEndpointsStrategy),
                param_overrides: HashMap::new(),
            },
            RepairRuleConfig {
                rule: rule("g_farthest", MISSING_ENDPOINTS, &["unreachable_finish"]),
                strategy: Box::new(FarthestEndpointsStrategy),
                param_overrides: HashMap::new(),
            },
        ],
        vec![
            rule("g_random", MISSING_ENDPOINTS, &["missing_endpoints"]),
            rule("g_farthest", MISSING_ENDPOINTS, &["unreachable_finish"]),
        ],
    );
    let issues_a = vec![("g_random".to_string(), Issue::new(MISSING_ENDPOINTS))];
    let issues_b = vec![("g_farthest".to_string(), Issue::new(MISSING_ENDPOINTS))];
    let results_a = engine.run(&issues_a, &mut maze_a, &mut rng_a, &PresetState::empty());
    let results_b = engine.run(&issues_b, &mut maze_b, &mut rng_b, &PresetState::empty());
    assert_eq!(results_a.len(), 1);
    assert_eq!(results_b.len(), 1);
    assert!(matches!(results_a[0].result, RepairResult::Fixed { score: _ }));
    assert!(matches!(results_b[0].result, RepairResult::Fixed { score: _ }));
}
