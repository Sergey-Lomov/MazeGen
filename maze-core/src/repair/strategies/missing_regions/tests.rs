use super::GrowContext;
use super::convert::{convert_region, membership_matches};
use super::grow::{OpenedNeighbor, grow_front, sever_from_parent, try_open_excess_neighbor};
use super::reuse::{absorb_until_min_size, filter_by_border, prioritize_candidates};
use super::*;
use crate::IdGenerator;
use crate::graph::scc::ComponentId;
use crate::graph::{EdgeKind as EK, Graph as G};
use crate::quality_control::MissingRegionsIssue;
use crate::random::MazeRng;
use crate::repair::params::build_params;
use crate::space::{MultiLevelField, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::collections::HashMap as StdHashMap;
use std::sync::Arc;

fn default_params() -> StrategyParams {
    build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(
            &MissingRegionsStrategy,
        ),
        None,
    )
}

/// Runs `MissingRegionsStrategy::apply` under the new immutable-`&Maze` + returned-commands
/// contract and commits the resulting commands back onto `maze` in place, so a test's existing
/// post-condition assertions on `maze.graph`/`maze.analysis`/`maze.meta` keep working exactly as
/// they did when `apply` mutated the maze directly. Returns the `RepairResult`.
fn apply_and_commit(
    issue: &MissingRegionsIssue,
    maze: &mut Maze<SquareTessellation>,
    rng: &mut dyn rand::RngCore,
    params: &StrategyParams,
    preset_state: &PresetState,
) -> RepairResult {
    let (result, commands) = RepairStrategy::apply(
        &MissingRegionsStrategy,
        issue,
        maze,
        rng,
        params,
        preset_state,
        &[],
    );
    crate::quality_control::apply_commands::apply_commands(
        maze,
        preset_state,
        commands,
        None,
        None,
    );
    result
}

fn test_ctx<'a>(
    committed_nodes: &'a HashSet<NodeId>,
    preset_state: &'a PresetState,
) -> GrowContext<'a> {
    GrowContext {
        committed_nodes,
        preset_state,
        inbound_requires_geometry: true,
        outbound_requires_geometry: true,
    }
}

/// Builds a `1xN` row field with an empty graph and returns its nodes in x-order — the shared
/// boilerplate every linear `maze_with_*` fixture in this file starts from.
fn linear_field(n: usize) -> (MultiLevelField<SquareTessellation>, G, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(n, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = G::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let nodes: Vec<_> = field
        .field_of(field_level)
        .unwrap()
        .all_points()
        .map(|p| field.node_at(field_level, p).unwrap())
        .collect();
    (field, g, nodes)
}

/// Builds a `MISSING_REGIONS` issue from shortfall counts — `missing` values are how many
/// regions short of the minimum each class is (always positive), converted to the `-N`
/// balance convention internally so existing tests keep their original "missing count" call
/// sites unchanged.
fn issue_for(missing: Vec<(RegionClass, u32)>) -> MissingRegionsIssue {
    MissingRegionsIssue::new_from_check(
        "test",
        missing.into_iter().map(|(c, n)| (c, -(n as i32))).collect(),
    )
}

/// Builds a `MISSING_REGIONS` issue from raw signed balances — `-N` shortfall, `+N` surplus
/// budget for cross-region growth.
fn issue_with_balance(balance: Vec<(RegionClass, i32)>) -> MissingRegionsIssue {
    MissingRegionsIssue::new_from_check("test", balance.into_iter().collect())
}

/// 1x6 row: start(0) -> 1 -> finish(2), each a singleton; nodes 3,4,5 unconnected (each a
/// singleton Unreachable region) and geometrically adjacent in a chain.
fn maze_with_path_and_unreachables() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(6);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[1], nodes[2], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);
    (maze, nodes)
}

