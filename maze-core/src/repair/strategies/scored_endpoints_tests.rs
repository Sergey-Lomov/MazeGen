use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind, Graph};
use crate::quality_control::MissingEndpointsIssue;
use crate::random::MazeRng;
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::collections::HashMap as StdHashMap;
use std::sync::Arc;

fn default_params() -> StrategyParams {
    build_params(
        <ScoredEndpointsStrategy as RepairStrategy<SquareTessellation, MissingEndpointsIssue>>::params(&ScoredEndpointsStrategy),
        None,
    )
}

fn make_maze(n_cols: usize, n_rows: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field =
        MultiLevelField::single_level(Arc::default(), square_rect(n_cols, n_rows), &mut ids)
            .unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    Maze::new(field, graph)
}

fn make_connected_maze(n_cols: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
    let mut maze = make_maze(n_cols, 1);
    let ordered: Vec<_> = (0..n_cols)
        .map(|x| {
            maze.field
                .node_at(
                    maze.field.single_level_id(),
                    SquarePoint { x: x as i32, y: 0 },
                )
                .unwrap()
        })
        .collect();
    for i in 0..ordered.len() - 1 {
        maze.graph
            .build_initial_bidirectional_edge(ordered[i], ordered[i + 1], EdgeKind::Basic);
    }
    (maze, ordered)
}

fn rng() -> MazeRng {
    MazeRng::seed_from_u64(7)
}

fn issue(missing_start: bool, missing_finish: bool) -> MissingEndpointsIssue {
    MissingEndpointsIssue::new_from_check("test", missing_start, missing_finish)
}

#[test]
fn apply_fixed_immediately_when_both_already_set() {
    let (mut maze, nodes) = make_connected_maze(3);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);
    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(false, false),
        &mut maze,
        &mut rng(),
        &default_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_fails_on_single_isolated_node_no_reachable_pair() {
    // A single node has a nav node but no second node to pair with -- `best_pair` must
    // find no valid (s, f) pair (every candidate requires f != s and a finite distance).
    let mut maze = make_maze(1, 1);
    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &default_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_picks_best_pair_when_neither_endpoint_set() {
    let (mut maze, nodes) = make_connected_maze(5);
    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &default_params(),
        &PresetState::empty(),
        &[],
    );
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
    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(false, true),
        &mut maze,
        &mut rng(),
        &default_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    assert_eq!(maze.meta.start, Some(nodes[0]));
    assert_eq!(
        maze.meta.finish,
        Some(nodes[4]),
        "farthest/highest-scoring node on a straight corridor is the opposite end"
    );
}

