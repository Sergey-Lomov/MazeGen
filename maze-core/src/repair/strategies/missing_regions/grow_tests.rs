use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind as EK, Graph as G};
use crate::random::MazeRng;
use crate::repair::draft::DraftMaze;
use crate::space::{MultiLevelField, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::sync::Arc;

/// 1x2 path (start=0, finish=1) plus a 3-armed star of Unreachable singletons centered on
/// `hub` (node 2): each arm is a straight bidirectional chain of `arm_len` nodes running in a
/// different geometric direction, so `hub`'s frontier branches three ways after the first step
/// -- enough to tell DFS (stays on one arm) apart from BFS (spreads across all three) by which
/// nodes end up in the grown region. Grid is built oversized and arms are placed along +x, +y,
/// -y from `hub` so none of them touch the path or each other except at `hub`.
fn maze_with_three_armed_star(
    arm_len: i32,
) -> (Maze<SquareTessellation>, NodeId, Vec<Vec<NodeId>>) {
    let mut ids = IdGenerator::new();
    let width = (arm_len + 4) as usize;
    let height = (arm_len * 2 + 2) as usize;
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(width, height), &mut ids)
            .unwrap();
    let field_level = field.single_level_id();
    let mut g = G::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let n = |x: i32, y: i32| {
        field
            .node_at(field_level, crate::space::SquarePoint { x, y })
            .unwrap()
    };

    let start = n(0, arm_len);
    let finish = n(1, arm_len);
    g.add_edge(start, finish, EK::Basic);

    let hub = n(2, arm_len);
    // Arm A: +x direction from hub.
    let arm_a: Vec<NodeId> = (0..arm_len).map(|i| n(3 + i, arm_len)).collect();
    // Arm B: +y direction from hub.
    let arm_b: Vec<NodeId> = (0..arm_len).map(|i| n(2, arm_len + 1 + i)).collect();
    // Arm C: -y direction from hub.
    let arm_c: Vec<NodeId> = (0..arm_len).map(|i| n(2, arm_len - 1 - i)).collect();

    for arm in [&arm_a, &arm_b, &arm_c] {
        g.add_bidirectional_edge(hub, arm[0], EK::Basic);
        for w in arm.windows(2) {
            g.add_bidirectional_edge(w[0], w[1], EK::Basic);
        }
    }

    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);
    (maze, hub, vec![arm_a, arm_b, arm_c])
}

#[test]
fn grow_front_with_locality_one_stays_depth_first_on_a_single_arm() {
    // locality=1.0 always continues from the most recently added node (DFS) -- growing to
    // arm_len+1 nodes (hub + the whole arm) from a 3-armed star must consume one entire arm
    // before ever touching another, regardless of which arm it picks.
    let (maze, hub, arms) = maze_with_three_armed_star(4);
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(hub).unwrap();
    let critical: HashSet<NodeId> = maze
        .analysis
        .route_info(&maze.graph, &maze.field, &maze.meta)
        .map(|r| r.path.into_iter().collect())
        .unwrap_or_default();
    let mut budget = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft,
        hub,
        seed_component,
        &scc,
        &region_classes,
        &mut budget,
        1.0,
        5,
        &critical,
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    let members = result.expect("must grow to min_region_size within a single 4-node arm + hub");
    assert_eq!(members.len(), 5);
    let full_arm_included = arms
        .iter()
        .any(|arm| arm.iter().all(|n| members.contains(n)));
    assert!(
        full_arm_included,
        "DFS (locality=1.0) must fully consume one arm before branching, members: {:?}",
        members
    );
}