#[test]
fn apply_fails_without_start_or_finish() {
    let (mut maze, _) = maze_with_path_and_unreachables();
    maze.meta.start = None;
    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_reuses_unreachable_region_into_trap() {
    let (mut maze, nodes) = maze_with_path_and_unreachables();
    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    let has_trap = [nodes[3], nodes[4], nodes[5]].iter().any(|&n| {
        scc.component_of(n)
            .and_then(|idx| classes.get(&idx))
            .copied()
            == Some(RegionClass::Trap)
    });
    assert!(
        has_trap,
        "expected one of the unreachable singletons to become a Trap region"
    );
}

#[test]
fn apply_path_class_is_skipped_not_failed() {
    let (mut maze, _) = maze_with_path_and_unreachables();
    let issue = issue_for(vec![(RegionClass::Path, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    let result = apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Failed));
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(
        edges_before, edges_after,
        "Path-only request must not mutate the graph"
    );
}

#[test]
fn apply_fails_when_no_candidates_at_all() {
    // Path-only maze with no spare nodes to reuse or grow from.
    let (field, mut g, nodes) = linear_field(3);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[1], nodes[2], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    let result = apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Failed));
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(
        edges_before, edges_after,
        "failed attempts must leave the graph untouched"
    );
}

#[test]
fn apply_respects_preset_blocked_pairs_during_reuse() {
    let (mut maze, nodes) = maze_with_path_and_unreachables();
    let mut preset_state = PresetState::empty();
    // Block every possible bridge from the path into the unreachable singletons.
    for &from in &[nodes[0], nodes[1], nodes[2]] {
        for &to in &[nodes[3], nodes[4], nodes[5]] {
            preset_state.blocked.insert((from, to));
            preset_state.blocked.insert((to, from));
        }
    }
    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(3);
    let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    let result = apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &preset_state,
    );
    assert!(matches!(result, RepairResult::Failed));
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_before, edges_after);
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let (mut maze_a, _) = maze_with_path_and_unreachables();
    let issue_a = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng_a = MazeRng::seed_from_u64(99);
    apply_and_commit(
        &issue_a,
        &mut maze_a,
        &mut rng_a,
        &default_params(),
        &PresetState::empty(),
    );

    let (mut maze_b, _) = maze_with_path_and_unreachables();
    let issue_b = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng_b = MazeRng::seed_from_u64(99);
    apply_and_commit(
        &issue_b,
        &mut maze_b,
        &mut rng_b,
        &default_params(),
        &PresetState::empty(),
    );

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_a, edges_b);
}

#[test]
fn apply_never_uses_critical_path_nodes_as_seed_or_bridge_target() {
    let (mut maze, nodes) = maze_with_path_and_unreachables();
    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(11);
    apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );
    // Critical path nodes (0,1,2) must keep their original outgoing edges only to each
    // other -- they should not have been absorbed into the new Trap region's component.
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    for &n in &[nodes[0], nodes[1], nodes[2]] {
        let class = scc
            .component_of(n)
            .and_then(|idx| classes.get(&idx))
            .copied();
        assert_eq!(class, Some(RegionClass::Path));
    }
}