#[test]
fn apply_fixes_start_when_only_finish_set() {
    let (mut maze, nodes) = make_connected_maze(5);
    maze.meta.finish = Some(nodes[4]);
    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, false),
        &mut maze,
        &mut rng(),
        &default_params(),
        &PresetState::empty(),
        &[],
    );
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
    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(false, true),
        &mut maze,
        &mut rng(),
        &default_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_fails_when_disconnected_and_start_cannot_reach_anything() {
    // Two disconnected singleton nodes -- no edges at all -- start fixed, no finish
    // reachable from it.
    let mut maze = make_maze(2, 1);
    let a = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 })
        .unwrap();
    maze.meta.start = Some(a);
    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(false, true),
        &mut maze,
        &mut rng(),
        &default_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_prefers_junction_path_when_junction_weight_dominates() {
    // Row 0: corridor 0-1-2-3. A side branch at (1,1) hangs off node (1,0), making
    // (1,0) a 3-way junction. With junction_weight dominating and path/one-way zeroed,
    // the best-scoring pair must be the one whose route passes through (1,0).
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(4, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> =
        [(0, 0), (1, 0), (2, 0), (3, 0), (1, 1)]
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
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    // With path/one-way weight zeroed, any pair whose route never crosses the junction
    // scores exactly 0 -- the winning pair must have a strictly positive score, which
    // only happens if its route passes through junction node (1,0).
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let nav = crate::graph::nav::build_nav_graph_pinned(
        &maze.graph,
        &[start, finish].into_iter().collect(),
    );
    let route = crate::graph::routing::compute_route_info(&nav, &maze.field, start, finish)
        .expect("route must exist between the chosen pair");
    let junction = nodes[&(1, 0)];
    assert!(
        route.path.contains(&junction),
        "winning route must pass through the junction node"
    );
}

#[test]
fn apply_prefers_teleport_path_when_teleport_weight_dominates() {
    // Two disjoint straight corridors, 0-1-2 and 3-4-5, linked only by a teleport edge
    // 1 -> 4. With teleport_weight dominating and path/junction/one-way zeroed, the
    // best-scoring pair must be the one whose route crosses the teleport.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(3, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> =
        [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]
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
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    // With every other weight zeroed, only a route crossing the teleport scores
    // positively -- the winning pair must have a strictly positive score.
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let nav = crate::graph::nav::build_nav_graph_pinned(
        &maze.graph,
        &[start, finish].into_iter().collect(),
    );
    let route = crate::graph::routing::compute_route_info(&nav, &maze.field, start, finish)
        .expect("route must exist between the chosen pair");
    let teleport_src = nodes[&(1, 0)];
    let teleport_dst = nodes[&(1, 1)];
    let crosses_teleport = route
        .path
        .windows(2)
        .any(|w| w[0] == teleport_src && w[1] == teleport_dst);
    assert!(
        crosses_teleport,
        "winning route must cross the teleport edge"
    );
}

#[test]
fn apply_prefers_cross_floor_path_when_cross_floor_weight_dominates() {
    // Two disjoint straight corridors, 0-1-2 and 3-4-5, linked only by a two-way
    // VerticalPassage edge 1 <-> 4. With cross_floor_weight dominating and
    // path/junction/one-way zeroed, the best-scoring pair must be the one whose route
    // crosses the vertical passage. Exercises the full `apply` pipeline (not just
    // `score_path`/`cross_floor_flags` in isolation).
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(3, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> =
        [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]
            .iter()
            .map(|&(x, y)| ((x, y), field.node_at(level, SquarePoint { x, y }).unwrap()))
            .collect();
    for x in 0..2 {
        graph.build_initial_bidirectional_edge(nodes[&(x, 0)], nodes[&(x + 1, 0)], EdgeKind::Basic);
        graph.build_initial_bidirectional_edge(nodes[&(x, 1)], nodes[&(x + 1, 1)], EdgeKind::Basic);
    }
    graph.build_initial_bidirectional_edge(
        nodes[&(1, 0)],
        nodes[&(1, 1)],
        EdgeKind::VerticalPassage,
    );
    let mut maze: Maze<SquareTessellation> = Maze::new(field, graph);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_CROSS_FLOOR_WEIGHT.to_string(), "1000".to_string());
    overrides.insert(PARAM_PATH_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_JUNCTION_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let nav = crate::graph::nav::build_nav_graph_pinned(
        &maze.graph,
        &[start, finish].into_iter().collect(),
    );
    let route = crate::graph::routing::compute_route_info(&nav, &maze.field, start, finish)
        .expect("route must exist between the chosen pair");
    let passage_a = nodes[&(1, 0)];
    let passage_b = nodes[&(1, 1)];
    let crosses_passage = route.path.windows(2).any(|w| {
        (w[0] == passage_a && w[1] == passage_b) || (w[0] == passage_b && w[1] == passage_a)
    });
    assert!(
        crosses_passage,
        "winning route must cross the vertical passage edge"
    );
}

#[test]
fn apply_prefers_pair_whose_own_endpoint_sits_on_a_split_tile() {
    // Two disjoint 3-node corridors: 0-1-2 (node 0's point is split, extra sibling `s`) and
    // 3-4-5 (no splits at all). With split_weight dominating and every other weight zeroed,
    // only a pair that includes node 0 or `s` as an endpoint scores positively -- regression
    // for the route's own start/finish node being excluded from split_count (GitHub issue #261).
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let extra = field.add_node_at(level, SquarePoint { x: 0, y: 0 }, &mut ids);
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let nodes: StdHashMap<(i32, i32), crate::ids::NodeId> =
        [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]
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
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    // With every other weight zeroed, only a pair whose route touches the split point (0,0)
    // (via node 0 or its sibling `extra`) scores positively.
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let split_point_node = nodes[&(0, 0)];
    assert!(
        start == split_point_node
            || finish == split_point_node
            || start == extra
            || finish == extra,
        "winning pair must have an endpoint on the split tile at (0,0), got start={start} finish={finish}",
    );
}

#[test]
fn apply_prefers_elevator_path_with_more_stops_when_elevator_stop_weight_dominates() {
    // Two disjoint straight corridors, 0-1-2 and 3-4-5, linked by two independent
    // elevators: a plain 2-stop elevator (1 <-> 4) and a 4-stop elevator whose other two
    // stops (on unreachable floors) don't touch either corridor, only one of whose fan
    // edges (2 <-> 5) is reachable from the corridors. With elevator_stop_weight
    // dominating and path/junction/one-way/cross_floor zeroed, the winning pair must cross
    // the 4-stop elevator (bonus 2), not the 2-stop one (bonus 0).
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), std::iter::empty());
    let floors: Vec<_> = (0..4)
        .map(|_| {
            mf.add_level(
                crate::space::Field::<SquareTessellation>::new(
                    Arc::default(),
                    square_rect(3, 1),
                    &mut ids,
                )
                .unwrap(),
            )
        })
        .collect();
    let mut graph = Graph::new();
    for node in mf.all_node_ids() {
        graph.add_node(node);
    }

    let at = |floor: usize, x: i32| mf.node_at(floors[floor], SquarePoint { x, y: 0 }).unwrap();

    // Floor 0 corridor: 0-1-2. Floor 1 corridor: 0-1-2 (independent nodes, same shape).
    for x in 0..2 {
        graph.build_initial_bidirectional_edge(at(0, x), at(0, x + 1), EdgeKind::Basic);
        graph.build_initial_bidirectional_edge(at(1, x), at(1, x + 1), EdgeKind::Basic);
    }

    // Plain 2-stop elevator linking (0,1) <-> (1,1).
    graph.build_initial_bidirectional_edge(at(0, 1), at(1, 1), EdgeKind::Elevator);

    // 4-stop elevator: stops on floor 0 x=2, floor 1 x=2, floor 2 x=0, floor 3 x=0 -- fully
    // connected fan, but only the (0,2) <-> (1,2) leg is reachable from the two corridors.
    let big_stops = [
        at(0, 2),
        at(1, 2),
        mf.node_at(floors[2], SquarePoint { x: 0, y: 0 }).unwrap(),
        mf.node_at(floors[3], SquarePoint { x: 0, y: 0 }).unwrap(),
    ];
    for id in &big_stops {
        graph.add_node(*id);
    }
    for i in 0..big_stops.len() {
        for j in (i + 1)..big_stops.len() {
            graph.build_initial_bidirectional_edge(big_stops[i], big_stops[j], EdgeKind::Elevator);
        }
    }

    let mut maze: Maze<SquareTessellation> = Maze::new(mf, graph);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_ELEVATOR_STOP_WEIGHT.to_string(), "1000".to_string());
    overrides.insert(PARAM_PATH_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_JUNCTION_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_CROSS_FLOOR_WEIGHT.to_string(), "0".to_string());
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    let start = maze.meta.start.unwrap();
    let finish = maze.meta.finish.unwrap();
    let nav = crate::graph::nav::build_nav_graph_pinned(
        &maze.graph,
        &[start, finish].into_iter().collect(),
    );
    let route = crate::graph::routing::compute_route_info(&nav, &maze.field, start, finish)
        .expect("route must exist between the chosen pair");
    let (big_a, big_b) = (big_stops[0], big_stops[1]);
    let crosses_big_elevator = route
        .path
        .windows(2)
        .any(|w| (w[0] == big_a && w[1] == big_b) || (w[0] == big_b && w[1] == big_a));
    assert!(
        crosses_big_elevator,
        "winning route must cross the 4-stop elevator, not the 2-stop one"
    );
}