#[test]
fn grow_front_with_locality_zero_spreads_breadth_first_across_arms() {
    // locality=0.0 always picks a uniformly random node across the WHOLE frontier (BFS-like)
    // -- growing to only 4 nodes (hub + 3) from a 3-armed star should be very likely to touch
    // more than one arm rather than fully depleting a single one first, since immediately
    // after the first expansion the frontier holds one candidate per arm all at once.
    let mut touched_multiple_arms = false;
    for seed in 0..30u64 {
        let (maze, hub, arms) = maze_with_three_armed_star(6);
        let scc = maze.analysis.scc(&maze.graph);
        let region_classes = maze
            .analysis
            .region_classes(&maze.graph, &maze.field, &maze.meta);
        let seed_component = scc.component_of(hub).unwrap();
        let critical: HashSet<NodeId> = maze
            .analysis
            .route_info(&maze.graph, &maze.field, &maze.meta)
            .map(|r| r.path.into_iter().collect())
            .unwrap_or_default();
        let mut budget = HashMap::new();
        let mut rng = MazeRng::seed_from_u64(seed);
        let mut draft = DraftMaze::new(maze);
        let result = grow_front(
            &mut draft,
            hub,
            seed_component,
            &scc,
            &region_classes,
            &mut budget,
            0.0,
            4,
            &critical,
            &test_ctx(&HashSet::new(), &PresetState::empty()),
            &mut rng,
        );
        let members = result.expect("must grow to min_region_size");
        let arms_touched = arms
            .iter()
            .filter(|arm| arm.iter().any(|n| members.contains(n)))
            .count();
        if arms_touched > 1 {
            touched_multiple_arms = true;
            break;
        }
    }
    assert!(
        touched_multiple_arms,
        "BFS (locality=0.0) must spread across more than one arm at least once over 30 seeds"
    );
}

/// 1x2 path (start=0, finish=1). `seed`(2) has TWO geometric neighbors: `two_way`(3), joined by
/// a bidirectional edge, and `one_way`(4), joined only by a directed edge `seed -> one_way` (no
/// edge back). Growth from `seed` must only ever pick `two_way` as a candidate.
fn maze_with_one_way_and_two_way_neighbor() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 2), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = G::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let n = |x: i32, y: i32| {
        field
            .node_at(field_level, crate::space::SquarePoint { x, y })
            .unwrap()
    };
    let start = n(0, 0);
    let finish = n(1, 0);
    let seed = n(2, 0);
    let two_way = n(2, 1);
    let one_way = n(1, 1);
    g.add_edge(start, finish, EK::Basic);
    g.add_bidirectional_edge(seed, two_way, EK::Basic);
    g.add_edge(seed, one_way, EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);
    (maze, vec![start, finish, seed, two_way, one_way])
}

#[test]
fn grow_front_only_expands_through_bidirectional_edges() {
    let (maze, nodes) = maze_with_one_way_and_two_way_neighbor();
    let seed = nodes[2];
    let two_way = nodes[3];
    let one_way = nodes[4];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = maze
        .analysis
        .route_info(&maze.graph, &maze.field, &maze.meta)
        .map(|r| r.path.into_iter().collect())
        .unwrap_or_default();
    let mut budget = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft,
        seed,
        seed_component,
        &scc,
        &region_classes,
        &mut budget,
        0.5,
        2,
        &critical,
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    let members = result.expect("two_way is a valid bidirectional candidate");
    assert!(
        members.contains(&two_way),
        "must grow into the bidirectionally-connected neighbor"
    );
    assert!(
        !members.contains(&one_way),
        "must never grow into a neighbor reachable only via a one-way edge"
    );
}

#[test]
fn grow_front_fails_when_only_one_way_neighbors_are_available() {
    // Same fixture, but ask for min_region_size=3 (seed + two_way + one more) -- once two_way
    // is exhausted (it has no further non-critical bidirectional neighbors of its own) and no
    // excess budget exists to cross into one_way's component, growth must fail outright.
    let (maze, nodes) = maze_with_one_way_and_two_way_neighbor();
    let seed = nodes[2];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = maze
        .analysis
        .route_info(&maze.graph, &maze.field, &maze.meta)
        .map(|r| r.path.into_iter().collect())
        .unwrap_or_default();
    let mut budget = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft,
        seed,
        seed_component,
        &scc,
        &region_classes,
        &mut budget,
        0.5,
        3,
        &critical,
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    assert!(
        result.is_none(),
        "no excess budget to cross into one_way's component -- must fail, never take a one-way edge"
    );
}

/// 1x2 path (start=0, finish=1). `in_region` = {2}, a singleton Unreachable component.
/// `neighbor`(3) is a geometric neighbor of node 2, its own singleton Unreachable component,
/// with no edge to node 2 yet (candidate for bridging).
fn maze_with_bridgeable_neighbor() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(4);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

