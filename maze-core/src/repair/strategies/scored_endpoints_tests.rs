use super::*;
use std::collections::HashMap as StdHashMap;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::{Graph, EdgeKind};
use crate::IdGenerator;
use crate::space::{SquareTessellation, square_rect, MultiLevelField, SquarePoint};
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
    let field = MultiLevelField::single_level(square_rect(n_cols, n_rows), &mut ids).unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    Maze::new(field, graph)
}

fn make_connected_maze(n_cols: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
    let mut maze = make_maze(n_cols, 1);
    let ordered: Vec<_> = (0..n_cols)
        .map(|x| maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: x as i32, y: 0 }).unwrap())
        .collect();
    for i in 0..ordered.len() - 1 {
        maze.graph.build_initial_bidirectional_edge(ordered[i], ordered[i + 1], EdgeKind::Basic);
    }
    (maze, ordered)
}

fn rng() -> MazeRng { MazeRng::seed_from_u64(7) }

fn issue(missing_start: bool, missing_finish: bool) -> MissingEndpointsIssue {
    MissingEndpointsIssue::new_from_check("test", missing_start, missing_finish)
}

#[test]
fn apply_fixed_immediately_when_both_already_set() {
    let (mut maze, nodes) = make_connected_maze(3);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(false, false), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_fails_on_single_isolated_node_no_reachable_pair() {
    // A single node has a nav node but no second node to pair with -- `best_pair` must
    // find no valid (s, f) pair (every candidate requires f != s and a finite distance).
    let mut maze = make_maze(1, 1);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(true, true), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_picks_best_pair_when_neither_endpoint_set() {
    let (mut maze, nodes) = make_connected_maze(5);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(true, true), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
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
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(false, true), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    assert_eq!(maze.meta.start, Some(nodes[0]));
    assert_eq!(maze.meta.finish, Some(nodes[4]), "farthest/highest-scoring node on a straight corridor is the opposite end");
}

#[test]
fn apply_fixes_start_when_only_finish_set() {
    let (mut maze, nodes) = make_connected_maze(5);
    maze.meta.finish = Some(nodes[4]);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(true, false), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
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
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(false, true), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_fails_when_disconnected_and_start_cannot_reach_anything() {
    // Two disconnected singleton nodes -- no edges at all -- start fixed, no finish
    // reachable from it.
    let mut maze = make_maze(2, 1);
    let a = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
    maze.meta.start = Some(a);
    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(false, true), &mut maze, &mut rng(), &default_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_prefers_junction_path_when_junction_weight_dominates() {
    // Row 0: corridor 0-1-2-3. A side branch at (1,1) hangs off node (1,0), making
    // (1,0) a 3-way junction. With junction_weight dominating and path/one-way zeroed,
    // the best-scoring pair must be the one whose route passes through (1,0).
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(4, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> = [(0, 0), (1, 0), (2, 0), (3, 0), (1, 1)]
        .iter()
        .map(|&(x, y)| ((x, y), field.node_at(level, SquarePoint { x, y }).unwrap()))
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

    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(true, true), &mut maze, &mut rng(), &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    // With path/one-way weight zeroed, any pair whose route never crosses the junction
    // scores exactly 0 -- the winning pair must have a strictly positive score, which
    // only happens if its route passes through junction node (1,0).
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let nav = crate::graph::nav::build_nav_graph_pinned(&maze.graph, &[start, finish].into_iter().collect());
    let route = crate::graph::routing::compute_route_info(&nav, &maze.field, start, finish)
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
    let field = MultiLevelField::single_level(square_rect(3, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> = [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]
        .iter()
        .map(|&(x, y)| ((x, y), field.node_at(level, SquarePoint { x, y }).unwrap()))
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

    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(true, true), &mut maze, &mut rng(), &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    // With every other weight zeroed, only a route crossing the teleport scores
    // positively -- the winning pair must have a strictly positive score.
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let nav = crate::graph::nav::build_nav_graph_pinned(&maze.graph, &[start, finish].into_iter().collect());
    let route = crate::graph::routing::compute_route_info(&nav, &maze.field, start, finish)
        .expect("route must exist between the chosen pair");
    let teleport_src = nodes[&(1, 0)];
    let teleport_dst = nodes[&(1, 1)];
    let crosses_teleport = route.path.windows(2)
        .any(|w| w[0] == teleport_src && w[1] == teleport_dst);
    assert!(crosses_teleport, "winning route must cross the teleport edge");
}

#[test]
fn apply_prefers_vertical_passage_path_when_vertical_passage_weight_dominates() {
    // Two disjoint straight corridors, 0-1-2 and 3-4-5, linked only by a two-way
    // VerticalPassage edge 1 <-> 4. With vertical_passage_weight dominating and
    // path/junction/one-way zeroed, the best-scoring pair must be the one whose route
    // crosses the vertical passage. Exercises the full `apply` pipeline (not just
    // `score_path`/`edge_kind_counts` in isolation), so it would catch e.g. `graph` not
    // actually being threaded into `ScoredPathContext::build`.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(3, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> = [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]
        .iter()
        .map(|&(x, y)| ((x, y), field.node_at(level, SquarePoint { x, y }).unwrap()))
        .collect();
    for x in 0..2 {
        graph.build_initial_bidirectional_edge(nodes[&(x, 0)], nodes[&(x + 1, 0)], EdgeKind::Basic);
        graph.build_initial_bidirectional_edge(nodes[&(x, 1)], nodes[&(x + 1, 1)], EdgeKind::Basic);
    }
    graph.build_initial_bidirectional_edge(nodes[&(1, 0)], nodes[&(1, 1)], EdgeKind::VerticalPassage);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, graph);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_VERTICAL_PASSAGE_WEIGHT.to_string(), "1000".to_string());
    overrides.insert(PARAM_PATH_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_JUNCTION_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
    let params = build_params(
        <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation, MissingEndpointsIssue>>::params(&ScoredEndpointsStrategy),
        Some(&overrides),
    );

    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(true, true), &mut maze, &mut rng(), &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let nav = crate::graph::nav::build_nav_graph_pinned(&maze.graph, &[start, finish].into_iter().collect());
    let route = crate::graph::routing::compute_route_info(&nav, &maze.field, start, finish)
        .expect("route must exist between the chosen pair");
    let passage_a = nodes[&(1, 0)];
    let passage_b = nodes[&(1, 1)];
    let crosses_passage = route.path.windows(2)
        .any(|w| (w[0] == passage_a && w[1] == passage_b) || (w[0] == passage_b && w[1] == passage_a));
    assert!(crosses_passage, "winning route must cross the vertical passage edge");
}

#[test]
fn apply_prefers_pair_whose_own_endpoint_sits_on_a_split_tile() {
    // Two disjoint 3-node corridors: 0-1-2 (node 0's point is split, extra sibling `s`) and
    // 3-4-5 (no splits at all). With split_weight dominating and every other weight zeroed,
    // only a pair that includes node 0 or `s` as an endpoint scores positively -- regression
    // for the route's own start/finish node being excluded from split_count (GitHub issue #261).
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let extra = field.add_node_at(level, SquarePoint { x: 0, y: 0 }, &mut ids);
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> = [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]
        .iter()
        .map(|&(x, y)| ((x, y), field.node_at(level, SquarePoint { x, y }).unwrap()))
        .collect();
    for x in 0..2 {
        graph.build_initial_bidirectional_edge(nodes[&(x, 0)], nodes[&(x + 1, 0)], EdgeKind::Basic);
        graph.build_initial_bidirectional_edge(nodes[&(x, 1)], nodes[&(x + 1, 1)], EdgeKind::Basic);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, graph);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_SPLIT_WEIGHT.to_string(), "1000".to_string());
    overrides.insert(PARAM_PATH_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_JUNCTION_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
    let params = build_params(
        <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation, MissingEndpointsIssue>>::params(&ScoredEndpointsStrategy),
        Some(&overrides),
    );

    let result = apply_and_commit(&ScoredEndpointsStrategy, &issue(true, true), &mut maze, &mut rng(), &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    // With every other weight zeroed, only a pair whose route touches the split point (0,0)
    // (via node 0 or its sibling `extra`) scores positively.
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let split_point_node = nodes[&(0, 0)];
    assert!(
        start == split_point_node || finish == split_point_node || start == extra || finish == extra,
        "winning pair must have an endpoint on the split tile at (0,0), got start={start} finish={finish}",
    );
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
    let split_counts = vec![0, 0];
    let split_flags = vec![false, false, false];
    let vertical_passage_counts = vec![0, 0];
    let elevator_counts = vec![0, 0];
    let weights = ScoreWeights { path_weight: 0.0, junction_weight: 0.0, oneway_weight: 0.0, teleport_weight: 7.0, split_weight: 0.0, vertical_passage_weight: 0.0, elevator_weight: 0.0 };

    let score_one_teleport = score_path(&junction_flags, &oneway_flags, &teleport_flags, &split_counts, &split_flags, &vertical_passage_counts, &elevator_counts, &[0], &edges, 1, &weights);
    assert_eq!(score_one_teleport, 7.0);

    let score_both_edges = score_path(&junction_flags, &oneway_flags, &teleport_flags, &split_counts, &split_flags, &vertical_passage_counts, &elevator_counts, &[0, 1], &edges, 2, &weights);
    assert_eq!(score_both_edges, 7.0, "second edge isn't a teleport crossing, so it must not add to the score");

    let score_no_teleport = score_path(&junction_flags, &oneway_flags, &teleport_flags, &split_counts, &split_flags, &vertical_passage_counts, &elevator_counts, &[1], &edges, 1, &weights);
    assert_eq!(score_no_teleport, 0.0);
}

#[test]
fn score_path_adds_vertical_passage_and_elevator_count_times_weight() {
    // Edge 0's single hop (10 -> 20) is a VerticalPassage; edge 1's single hop (20 -> 30) is
    // an Elevator. With every other weight zeroed, each edge contributes its own weight once.
    let edges_owned = vec![
        NavEdge { from: 0, to: 1, path: vec![10, 20], reverse_edge: None, is_teleport: false },
        NavEdge { from: 1, to: 2, path: vec![20, 30], reverse_edge: None, is_teleport: false },
    ];
    let edges: Vec<&NavEdge> = edges_owned.iter().collect();
    let junction_flags = vec![false, false, false];
    let oneway_flags = vec![false, false];
    let teleport_flags = vec![false, false];
    let split_counts = vec![0, 0];
    let split_flags = vec![false, false, false];

    let mut graph = Graph::new();
    for id in [10, 20, 30] { graph.add_node(id); }
    graph.build_initial_edge(10, 20, EdgeKind::VerticalPassage);
    graph.build_initial_edge(20, 30, EdgeKind::Elevator);

    let vertical_passage_counts = edge_kind_counts(&edges, &graph, EdgeKind::VerticalPassage);
    let elevator_counts = edge_kind_counts(&edges, &graph, EdgeKind::Elevator);
    assert_eq!(vertical_passage_counts, vec![1, 0]);
    assert_eq!(elevator_counts, vec![0, 1]);

    let weights = ScoreWeights { path_weight: 0.0, junction_weight: 0.0, oneway_weight: 0.0, teleport_weight: 0.0, split_weight: 0.0, vertical_passage_weight: 6.0, elevator_weight: 9.0 };

    let score_vertical = score_path(&junction_flags, &oneway_flags, &teleport_flags, &split_counts, &split_flags, &vertical_passage_counts, &elevator_counts, &[0], &edges, 1, &weights);
    assert_eq!(score_vertical, 6.0);

    let score_elevator = score_path(&junction_flags, &oneway_flags, &teleport_flags, &split_counts, &split_flags, &vertical_passage_counts, &elevator_counts, &[1], &edges, 1, &weights);
    assert_eq!(score_elevator, 9.0);

    let score_both = score_path(&junction_flags, &oneway_flags, &teleport_flags, &split_counts, &split_flags, &vertical_passage_counts, &elevator_counts, &[0, 1], &edges, 2, &weights);
    assert_eq!(score_both, 15.0);
}

#[test]
fn edge_kind_counts_finds_vertical_passage_even_with_a_parallel_basic_edge() {
    // Regression: `Graph::add_edge`'s kind-aware dedup lets a `Basic` edge coexist with a
    // `VerticalPassage` edge in the same direction between the same pair (GitHub issue #197).
    // `edge_kind_counts` must use the kind-specific lookup (`edge_between_kind`), not the
    // arbitrary-kind `edge_between` -- otherwise it could resolve to the `Basic` edge and miss
    // the floor-crossing hop entirely.
    let edges_owned = vec![
        NavEdge { from: 0, to: 1, path: vec![10, 20], reverse_edge: None, is_teleport: false },
    ];
    let edges: Vec<&NavEdge> = edges_owned.iter().collect();

    let mut graph = Graph::new();
    for id in [10, 20] { graph.add_node(id); }
    graph.build_initial_edge(10, 20, EdgeKind::Basic);
    graph.build_initial_edge(10, 20, EdgeKind::VerticalPassage);

    let vertical_passage_counts = edge_kind_counts(&edges, &graph, EdgeKind::VerticalPassage);
    assert_eq!(vertical_passage_counts, vec![1], "must find the VerticalPassage hop despite the parallel Basic edge");
}

#[test]
fn score_path_adds_split_count_times_weight() {
    // Edge 0 crosses one split-tile occurrence, edge 1 crosses two. Both non-junction,
    // non-oneway, non-teleport, so with every other weight zeroed the only contribution is
    // split_weight times the summed per-edge split_counts of the path's edges.
    let edges_owned = vec![
        NavEdge { from: 0, to: 1, path: vec![10, 20], reverse_edge: None, is_teleport: false },
        NavEdge { from: 1, to: 2, path: vec![20, 30, 40], reverse_edge: None, is_teleport: false },
    ];
    let edges: Vec<&NavEdge> = edges_owned.iter().collect();
    let junction_flags = vec![false, false, false];
    let oneway_flags = vec![false, false];
    let teleport_flags = vec![false, false];
    let split_counts = vec![1, 2];
    let split_flags = vec![false, false, false];
    let vertical_passage_counts = vec![0, 0];
    let elevator_counts = vec![0, 0];
    let weights = ScoreWeights { path_weight: 0.0, junction_weight: 0.0, oneway_weight: 0.0, teleport_weight: 0.0, split_weight: 4.0, vertical_passage_weight: 0.0, elevator_weight: 0.0 };

    let score_one_edge = score_path(&junction_flags, &oneway_flags, &teleport_flags, &split_counts, &split_flags, &vertical_passage_counts, &elevator_counts, &[0], &edges, 1, &weights);
    assert_eq!(score_one_edge, 4.0);

    let score_both_edges = score_path(&junction_flags, &oneway_flags, &teleport_flags, &split_counts, &split_flags, &vertical_passage_counts, &elevator_counts, &[0, 1], &edges, 3, &weights);
    assert_eq!(score_both_edges, 12.0, "split_counts of both path edges must sum before multiplying by the weight");
}

#[test]
fn score_path_counts_the_routes_own_start_node_as_a_split_too() {
    // Regression: split_counts (per-edge) structurally excludes each edge's `from` node, so
    // the route's very first node (edge 0's `from`, nav node 0) would never be checked for
    // being a split tile unless score_path adds it separately via split_flags -- exactly like
    // it already does for junction_count via nav_nodes_on_path's i==0 push.
    let edges_owned = vec![
        NavEdge { from: 0, to: 1, path: vec![10, 20], reverse_edge: None, is_teleport: false },
    ];
    let edges: Vec<&NavEdge> = edges_owned.iter().collect();
    let junction_flags = vec![false, false];
    let oneway_flags = vec![false];
    let teleport_flags = vec![false];
    let split_counts = vec![0]; // edge 0's own tiles (path[1..] = [20]) has no split
    let split_flags = vec![true, false]; // nav node 0 (the route's start) IS a split tile
    let vertical_passage_counts = vec![0];
    let elevator_counts = vec![0];
    let weights = ScoreWeights { path_weight: 0.0, junction_weight: 0.0, oneway_weight: 0.0, teleport_weight: 0.0, split_weight: 10.0, vertical_passage_weight: 0.0, elevator_weight: 0.0 };

    let score = score_path(&junction_flags, &oneway_flags, &teleport_flags, &split_counts, &split_flags, &vertical_passage_counts, &elevator_counts, &[0], &edges, 1, &weights);
    assert_eq!(score, 10.0, "the route's start node sitting on a split tile must still contribute to split_count");
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let (mut maze_a, _) = make_connected_maze(5);
    let mut rng_a = MazeRng::seed_from_u64(123);
    apply_and_commit(&ScoredEndpointsStrategy, &issue(true, true), &mut maze_a, &mut rng_a, &default_params(), &PresetState::empty(), &[]);

    let (mut maze_b, _) = make_connected_maze(5);
    let mut rng_b = MazeRng::seed_from_u64(123);
    apply_and_commit(&ScoredEndpointsStrategy, &issue(true, true), &mut maze_b, &mut rng_b, &default_params(), &PresetState::empty(), &[]);

    assert_eq!(maze_a.meta.start, maze_b.meta.start);
    assert_eq!(maze_a.meta.finish, maze_b.meta.finish);
}