#[test]
fn apply_grows_when_no_reusable_unreachable_region_exists() {
    // 1x2 path (start/finish) plus a 1x3 strip of unconnected nodes geometrically
    // adjacent to each other but not to the path -- forces growth (front expansion)
    // since reuse alone (a single singleton) still works, so use min_region_size=2
    // to force growth to actually expand the frontier.
    let (field, mut g, nodes) = linear_field(5);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "2".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(
            &MissingRegionsStrategy,
        ),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_grows_from_a_tree_shaped_maze_with_no_non_path_regions_at_all() {
    // Regression test: a tree-shaped maze (no cycles, e.g. the typical
    // recursive_backtracker output with a low/zero one_way_chance) has exactly one SCC
    // covering every node, classified entirely as Path -- there is no pre-existing
    // Unreachable/Trap/Alternative region anywhere to reuse or seed growth from. Growth
    // must still be able to carve a Trap region out of a non-critical-path branch.
    //
    // Layout: a 3x3 grid, every node connected into one all-bidirectional spanning tree
    // (no cycles):
    //   (0,0)-(1,0)-(2,0)
    //           |     |
    //         (1,1) (2,1)-(2,2)
    //           |
    //   (0,1)-(0,2)   (1,2) (leaf off (0,1) and (1,1) respectively)
    // start=(0,0), finish=(2,0): critical path is (0,0)-(1,0)-(2,0). Every other node is
    // reachable both ways through the tree's single connecting path but NOT on the
    // critical path -- a valid growth seed.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(3, 3), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = G::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let all_coords: Vec<(i32, i32)> = (0..3).flat_map(|y| (0..3).map(move |x| (x, y))).collect();
    let nodes: StdHashMap<(i32, i32), NodeId> = all_coords
        .iter()
        .map(|&(x, y)| {
            (
                (x, y),
                field
                    .node_at(field_level, crate::space::SquarePoint { x, y })
                    .unwrap(),
            )
        })
        .collect();
    g.add_bidirectional_edge(nodes[&(0, 0)], nodes[&(1, 0)], EK::Basic);
    g.add_bidirectional_edge(nodes[&(1, 0)], nodes[&(2, 0)], EK::Basic);
    g.add_bidirectional_edge(nodes[&(1, 0)], nodes[&(1, 1)], EK::Basic);
    g.add_bidirectional_edge(nodes[&(1, 1)], nodes[&(1, 2)], EK::Basic);
    g.add_bidirectional_edge(nodes[&(1, 1)], nodes[&(0, 1)], EK::Basic);
    g.add_bidirectional_edge(nodes[&(0, 1)], nodes[&(0, 2)], EK::Basic);
    g.add_bidirectional_edge(nodes[&(2, 0)], nodes[&(2, 1)], EK::Basic);
    g.add_bidirectional_edge(nodes[&(2, 1)], nodes[&(2, 2)], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    let start = nodes[&(0, 0)];
    let finish = nodes[&(2, 0)];
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);

    // Sanity check the fixture: confirm there is exactly one SCC (the whole tree) and it
    // has zero Unreachable/Trap regions to reuse or seed growth from (every node is
    // either on the shortest path -- Path -- or reachable both ways through the tree's
    // single connecting path -- Alternative).
    let classes_before = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    assert!(
        classes_before
            .values()
            .all(|&c| c == RegionClass::Path || c == RegionClass::Alternative),
        "fixture must start with zero Unreachable/Trap regions, got: {:?}",
        classes_before.values().collect::<Vec<_>>()
    );

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "1".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(
            &MissingRegionsStrategy,
        ),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "growth must succeed even with zero pre-existing non-Path regions"
    );

    let classes_after = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    assert!(
        classes_after.values().any(|&c| c == RegionClass::Trap),
        "expected a Trap region to have been created"
    );
}

/// 1x8 row: start(0) -> 1 -> finish(2), then four singleton Unreachable regions (3,4,5,6)
/// geometrically chained, and one more singleton (7) chained after them -- enough spare
/// regions for multi-item scenarios.
fn maze_with_many_unreachables() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(8);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[1], nodes[2], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);
    (maze, nodes)
}

#[test]
fn apply_two_trap_regions_both_succeed_via_reuse() {
    let (mut maze, nodes) = maze_with_many_unreachables();
    let issue = issue_for(vec![(RegionClass::Trap, 2)]);
    let mut rng = MazeRng::seed_from_u64(13);
    let result = apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    let trap_count = [nodes[3], nodes[4], nodes[5], nodes[6], nodes[7]]
        .iter()
        .filter(|&&n| {
            scc.component_of(n)
                .and_then(|idx| classes.get(&idx))
                .copied()
                == Some(RegionClass::Trap)
        })
        .count();
    assert_eq!(
        trap_count, 2,
        "exactly 2 distinct singletons should have become separate Trap regions"
    );
}

#[test]
fn apply_second_item_never_reuses_first_items_committed_nodes() {
    let (mut maze, nodes) = maze_with_many_unreachables();
    let issue = issue_for(vec![(RegionClass::Trap, 2)]);
    let mut rng = MazeRng::seed_from_u64(13);
    apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );

    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    let trap_components: HashSet<ComponentId> = [nodes[3], nodes[4], nodes[5], nodes[6], nodes[7]]
        .iter()
        .filter_map(|&n| scc.component_of(n))
        .filter(|idx| classes.get(idx).copied() == Some(RegionClass::Trap))
        .collect();
    // Two Trap regions were created -- they must be two distinct components, not the same
    // component re-grown/re-converted (which would mean the second item touched the
    // first's already-committed nodes instead of finding a fresh region).
    assert_eq!(trap_components.len(), 2);
}