#[test]
fn try_open_excess_neighbor_bridges_a_single_node_and_debits_full_component_size() {
    let (maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let neighbor_component = scc.component_of(neighbor).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft,
        &in_region,
        &scc,
        &region_classes,
        &mut budget,
        &critical,
        &HashSet::from([seed_component]),
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    assert_eq!(
        opened,
        Some(OpenedNeighbor {
            node: neighbor,
            component: neighbor_component
        })
    );
    assert!(
        draft.maze.graph.edge_between(seed, neighbor).is_some(),
        "forward bridge edge must be added"
    );
    assert!(
        draft.maze.graph.edge_between(neighbor, seed).is_some(),
        "bridge must be bidirectional"
    );
    assert_eq!(
        budget.get(&RegionClass::Unreachable),
        None,
        "1-node component fully spends a budget of 1 -- entry removed"
    );
}

#[test]
fn try_open_excess_neighbor_returns_none_without_budget_for_the_bordering_class() {
    let (maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget: HashMap<RegionClass, i32> = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft,
        &in_region,
        &scc,
        &region_classes,
        &mut budget,
        &critical,
        &HashSet::from([seed_component]),
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    assert_eq!(
        opened, None,
        "no excess budget for neighbor's class -- must not cross"
    );
    assert!(
        draft.maze.graph.edge_between(seed, neighbor).is_none(),
        "no edge should have been added"
    );
    assert!(draft.maze.graph.edge_between(neighbor, seed).is_none());
}

#[test]
fn try_open_excess_neighbor_skips_a_critical_bordering_node() {
    let (maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    // Treat `neighbor` itself as critical -- must be excluded from bordering candidates
    // exactly like a same-component candidate would be.
    let critical: HashSet<NodeId> = [nodes[0], nodes[1], neighbor].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft,
        &in_region,
        &scc,
        &region_classes,
        &mut budget,
        &critical,
        &HashSet::from([seed_component]),
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    assert_eq!(
        opened, None,
        "neighbor is on the critical path -- must never be crossed into"
    );
    assert!(draft.maze.graph.edge_between(seed, neighbor).is_none());
}

#[test]
fn try_open_excess_neighbor_skips_a_committed_bordering_node() {
    let (maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let committed: HashSet<NodeId> = [neighbor].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft,
        &in_region,
        &scc,
        &region_classes,
        &mut budget,
        &critical,
        &HashSet::from([seed_component]),
        &test_ctx(&committed, &PresetState::empty()),
        &mut rng,
    );

    assert_eq!(
        opened, None,
        "neighbor was already committed by an earlier region item -- must never be crossed into"
    );
    assert!(draft.maze.graph.edge_between(seed, neighbor).is_none());
}

#[test]
fn try_open_excess_neighbor_respects_preset_blocked_bridge() {
    let (maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((seed, neighbor));
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft,
        &in_region,
        &scc,
        &region_classes,
        &mut budget,
        &critical,
        &HashSet::from([seed_component]),
        &test_ctx(&HashSet::new(), &preset_state),
        &mut rng,
    );

    assert_eq!(
        opened, None,
        "the only bordering candidate's bridge is preset-blocked -- must fail without leaking a partial edge"
    );
    assert!(
        draft.maze.graph.edge_between(seed, neighbor).is_none(),
        "no forward edge must leak from the blocked attempt"
    );
    assert!(draft.maze.graph.edge_between(neighbor, seed).is_none());
    assert_eq!(
        budget.get(&RegionClass::Unreachable),
        Some(&1),
        "a fully-blocked attempt must not debit the budget"
    );
}

#[test]
fn try_open_excess_neighbor_respects_preset_blocked_return_direction() {
    // Forward direction (seed -> neighbor) is allowed, only the return edge is blocked --
    // the candidate must still be rejected as a whole (bidirectional bridge required), and the
    // speculative forward edge must be rolled back, not left dangling as a one-way leak.
    let (maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((neighbor, seed));
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft,
        &in_region,
        &scc,
        &region_classes,
        &mut budget,
        &critical,
        &HashSet::from([seed_component]),
        &test_ctx(&HashSet::new(), &preset_state),
        &mut rng,
    );

    assert_eq!(
        opened, None,
        "return direction blocked -- whole candidate must be rejected"
    );
    assert!(
        draft.maze.graph.edge_between(seed, neighbor).is_none(),
        "speculative forward edge must be rolled back, not left as a one-way leak"
    );
    assert!(draft.maze.graph.edge_between(neighbor, seed).is_none());
}

#[test]
fn grow_front_crosses_into_excess_budgeted_neighbor_component_and_continues_growing_there() {
    // seed's own component is a singleton -- reaching min_region_size=3 requires crossing into
    // `neighbor`'s component AND continuing to grow from there via `neighbor`'s own
    // bidirectional edge to a third node, proving growth resumes past the crossed-in node
    // rather than stopping at exactly one absorbed node.
    let (field, mut g, nodes) = linear_field(5);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let seed = nodes[2];
    let neighbor = nodes[3];
    let beyond = nodes[4];

    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 2)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft,
        seed,
        seed_component,
        &scc,
        &region_classes,
        &mut budget,
        0.5,
        3,
        &critical,
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    let members =
        result.expect("must cross into neighbor's component and keep growing to reach size 3");
    assert_eq!(members, HashSet::from([seed, neighbor, beyond]));
}

/// 3x2 grid: `seed` has two same-component bidirectional branches: `dead_end` (a single node,
/// exhausted after one step) and `long_branch` (two nodes long, still has candidates after
/// `dead_end` is spent). `bridgeable` is a separate singleton Unreachable component,
/// geometrically adjacent to `dead_end` only -- an excess-budgeted neighbor that a premature
/// (per-node, not whole-frontier) absorption trigger would incorrectly cross into as soon as
/// `dead_end` alone runs out of candidates, even while `long_branch` still has same-component
/// nodes left to grow into.
fn maze_with_uneven_branches_and_a_bridgeable_neighbor() -> (Maze<SquareTessellation>, Vec<NodeId>)
{
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(4, 2), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = G::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let n = |x: i32, y: i32| {
        field
            .node_at(field_level, crate::space::SquarePoint { x, y })
            .unwrap()
    };
    let start = n(0, 0);
    let finish = n(1, 0);
    let seed = n(2, 0);
    let dead_end = n(3, 0);
    let long_a = n(2, 1);
    let long_b = n(3, 1);
    let bridgeable = n(1, 1); // field-neighbor of dead_end only, separate Unreachable singleton

    g.add_edge(start, finish, EK::Basic);
    g.add_bidirectional_edge(seed, dead_end, EK::Basic);
    g.add_bidirectional_edge(seed, long_a, EK::Basic);
    g.add_bidirectional_edge(long_a, long_b, EK::Basic);

    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);
    (
        maze,
        vec![start, finish, seed, dead_end, long_a, long_b, bridgeable],
    )
}

#[test]
fn grow_front_does_not_cross_into_a_neighbor_component_while_other_frontier_nodes_still_have_candidates()
 {
    // Force BFS-like uniform frontier picks (locality=0.0) so `dead_end` (a valid frontier
    // pick) gets exhausted at some point while `long_a`/`long_b` still have unexplored
    // same-component candidates -- with `min_region_size` set to consume the ENTIRE
    // same-component reachable set (seed + dead_end + long_a + long_b = 4 nodes), growth must
    // finish using only same-component nodes and never touch `bridgeable`, even though
    // `bridgeable` has plenty of excess budget available the whole time.
    let (maze, nodes) = maze_with_uneven_branches_and_a_bridgeable_neighbor();
    let seed = nodes[2];
    let dead_end = nodes[3];
    let long_a = nodes[4];
    let long_b = nodes[5];
    let bridgeable = nodes[6];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();

    for seed_val in 0..30u64 {
        let (maze, _) = maze_with_uneven_branches_and_a_bridgeable_neighbor();
        let mut budget = HashMap::from([(RegionClass::Unreachable, 100)]);
        let mut rng = MazeRng::seed_from_u64(seed_val);
        let mut draft = DraftMaze::new(maze);
        let result = grow_front(
            &mut draft,
            seed,
            seed_component,
            &scc,
            &region_classes,
            &mut budget,
            0.0,
            4,
            &critical,
            &test_ctx(&HashSet::new(), &PresetState::empty()),
            &mut rng,
        );
        let members = result.unwrap_or_else(|| panic!("seed {seed_val}: same-component set alone reaches min_region_size=4, must not need to cross"));
        assert_eq!(
            members,
            HashSet::from([seed, dead_end, long_a, long_b]),
            "seed {seed_val}: must consume all 4 same-component nodes, never touching bridgeable"
        );
        assert_eq!(
            budget.get(&RegionClass::Unreachable),
            Some(&100),
            "seed {seed_val}: excess budget must remain untouched -- no crossing should have happened"
        );
        assert!(
            draft
                .maze
                .graph
                .edge_between(dead_end, bridgeable)
                .is_none(),
            "seed {seed_val}: no bridge to bridgeable must have been added"
        );
    }
}

#[test]
fn grow_front_fails_when_frontier_exhausted_and_no_excess_budget_to_cross() {
    let (maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget: HashMap<RegionClass, i32> = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft,
        seed,
        seed_component,
        &scc,
        &region_classes,
        &mut budget,
        0.5,
        2,
        &critical,
        &test_ctx(&HashSet::new(), &PresetState::empty()),
        &mut rng,
    );

    assert!(
        result.is_none(),
        "seed is a singleton component with no bidirectional neighbor and no excess budget -- must fail"
    );
}

/// 3x3 grid: a 5-node plus-shaped Unreachable component (center + 4 arms, all bidirectional)
/// with one extra bidirectional edge from the top arm out to a 6th node OUTSIDE `members` --
/// the external edge `sever_from_parent` must cut, while internal plus-shaped connectivity must
/// survive untouched.
fn maze_with_plus_shaped_region_and_external_edge() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 4), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = G::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let n = |x: i32, y: i32| {
        field
            .node_at(field_level, crate::space::SquarePoint { x, y })
            .unwrap()
    };
    let start = n(0, 0);
    let finish = n(1, 0);
    g.add_edge(start, finish, EK::Basic);

    let center = n(1, 2);
    let up = n(1, 1);
    let down = n(1, 3);
    let left = n(0, 2);
    let right = n(2, 2);
    let outside = n(0, 1); // field-neighbor of `up`, NOT part of `members`

    g.add_bidirectional_edge(center, up, EK::Basic);
    g.add_bidirectional_edge(center, down, EK::Basic);
    g.add_bidirectional_edge(center, left, EK::Basic);
    g.add_bidirectional_edge(center, right, EK::Basic);
    g.add_bidirectional_edge(up, outside, EK::Basic); // external edge, must be severed

    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);
    (
        maze,
        vec![start, finish, center, up, down, left, right, outside],
    )
}