#[test]
fn score_path_adds_teleport_count_times_weight() {
    // Two edges: edge 0 crosses a teleport, edge 1 doesn't. Both non-junction, non-oneway,
    // so with path/junction/oneway weights zeroed the only contribution is teleport_weight
    // times how many of the two path edges are flagged as teleport. Uses a real NavGraph (via
    // `build_nav_graph_pinned`, so `reverse_edge` linking runs) because `score_path` now
    // computes junction_count from `nav` directly (GitHub issue #535 follow-up: route-aware
    // junctions), even though junction_weight is zeroed here.
    let mut ids = IdGenerator::new();
    let mut graph = Graph::new();
    let nodes: Vec<_> = (0..3)
        .map(|_| {
            let id = ids.next_id();
            graph.add_node(id);
            id
        })
        .collect();
    graph.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    graph.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
    let nav = crate::graph::nav::build_nav_graph_pinned(&graph, &nodes.iter().copied().collect());

    let edges: Vec<&NavEdge> = nav.edges().collect();
    let oneway_flags = vec![false, false];
    let cross_floor_flags = vec![false, false];
    let teleport_flags = teleport_flags(&edges);
    let split_counts = vec![0, 0];
    let split_flags = vec![false, false, false];
    let elevator_stop_counts = vec![0, 0];
    let weights = ScoreWeights {
        path_weight: 0.0,
        junction_weight: 0.0,
        oneway_weight: 0.0,
        cross_floor_weight: 0.0,
        split_weight: 0.0,
        teleport_weight: 7.0,
        elevator_stop_weight: 0.0,
    };

    let score_one_teleport = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[0],
        &edges,
        1,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(score_one_teleport, 7.0);

    let score_both_edges = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[0, 1],
        &edges,
        2,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(
        score_both_edges, 7.0,
        "second edge isn't a teleport crossing, so it must not add to the score"
    );

    let score_no_teleport = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[1],
        &edges,
        1,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(score_no_teleport, 0.0);
}