#[test]
fn apply_partial_success_within_one_class_is_fixed() {
    // 2 Trap regions requested but only enough spare singletons for partial progress
    // before a later item in the same class runs out of fresh (non-committed) candidates
    // and fails -- overall result must still be `Fixed` because at least one item in the
    // whole call succeeded, not `Failed` just because the full `missing` count wasn't met.
    let (field, mut g, nodes) = linear_field(4);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    // Only nodes[2],nodes[3] left as Unreachable singletons -- but they are geometrically
    // adjacent to each other (node[2]-node[3]), so once one becomes Trap (and is added to
    // committed_nodes) the other still has its own neighbor (node[1]=finish) to bridge
    // from, so this remains a 2-region scenario, not a contrived deadlock.
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let issue = issue_for(vec![(RegionClass::Trap, 2)]);
    let mut rng = MazeRng::seed_from_u64(21);
    let result = apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_max_total_failures_aborts_remaining_classes() {
    // `Alternative` is processed first (sorted by class name, "alternative" < "trap") and
    // is unreachable here (no outbound-to-finish bridge exists from the unreachable
    // singletons without looping back through the Path region in this 1x6 strip) -- it
    // burns through `MAX_TOTAL_FAILURES` before `Trap` ever gets a turn, so `Trap`'s
    // `missing` count must remain fully untouched (0 committed) and the overall result is
    // `Failed` (nothing committed at all).
    let (mut maze, _) = maze_with_path_and_unreachables();
    let issue = issue_for(vec![(RegionClass::Trap, 1), (RegionClass::Alternative, 1)]);
    let mut rng = MazeRng::seed_from_u64(21);
    let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    let result = apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Failed));
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(
        edges_before, edges_after,
        "every attempted mutation must have been rolled back"
    );
}

#[test]
fn apply_growth_never_crosses_into_a_different_scc_component() {
    // Path: 0 -> 1 (start -> finish). A 3-node Unreachable SCC (2<->3<->4, cyclic, all
    // mutually reachable) sits geometrically adjacent to a *separate* singleton
    // Unreachable node 5 (5 is a field-neighbor of 4, but no edge connects them, so it's
    // its own SCC). With min_region_size=2, growth seeded inside the 3-node component
    // must stay within {2,3,4} and never pull in node 5 from the neighboring component.
    let (field, mut g, nodes) = linear_field(6);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_bidirectional_edge(nodes[2], nodes[3], EK::Basic);
    g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "2".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(
            &MissingRegionsStrategy,
        ),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(17);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // node 5 must remain its own untouched Unreachable singleton -- not absorbed into the
    // grown/converted Trap region, and not connected to anything.
    assert!(maze.graph.edge_between(nodes[4], nodes[5]).is_none());
    assert!(maze.graph.edge_between(nodes[5], nodes[4]).is_none());
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    assert_eq!(
        scc.component_of(nodes[5])
            .and_then(|idx| classes.get(&idx))
            .copied(),
        Some(RegionClass::Unreachable)
    );
}

/// 1x7 row: 0=start, 1=finish (edge 0->1), 2=gap bidirectionally tied to finish so it joins
/// finish's SCC and is classified `Path` -- a node with no excess budget entry for its own
/// class is skipped by `try_open_excess_neighbor` regardless of how many components border
/// it, so this keeps the gap from ever being mistaken for a crossable neighbor by the unit
/// tests below, while still putting one tile of geometric distance between finish and node 3
/// (so `{3,4,5}` is never a field-neighbor of finish/start directly). 3..5 a 3-node cyclic
/// Unreachable SCC (3<->4<->5, chained), 6=region6 a separate singleton Unreachable SCC
/// (field-neighbor of node 5 only, no graph edge to it).
fn maze_with_two_isolated_unreachable_components() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(7);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_bidirectional_edge(nodes[1], nodes[2], EK::Basic);
    g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
    g.add_bidirectional_edge(nodes[4], nodes[5], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

/// 1x6 column (single-wide field -- no second column of unused nodes to compete for excess
/// budget): `(0,0)=start -> (0,1)=finish, (0,2)=region6 (singleton Unreachable,
/// field-neighbor of finish AND of n5), (0,3)=n5 <-> (0,4)=n4 <-> (0,5)=n3` (3-node cyclic
/// Unreachable SCC). `{n3,n4,n5}` borders nothing reachable on its own (no member is a
/// field-neighbor of start/finish). `region6` alone borders `reachable_from_start` (finish,
/// via the start->finish edge) -- on its own it's exactly the kind of single-node region
/// `try_reuse` could already convert straight to `Trap`, EXCEPT it is forced too small via
/// `min_region_size` in the tests below, so it must absorb `{n3,n4,n5}` (its only other
/// field-bordering component) to reach the required size before conversion. The merged
/// 4-node set is what actually reaches `Trap`, not `region6` alone.
fn maze_with_mergeable_pair_bordering_finish() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(1, 6), &mut ids).unwrap();
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
    let finish = n(0, 1);
    let region6 = n(0, 2);
    let n5 = n(0, 3);
    let n4 = n(0, 4);
    let n3 = n(0, 5);
    g.add_edge(start, finish, EK::Basic);
    g.add_bidirectional_edge(n3, n4, EK::Basic);
    g.add_bidirectional_edge(n4, n5, EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);
    (maze, vec![start, finish, region6, n3, n4, n5])
}