#[test]
fn sever_from_parent_removes_external_edges_but_keeps_internal_connectivity() {
    let (maze, nodes) = maze_with_plus_shaped_region_and_external_edge();
    let center = nodes[2];
    let up = nodes[3];
    let down = nodes[4];
    let left = nodes[5];
    let right = nodes[6];
    let outside = nodes[7];
    let members: HashSet<NodeId> = [center, up, down, left, right].into_iter().collect();

    let mut draft = DraftMaze::new(maze);
    assert!(sever_from_parent(
        &mut draft,
        &members,
        &PresetState::empty()
    ));

    assert!(
        draft.maze.graph.edge_between(up, outside).is_none(),
        "external edge must be cut (outbound)"
    );
    assert!(
        draft.maze.graph.edge_between(outside, up).is_none(),
        "external edge must be cut (inbound)"
    );

    for &(a, b) in &[
        (center, up),
        (center, down),
        (center, left),
        (center, right),
    ] {
        assert!(
            draft.maze.graph.edge_between(a, b).is_some(),
            "internal edge {a:?}->{b:?} must survive severance"
        );
        assert!(
            draft.maze.graph.edge_between(b, a).is_some(),
            "internal edge {b:?}->{a:?} must survive severance"
        );
    }

    let scc = draft.maze.analysis.scc(&draft.maze.graph);
    let members_component = scc.component_of(center);
    for &m in &members {
        assert_eq!(
            scc.component_of(m),
            members_component,
            "members must remain one connected SCC after severance"
        );
    }
}