#[test]
fn score_path_adds_cross_floor_count_times_weight_for_vertical_and_elevator_hops() {
    // Edge 0 is a VerticalPassage hop, edge 1 is an Elevator hop, edge 2 is a plain Basic
    // hop. With every other weight zeroed, cross_floor_weight applies once per
    // vertical/elevator edge and not at all for the basic one -- oneway_weight/directionality
    // is independent and doesn't affect this count (GitHub issue #535 follow-up).
    let mut ids = IdGenerator::new();
    let mut graph = Graph::new();
    let nodes: Vec<_> = (0..4)
        .map(|_| {
            let id = ids.next_id();
            graph.add_node(id);
            id
        })
        .collect();
    graph.add_edge(nodes[0], nodes[1], EdgeKind::VerticalPassage);
    graph.add_edge(nodes[1], nodes[2], EdgeKind::Elevator);
    graph.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
    let nav = crate::graph::nav::build_nav_graph_pinned(&graph, &nodes.iter().copied().collect());

    let edges: Vec<&NavEdge> = nav.edges().collect();
    let oneway_flags = vec![false, false, false];
    let cross_floor_flags = cross_floor_flags(&edges);
    assert_eq!(cross_floor_flags, vec![true, true, false]);
    let teleport_flags = vec![false, false, false];
    let split_counts = vec![0, 0, 0];
    let split_flags = vec![false, false, false, false];
    let elevator_stop_counts = vec![0, 0, 0];
    let weights = ScoreWeights {
        path_weight: 0.0,
        junction_weight: 0.0,
        oneway_weight: 0.0,
        cross_floor_weight: 6.0,
        split_weight: 0.0,
        teleport_weight: 0.0,
        elevator_stop_weight: 0.0,
    };

    let score_vertical = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[0],
        &edges,
        1,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(score_vertical, 6.0);

    let score_elevator = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[1],
        &edges,
        1,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(score_elevator, 6.0);

    let score_basic = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[2],
        &edges,
        1,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(score_basic, 0.0);

    let score_all = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[0, 1, 2],
        &edges,
        3,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(score_all, 12.0);
}

#[test]
fn elevator_stop_counts_applies_max_0_stops_minus_2_per_elevator_hop() {
    // Two independent elevators, each stop on its own floor: a 2-stop one (floors 0-1) and
    // a 4-stop one (floors 2-5, fully connected fan). Edge 0 crosses the 2-stop elevator
    // (bonus max(0, 2-2) = 0), edge 1 crosses one leg of the 4-stop elevator
    // (bonus max(0, 4-2) = 2), edge 2 is a non-elevator hop (bonus 0).
    let mut ids = IdGenerator::new();
    let mut mf: MultiLevelField<SquareTessellation> =
        MultiLevelField::new(Arc::default(), std::iter::empty());
    let floors: Vec<_> = (0..6)
        .map(|_| {
            mf.add_level(
                crate::space::Field::<SquareTessellation>::new(
                    Arc::default(),
                    square_rect(1, 1),
                    &mut ids,
                )
                .unwrap(),
            )
        })
        .collect();
    let at = |floor: usize| {
        mf.node_at(floors[floor], SquarePoint { x: 0, y: 0 })
            .unwrap()
    };
    let (small_a, small_b) = (at(0), at(1));
    let big_stops = [at(2), at(3), at(4), at(5)];

    let mut graph = Graph::new();
    for node in mf.all_node_ids() {
        graph.add_node(node);
    }
    graph.build_initial_bidirectional_edge(small_a, small_b, EdgeKind::Elevator);
    for i in 0..big_stops.len() {
        for j in (i + 1)..big_stops.len() {
            graph.build_initial_bidirectional_edge(big_stops[i], big_stops[j], EdgeKind::Elevator);
        }
    }

    let edges_owned = [
        NavEdge {
            from: 0,
            to: 1,
            path: vec![small_a, small_b],
            reverse_edge: None,
            is_teleport: false,
            is_elevator: true,
            is_vertical: false,
        },
        NavEdge {
            from: 1,
            to: 2,
            path: vec![big_stops[0], big_stops[1]],
            reverse_edge: None,
            is_teleport: false,
            is_elevator: true,
            is_vertical: false,
        },
        NavEdge {
            from: 2,
            to: 3,
            path: vec![big_stops[1], big_stops[2]],
            reverse_edge: None,
            is_teleport: false,
            is_elevator: false,
            is_vertical: false,
        },
    ];
    let edges: Vec<&NavEdge> = edges_owned.iter().collect();

    let counts = elevator_stop_counts(&edges, &graph, &mf);
    assert_eq!(counts, vec![0, 2, 0]);
}

