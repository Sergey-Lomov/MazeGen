use std::collections::HashMap;
use rand::SeedableRng;
use maze_core::random::MazeRng;
use maze_core::{Graph, IdGenerator, Maze, NodeId};
use maze_core::generation::PresetState;
use maze_core::graph::EdgeKind;
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::quality_control::{Rule, MissingEndpointsIssue};
use maze_core::quality_control::rule::apply_commands;
use maze_core::repair::{
    RepairResult, RepairStrategy, StrategyParams,
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
        maze.graph.build_initial_bidirectional_edge(ordered[i], ordered[i + 1], EdgeKind::Basic);
    }
    (maze, ordered)
}

fn make_rng() -> MazeRng {
    MazeRng::seed_from_u64(42)
}

fn no_params() -> StrategyParams {
    StrategyParams::new()
}

/// Calls `apply` then immediately applies the returned commands to `maze` — mirrors
/// `Rule::dispatch_repair_typed`'s own apply-then-commit sequencing (GitHub issue #118).
fn apply_and_commit<T: maze_core::space::Tessellation, I: maze_core::quality_control::IssueRequirement>(
    strategy: &impl RepairStrategy<T, I>,
    issue: &I,
    maze: &mut Maze<T>,
    rng: &mut dyn rand::RngCore,
    params: &StrategyParams,
    preset_state: &PresetState,
    nested: &[maze_core::repair::NestedStrategyConfig<T>],
) -> RepairResult {
    let (result, commands) = strategy.apply(issue, maze, rng, params, preset_state, nested);
    apply_commands(maze, preset_state, commands);
    result
}

// --- RandomEndpointsStrategy ---

#[test]
fn random_endpoints_sets_both_when_neither_set() {
    let (mut maze, _) = make_connected_maze(3);
    let mut rng = make_rng();
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&RandomEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&RandomEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&RandomEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&RandomEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&RandomEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn random_endpoints_isolated_start_returns_failed() {
    let mut maze = make_maze(3, 1);
    let start = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    maze.meta.start = Some(start);
    let mut rng = make_rng();
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&RandomEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.meta.finish.is_none());
}

// --- FarthestEndpointsStrategy ---

#[test]
fn farthest_endpoints_sets_both_when_neither_set() {
    let (mut maze, _) = make_connected_maze(5);
    let mut rng = make_rng();
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&FarthestEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&FarthestEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&FarthestEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&FarthestEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: _ }));
    assert_eq!(maze.meta.start, Some(ordered[0]));
    assert_eq!(maze.meta.finish, Some(ordered[4]));
}

#[test]
fn farthest_endpoints_deterministic() {
    let run = || {
        let (mut maze, _) = make_connected_maze(5);
        let mut rng = MazeRng::seed_from_u64(99);
        let issue = MissingEndpointsIssue::default();
        apply_and_commit(&FarthestEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    maze.graph.build_initial_bidirectional_edge(ordered[0], ordered[1], EdgeKind::Basic);
    maze.graph.build_initial_bidirectional_edge(ordered[2], ordered[3], EdgeKind::Basic);
    (maze, ordered)
}

#[test]
fn farthest_endpoints_disconnected_graph_stays_in_same_component() {
    let (mut maze, ordered) = make_disconnected_maze();
    maze.meta.start = Some(ordered[0]);
    let mut rng = make_rng();
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&FarthestEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let issue = MissingEndpointsIssue::default();
    let result = apply_and_commit(&FarthestEndpointsStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

// --- Rule::dispatch_repair routing ---
// (was "RepairEngine routing" against the pre-#106 flat `RepairEngine` — dispatch now lives
// directly on `Rule`, which owns its own strategy; there is no separate routing engine anymore.)

fn now_ms_stub() -> f64 { 0.0 }

fn rule_with_strategy(
    id: &str,
    strategy: Box<dyn RepairStrategy<SquareTessellation, MissingEndpointsIssue>>,
) -> Rule<SquareTessellation, MissingEndpointsIssue> {
    Rule::new(id.to_string(), vec![], Some(strategy), HashMap::new(), vec![])
}

#[test]
fn rule_dispatch_repair_runs_its_own_strategy() {
    let (mut maze, _) = make_connected_maze(3);
    let mut rng = make_rng();
    let rule = rule_with_strategy("g1", Box::new(RandomEndpointsStrategy));
    let issue = MissingEndpointsIssue::default();
    let mut timing = HashMap::new();
    let result = rule.dispatch_repair_typed(&issue, &mut maze, &mut rng, &PresetState::empty(), &mut timing, &now_ms_stub);
    assert!(matches!(result, Some((RepairResult::Fixed { score: _ }, _))));
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
}

#[test]
fn rule_dispatch_repair_none_when_no_strategy() {
    let mut maze = make_maze(2, 1);
    let mut rng = make_rng();
    let rule: Rule<SquareTessellation, MissingEndpointsIssue> = Rule::new("g1".to_string(), vec![], None, HashMap::new(), vec![]);
    let issue = MissingEndpointsIssue::default();
    let mut timing = HashMap::new();
    let result = rule.dispatch_repair_typed(&issue, &mut maze, &mut rng, &PresetState::empty(), &mut timing, &now_ms_stub);
    assert!(result.is_none());
    assert!(maze.meta.start.is_none());
}

#[test]
fn two_rules_same_kind_get_different_strategies() {
    // Two rules producing the same IssueKind (MISSING_ENDPOINTS here, standing in for the
    // real-world min/max loop length case) dispatch to their own strategy independently — each
    // `Rule` owns its own strategy, so there is no shared routing table to get this wrong.
    let (mut maze_a, _) = make_connected_maze(3);
    let (mut maze_b, _) = make_connected_maze(5);
    let mut rng_a = make_rng();
    let mut rng_b = make_rng();
    let rule_a = rule_with_strategy("g_random", Box::new(RandomEndpointsStrategy));
    let rule_b = rule_with_strategy("g_farthest", Box::new(FarthestEndpointsStrategy));
    let issue = MissingEndpointsIssue::default();
    let mut timing_a = HashMap::new();
    let mut timing_b = HashMap::new();
    let result_a = rule_a.dispatch_repair_typed(&issue, &mut maze_a, &mut rng_a, &PresetState::empty(), &mut timing_a, &now_ms_stub);
    let result_b = rule_b.dispatch_repair_typed(&issue, &mut maze_b, &mut rng_b, &PresetState::empty(), &mut timing_b, &now_ms_stub);
    assert!(matches!(result_a, Some((RepairResult::Fixed { score: _ }, _))));
    assert!(matches!(result_b, Some((RepairResult::Fixed { score: _ }, _))));
}
