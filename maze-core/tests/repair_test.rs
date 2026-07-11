use std::collections::HashMap;
use rand::SeedableRng;
use maze_core::random::MazeRng;
use maze_core::{Graph, IdGenerator, Maze, NodeId};
use maze_core::generation::PresetState;
use maze_core::graph::EdgeKind;
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::quality_control::{Rule, MissingEndpointsIssue};
use maze_core::repair::{
    RepairResult, RepairStrategy, StrategyParams,
    RandomEndpointsStrategy, FarthestEndpointsStrategy, SnapshotStack,
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

// --- RandomEndpointsStrategy ---

#[test]
fn random_endpoints_sets_both_when_neither_set() {
    let (mut maze, _) = make_connected_maze(3);
    let mut rng = make_rng();
    let issue = MissingEndpointsIssue::default();
    let result = RepairStrategy::apply(&RandomEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let result = RepairStrategy::apply(&RandomEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let result = RepairStrategy::apply(&RandomEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let result = RepairStrategy::apply(&RandomEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let result = RepairStrategy::apply(&RandomEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn random_endpoints_isolated_start_returns_failed() {
    let mut maze = make_maze(3, 1);
    let start = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    maze.meta.start = Some(start);
    let mut rng = make_rng();
    let issue = MissingEndpointsIssue::default();
    let result = RepairStrategy::apply(&RandomEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.meta.finish.is_none());
}

// --- FarthestEndpointsStrategy ---

#[test]
fn farthest_endpoints_sets_both_when_neither_set() {
    let (mut maze, _) = make_connected_maze(5);
    let mut rng = make_rng();
    let issue = MissingEndpointsIssue::default();
    let result = RepairStrategy::apply(&FarthestEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let result = RepairStrategy::apply(&FarthestEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let result = RepairStrategy::apply(&FarthestEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let result = RepairStrategy::apply(&FarthestEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
        RepairStrategy::apply(&FarthestEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let result = RepairStrategy::apply(&FarthestEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    let result = RepairStrategy::apply(&FarthestEndpointsStrategy, &issue, &mut maze, &mut SnapshotStack::new(), &mut rng, &no_params(), &PresetState::empty(), &[]);
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
    assert!(matches!(result, Some(RepairResult::Fixed { score: _ })));
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
    assert!(matches!(result_a, Some(RepairResult::Fixed { score: _ })));
    assert!(matches!(result_b, Some(RepairResult::Fixed { score: _ })));
}

// --- SnapshotStack ---

#[test]
fn snapshot_restore_reverts_full_graph_structure() {
    let (mut maze, ordered) = make_connected_maze(4);
    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    let before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();

    // Mutate several independent parts at once: remove an edge, add a node, add a new edge.
    let e = maze.graph.edge_between(ordered[0], ordered[1]).unwrap();
    maze.graph.remove_initial_edge(e);
    let new_node: NodeId = ordered.iter().max().unwrap() + 1;
    maze.graph.add_node(new_node);
    maze.graph.build_initial_edge(ordered[2], ordered[3], EdgeKind::Basic);

    stack.restore(&mut maze);

    let after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(before, after);
    assert_eq!(maze.graph.node_count(), ordered.len());
}

#[test]
fn snapshot_restore_reverts_full_meta() {
    let (mut maze, ordered) = make_connected_maze(3);
    maze.meta.start = Some(ordered[0]);
    maze.meta.finish = Some(ordered[2]);
    maze.meta.route_score = Some(1.5);

    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    maze.meta.start = Some(ordered[1]);
    maze.meta.finish = None;
    maze.meta.route_score = Some(9.9);

    stack.restore(&mut maze);

    assert_eq!(maze.meta.start, Some(ordered[0]));
    assert_eq!(maze.meta.finish, Some(ordered[2]));
    assert_eq!(maze.meta.route_score, Some(1.5));
}

#[test]
fn snapshot_stack_restores_in_lifo_order() {
    let (mut maze, ordered) = make_connected_maze(3);
    let mut stack = SnapshotStack::new();

    stack.snapshot(&maze); // depth 1: start=None
    maze.meta.start = Some(ordered[0]);
    stack.snapshot(&maze); // depth 2: start=ordered[0]
    maze.meta.start = Some(ordered[1]);

    stack.restore(&mut maze);
    assert_eq!(maze.meta.start, Some(ordered[0]));

    stack.restore(&mut maze);
    assert_eq!(maze.meta.start, None);
}

#[test]
fn snapshot_stack_supports_interleaved_snapshot_restore() {
    let (mut maze, ordered) = make_connected_maze(3);
    let mut stack = SnapshotStack::new();

    stack.snapshot(&maze);
    maze.meta.start = Some(ordered[0]);
    stack.restore(&mut maze);
    assert_eq!(maze.meta.start, None);

    stack.snapshot(&maze);
    maze.meta.start = Some(ordered[1]);
    stack.restore(&mut maze);
    assert_eq!(maze.meta.start, None);
}

#[test]
fn restore_bumps_version_strictly_past_pre_restore_version() {
    let (mut maze, ordered) = make_connected_maze(3);
    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    maze.graph.build_initial_edge(ordered[0], ordered[2], EdgeKind::Basic);
    let version_before_restore = maze.graph.version();

    stack.restore(&mut maze);

    assert!(maze.graph.version() > version_before_restore,
        "restored version {} must be strictly greater than pre-restore version {}",
        maze.graph.version(), version_before_restore);
}

#[test]
fn restore_version_monotonic_across_multiple_restores() {
    let (mut maze, ordered) = make_connected_maze(4);
    let mut stack = SnapshotStack::new();

    stack.snapshot(&maze);
    maze.graph.build_initial_edge(ordered[0], ordered[2], EdgeKind::Basic);
    stack.snapshot(&maze);
    maze.graph.build_initial_edge(ordered[1], ordered[3], EdgeKind::Basic);

    let v0 = maze.graph.version();
    stack.restore(&mut maze);
    let v1 = maze.graph.version();
    assert!(v1 > v0, "first restore must strictly increase version");

    maze.graph.build_initial_edge(ordered[0], ordered[3], EdgeKind::Basic);
    let v2 = maze.graph.version();
    stack.restore(&mut maze);
    let v3 = maze.graph.version();
    assert!(v3 > v2, "second restore must strictly increase version");
}

#[test]
fn restore_invalidates_nav_graph_cache() {
    let (mut maze, ordered) = make_connected_maze(4);
    maze.meta.start = Some(ordered[0]);
    maze.meta.finish = Some(ordered[3]);
    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    // Cache nav_graph at an intermediate, soon-to-be-rolled-back state.
    let e = maze.graph.edge_between(ordered[1], ordered[2]).unwrap();
    maze.graph.remove_initial_edge(e);
    let intermediate_nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
    let intermediate_count = intermediate_nav.edges().count();

    stack.restore(&mut maze);

    let restored_nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
    let restored_count = restored_nav.edges().count();
    assert_ne!(restored_count, intermediate_count, "nav_graph must reflect the restored topology, not the cached intermediate one");
}

#[test]
fn restore_invalidates_scc_cache() {
    let (mut maze, ordered) = make_disconnected_maze();
    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    // Connect the two components at an intermediate state, cache scc, then roll back.
    maze.graph.build_initial_bidirectional_edge(ordered[1], ordered[2], EdgeKind::Basic);
    let intermediate_scc = maze.analysis.scc(&maze.graph);
    assert_eq!(intermediate_scc.components.len(), 1, "bridging edge must merge both components into one");

    stack.restore(&mut maze);

    let restored_scc = maze.analysis.scc(&maze.graph);
    assert_eq!(restored_scc.components.len(), 2, "scc must reflect the restored (disconnected) topology, not the cached intermediate one");
}

#[test]
fn restore_invalidates_route_info_cache() {
    let (mut maze, ordered) = make_connected_maze(4);
    maze.meta.start = Some(ordered[0]);
    maze.meta.finish = Some(ordered[3]);
    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    let intermediate_route = maze.analysis.route_info(&maze.graph, &maze.meta);
    assert!(intermediate_route.is_some(), "route must exist before the bridge is cut");

    let e = maze.graph.edge_between(ordered[1], ordered[2]).unwrap();
    maze.graph.remove_initial_edge(e);
    let e_rev = maze.graph.edge_between(ordered[2], ordered[1]).unwrap();
    maze.graph.remove_initial_edge(e_rev);
    let cut_route = maze.analysis.route_info(&maze.graph, &maze.meta);
    assert!(cut_route.is_none(), "route must be gone once the only bridge is cut");

    stack.restore(&mut maze);

    let restored_route = maze.analysis.route_info(&maze.graph, &maze.meta);
    assert!(restored_route.is_some(), "route_info must reflect the restored topology, not the cached cut-bridge state");
}

#[test]
fn restore_invalidates_graph_analytics_cache() {
    let (mut maze, ordered) = make_connected_maze(4);
    maze.meta.start = Some(ordered[0]);
    maze.meta.finish = Some(ordered[3]);
    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    // Add a bridging edge that creates a cycle, cache graph_analytics on that intermediate
    // state, then roll back.
    maze.graph.build_initial_bidirectional_edge(ordered[0], ordered[3], EdgeKind::Basic);
    let intermediate = maze.analysis.graph_analytics(&maze.graph, &maze.meta);
    assert!(intermediate.cycle_count > 0, "added bridge must create a cycle");

    stack.restore(&mut maze);

    let restored = maze.analysis.graph_analytics(&maze.graph, &maze.meta);
    assert_eq!(restored.cycle_count, 0, "graph_analytics must reflect the restored (acyclic) topology, not the cached intermediate one");
}

#[test]
fn restore_invalidates_distance_from_start_cache() {
    let (mut maze, ordered) = make_connected_maze(4);
    maze.meta.start = Some(ordered[0]);
    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    // Extending the corridor changes the tile-distance to the far end.
    let new_node: NodeId = ordered.iter().max().unwrap() + 1;
    maze.graph.add_node(new_node);
    maze.graph.build_initial_bidirectional_edge(ordered[3], new_node, EdgeKind::Basic);
    let intermediate = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
    let intermediate_max = *intermediate.values().max().unwrap();

    stack.restore(&mut maze);

    let restored = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
    let restored_max = *restored.values().max().unwrap();
    assert_ne!(restored_max, intermediate_max, "distance_from_start must reflect the restored topology, not the cached intermediate one");
}

#[test]
fn restore_invalidates_distance_from_finish_cache() {
    let (mut maze, ordered) = make_connected_maze(4);
    maze.meta.finish = Some(ordered[3]);
    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    let new_node: NodeId = ordered.iter().max().unwrap() + 1;
    maze.graph.add_node(new_node);
    maze.graph.build_initial_bidirectional_edge(ordered[0], new_node, EdgeKind::Basic);
    let intermediate = maze.analysis.distance_from_finish(&maze.graph, &maze.meta).unwrap();
    let intermediate_max = *intermediate.values().max().unwrap();

    stack.restore(&mut maze);

    let restored = maze.analysis.distance_from_finish(&maze.graph, &maze.meta).unwrap();
    let restored_max = *restored.values().max().unwrap();
    assert_ne!(restored_max, intermediate_max, "distance_from_finish must reflect the restored topology, not the cached intermediate one");
}

#[test]
fn restore_with_no_mutation_still_bumps_version() {
    // snapshot() immediately followed by restore() with nothing mutated in between — version
    // must still strictly increase, since it's a cache-invalidation counter, not a content
    // fingerprint (see SnapshotStack::restore doc comment).
    let (mut maze, _) = make_connected_maze(3);
    let mut stack = SnapshotStack::new();
    stack.snapshot(&maze);

    let version_before = maze.graph.version();
    stack.restore(&mut maze);

    assert!(maze.graph.version() > version_before,
        "version must strictly increase even when restored content is identical to pre-restore content");
}

#[test]
fn snapshot_stack_default_is_empty_and_panics_on_restore() {
    let (mut maze, _) = make_connected_maze(3);
    let mut stack = SnapshotStack::default();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| stack.restore(&mut maze)));
    assert!(result.is_err(), "SnapshotStack::default() must start with an empty stack, same as new()");
}

#[test]
fn snapshot_always_pushes_even_without_intervening_mutation() {
    let (mut maze, ordered) = make_connected_maze(3);
    maze.meta.start = Some(ordered[0]);
    let mut stack = SnapshotStack::new();

    stack.snapshot(&maze);
    stack.snapshot(&maze); // no mutation between the two snapshot() calls

    maze.meta.start = Some(ordered[1]);
    stack.restore(&mut maze);
    assert_eq!(maze.meta.start, Some(ordered[0]));

    maze.meta.start = Some(ordered[2]);
    stack.restore(&mut maze);
    assert_eq!(maze.meta.start, Some(ordered[0]));
}

#[test]
#[should_panic(expected = "restore() called with empty snapshot stack")]
fn restore_on_empty_stack_panics() {
    let (mut maze, _) = make_connected_maze(3);
    let mut stack = SnapshotStack::new();
    stack.restore(&mut maze);
}