#[test]
fn apply_merges_a_too_small_region_with_an_excess_budgeted_neighbor_to_reach_min_size() {
    // min_region_size=4 (bigger than region6's 1 node, and bigger than {n3,n4,n5}'s 3
    // nodes individually) AND the issue carries a `+1` surplus balance for Unreachable --
    // with that budget present, the strategy must merge region6 (which alone borders
    // finish but is too small) with its only bordering neighbor {n3,n4,n5} (which alone
    // borders nothing), bridge the two chunks together, and land all 4 nodes on Trap as one
    // region. Whether this happens via `try_reuse`'s new absorb-loop or via `try_grow`
    // falling back doesn't matter to this test -- either path is the feature under test.
    let (mut maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let region6 = nodes[2];
    let n3 = nodes[3];
    let n4 = nodes[4];
    let n5 = nodes[5];

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "4".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(
            &MissingRegionsStrategy,
        ),
        Some(&overrides),
    );

    let issue = issue_with_balance(vec![(RegionClass::Trap, -1), (RegionClass::Unreachable, 1)]);
    let mut rng = MazeRng::seed_from_u64(17);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "must succeed by merging region6 with {{n3,n4,n5}} using the Unreachable surplus budget"
    );

    // All 4 nodes must now be one single Trap region -- proves both the cross-component
    // absorption and the bridging edge (otherwise region6 would be disconnected from
    // {n3,n4,n5} and membership-check would never have let this land on Trap for all four
    // at once).
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    let merged_component = scc.component_of(region6);
    assert!(
        merged_component.is_some(),
        "region6 must be in some SCC after absorption"
    );
    for &n in &[n3, n4, n5, region6] {
        assert_eq!(
            scc.component_of(n),
            merged_component,
            "all four absorbed nodes must share one SCC"
        );
    }
    assert_eq!(
        classes.get(&merged_component.unwrap()).copied(),
        Some(RegionClass::Trap)
    );
}

#[test]
fn apply_reuses_undersized_region_alone_without_excess_budget() {
    // Same layout, same min_region_size=4 -- but NO surplus balance entry for Unreachable
    // this time. `try_reuse` has never required a minimum size on its own (only `try_grow`
    // enforces `min_region_size` for newly grown regions) -- absorption is opportunistic,
    // not mandatory, so region6 alone (1 node, below min_region_size) is still reused into
    // Trap exactly as it always was, without merging {n3,n4,n5} at all.
    let (mut maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let region6 = nodes[2];
    let n3 = nodes[3];

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "4".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(
            &MissingRegionsStrategy,
        ),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(17);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "no excess budget -- region6 must still be reusable alone, below min_region_size"
    );

    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    assert_eq!(
        classes.get(&scc.component_of(region6).unwrap()).copied(),
        Some(RegionClass::Trap),
        "region6 alone became Trap"
    );
    assert_eq!(
        classes.get(&scc.component_of(n3).unwrap()).copied(),
        Some(RegionClass::Unreachable),
        "{{n3,n4,n5}} must remain untouched, not merged in"
    );
}