#[test]
fn sever_from_parent_fails_when_a_required_cut_is_preset_blocked() {
    let (maze, nodes) = maze_with_plus_shaped_region_and_external_edge();
    let center = nodes[2];
    let up = nodes[3];
    let down = nodes[4];
    let left = nodes[5];
    let right = nodes[6];
    let outside = nodes[7];
    let members: HashSet<NodeId> = [center, up, down, left, right].into_iter().collect();

    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((up, outside));

    let mut draft = DraftMaze::new(maze);
    assert!(
        !sever_from_parent(&mut draft, &members, &preset_state),
        "a preset-protected external edge blocks the whole severance"
    );
}

/// 1x2 path (start=0, finish=1) plus 6 singleton Unreachable seed candidates: `bordering`(2) is
/// a field-neighbor of finish (so it has a nonzero inbound border_score for `Trap`), and 5 decoy
/// seeds (3..8) are geometrically isolated from the path (a gap at node 2's row keeps them from
/// ever being field-neighbors of start/finish). With `MAX_GROW_ATTEMPTS=3` (fewer than 6 total
/// seed candidates), border-priority being ON must always pick `bordering` first; being OFF
/// means shuffle alone decides and `bordering` can easily be excluded from the 3-seed attempt
/// window entirely, making growth (and therefore the whole `MissingRegions` conversion) fail
/// more often across seeds.
fn maze_with_one_bordering_seed_and_decoys() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(9);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    // nodes[2] is a field-neighbor of finish (nodes[1]) -- the only seed with a border. Decoys
    // 3..8 are only adjacent to the path through node 2 (not directly), and `border_score` only
    // checks direct field-adjacency to reachable_from_start/reachable_to_finish, not
    // transitively -- so they score 0.
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

