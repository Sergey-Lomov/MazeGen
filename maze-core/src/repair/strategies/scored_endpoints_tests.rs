use super::*;
use std::collections::HashMap as StdHashMap;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::{Graph, EdgeKind};
use crate::IdGenerator;
use crate::space::{SquareTessellation, square_rect, Field, SquarePoint};
use crate::repair::params::build_params;
use crate::quality_control::MissingEndpointsIssue;
use crate::repair::strategies::test_utils::apply_and_commit;

fn default_params() -> StrategyParams {
    build_params(
        <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation, MissingEndpointsIssue>>::params(&ScoredEndpointsStrategy),
        None,
    )
}

fn make_maze(n_cols: usize, n_rows: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(n_cols, n_rows), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    Maze::new(field, graph)
}

fn make_connected_maze(n_cols: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
    let mut maze = make_maze(n_cols, 1);
    let ordered: Vec<_> = (0..n_cols)
        .map(|x| maze.field.node_at(SquarePoint { x: x as i32, y: 0 }).unwrap())
        .collect();
    for i in 0..ordered.len() - 1 {
        maze.graph.build_initial_bidirectional_edge(ordered[i], ordered[i + 1], EdgeKind::Basic);
    }
    (maze, ordered)
}

fn rng() -> MazeRng { MazeRng::seed_from_u64(7) }

fn issue() -> MissingEndpointsIssue { MissingEndpointsIssue::default() }