#[test]
fn apply_does_not_leak_inbound_edge_from_a_failed_unreachable_to_alternative_candidate() {
    // Two Unreachable singletons (3 and 5), each geometrically adjacent to the path.
    // Node 3's only route to finish-reachable territory is blocked by preset, so any
    // candidate that tries to convert node 3 into Alternative must add its inbound edge
    // (from the path) and then fail the outbound search -- that inbound edge must not
    // survive into the final graph once node 5 succeeds instead. Regression test for the
    // mutation-leak bug in convert_region's (Unreachable -> Alternative) transition.
    // Try many seeds to make the candidate ordering exercise node 3 first at least once
    // regardless of rng -- the bug only manifests when a failing candidate is tried before
    // a succeeding one in the same call.
    for seed in 0..30u64 {
        let (field, mut g, nodes) = linear_field(6);
        g.add_edge(nodes[0], nodes[1], EK::Basic);
        g.add_edge(nodes[1], nodes[2], EK::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[2]);

        let mut preset_state = PresetState::empty();
        // Block every outgoing edge from node 3 -- it can receive an inbound edge but can
        // never get an outbound edge to finish-reachable territory, so
        // Unreachable->Alternative must fail for it specifically after adding the inbound
        // edge.
        for &to in &[nodes[2], nodes[4]] {
            preset_state.blocked.insert((nodes[3], to));
        }

        let issue = issue_for(vec![(RegionClass::Alternative, 1)]);
        let mut rng = MazeRng::seed_from_u64(seed);
        let result = apply_and_commit(
            &issue,
            &mut maze,
            &mut rng,
            &default_params(),
            &preset_state,
        );
        if matches!(result, RepairResult::Fixed { score: None }) {
            // Whatever succeeded, node 3 must never have gained an inbound edge unless it
            // is itself the final committed Alternative region (in which case it would also
            // need a valid outbound edge, which preset forbids) -- so node 3 must have
            // exactly its original zero edges.
            assert!(
                maze.graph.edge_between(nodes[1], nodes[3]).is_none(),
                "seed {seed}: leaked inbound edge into node 3"
            );
            assert!(
                maze.graph.edge_between(nodes[2], nodes[3]).is_none(),
                "seed {seed}: leaked inbound edge into node 3"
            );
        }
    }
}

/// 1x17 row: 0-1-2 is the path (start=0, finish=2). Node 2 borders node 3, which heads a
/// 6-node connected Unreachable region (3..8) -- the only candidate actually convertible
/// into Trap. A gap at node 9 (left disconnected) separates it from 7 decoy Unreachable
/// singletons at nodes 10..16, with zero adjacency to the path or to the big region.
fn maze_with_one_bordering_region_and_decoys() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (field, mut g, nodes) = linear_field(17);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[1], nodes[2], EK::Basic);
    for i in 3..8 {
        g.add_bidirectional_edge(nodes[i], nodes[i + 1], EK::Basic);
    }
    // nodes[9] stays a disconnected gap; nodes[10..17] are 7 decoy singletons.
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);
    (maze, nodes)
}

#[test]
fn apply_reuse_prioritizes_the_region_actually_bordering_the_path() {
    // Regression test for "growth/reuse picks a region with no border to the path":
    // with MAX_REUSE_ATTEMPTS=5 candidates out of 8 Unreachable components total, an
    // unprioritized random pick has a real chance of exhausting the budget on decoys and
    // failing outright. Border-prioritization must always try the actually-convertible
    // region first regardless of seed.
    let (maze, _) = maze_with_one_bordering_region_and_decoys();
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let unreachable_count = classes
        .values()
        .filter(|&&c| c == RegionClass::Unreachable)
        .count();
    assert!(
        unreachable_count > MAX_REUSE_ATTEMPTS as usize,
        "fixture must have more candidates than the attempt budget"
    );

    for seed in 0..30u64 {
        let (mut maze, _) = maze_with_one_bordering_region_and_decoys();
        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = MazeRng::seed_from_u64(seed);
        let result = apply_and_commit(
            &issue,
            &mut maze,
            &mut rng,
            &default_params(),
            &PresetState::empty(),
        );
        assert!(
            matches!(result, RepairResult::Fixed { score: None }),
            "seed {seed}: must succeed by prioritizing the bordering region over decoys"
        );
    }
}