#[test]
fn score_path_adds_split_count_times_weight() {
    // Edge 0 crosses one split-tile occurrence, edge 1 crosses two. Both non-junction,
    // non-oneway, non-teleport, so with every other weight zeroed the only contribution is
    // split_weight times the summed per-edge split_counts of the path's edges.
    let mut ids = IdGenerator::new();
    let mut graph = Graph::new();
    let nodes: Vec<_> = (0..3)
        .map(|_| {
            let id = ids.next_id();
            graph.add_node(id);
            id
        })
        .collect();
    graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    graph.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
    let nav = crate::graph::nav::build_nav_graph_pinned(&graph, &nodes.iter().copied().collect());

    let edges: Vec<&NavEdge> = nav.edges().collect();
    let oneway_flags = vec![false, false];
    let cross_floor_flags = vec![false, false];
    let teleport_flags = vec![false, false];
    let split_counts = vec![1, 2];
    let split_flags = vec![false, false, false];
    let elevator_stop_counts = vec![0, 0];
    let weights = ScoreWeights {
        path_weight: 0.0,
        junction_weight: 0.0,
        oneway_weight: 0.0,
        cross_floor_weight: 0.0,
        split_weight: 4.0,
        teleport_weight: 0.0,
        elevator_stop_weight: 0.0,
    };

    let score_one_edge = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[0],
        &edges,
        1,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(score_one_edge, 4.0);

    let score_both_edges = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[0, 1],
        &edges,
        3,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(
        score_both_edges, 12.0,
        "split_counts of both path edges must sum before multiplying by the weight"
    );
}

#[test]
fn score_path_counts_the_routes_own_start_node_as_a_split_too() {
    // Regression: split_counts (per-edge) structurally excludes each edge's `from` node, so
    // the route's very first node (edge 0's `from`, nav node 0) would never be checked for
    // being a split tile unless score_path adds it separately via split_flags -- exactly like
    // it already does for junction_count via nav_nodes_on_path's i==0 push.
    let mut ids = IdGenerator::new();
    let mut graph = Graph::new();
    let nodes: Vec<_> = (0..2)
        .map(|_| {
            let id = ids.next_id();
            graph.add_node(id);
            id
        })
        .collect();
    graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let nav = crate::graph::nav::build_nav_graph_pinned(&graph, &nodes.iter().copied().collect());

    let edges: Vec<&NavEdge> = nav.edges().collect();
    let oneway_flags = vec![false];
    let cross_floor_flags = vec![false];
    let teleport_flags = vec![false];
    let split_counts = vec![0]; // edge 0's own tiles (path[1..]) has no split
    let split_flags = vec![true, false]; // nav node 0 (the route's start) IS a split tile
    let elevator_stop_counts = vec![0];
    let weights = ScoreWeights {
        path_weight: 0.0,
        junction_weight: 0.0,
        oneway_weight: 0.0,
        cross_floor_weight: 0.0,
        split_weight: 10.0,
        teleport_weight: 0.0,
        elevator_stop_weight: 0.0,
    };

    let score = score_path(
        &nav,
        &oneway_flags,
        &cross_floor_flags,
        &teleport_flags,
        &split_counts,
        &split_flags,
        &elevator_stop_counts,
        &[0],
        &edges,
        1,
        &weights,
        &mut HashMap::new(),
        &mut Vec::new(),
    );
    assert_eq!(
        score, 10.0,
        "the route's start node sitting on a split tile must still contribute to split_count"
    );
}