#[test]
fn apply_fixed_immediately_when_both_already_set() {
    let (mut maze, nodes) = make_connected_maze(3);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_fails_on_single_isolated_node_no_reachable_pair() {
    // A single node has a nav node but no second node to pair with -- `best_pair` must
    // find no valid (s, f) pair (every candidate requires f != s and a finite distance).
    let mut maze = make_maze(1, 1);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_picks_best_pair_when_neither_endpoint_set() {
    let (mut maze, nodes) = make_connected_maze(5);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.start, maze.meta.finish);
    // On a straight 5-node corridor, the longest path is start..end (endpoints), since
    // path_weight rewards length and there are no junctions/one-ways to compete with it.
    let (a, b) = (maze.meta.start.unwrap(), maze.meta.finish.unwrap());
    assert!((a == nodes[0] && b == nodes[4]) || (a == nodes[4] && b == nodes[0]));
}

#[test]
fn apply_fixes_finish_when_only_start_set() {
    let (mut maze, nodes) = make_connected_maze(5);
    maze.meta.start = Some(nodes[0]);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    assert_eq!(maze.meta.start, Some(nodes[0]));
    assert_eq!(maze.meta.finish, Some(nodes[4]), "farthest/highest-scoring node on a straight corridor is the opposite end");
}

#[test]
fn apply_fixes_start_when_only_finish_set() {
    let (mut maze, nodes) = make_connected_maze(5);
    maze.meta.finish = Some(nodes[4]);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    assert_eq!(maze.meta.finish, Some(nodes[4]));
    assert_eq!(maze.meta.start, Some(nodes[0]));
}

#[test]
fn apply_fails_when_fixed_start_node_not_in_nav_graph() {
    let (mut maze, nodes) = make_connected_maze(3);
    // start set to a node id that doesn't exist in the graph at all.
    let _ = nodes;
    maze.meta.start = Some(999_999);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_fails_when_disconnected_and_start_cannot_reach_anything() {
    // Two disconnected singleton nodes -- no edges at all -- start fixed, no finish
    // reachable from it.
    let mut maze = make_maze(2, 1);
    let a = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    maze.meta.start = Some(a);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_prefers_junction_path_when_junction_weight_dominates() {
    // Row 0: corridor 0-1-2-3. A side branch at (1,1) hangs off node (1,0), making
    // (1,0) a 3-way junction. With junction_weight dominating and path/one-way zeroed,
    // the best-scoring pair must be the one whose route passes through (1,0).
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(4, 2), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> = [(0, 0), (1, 0), (2, 0), (3, 0), (1, 1)]
        .iter()
        .map(|&(x, y)| ((x, y), field.node_at(SquarePoint { x, y }).unwrap()))
        .collect();
    for x in 0..3 {
        graph.build_initial_bidirectional_edge(nodes[&(x, 0)], nodes[&(x + 1, 0)], EdgeKind::Basic);
    }
    graph.build_initial_bidirectional_edge(nodes[&(1, 0)], nodes[&(1, 1)], EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, graph);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_JUNCTION_WEIGHT.to_string(), "1000".to_string());
    overrides.insert(PARAM_PATH_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
    let params = build_params(
        <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation, MissingEndpointsIssue>>::params(&ScoredEndpointsStrategy),
        Some(&overrides),
    );

    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze, &mut rng(), &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    // With path/one-way weight zeroed, any pair whose route never crosses the junction
    // scores exactly 0 -- the winning pair must have a strictly positive score, which
    // only happens if its route passes through junction node (1,0).
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let nav = crate::graph::nav::build_nav_graph_pinned(&maze.graph, &[start, finish].into_iter().collect());
    let route = crate::graph::routing::compute_route_info(&nav, start, finish)
        .expect("route must exist between the chosen pair");
    let junction = nodes[&(1, 0)];
    assert!(route.path.contains(&junction), "winning route must pass through the junction node");
}

#[test]
fn apply_prefers_teleport_path_when_teleport_weight_dominates() {
    // Two disjoint straight corridors, 0-1-2 and 3-4-5, linked only by a one-way
    // teleport edge 1 -> 4. With teleport_weight dominating and path/junction/one-way
    // zeroed, the best-scoring pair must be the one whose route crosses the teleport.
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(3, 2), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> = [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]
        .iter()
        .map(|&(x, y)| ((x, y), field.node_at(SquarePoint { x, y }).unwrap()))
        .collect();
    for x in 0..2 {
        graph.build_initial_bidirectional_edge(nodes[&(x, 0)], nodes[&(x + 1, 0)], EdgeKind::Basic);
        graph.build_initial_bidirectional_edge(nodes[&(x, 1)], nodes[&(x + 1, 1)], EdgeKind::Basic);
    }
    graph.add_edge(nodes[&(1, 0)], nodes[&(1, 1)], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, graph);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_TELEPORT_WEIGHT.to_string(), "1000".to_string());
    overrides.insert(PARAM_PATH_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_JUNCTION_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
    let params = build_params(
        <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation, MissingEndpointsIssue>>::params(&ScoredEndpointsStrategy),
        Some(&overrides),
    );

    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze, &mut rng(), &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    // With every other weight zeroed, only a route crossing the teleport scores
    // positively -- the winning pair must have a strictly positive score.
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let nav = crate::graph::nav::build_nav_graph_pinned(&maze.graph, &[start, finish].into_iter().collect());
    let route = crate::graph::routing::compute_route_info(&nav, start, finish)
        .expect("route must exist between the chosen pair");
    let teleport_src = nodes[&(1, 0)];
    let teleport_dst = nodes[&(1, 1)];
    let crosses_teleport = route.path.windows(2)
        .any(|w| w[0] == teleport_src && w[1] == teleport_dst);
    assert!(crosses_teleport, "winning route must cross the teleport edge");
}

#[test]
fn score_path_adds_teleport_count_times_weight() {
    // Two edges: edge 0 crosses a teleport, edge 1 doesn't. Both non-junction, non-oneway,
    // so with path/junction/oneway weights zeroed the only contribution is teleport_weight
    // times how many of the two path edges are flagged as teleport.
    let edges_owned = vec![
        NavEdge { from: 0, to: 1, path: vec![10, 20], reverse_edge: None, is_teleport: true },
        NavEdge { from: 1, to: 2, path: vec![20, 30], reverse_edge: None, is_teleport: false },
    ];
    let edges: Vec<&NavEdge> = edges_owned.iter().collect();
    let junction_flags = vec![false, false, false];
    let oneway_flags = vec![false, false];
    let teleport_flags = vec![true, false];
    let weights = ScoreWeights { path_weight: 0.0, junction_weight: 0.0, oneway_weight: 0.0, teleport_weight: 7.0 };

    let score_one_teleport = score_path(&junction_flags, &oneway_flags, &teleport_flags, &[0], &edges, 1, &weights);
    assert_eq!(score_one_teleport, 7.0);

    let score_both_edges = score_path(&junction_flags, &oneway_flags, &teleport_flags, &[0, 1], &edges, 2, &weights);
    assert_eq!(score_both_edges, 7.0, "second edge isn't a teleport crossing, so it must not add to the score");

    let score_no_teleport = score_path(&junction_flags, &oneway_flags, &teleport_flags, &[1], &edges, 1, &weights);
    assert_eq!(score_no_teleport, 0.0);
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let (mut maze_a, _) = make_connected_maze(5);
    let mut rng_a = MazeRng::seed_from_u64(123);
    apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze_a, &mut rng_a, &default_params(), &PresetState::empty(), &[]);

    let (mut maze_b, _) = make_connected_maze(5);
    let mut rng_b = MazeRng::seed_from_u64(123);
    apply_and_commit(&ScoredEndpointsStrategy, &issue(), &mut maze_b, &mut rng_b, &default_params(), &PresetState::empty(), &[]);

    assert_eq!(maze_a.meta.start, maze_b.meta.start);
    assert_eq!(maze_a.meta.finish, maze_b.meta.finish);
}