#[test]
fn apply_makes_trap_from_unreachable_region_with_existing_outbound_edge_to_finish() {
    // Regression test for a real user-reported bug: an Unreachable region (nothing
    // reaches IN) can still already hold an outgoing edge into finish-reachable
    // territory, since nothing being able to enter doesn't mean nothing can leave. Once
    // a plain single-edge inbound bridge is added (the old behavior), the region
    // immediately becomes reachable both ways -> Alternative, not Trap, and the bridge
    // attempt is rejected by membership-check every time. The fix must detect this and
    // sever the pre-existing outbound edge before retrying the inbound bridge.
    //
    // Layout (1x5 row): 0 -> 1 -> 2 is the path (start=0, finish=2). Node 3 is an
    // Unreachable singleton (nobody can reach it) with a directed edge 3 -> 2 already
    // present -- so node 3 already "reaches" finish, it's just unreachable FROM start.
    let (field, mut g, nodes) = linear_field(5);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[1], nodes[2], EK::Basic);
    g.add_edge(nodes[3], nodes[2], EK::Basic); // pre-existing outbound edge to finish-reachable
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);

    // Sanity: node 3 starts Unreachable despite already reaching finish.
    let classes_before = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let scc_before = maze.analysis.scc(&maze.graph);
    assert_eq!(
        scc_before
            .component_of(nodes[3])
            .and_then(|idx| classes_before.get(&idx))
            .copied(),
        Some(RegionClass::Unreachable)
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(990043);
    let result = apply_and_commit(
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let classes_after = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let scc_after = maze.analysis.scc(&maze.graph);
    assert_eq!(
        scc_after
            .component_of(nodes[3])
            .and_then(|idx| classes_after.get(&idx))
            .copied(),
        Some(RegionClass::Trap)
    );
}

#[test]
fn apply_undo_does_not_destroy_a_pre_existing_edge_shared_by_two_candidates() {
    // Regression test for a real user-reported bug: `try_with_candidates`'s per-candidate
    // undo unconditionally removed the candidate edge after a failed membership-check,
    // even when that edge had already existed BEFORE this attempt (e.g. two different
    // bridging candidates resolve to coordinates that turn out to already be connected).
    // That silently destroyed a pre-existing edge unrelated to this conversion attempt,
    // corrupting `members`' internal connectivity for every subsequent candidate in the
    // same loop -- manifesting as `membership_matches` seeing a region split into
    // multiple classes (e.g. {Unreachable, Trap}) no matter which candidate was tried,
    // even though a clean attempt would have succeeded.
    //
    // Large region (10x10 grid, fully bidirectional internally -- like the interior of a
    // real recursive_backtracker maze, not an artificially one-way-heavy structure) with
    // a single pre-existing one-way edge from one corner into the path row, matching the
    // real-world shape: "Unreachable region that already happens to reach finish through
    // one existing edge" rather than many.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(10, 11), &mut ids).unwrap();
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

    for x in 0..9 {
        g.add_bidirectional_edge(n(x, 0), n(x + 1, 0), EK::Basic);
    }
    // Region (rows 1..11): fully bidirectional grid block, no artificial one-way mesh.
    for y in 1..11 {
        for x in 0..9 {
            g.add_bidirectional_edge(n(x, y), n(x + 1, y), EK::Basic);
        }
    }
    for y in 1..10 {
        for x in 0..10 {
            g.add_bidirectional_edge(n(x, y), n(x, y + 1), EK::Basic);
        }
    }
    // Single pre-existing one-way edge from the region into the path row.
    g.add_edge(n(0, 1), n(0, 0), EK::Basic);

    let start = n(0, 0);
    let finish = n(9, 0);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "10".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(
            &MissingRegionsStrategy,
        ),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(990043);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[cfg(test)]
#[path = "reuse_tests.rs"]
mod reuse_tests;

#[cfg(test)]
#[path = "convert_tests.rs"]
mod convert_tests;

#[cfg(test)]
#[path = "grow_tests.rs"]
mod grow_tests;

#[test]
fn apply_end_to_end_grown_region_has_no_leftover_edge_to_its_original_neighborhood() {
    // Full apply() through try_grow: confirm the end-to-end committed region also ends up
    // severed from anything outside `members` in the final graph, not just in the
    // `sever_from_parent` unit test above.
    let (field, mut g, nodes) = linear_field(5);
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "2".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(
            &MissingRegionsStrategy,
        ),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // The Trap region must be exactly one SCC -- nothing left half-connected to the rest of
    // the (now Path-only) graph via a stray edge that would have made it Path/Alternative
    // instead of a clean Trap.
    let classes = maze
        .analysis
        .region_classes(&maze.graph, &maze.field, &maze.meta);
    let trap_components: HashSet<_> = classes
        .iter()
        .filter(|&(_, &c)| c == RegionClass::Trap)
        .map(|(&idx, _)| idx)
        .collect();
    assert_eq!(
        trap_components.len(),
        1,
        "exactly one Trap component must exist"
    );
}