#[test]
fn try_grow_border_priority_on_always_picks_the_bordering_seed_first() {
    for seed in 0..20u64 {
        let (maze, nodes) = maze_with_one_bordering_seed_and_decoys();
        let bordering = nodes[2];
        let mut rng = MazeRng::seed_from_u64(seed);
        let mut excess_budget: HashMap<RegionClass, i32> = HashMap::new();
        let ctx = GrowContext {
            committed_nodes: &HashSet::new(),
            preset_state: &PresetState::empty(),
            inbound_requires_geometry: true,
            outbound_requires_geometry: true,
        };
        let mut draft = DraftMaze::new(maze);
        let result = try_grow(
            &mut draft,
            RegionClass::Trap,
            0.5,
            1,
            &mut excess_budget,
            &ctx,
            &mut rng,
        );
        let members = result.unwrap_or_else(|| panic!("seed {seed}: growth must succeed with MAX_GROW_ATTEMPTS covering the bordering seed when priority is ON"));
        assert!(
            members.contains(&bordering),
            "seed {seed}: border priority ON must always land on the bordering seed"
        );
    }
}

#[test]
fn try_grow_border_priority_off_sometimes_fails_by_missing_the_bordering_seed() {
    // Decoy seeds (3..8) have zero border to `reachable_from_start` -- `convert_region` can
    // never bridge them into `Trap`, so growth only succeeds when `bordering` (node 2) is among
    // the `MAX_GROW_ATTEMPTS=3` seeds actually tried. With priority ON that's guaranteed (see
    // the sibling test); with it OFF, shuffle alone decides the 3-seed window, so `bordering`
    // must occasionally miss the window and the whole attempt must fail (`None`) -- proving
    // border-priority is genuinely doing the work of guaranteeing success, not a no-op.
    let mut saw_a_failure = false;
    for seed in 0..40u64 {
        let (maze, _) = maze_with_one_bordering_seed_and_decoys();
        let mut rng = MazeRng::seed_from_u64(seed);
        let mut excess_budget: HashMap<RegionClass, i32> = HashMap::new();
        let ctx = GrowContext {
            committed_nodes: &HashSet::new(),
            preset_state: &PresetState::empty(),
            inbound_requires_geometry: false,
            outbound_requires_geometry: false,
        };
        let mut draft = DraftMaze::new(maze);
        let result = try_grow(
            &mut draft,
            RegionClass::Trap,
            0.5,
            1,
            &mut excess_budget,
            &ctx,
            &mut rng,
        );
        if result.is_none() {
            saw_a_failure = true;
            break;
        }
    }
    assert!(
        saw_a_failure,
        "border priority OFF must let the bordering seed miss the MAX_GROW_ATTEMPTS window (causing a failed attempt) at least once over 40 seeds"
    );
}