#[test]
fn apply_fails_when_best_score_below_min_score() {
    let (mut maze, _) = make_connected_maze(5);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_SCORE.to_string(), "1000000".to_string());
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.meta.start.is_none());
    assert!(maze.meta.finish.is_none());
}

#[test]
fn apply_succeeds_when_best_score_meets_min_score() {
    let (mut maze, nodes) = make_connected_maze(5);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_SCORE.to_string(), "1".to_string());
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    let (a, b) = (maze.meta.start.unwrap(), maze.meta.finish.unwrap());
    assert!((a == nodes[0] && b == nodes[4]) || (a == nodes[4] && b == nodes[0]));
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let (mut maze_a, _) = make_connected_maze(5);
    let mut rng_a = MazeRng::seed_from_u64(123);
    apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze_a,
        &mut rng_a,
        &default_params(),
        &PresetState::empty(),
        &[],
    );

    let (mut maze_b, _) = make_connected_maze(5);
    let mut rng_b = MazeRng::seed_from_u64(123);
    apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze_b,
        &mut rng_b,
        &default_params(),
        &PresetState::empty(),
        &[],
    );

    assert_eq!(maze_a.meta.start, maze_b.meta.start);
    assert_eq!(maze_a.meta.finish, maze_b.meta.finish);
}

#[test]
fn apply_picks_deepest_leaf_across_a_branching_tree_of_plain_dead_end_tails() {
    // A 3-way junction at (0,0) with three plain dead-end tails hanging off it, of different
    // depths (1, 2, and 3 hops), plus a further branch partway down the depth-3 tail (so pruning
    // must peel a whole nested subtree, not just single-hop tails). With path_weight the only
    // nonzero weight, the winning pair must be the two deepest reachable leaves: the tips of the
    // depth-2 and depth-3 tails (the depth-1 tail and the depth-3 tail's own shallow side branch
    // are strictly shallower and must lose) -- this is exactly the "peel dominated dead-end tails"
    // optimization's target shape (GitHub issue #634 follow-up).
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(4, 4), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let at = |x: i32, y: i32| field.node_at(level, SquarePoint { x, y }).unwrap();
    let bidir = |g: &mut Graph, a, b| g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);

    // Junction at (0,0). Tail A: depth 1 -> (1,0). Tail B: depth 2 -> (0,1)-(0,2). Tail C: depth 3
    // -> (2,0)-(2,1)-(2,2), with a depth-1 side branch off (2,1) -> (3,1).
    bidir(&mut graph, at(0, 0), at(1, 0));
    bidir(&mut graph, at(0, 0), at(0, 1));
    bidir(&mut graph, at(0, 1), at(0, 2));
    bidir(&mut graph, at(0, 0), at(2, 0));
    bidir(&mut graph, at(2, 0), at(2, 1));
    bidir(&mut graph, at(2, 1), at(2, 2));
    bidir(&mut graph, at(2, 1), at(3, 1));
    let mut maze: Maze<SquareTessellation> = Maze::new(field, graph);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_JUNCTION_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    let (a, b) = (maze.meta.start.unwrap(), maze.meta.finish.unwrap());
    let deep_b = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 2 })
        .unwrap();
    let deep_c = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 2 })
        .unwrap();
    assert!(
        (a == deep_b && b == deep_c) || (a == deep_c && b == deep_b),
        "winning pair must be the two deepest leaves (0,2) and (2,2), got start={a} finish={b}",
    );
}

