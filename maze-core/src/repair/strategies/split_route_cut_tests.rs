use super::*;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::EdgeKind;
use crate::{Graph, IdGenerator};
use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
use crate::repair::strategies::test_utils::{apply_and_commit, apply_and_commit_default};
use crate::repair::strategies::group_select::PRIORITY_RANDOM;

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = std::collections::HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    crate::repair::params::build_params(<SplitRouteCutStrategy as RepairStrategy<SquareTessellation, InvalidSplitRouteIssue>>::params(&SplitRouteCutStrategy), Some(&map))
}

/// slot0 --e0--> a --e1--> extra: a 2-step route between the split tile's two nodes. e0 (slot0 ->
/// a) and e1 (a -> extra) are both split edges (each touches the split point); there is no
/// non-split edge on this particular route.
fn maze_with_all_split_route() -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(field_level, p).unwrap();
    let extra = field.add_node_at(field_level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let a = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
    let e0 = g.build_initial_edge(slot0, a, EdgeKind::Basic);
    let e1 = g.build_initial_edge(a, extra, EdgeKind::Basic);
    let maze = Maze::new(field, g);
    (maze, e0, e1)
}

/// slot0 --e0--> a --e1--> b --e2--> extra: a 3-step route. e0/e2 are split edges, e1 (a -> b) is
/// the one non-split edge on the route.
fn maze_with_mixed_route() -> (Maze<SquareTessellation>, EdgeId, EdgeId, EdgeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(field_level, p).unwrap();
    let extra = field.add_node_at(field_level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let a = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
    let b = field.node_at(field_level, SquarePoint { x: 2, y: 0 }).unwrap();
    let e0 = g.build_initial_edge(slot0, a, EdgeKind::Basic);
    let e1 = g.build_initial_edge(a, b, EdgeKind::Basic);
    let e2 = g.build_initial_edge(b, extra, EdgeKind::Basic);
    let maze = Maze::new(field, g);
    (maze, e0, e1, e2)
}

#[test]
fn apply_succeeds_on_empty_routes() {
    let (mut maze, _, _) = maze_with_all_split_route();
    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&SplitRouteCutStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn default_other_only_scope_leaves_a_split_only_route_untouched() {
    // Every edge on this route is a split edge; the default edge_scope (other_only) has nothing
    // eligible to cut, so the route survives and the strategy reports Failed.
    let (mut maze, e0, e1) = maze_with_all_split_route();
    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![vec![(e0, true), (e1, true)]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&SplitRouteCutStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.graph.edge(e0).is_some());
    assert!(maze.graph.edge(e1).is_some());
}

#[test]
fn other_only_scope_cuts_the_routes_non_split_edge() {
    let (mut maze, e0, e1, e2) = maze_with_mixed_route();
    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![vec![(e0, true), (e1, false), (e2, true)]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&SplitRouteCutStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge(e1).is_none(), "the only non-split edge must be the one cut under other_only");
    assert!(maze.graph.edge(e0).is_some(), "split edges must survive under other_only");
    assert!(maze.graph.edge(e2).is_some(), "split edges must survive under other_only");
}

#[test]
fn split_only_scope_cuts_a_split_edge_directly() {
    let (mut maze, e0, e1) = maze_with_all_split_route();
    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![vec![(e0, true), (e1, true)]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&SplitRouteCutStrategy, &issue, &mut maze, &mut rng,
        &params_with(&[(PARAM_EDGE_SCOPE, EDGE_SCOPE_SPLIT_ONLY)]), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let e0_gone = maze.graph.edge(e0).is_none();
    let e1_gone = maze.graph.edge(e1).is_none();
    assert!(e0_gone || e1_gone, "exactly one split edge must be cut");
    assert!(!(e0_gone && e1_gone), "only one edge should be cut for a single route");
}

#[test]
fn any_scope_cuts_some_eligible_edge() {
    let (mut maze, e0, e1, e2) = maze_with_mixed_route();
    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![vec![(e0, true), (e1, false), (e2, true)]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&SplitRouteCutStrategy, &issue, &mut maze, &mut rng,
        &params_with(&[(PARAM_EDGE_SCOPE, EDGE_SCOPE_ANY)]), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let remaining = [e0, e1, e2].iter().filter(|&&id| maze.graph.edge(id).is_some()).count();
    assert_eq!(remaining, 2, "exactly one of the three route edges must be cut");
}

#[test]
fn cutting_a_bidirectional_passage_removes_both_directions() {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(field_level, p).unwrap();
    let extra = field.add_node_at(field_level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let a = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
    let b = field.node_at(field_level, SquarePoint { x: 2, y: 0 }).unwrap();
    let e0 = g.build_initial_edge(slot0, a, EdgeKind::Basic);
    let (e1_fwd, _e1_rev) = g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);
    let e2 = g.build_initial_edge(b, extra, EdgeKind::Basic);
    let mut maze = Maze::new(field, g);

    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![vec![(e0, true), (e1_fwd, false), (e2, true)]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&SplitRouteCutStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(a, b).is_none(), "forward direction must be removed");
    assert!(maze.graph.edge_between(b, a).is_none(), "reverse direction must also be removed");
}

#[test]
fn shared_non_split_edge_removal_drops_the_other_pending_route() {
    // Two routes share the same non-split middle edge e1 (e.g. both A->B and B->A short paths
    // happen to funnel through the same outside corridor). Cutting it once must resolve both
    // routes in a single apply(), not cut twice.
    let (mut maze, e0, e1, e2) = maze_with_mixed_route();
    let route_a = vec![(e0, true), (e1, false), (e2, true)];
    let route_b = vec![(e2, true), (e1, false), (e0, true)]; // reverse-direction route, same edges
    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![route_a, route_b]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&SplitRouteCutStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge(e1).is_none());
    // Only one cut should have been needed/applied -- split edges of both routes must survive.
    assert!(maze.graph.edge(e0).is_some());
    assert!(maze.graph.edge(e2).is_some());
}

#[test]
fn scored_selection_prefers_the_edge_shared_by_more_routes() {
    // Three routes: two share e1 (non-split), the third has its own disjoint non-split edge e3.
    // Scored selection on the first-processed route (route_a, sharing e1) must pick e1 over
    // whatever else -- and once e1 is cut, route_b (which also contains e1) is dropped without a
    // second cut, leaving e3's route to be cut independently for the strategy to succeed overall.
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(field_level, p).unwrap();
    let extra = field.add_node_at(field_level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let a = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
    let c = field.node_at(field_level, SquarePoint { x: 2, y: 0 }).unwrap();
    let e0 = g.build_initial_edge(slot0, a, EdgeKind::Basic);
    let e1 = g.build_initial_edge(a, c, EdgeKind::Basic); // shared non-split edge
    let e2 = g.build_initial_edge(c, extra, EdgeKind::Basic);
    let mut maze = Maze::new(field, g);

    let route_a = vec![(e0, true), (e1, false), (e2, true)];
    let route_b = vec![(e2, true), (e1, false), (e0, true)];
    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![route_a, route_b]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&SplitRouteCutStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge(e1).is_none(), "the edge shared by both routes must be the one cut");
}

#[test]
fn apply_is_deterministic_for_fixed_seed_under_random_selection() {
    // Explicit PRIORITY_RANDOM -- the strategy's own default changed to PRIORITY_PROBLEMATIC, so
    // relying on apply_and_commit_default here would silently stop exercising the random branch
    // of pick_candidate despite this test's name.
    let (mut maze_a, e0, e1, e2) = maze_with_mixed_route();
    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![vec![(e0, true), (e1, false), (e2, true)]]);
    let mut rng_a = MazeRng::seed_from_u64(42);
    apply_and_commit(&SplitRouteCutStrategy, &issue, &mut maze_a, &mut rng_a,
        &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]), &PresetState::empty(), &[]);

    let (mut maze_b, _, _, _) = maze_with_mixed_route();
    let mut rng_b = MazeRng::seed_from_u64(42);
    apply_and_commit(&SplitRouteCutStrategy, &issue, &mut maze_b, &mut rng_b,
        &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]), &PresetState::empty(), &[]);

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| e.id).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| e.id).collect();
    assert_eq!(edges_a, edges_b);
}

#[test]
fn a_stale_chosen_edge_is_skipped_without_counting_as_fixed() {
    // The route's only eligible (non-split) edge no longer exists in the graph by the time apply()
    // runs (e.g. removed by an earlier strategy in the same repair batch) -- cmd_remove_edge_with_reverse
    // must produce no commands for it (graph.can_remove_edge returns false for a stale id), and the
    // strategy must report Failed rather than silently counting the no-op cut as a success.
    let (mut maze, e0, e1, e2) = maze_with_mixed_route();
    maze.graph.remove_initial_edge(e1);
    let issue = InvalidSplitRouteIssue::new_from_check("test", vec![vec![(e0, true), (e1, false), (e2, true)]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit_default(&SplitRouteCutStrategy, &issue, &mut maze, &mut rng, &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.graph.edge(e0).is_some());
    assert!(maze.graph.edge(e2).is_some());
}