#[test]
fn apply_does_not_prune_when_path_weight_is_zero() {
    // Same junction-with-three-tails shape as
    // `apply_picks_deepest_leaf_across_a_branching_tree_of_plain_dead_end_tails`, but with
    // `path_weight` at 0 and `junction_weight` the only nonzero weight instead. The dominance proof
    // pruning relies on requires strict growth of `path_weight`'s contribution (see
    // `ScoredPathContext::build`'s doc comment) -- at `path_weight <= 0.0` that growth disappears, so
    // pruning must be disabled and every node, including the depth-1 tail tip normally dominated
    // away, must remain a `best_pair` candidate. With junction_weight as the only nonzero weight,
    // every leaf ties on junction_count (all three tails end one hop past the junction's own
    // junction node), so the depth-1 tail tip winning here can only happen if it was never pruned
    // from the candidate list in the first place (GitHub issue #634 follow-up).
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(4, 4), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let at = |x: i32, y: i32| field.node_at(level, SquarePoint { x, y }).unwrap();
    let bidir = |g: &mut Graph, a, b| g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);

    // Junction at (0,0). Tail A: depth 1 -> (1,0). Tail B: depth 2 -> (0,1)-(0,2). Tail C: depth 3
    // -> (2,0)-(2,1)-(2,2).
    bidir(&mut graph, at(0, 0), at(1, 0));
    bidir(&mut graph, at(0, 0), at(0, 1));
    bidir(&mut graph, at(0, 1), at(0, 2));
    bidir(&mut graph, at(0, 0), at(2, 0));
    bidir(&mut graph, at(2, 0), at(2, 1));
    bidir(&mut graph, at(2, 1), at(2, 2));
    let mut maze: Maze<SquareTessellation> = Maze::new(field, graph);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_PATH_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    let (a, b) = (maze.meta.start.unwrap(), maze.meta.finish.unwrap());
    let shallow_a = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 1, y: 0 })
        .unwrap();
    assert!(
        a == shallow_a || b == shallow_a,
        "depth-1 tail tip (1,0), normally pruned away, must survive as a candidate when \
         path_weight is 0, got start={a} finish={b}",
    );
}

#[test]
fn apply_keeps_a_plain_fork_as_a_candidate_when_two_of_its_branches_are_a_loop() {
    // A 3-way plain fork at (1,1): two of its branches are opposite sides of a plain 4-cycle
    // ((1,1)-(0,1)-(0,0)-(1,0)-(1,1)), and the third is a genuine dead-end tail ((1,1)-(2,1)-(3,1)).
    // The fork can't be proven dominated by any single branch here -- unlike a fork whose branches
    // are *all* dead-end tails, two of this fork's branches loop back into the rest of the graph, so
    // there's no single "outside" leaf to compare the loop's two sides against. The fork must
    // therefore survive pruning as its own candidate (GitHub issue #634 follow-up: a fork must only
    // be dropped when at most one of its original branches leads back into the rest of the graph).
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(4, 2), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let at = |x: i32, y: i32| field.node_at(level, SquarePoint { x, y }).unwrap();
    let bidir = |g: &mut Graph, a, b| g.build_initial_bidirectional_edge(a, b, EdgeKind::Basic);

    bidir(&mut graph, at(1, 1), at(0, 1));
    bidir(&mut graph, at(0, 1), at(0, 0));
    bidir(&mut graph, at(0, 0), at(1, 0));
    bidir(&mut graph, at(1, 0), at(1, 1));
    bidir(&mut graph, at(1, 1), at(2, 1));
    bidir(&mut graph, at(2, 1), at(3, 1));
    let mut maze: Maze<SquareTessellation> = Maze::new(field, graph);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_JUNCTION_WEIGHT.to_string(), "0".to_string());
    overrides.insert(PARAM_ONEWAY_WEIGHT.to_string(), "0".to_string());
    let params =
        build_params(
            <ScoredEndpointsStrategy as RepairStrategy<
                SquareTessellation,
                MissingEndpointsIssue,
            >>::params(&ScoredEndpointsStrategy),
            Some(&overrides),
        );

    let result = apply_and_commit(
        &ScoredEndpointsStrategy,
        &issue(true, true),
        &mut maze,
        &mut rng(),
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: Some(_) }));
    let (a, b) = (maze.meta.start.unwrap(), maze.meta.finish.unwrap());
    let fork = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 1, y: 1 })
        .unwrap();
    let deep_tail = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 3, y: 1 })
        .unwrap();
    // What this regression test actually checks is that the fork survived pruning as a candidate:
    // with path_weight the only nonzero weight, the fork is one endpoint of the longest simple path
    // in this graph (dead-end tail tip, through the fork, around one side of the loop), so it can
    // only win here if it wasn't wrongly dropped from the candidate list.
    assert!(
        a == fork || b == fork,
        "fork at (1,1) must survive pruning as a candidate, got start={a} finish={b}",
    );
    assert!(
        a == deep_tail || b == deep_tail,
        "dead-end tail tip (3,1) must be the other endpoint, got start={a} finish={b}",
    );
}
