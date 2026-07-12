use super::*;
use super::grow::{grow_front, try_open_excess_neighbor, sever_from_parent, OpenedNeighbor};
use super::reuse::{filter_by_border, absorb_until_min_size, prioritize_candidates};
use super::convert::{convert_region, membership_matches};
use super::GrowContext;
use crate::repair::draft::DraftMaze;
use std::collections::HashMap as StdHashMap;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::{Graph as G, EdgeKind as EK};
use crate::IdGenerator;
use crate::space::{SquareTessellation, square_rect, Field};
use crate::repair::params::build_params;
use crate::graph::scc::ComponentId;
use crate::quality_control::MissingRegionsIssue;

fn default_params() -> StrategyParams {
    build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(&MissingRegionsStrategy),
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
    let (result, commands) = RepairStrategy::apply(&MissingRegionsStrategy, issue, maze, rng, params, preset_state, &[]);
    crate::quality_control::rule::apply_commands(maze, preset_state, commands);
    result
}

fn test_ctx<'a>(committed_nodes: &'a HashSet<NodeId>, preset_state: &'a PresetState) -> GrowContext<'a> {
    GrowContext { committed_nodes, preset_state, inbound_requires_geometry: true, outbound_requires_geometry: true }
}

/// Builds a `MISSING_REGIONS` issue from shortfall counts — `missing` values are how many
/// regions short of the minimum each class is (always positive), converted to the `-N`
/// balance convention internally so existing tests keep their original "missing count" call
/// sites unchanged.
fn issue_for(missing: Vec<(RegionClass, u32)>) -> MissingRegionsIssue {
    MissingRegionsIssue::new_from_check("test", missing.into_iter().map(|(c, n)| (c, -(n as i32))).collect())
}

/// Builds a `MISSING_REGIONS` issue from raw signed balances — `-N` shortfall, `+N` surplus
/// budget for cross-region growth.
fn issue_with_balance(balance: Vec<(RegionClass, i32)>) -> MissingRegionsIssue {
    MissingRegionsIssue::new_from_check("test", balance.into_iter().collect())
}

/// 1x6 row: start(0) -> 1 -> finish(2), each a singleton; nodes 3,4,5 unconnected (each a
/// singleton Unreachable region) and geometrically adjacent in a chain.
fn maze_with_path_and_unreachables() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(6, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_reuses_unreachable_region_into_trap() {
    let (mut maze, nodes) = maze_with_path_and_unreachables();
    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    let has_trap = [nodes[3], nodes[4], nodes[5]].iter().any(|&n| {
        scc.component_of(n).and_then(|idx| classes.get(&idx)).copied() == Some(RegionClass::Trap)
    });
    assert!(has_trap, "expected one of the unreachable singletons to become a Trap region");
}

#[test]
fn apply_path_class_is_skipped_not_failed() {
    let (mut maze, _) = maze_with_path_and_unreachables();
    let issue = issue_for(vec![(RegionClass::Path, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_before, edges_after, "Path-only request must not mutate the graph");
}

#[test]
fn apply_fails_when_no_candidates_at_all() {
    // Path-only maze with no spare nodes to reuse or grow from.
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[1], nodes[2], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_before, edges_after, "failed attempts must leave the graph untouched");
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
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &preset_state);
    assert!(matches!(result, RepairResult::Failed));
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_before, edges_after);
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let (mut maze_a, _) = maze_with_path_and_unreachables();
    let issue_a = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng_a = MazeRng::seed_from_u64(99);
    apply_and_commit(&issue_a, &mut maze_a, &mut rng_a, &default_params(), &PresetState::empty());

    let (mut maze_b, _) = maze_with_path_and_unreachables();
    let issue_b = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng_b = MazeRng::seed_from_u64(99);
    apply_and_commit(&issue_b, &mut maze_b, &mut rng_b, &default_params(), &PresetState::empty());

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_a, edges_b);
}

#[test]
fn apply_never_uses_critical_path_nodes_as_seed_or_bridge_target() {
    let (mut maze, nodes) = maze_with_path_and_unreachables();
    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(11);
    apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
    // Critical path nodes (0,1,2) must keep their original outgoing edges only to each
    // other -- they should not have been absorbed into the new Trap region's component.
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    for &n in &[nodes[0], nodes[1], nodes[2]] {
        let class = scc.component_of(n).and_then(|idx| classes.get(&idx)).copied();
        assert_eq!(class, Some(RegionClass::Path));
    }
}

#[test]
fn apply_grows_when_no_reusable_unreachable_region_exists() {
    // 1x2 path (start/finish) plus a 1x3 strip of unconnected nodes geometrically
    // adjacent to each other but not to the path -- forces growth (front expansion)
    // since reuse alone (a single singleton) still works, so use min_region_size=2
    // to force growth to actually expand the frontier.
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "2".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(&MissingRegionsStrategy),
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
    let field = Field::new(square_rect(3, 3), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let all_coords: Vec<(i32, i32)> = (0..3).flat_map(|y| (0..3).map(move |x| (x, y))).collect();
    let nodes: StdHashMap<(i32, i32), NodeId> = all_coords.iter()
        .map(|&(x, y)| ((x, y), field.node_at(crate::space::SquarePoint { x, y }).unwrap()))
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
    let classes_before = maze.analysis.region_classes(&maze.graph, &maze.meta);
    assert!(
        classes_before.values().all(|&c| c == RegionClass::Path || c == RegionClass::Alternative),
        "fixture must start with zero Unreachable/Trap regions, got: {:?}", classes_before.values().collect::<Vec<_>>()
    );

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "1".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(&MissingRegionsStrategy),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }), "growth must succeed even with zero pre-existing non-Path regions");

    let classes_after = maze.analysis.region_classes(&maze.graph, &maze.meta);
    assert!(classes_after.values().any(|&c| c == RegionClass::Trap), "expected a Trap region to have been created");
}

/// 1x8 row: start(0) -> 1 -> finish(2), then four singleton Unreachable regions (3,4,5,6)
/// geometrically chained, and one more singleton (7) chained after them -- enough spare
/// regions for multi-item scenarios.
fn maze_with_many_unreachables() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(8, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    let trap_count = [nodes[3], nodes[4], nodes[5], nodes[6], nodes[7]].iter()
        .filter(|&&n| scc.component_of(n).and_then(|idx| classes.get(&idx)).copied() == Some(RegionClass::Trap))
        .count();
    assert_eq!(trap_count, 2, "exactly 2 distinct singletons should have become separate Trap regions");
}

#[test]
fn apply_second_item_never_reuses_first_items_committed_nodes() {
    let (mut maze, nodes) = maze_with_many_unreachables();
    let issue = issue_for(vec![(RegionClass::Trap, 2)]);
    let mut rng = MazeRng::seed_from_u64(13);
    apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());

    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    let trap_components: HashSet<ComponentId> = [nodes[3], nodes[4], nodes[5], nodes[6], nodes[7]].iter()
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
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
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
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Failed));
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_before, edges_after, "every attempted mutation must have been rolled back");
}

#[test]
fn apply_growth_never_crosses_into_a_different_scc_component() {
    // Path: 0 -> 1 (start -> finish). A 3-node Unreachable SCC (2<->3<->4, cyclic, all
    // mutually reachable) sits geometrically adjacent to a *separate* singleton
    // Unreachable node 5 (5 is a field-neighbor of 4, but no edge connects them, so it's
    // its own SCC). With min_region_size=2, growth seeded inside the 3-node component
    // must stay within {2,3,4} and never pull in node 5 from the neighboring component.
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(6, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_bidirectional_edge(nodes[2], nodes[3], EK::Basic);
    g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "2".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(&MissingRegionsStrategy),
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
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    assert_eq!(scc.component_of(nodes[5]).and_then(|idx| classes.get(&idx)).copied(), Some(RegionClass::Unreachable));
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
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(7, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
    let field: Field<SquareTessellation> = Field::new(square_rect(1, 6), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();
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
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(&MissingRegionsStrategy),
        Some(&overrides),
    );

    let issue = issue_with_balance(vec![(RegionClass::Trap, -1), (RegionClass::Unreachable, 1)]);
    let mut rng = MazeRng::seed_from_u64(17);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }), "must succeed by merging region6 with {{n3,n4,n5}} using the Unreachable surplus budget");

    // All 4 nodes must now be one single Trap region -- proves both the cross-component
    // absorption and the bridging edge (otherwise region6 would be disconnected from
    // {n3,n4,n5} and membership-check would never have let this land on Trap for all four
    // at once).
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    let merged_component = scc.component_of(region6);
    assert!(merged_component.is_some(), "region6 must be in some SCC after absorption");
    for &n in &[n3, n4, n5, region6] {
        assert_eq!(scc.component_of(n), merged_component, "all four absorbed nodes must share one SCC");
    }
    assert_eq!(classes.get(&merged_component.unwrap()).copied(), Some(RegionClass::Trap));
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
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(&MissingRegionsStrategy),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(17);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }), "no excess budget -- region6 must still be reusable alone, below min_region_size");

    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let scc = maze.analysis.scc(&maze.graph);
    assert_eq!(classes.get(&scc.component_of(region6).unwrap()).copied(), Some(RegionClass::Trap), "region6 alone became Trap");
    assert_eq!(classes.get(&scc.component_of(n3).unwrap()).copied(), Some(RegionClass::Unreachable), "{{n3,n4,n5}} must remain untouched, not merged in");
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
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(6, 1), &mut ids).unwrap();
        let mut g = G::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
        let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &preset_state);
        if matches!(result, RepairResult::Fixed { score: None }) {
            // Whatever succeeded, node 3 must never have gained an inbound edge unless it
            // is itself the final committed Alternative region (in which case it would also
            // need a valid outbound edge, which preset forbids) -- so node 3 must have
            // exactly its original zero edges.
            assert!(maze.graph.edge_between(nodes[1], nodes[3]).is_none(), "seed {seed}: leaked inbound edge into node 3");
            assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_none(), "seed {seed}: leaked inbound edge into node 3");
        }
    }
}

/// 1x17 row: 0-1-2 is the path (start=0, finish=2). Node 2 borders node 3, which heads a
/// 6-node connected Unreachable region (3..8) -- the only candidate actually convertible
/// into Trap. A gap at node 9 (left disconnected) separates it from 7 decoy Unreachable
/// singletons at nodes 10..16, with zero adjacency to the path or to the big region.
fn maze_with_one_bordering_region_and_decoys() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(17, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let unreachable_count = classes.values().filter(|&&c| c == RegionClass::Unreachable).count();
    assert!(unreachable_count > MAX_REUSE_ATTEMPTS as usize, "fixture must have more candidates than the attempt budget");

    for seed in 0..30u64 {
        let (mut maze, _) = maze_with_one_bordering_region_and_decoys();
        let issue = issue_for(vec![(RegionClass::Trap, 1)]);
        let mut rng = MazeRng::seed_from_u64(seed);
        let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
        assert!(matches!(result, RepairResult::Fixed { score: None }), "seed {seed}: must succeed by prioritizing the bordering region over decoys");
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
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(5, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[1], nodes[2], EK::Basic);
    g.add_edge(nodes[3], nodes[2], EK::Basic); // pre-existing outbound edge to finish-reachable
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);

    // Sanity: node 3 starts Unreachable despite already reaching finish.
    let classes_before = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let scc_before = maze.analysis.scc(&maze.graph);
    assert_eq!(scc_before.component_of(nodes[3]).and_then(|idx| classes_before.get(&idx)).copied(), Some(RegionClass::Unreachable));

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(990043);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &default_params(), &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let classes_after = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let scc_after = maze.analysis.scc(&maze.graph);
    assert_eq!(scc_after.component_of(nodes[3]).and_then(|idx| classes_after.get(&idx)).copied(), Some(RegionClass::Trap));
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
    let field: Field<SquareTessellation> = Field::new(square_rect(10, 11), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();

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
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(&MissingRegionsStrategy),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(990043);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn filter_by_border_drops_a_candidate_with_zero_border_on_every_needed_side() {
    // {n3,n4,n5} borders nothing reachable on its own (per the fixture's doc-comment: no
    // member is a field-neighbor of start/finish) -- for `Unreachable -> Trap` (needs inbound
    // only), it must be dropped entirely, not merely deprioritized.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let n3 = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let n3_component = scc.component_of(n3).unwrap();
    let mut candidates = vec![n3_component];

    let reachable_from_start: HashSet<NodeId> = maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> = maze.graph.reachable_to(finish).into_iter().collect();
    filter_by_border(&maze, &mut candidates, RegionClass::Trap, &classes, &scc, &reachable_from_start, &reachable_to_finish, true, true);

    assert!(!candidates.contains(&n3_component), "{{n3,n4,n5}} has zero inbound border -- must be filtered out");
}

#[test]
fn filter_by_border_keeps_a_candidate_with_the_needed_border() {
    // region6 borders reachable_from_start (finish, via the start->finish edge) -- for
    // `Unreachable -> Trap` (needs inbound only), it must survive the filter.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let region6 = nodes[2];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let region6_component = scc.component_of(region6).unwrap();
    let mut candidates = vec![region6_component];

    let reachable_from_start: HashSet<NodeId> = maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> = maze.graph.reachable_to(finish).into_iter().collect();
    let border_count = filter_by_border(&maze, &mut candidates, RegionClass::Trap, &classes, &scc, &reachable_from_start, &reachable_to_finish, true, true);

    assert!(candidates.contains(&region6_component), "region6 has an inbound border -- must survive the filter");
    assert!(border_count.get(&region6_component).copied().unwrap_or(0) > 0, "surviving border-needing candidate must have a recorded border-count");
}

#[test]
fn filter_by_border_keeps_alternative_candidate_with_only_one_of_the_two_needed_borders() {
    // For `Unreachable -> Alternative` (needs BOTH inbound and outbound), a candidate with
    // only ONE of the two must still survive the filter -- the missing side can be reached
    // later via absorbing a same-class neighbor, so requiring both up front would wrongly
    // reject it. region6 borders reachable_from_start (finish, inbound) but its only other
    // field-neighbor is n5 (part of {n3,n4,n5}, not finish-reachable) -- zero outbound border.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let region6 = nodes[2];
    let n5 = nodes[5];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let region6_component = scc.component_of(region6).unwrap();
    let mut candidates = vec![region6_component];

    let reachable_from_start: HashSet<NodeId> = maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> = maze.graph.reachable_to(finish).into_iter().collect();
    assert!(!reachable_to_finish.contains(&n5), "sanity: n5 (region6's only other neighbor) must not be finish-reachable");

    filter_by_border(&maze, &mut candidates, RegionClass::Alternative, &classes, &scc, &reachable_from_start, &reachable_to_finish, true, true);

    assert!(candidates.contains(&region6_component), "region6 has only an inbound border (no outbound) -- must still survive the OR-filter for Alternative");
}

#[test]
fn filter_by_border_keeps_a_border_less_candidate_when_its_needed_side_has_geometry_disabled() {
    // {n3,n4,n5} has zero inbound border -- with plain geometric bridging (both flags `true`,
    // see `filter_by_border_drops_a_candidate_with_zero_border_on_every_needed_side`) it's
    // dropped. But a teleport-style bridging mechanism doesn't need a field-adjacent border to
    // place its inbound edge -- disabling `inbound_requires_geometry` must keep it instead.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let n3 = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let n3_component = scc.component_of(n3).unwrap();
    let mut candidates = vec![n3_component];

    let reachable_from_start: HashSet<NodeId> = maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> = maze.graph.reachable_to(finish).into_iter().collect();
    let border_count = filter_by_border(&maze, &mut candidates, RegionClass::Trap, &classes, &scc, &reachable_from_start, &reachable_to_finish, false, true);

    assert!(candidates.contains(&n3_component), "inbound geometry disabled -- border-less {{n3,n4,n5}} must survive");
    assert!(!border_count.contains_key(&n3_component), "a side with geometry disabled contributes no border-count");
}

#[test]
fn filter_by_border_keeps_everything_when_both_geometry_flags_are_disabled() {
    // With both flags off, no border check happens at all for any candidate -- every candidate
    // whose class can transition to `target` is kept, matching a fully teleport-based bridging
    // mechanism where geometric placement is irrelevant on both sides.
    let (maze, nodes) = maze_with_mergeable_pair_bordering_finish();
    let start = nodes[0];
    let finish = nodes[1];
    let n3 = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let n3_component = scc.component_of(n3).unwrap();
    let mut candidates = vec![n3_component];

    let reachable_from_start: HashSet<NodeId> = maze.graph.reachable_from(start).into_iter().collect();
    let reachable_to_finish: HashSet<NodeId> = maze.graph.reachable_to(finish).into_iter().collect();
    let border_count = filter_by_border(&maze, &mut candidates, RegionClass::Alternative, &classes, &scc, &reachable_from_start, &reachable_to_finish, false, false);

    assert!(candidates.contains(&n3_component), "both geometry requirements disabled -- border-less {{n3,n4,n5}} must survive even for Alternative (needs both sides)");
    assert!(border_count.is_empty(), "no side requires geometry -- no border-count should be recorded for anyone");
}

/// 1x5 row: 0=start, 1=finish (edge 0->1), 2=candidate (singleton Unreachable, field-neighbor
/// of node 3 only, no graph edge to it), 3=trap_neighbor (singleton Trap: directed edge 1->3,
/// so it's reachable from start but can't reach finish -- a DIFFERENT class than `candidate`).
/// 4 is left disconnected/unused as a geometric buffer so `trap_neighbor` has exactly one
/// bordering component (`candidate`) to be absorbed by.
fn maze_with_candidate_and_different_class_neighbor() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[1], nodes[3], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

#[test]
fn absorb_until_min_size_absorbs_a_neighbor_of_a_different_class_when_it_has_budget() {
    let (mut maze, nodes) = maze_with_candidate_and_different_class_neighbor();
    let candidate = nodes[2];
    let trap_neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    assert_eq!(classes.get(&scc.component_of(candidate).unwrap()).copied(), Some(RegionClass::Unreachable));
    assert_eq!(classes.get(&scc.component_of(trap_neighbor).unwrap()).copied(), Some(RegionClass::Trap), "sanity: neighbor must be a DIFFERENT class than the candidate");

    let candidate_idx = scc.component_of(candidate).unwrap();
    let mut members: HashSet<NodeId> = [candidate].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    absorb_until_min_size(&mut draft, &mut members, candidate_idx, 2, &scc, &classes, &mut budget, &critical, &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng);

    assert!(members.contains(&trap_neighbor), "trap_neighbor has its own budget -- must be absorbed despite being a different class");
    assert_eq!(budget.get(&RegionClass::Trap), None, "trap_neighbor's budget (1) fully spent on its own 1-node size -- entry removed");
    assert!(draft.maze.graph.edge_between(candidate, trap_neighbor).is_some(), "a bidirectional bridge must have been added");
    assert!(draft.maze.graph.edge_between(trap_neighbor, candidate).is_some(), "a bidirectional bridge must have been added");
}

#[test]
fn absorb_until_min_size_does_not_absorb_when_the_neighbor_has_no_budget() {
    let (mut maze, nodes) = maze_with_candidate_and_different_class_neighbor();
    let candidate = nodes[2];
    let trap_neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);

    let candidate_idx = scc.component_of(candidate).unwrap();
    let mut members: HashSet<NodeId> = [candidate].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget: HashMap<RegionClass, i32> = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    absorb_until_min_size(&mut draft, &mut members, candidate_idx, 2, &scc, &classes, &mut budget, &critical, &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng);

    assert!(!members.contains(&trap_neighbor), "no budget entry for Trap at all -- trap_neighbor must remain outside members");
    assert_eq!(members.len(), 1, "members must stay at just the candidate's own node");
    assert!(draft.maze.graph.edge_between(candidate, trap_neighbor).is_none(), "no edge should have been added");
}

#[test]
fn absorb_until_min_size_skips_a_blocked_edge_and_succeeds_via_another_in_the_pool() {
    // 3x2 grid: candidate = (1,0), with TWO field-neighbors both inside the same 2-node Trap
    // component: (0,0) and (1,1). Block the (1,0)<->(0,0) edge specifically -- absorption
    // must still succeed via the (1,0)<->(1,1) edge instead of giving up on the whole
    // component, proving a single blocked edge is discarded from the pool, not its entire
    // bordering component.
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(3, 2), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();
    let start = n(2, 0);
    let finish = n(2, 1);
    let candidate = n(1, 0); // Unreachable singleton, field-neighbors: start(2,0), trap_a(0,0), trap_b(1,1)
    let trap_a = n(0, 0);
    let trap_b = n(1, 1);
    g.add_edge(start, finish, EK::Basic);
    g.add_edge(finish, trap_b, EK::Basic); // trap_a, trap_b reachable from start via finish -> can't reach finish back -> Trap
    g.add_bidirectional_edge(trap_a, trap_b, EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);

    let scc = maze.analysis.scc(&maze.graph);
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    assert_eq!(classes.get(&scc.component_of(candidate).unwrap()).copied(), Some(RegionClass::Unreachable));
    assert_eq!(classes.get(&scc.component_of(trap_a).unwrap()).copied(), Some(RegionClass::Trap), "sanity: {{trap_a,trap_b}} must be one Trap component");
    assert_eq!(scc.component_of(trap_a), scc.component_of(trap_b), "sanity: both bridge targets must be the SAME component");

    let mut preset_state = PresetState::empty();
    // Block only the candidate<->trap_a edge -- the candidate<->trap_b edge into the SAME
    // component must still be tried and succeed.
    preset_state.blocked.insert((candidate, trap_a));
    preset_state.blocked.insert((trap_a, candidate));

    let candidate_idx = scc.component_of(candidate).unwrap();
    let mut members: HashSet<NodeId> = [candidate].into_iter().collect();
    let critical: HashSet<NodeId> = [start, finish].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Trap, 2)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    absorb_until_min_size(&mut draft, &mut members, candidate_idx, 2, &scc, &classes, &mut budget, &critical, &test_ctx(&HashSet::new(), &preset_state), &mut rng);

    assert!(members.contains(&trap_a) && members.contains(&trap_b), "the component must still be absorbed via the non-blocked edge");
    assert!(draft.maze.graph.edge_between(candidate, trap_a).is_none(), "the blocked edge must never have been added");
    assert!(draft.maze.graph.edge_between(trap_a, candidate).is_none(), "the blocked edge must never have been added");
    assert!(draft.maze.graph.edge_between(candidate, trap_b).is_some(), "the non-blocked edge must have been added instead");
    assert!(draft.maze.graph.edge_between(trap_b, candidate).is_some(), "the non-blocked edge must have been added instead");
}

#[test]
fn prioritize_candidates_puts_a_large_enough_candidate_ahead_of_a_smaller_one_with_more_border() {
    // region6 (1 node) and {n3,n4,n5} (3 nodes) -- give the SMALLER one (region6) a bigger
    // border_count than the larger one, to isolate the size-tier check: even with a worse
    // border-count, the already-large-enough {n3,n4,n5} must still sort ahead of region6.
    let (maze, nodes) = maze_with_two_isolated_unreachable_components();
    let scc = maze.analysis.scc(&maze.graph);
    let n3_component = scc.component_of(nodes[3]).unwrap(); // {n3,n4,n5}, size 3
    let region6_component = scc.component_of(nodes[6]).unwrap(); // size 1
    assert_eq!(scc.components[n3_component].len(), 3);
    assert_eq!(scc.components[region6_component].len(), 1);

    let mut candidates = vec![region6_component, n3_component];
    let border_count = HashMap::from([(region6_component, 5usize), (n3_component, 1usize)]);
    let mut rng = MazeRng::seed_from_u64(1);

    prioritize_candidates(&mut candidates, &scc, &border_count, 2, &mut rng);

    assert_eq!(candidates[0], n3_component, "size >= min_region_size must outrank a smaller candidate regardless of border_count");
}

#[test]
fn prioritize_candidates_orders_by_border_count_within_the_same_size_tier() {
    // Two same-size-tier candidates (both below min_region_size) -- border_count alone decides
    // the order.
    let (maze, nodes) = maze_with_two_isolated_unreachable_components();
    let scc = maze.analysis.scc(&maze.graph);
    let n3_component = scc.component_of(nodes[3]).unwrap(); // size 3
    let region6_component = scc.component_of(nodes[6]).unwrap(); // size 1

    let mut candidates = vec![region6_component, n3_component];
    // min_region_size=10 -- both candidates fall in the same "too small" tier.
    let border_count = HashMap::from([(region6_component, 1usize), (n3_component, 5usize)]);
    let mut rng = MazeRng::seed_from_u64(1);

    prioritize_candidates(&mut candidates, &scc, &border_count, 10, &mut rng);

    assert_eq!(candidates[0], n3_component, "within the same size tier, higher border_count must sort first");
}

// ---- convert_region ----

/// 1x4 row: 0=start, 1=finish (edge 0->1), 2=candidate (singleton Unreachable, field-neighbor
/// of finish only, no graph edge to it). 3 is a geometric buffer so candidate has exactly one
/// field-neighbor outside itself (finish).
fn maze_with_isolated_candidate() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

#[test]
fn convert_region_unreachable_to_trap_adds_inbound_from_scratch() {
    let (mut maze, nodes) = maze_with_isolated_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Trap, &PresetState::empty(), &mut rng);

    assert!(result.is_some(), "must add an inbound edge and land on Trap");
    assert!(draft.maze.graph.edge_between(nodes[1], candidate).is_some(), "inbound edge from finish must have been added");
    let classes = draft.maze.analysis.region_classes(&draft.maze.graph, &draft.maze.meta);
    let scc = draft.maze.analysis.scc(&draft.maze.graph);
    assert_eq!(classes.get(&scc.component_of(candidate).unwrap()).copied(), Some(RegionClass::Trap));
}

/// 5x3 grid, row y=0 is a separate direct start->finish path that never touches row y=2 -- the
/// shortest route, so nothing in row y=2 can ever become Path no matter what gets bridged there.
/// Row y=1 stays entirely disconnected as a geometric buffer (see `maze_with_trap_candidate`'s
/// doc-comment for why -- avoids a candidate directly above/below a path node becoming an extra
/// bridging candidate). mid=(1,2) is reachable from start (directed edge start->mid) but has no
/// route to finish at all. candidate=(2,2) is an isolated Unreachable singleton. other=(3,2) has
/// a directed edge other->(3,0) (finish-reachable, not finish itself). candidate's only two
/// field-neighbors are mid (reachable-from-start-only) and other (finish-reachable-only) -- the
/// two sides never overlap, so there is exactly one valid candidate for each bridge direction,
/// deterministically regardless of shuffle.
fn maze_with_isolated_candidate_having_two_distinct_neighbors() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(5, 3), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();
    let start = n(0, 0);
    let finish = n(4, 0);
    let mid = n(1, 2);
    let candidate = n(2, 2);
    let other = n(3, 2);
    for x in 0..4 {
        g.add_edge(n(x, 0), n(x + 1, 0), EK::Basic);
    }
    g.add_edge(start, mid, EK::Basic);
    g.add_edge(other, n(3, 0), EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);
    (maze, vec![start, mid, candidate, other, finish])
}

#[test]
fn convert_region_unreachable_to_alternative_adds_both_inbound_and_outbound() {
    let (mut maze, nodes) = maze_with_isolated_candidate_having_two_distinct_neighbors();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Alternative, &PresetState::empty(), &mut rng);

    assert!(result.is_some(), "must add both inbound and outbound edges and land on Alternative");
    let classes = draft.maze.analysis.region_classes(&draft.maze.graph, &draft.maze.meta);
    let scc = draft.maze.analysis.scc(&draft.maze.graph);
    assert_eq!(classes.get(&scc.component_of(candidate).unwrap()).copied(), Some(RegionClass::Alternative));
}

/// 5x3 grid, row y=0 is a separate direct start->finish path (0,0)->(1,0)->(2,0)->(3,0)->(4,0)
/// that never touches row y=2 -- this is the shortest route, so nothing in row y=2 can ever
/// become Path no matter what gets bridged there. Row y=1 stays entirely disconnected (no
/// edges at all) so it never becomes a field-neighbor bridge target either -- it's pure
/// geometric buffer between the path row and the candidate row, since square tessellation gives
/// every node 4-directional neighbors (including vertical), and a candidate directly above/below
/// a path node would otherwise be a 3rd bridging candidate. Row y=2: mid=(1,2) is reachable from
/// start (directed edge (0,0)->(1,2), i.e. start->mid) but has no route to finish at all.
/// candidate=(2,2) has an existing inbound edge mid->candidate (Trap: reachable from start,
/// can't reach finish). other=(3,2) has a directed edge other->(3,0) (into finish-reachable
/// territory, but not finish itself). candidate's only two field-neighbors are mid
/// (reachable-from-start-only) and other (finish-reachable-only) -- the two sides never
/// overlap, so there is exactly one valid candidate for each bridge direction, deterministically
/// regardless of shuffle.
fn maze_with_trap_candidate() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(5, 3), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();
    let start = n(0, 0);
    let finish = n(4, 0);
    let mid = n(1, 2);
    let candidate = n(2, 2);
    let other = n(3, 2);
    for x in 0..4 {
        g.add_edge(n(x, 0), n(x + 1, 0), EK::Basic);
    }
    g.add_edge(start, mid, EK::Basic);
    g.add_edge(mid, candidate, EK::Basic);
    g.add_edge(other, n(3, 0), EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(start);
    maze.meta.finish = Some(finish);
    (maze, vec![start, mid, candidate, other, finish])
}

#[test]
fn convert_region_trap_to_alternative_adds_outbound_only() {
    let (mut maze, nodes) = maze_with_trap_candidate();
    let mid = nodes[1];
    let candidate = nodes[2];
    let other = nodes[3];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let scc = maze.analysis.scc(&maze.graph);
    let classes_before = maze.analysis.region_classes(&maze.graph, &maze.meta);
    assert_eq!(classes_before.get(&scc.component_of(candidate).unwrap()).copied(), Some(RegionClass::Trap), "sanity: candidate must start as Trap");
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Alternative, &PresetState::empty(), &mut rng);

    assert!(result.is_some(), "must add an outbound edge and land on Alternative");
    assert!(draft.maze.graph.edge_between(candidate, other).is_some(), "outbound edge into finish-reachable territory must have been added");
    // Original inbound edge (mid->candidate) must remain untouched -- Trap->Alternative never touches inbound.
    assert!(draft.maze.graph.edge_between(mid, candidate).is_some(), "pre-existing inbound edge must be preserved");
}

#[test]
fn convert_region_trap_to_unreachable_cuts_inbound() {
    let (mut maze, nodes) = maze_with_trap_candidate();
    let mid = nodes[1];
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Unreachable, &PresetState::empty(), &mut rng);

    assert!(result.is_some(), "must cut the inbound edge and land on Unreachable");
    assert!(draft.maze.graph.edge_between(mid, candidate).is_none(), "inbound edge must have been removed");
}

/// 1x4 row: 0=start, 1=finish. Directed edges 0->2 (inbound from start) and 2->1 (outbound to
/// finish) make candidate=2 reachable from start AND able to reach finish -- Alternative.
fn maze_with_alternative_candidate() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let n = |i: usize| nodes[i];
    // start(0) -> finish(1) not directly connected; route must go through candidate(2) itself
    // being reachable and able to reach finish, without candidate being ON the shortest path --
    // use an alternate direct start->finish edge so candidate stays off the critical path.
    g.add_edge(n(0), n(1), EK::Basic);
    g.add_edge(n(0), n(2), EK::Basic);
    g.add_edge(n(2), n(1), EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(n(0));
    maze.meta.finish = Some(n(1));
    (maze, nodes)
}

#[test]
fn convert_region_alternative_to_trap_cuts_outbound() {
    let (mut maze, nodes) = maze_with_alternative_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let scc = maze.analysis.scc(&maze.graph);
    let classes_before = maze.analysis.region_classes(&maze.graph, &maze.meta);
    assert_eq!(classes_before.get(&scc.component_of(candidate).unwrap()).copied(), Some(RegionClass::Alternative), "sanity: candidate must start as Alternative");
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Trap, &PresetState::empty(), &mut rng);

    assert!(result.is_some(), "must cut the outbound edge and land on Trap");
    assert!(draft.maze.graph.edge_between(candidate, nodes[1]).is_none(), "outbound edge to finish must have been removed");
    assert!(draft.maze.graph.edge_between(nodes[0], candidate).is_some(), "inbound edge must be preserved -- Alternative->Trap never touches inbound");
}

#[test]
fn convert_region_alternative_to_unreachable_cuts_inbound() {
    let (mut maze, nodes) = maze_with_alternative_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Unreachable, &PresetState::empty(), &mut rng);

    assert!(result.is_some(), "must cut the inbound edge and land on Unreachable");
    assert!(draft.maze.graph.edge_between(nodes[0], candidate).is_none(), "inbound edge must have been removed");
}

/// 1x5 row: 0=start, 1=finish (edge 0->1), 2=candidate (singleton Unreachable, no inbound, but
/// ALREADY has a pre-existing outbound edge 2->1 into finish -- unreachable from start despite
/// already being able to reach finish, since nothing can get IN). Regression fixture: a naive
/// single inbound-bridge would make it reachable both ways -> Alternative, not Trap; the audit
/// step must cut this pre-existing outbound edge first since target=Trap doesn't need outbound.
fn maze_with_unreachable_candidate_holding_hidden_outbound() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_edge(nodes[2], nodes[1], EK::Basic); // pre-existing outbound edge to finish-reachable
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

#[test]
fn convert_region_audits_away_a_hidden_outbound_edge_before_landing_on_trap() {
    let (mut maze, nodes) = maze_with_unreachable_candidate_holding_hidden_outbound();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let scc = maze.analysis.scc(&maze.graph);
    let classes_before = maze.analysis.region_classes(&maze.graph, &maze.meta);
    assert_eq!(classes_before.get(&scc.component_of(candidate).unwrap()).copied(), Some(RegionClass::Unreachable), "sanity: candidate must start Unreachable despite already reaching finish");
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Trap, &PresetState::empty(), &mut rng);

    assert!(result.is_some(), "audit must cut the hidden outbound edge before the inbound bridge, landing on Trap");
    assert!(draft.maze.graph.edge_between(candidate, nodes[1]).is_none(), "hidden outbound edge must have been audited away");
    assert!(draft.maze.graph.edge_between(nodes[1], candidate).is_some(), "inbound edge must have been added");
    let classes_after = draft.maze.analysis.region_classes(&draft.maze.graph, &draft.maze.meta);
    let scc_after = draft.maze.analysis.scc(&draft.maze.graph);
    assert_eq!(classes_after.get(&scc_after.component_of(candidate).unwrap()).copied(), Some(RegionClass::Trap));
}

#[test]
fn convert_region_fails_when_audit_removal_is_preset_blocked() {
    let (mut maze, nodes) = maze_with_trap_candidate();
    let mid = nodes[1];
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((mid, candidate));
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Unreachable, &preset_state, &mut rng);

    assert!(result.is_none(), "audit removal blocked by preset -- whole candidate must fail");
    assert!(draft.maze.graph.edge_between(mid, candidate).is_some(), "preset-protected edge must remain untouched");
}

#[test]
fn convert_region_fails_when_every_add_candidate_is_preset_blocked() {
    let (mut maze, nodes) = maze_with_isolated_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((nodes[1], candidate));
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Trap, &preset_state, &mut rng);

    assert!(result.is_none(), "sole inbound candidate blocked -- conversion must fail");
    assert!(draft.maze.graph.edge_between(nodes[1], candidate).is_none(), "no edge should have leaked in");
}

#[test]
fn convert_region_no_op_when_already_the_target_class() {
    let (mut maze, nodes) = maze_with_isolated_candidate();
    let candidate = nodes[2];
    let members: HashSet<NodeId> = [candidate].into_iter().collect();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = convert_region(&mut draft, &members, RegionClass::Unreachable, &PresetState::empty(), &mut rng);

    assert_eq!(result, Some(members), "already Unreachable -- no-op commit must succeed without any mutation");
    assert!(draft.maze.graph.edge_between(nodes[1], candidate).is_none(), "no edge should have been added for a no-op");
}

#[test]
fn membership_matches_true_when_members_resolve_to_target_class() {
    let (maze, nodes) = maze_with_isolated_candidate();
    let members: HashSet<NodeId> = [nodes[2]].into_iter().collect();

    assert!(membership_matches(&maze, &members, RegionClass::Unreachable));
    assert!(!membership_matches(&maze, &members, RegionClass::Trap));
}

#[test]
fn membership_matches_false_when_members_span_multiple_classes() {
    // start(0)/finish(1) are both Path; candidate(2) is Unreachable -- combining them into one
    // `members` set spans two different classes, so membership_matches must reject any target.
    let (maze, nodes) = maze_with_isolated_candidate();
    let members: HashSet<NodeId> = [nodes[0], nodes[2]].into_iter().collect();

    assert!(!membership_matches(&maze, &members, RegionClass::Path));
    assert!(!membership_matches(&maze, &members, RegionClass::Unreachable));
}

// ---- grow_front / try_open_excess_neighbor / sever_from_parent ----

/// 1x2 path (start=0, finish=1) plus a 3-armed star of Unreachable singletons centered on
/// `hub` (node 2): each arm is a straight bidirectional chain of `arm_len` nodes running in a
/// different geometric direction, so `hub`'s frontier branches three ways after the first step
/// -- enough to tell DFS (stays on one arm) apart from BFS (spreads across all three) by which
/// nodes end up in the grown region. Grid is built oversized and arms are placed along +x, +y,
/// -y from `hub` so none of them touch the path or each other except at `hub`.
fn maze_with_three_armed_star(arm_len: i32) -> (Maze<SquareTessellation>, NodeId, Vec<Vec<NodeId>>) {
    let mut ids = IdGenerator::new();
    let width = (arm_len + 4) as usize;
    let height = (arm_len * 2 + 2) as usize;
    let field: Field<SquareTessellation> = Field::new(square_rect(width, height), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();

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
    let (mut maze, hub, arms) = maze_with_three_armed_star(4);
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(hub).unwrap();
    let critical: HashSet<NodeId> = maze.analysis.route_info(&maze.graph, &maze.meta)
        .map(|r| r.path.into_iter().collect()).unwrap_or_default();
    let mut budget = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft, hub, seed_component, &scc, &region_classes, &mut budget,
        1.0, 5, &critical, &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
    );

    let members = result.expect("must grow to min_region_size within a single 4-node arm + hub");
    assert_eq!(members.len(), 5);
    let full_arm_included = arms.iter().any(|arm| arm.iter().all(|n| members.contains(n)));
    assert!(full_arm_included, "DFS (locality=1.0) must fully consume one arm before branching, members: {:?}", members);
}

#[test]
fn grow_front_with_locality_zero_spreads_breadth_first_across_arms() {
    // locality=0.0 always picks a uniformly random node across the WHOLE frontier (BFS-like)
    // -- growing to only 4 nodes (hub + 3) from a 3-armed star should be very likely to touch
    // more than one arm rather than fully depleting a single one first, since immediately
    // after the first expansion the frontier holds one candidate per arm all at once.
    let mut touched_multiple_arms = false;
    for seed in 0..30u64 {
        let (mut maze, hub, arms) = maze_with_three_armed_star(6);
        let scc = maze.analysis.scc(&maze.graph);
        let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
        let seed_component = scc.component_of(hub).unwrap();
        let critical: HashSet<NodeId> = maze.analysis.route_info(&maze.graph, &maze.meta)
            .map(|r| r.path.into_iter().collect()).unwrap_or_default();
        let mut budget = HashMap::new();
        let mut rng = MazeRng::seed_from_u64(seed);
        let mut draft = DraftMaze::new(maze);
        let result = grow_front(
            &mut draft, hub, seed_component, &scc, &region_classes, &mut budget,
            0.0, 4, &critical, &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
        );
        let members = result.expect("must grow to min_region_size");
        let arms_touched = arms.iter().filter(|arm| arm.iter().any(|n| members.contains(n))).count();
        if arms_touched > 1 {
            touched_multiple_arms = true;
            break;
        }
    }
    assert!(touched_multiple_arms, "BFS (locality=0.0) must spread across more than one arm at least once over 30 seeds");
}

/// 1x2 path (start=0, finish=1). `seed`(2) has TWO geometric neighbors: `two_way`(3), joined by
/// a bidirectional edge, and `one_way`(4), joined only by a directed edge `seed -> one_way` (no
/// edge back). Growth from `seed` must only ever pick `two_way` as a candidate.
fn maze_with_one_way_and_two_way_neighbor() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(3, 2), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();
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
    let (mut maze, nodes) = maze_with_one_way_and_two_way_neighbor();
    let seed = nodes[2];
    let two_way = nodes[3];
    let one_way = nodes[4];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = maze.analysis.route_info(&maze.graph, &maze.meta)
        .map(|r| r.path.into_iter().collect()).unwrap_or_default();
    let mut budget = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft, seed, seed_component, &scc, &region_classes, &mut budget,
        0.5, 2, &critical, &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
    );

    let members = result.expect("two_way is a valid bidirectional candidate");
    assert!(members.contains(&two_way), "must grow into the bidirectionally-connected neighbor");
    assert!(!members.contains(&one_way), "must never grow into a neighbor reachable only via a one-way edge");
}

#[test]
fn grow_front_fails_when_only_one_way_neighbors_are_available() {
    // Same fixture, but ask for min_region_size=3 (seed + two_way + one more) -- once two_way
    // is exhausted (it has no further non-critical bidirectional neighbors of its own) and no
    // excess budget exists to cross into one_way's component, growth must fail outright.
    let (mut maze, nodes) = maze_with_one_way_and_two_way_neighbor();
    let seed = nodes[2];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = maze.analysis.route_info(&maze.graph, &maze.meta)
        .map(|r| r.path.into_iter().collect()).unwrap_or_default();
    let mut budget = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft, seed, seed_component, &scc, &region_classes, &mut budget,
        0.5, 3, &critical, &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
    );

    assert!(result.is_none(), "no excess budget to cross into one_way's component -- must fail, never take a one-way edge");
}

/// 1x2 path (start=0, finish=1). `in_region` = {2}, a singleton Unreachable component.
/// `neighbor`(3) is a geometric neighbor of node 2, its own singleton Unreachable component,
/// with no edge to node 2 yet (candidate for bridging).
fn maze_with_bridgeable_neighbor() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    (maze, nodes)
}

#[test]
fn try_open_excess_neighbor_bridges_a_single_node_and_debits_full_component_size() {
    let (mut maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let neighbor_component = scc.component_of(neighbor).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft, &in_region, &scc, &region_classes, &mut budget, &critical,
        &HashSet::from([seed_component]), &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
    );

    assert_eq!(opened, Some(OpenedNeighbor { node: neighbor, component: neighbor_component }));
    assert!(draft.maze.graph.edge_between(seed, neighbor).is_some(), "forward bridge edge must be added");
    assert!(draft.maze.graph.edge_between(neighbor, seed).is_some(), "bridge must be bidirectional");
    assert_eq!(budget.get(&RegionClass::Unreachable), None, "1-node component fully spends a budget of 1 -- entry removed");
}

#[test]
fn try_open_excess_neighbor_returns_none_without_budget_for_the_bordering_class() {
    let (mut maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget: HashMap<RegionClass, i32> = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft, &in_region, &scc, &region_classes, &mut budget, &critical,
        &HashSet::from([seed_component]), &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
    );

    assert_eq!(opened, None, "no excess budget for neighbor's class -- must not cross");
    assert!(draft.maze.graph.edge_between(seed, neighbor).is_none(), "no edge should have been added");
    assert!(draft.maze.graph.edge_between(neighbor, seed).is_none());
}

#[test]
fn try_open_excess_neighbor_skips_a_critical_bordering_node() {
    let (mut maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    // Treat `neighbor` itself as critical -- must be excluded from bordering candidates
    // exactly like a same-component candidate would be.
    let critical: HashSet<NodeId> = [nodes[0], nodes[1], neighbor].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft, &in_region, &scc, &region_classes, &mut budget, &critical,
        &HashSet::from([seed_component]), &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
    );

    assert_eq!(opened, None, "neighbor is on the critical path -- must never be crossed into");
    assert!(draft.maze.graph.edge_between(seed, neighbor).is_none());
}

#[test]
fn try_open_excess_neighbor_skips_a_committed_bordering_node() {
    let (mut maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let committed: HashSet<NodeId> = [neighbor].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft, &in_region, &scc, &region_classes, &mut budget, &critical,
        &HashSet::from([seed_component]), &test_ctx(&committed, &PresetState::empty()), &mut rng,
    );

    assert_eq!(opened, None, "neighbor was already committed by an earlier region item -- must never be crossed into");
    assert!(draft.maze.graph.edge_between(seed, neighbor).is_none());
}

#[test]
fn try_open_excess_neighbor_respects_preset_blocked_bridge() {
    let (mut maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((seed, neighbor));
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft, &in_region, &scc, &region_classes, &mut budget, &critical,
        &HashSet::from([seed_component]), &test_ctx(&HashSet::new(), &preset_state), &mut rng,
    );

    assert_eq!(opened, None, "the only bordering candidate's bridge is preset-blocked -- must fail without leaking a partial edge");
    assert!(draft.maze.graph.edge_between(seed, neighbor).is_none(), "no forward edge must leak from the blocked attempt");
    assert!(draft.maze.graph.edge_between(neighbor, seed).is_none());
    assert_eq!(budget.get(&RegionClass::Unreachable), Some(&1), "a fully-blocked attempt must not debit the budget");
}

#[test]
fn try_open_excess_neighbor_respects_preset_blocked_return_direction() {
    // Forward direction (seed -> neighbor) is allowed, only the return edge is blocked --
    // the candidate must still be rejected as a whole (bidirectional bridge required), and the
    // speculative forward edge must be rolled back, not left dangling as a one-way leak.
    let (mut maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let neighbor = nodes[3];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let in_region: HashSet<NodeId> = [seed].into_iter().collect();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 1)]);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((neighbor, seed));
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let opened = try_open_excess_neighbor(
        &mut draft, &in_region, &scc, &region_classes, &mut budget, &critical,
        &HashSet::from([seed_component]), &test_ctx(&HashSet::new(), &preset_state), &mut rng,
    );

    assert_eq!(opened, None, "return direction blocked -- whole candidate must be rejected");
    assert!(draft.maze.graph.edge_between(seed, neighbor).is_none(), "speculative forward edge must be rolled back, not left as a one-way leak");
    assert!(draft.maze.graph.edge_between(neighbor, seed).is_none());
}

#[test]
fn grow_front_crosses_into_excess_budgeted_neighbor_component_and_continues_growing_there() {
    // seed's own component is a singleton -- reaching min_region_size=3 requires crossing into
    // `neighbor`'s component AND continuing to grow from there via `neighbor`'s own
    // bidirectional edge to a third node, proving growth resumes past the crossed-in node
    // rather than stopping at exactly one absorbed node.
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    g.add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);
    let seed = nodes[2];
    let neighbor = nodes[3];
    let beyond = nodes[4];

    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget = HashMap::from([(RegionClass::Unreachable, 2)]);
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft, seed, seed_component, &scc, &region_classes, &mut budget,
        0.5, 3, &critical, &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
    );

    let members = result.expect("must cross into neighbor's component and keep growing to reach size 3");
    assert_eq!(members, HashSet::from([seed, neighbor, beyond]));
}

/// 3x2 grid: `seed` has two same-component bidirectional branches: `dead_end` (a single node,
/// exhausted after one step) and `long_branch` (two nodes long, still has candidates after
/// `dead_end` is spent). `bridgeable` is a separate singleton Unreachable component,
/// geometrically adjacent to `dead_end` only -- an excess-budgeted neighbor that a premature
/// (per-node, not whole-frontier) absorption trigger would incorrectly cross into as soon as
/// `dead_end` alone runs out of candidates, even while `long_branch` still has same-component
/// nodes left to grow into.
fn maze_with_uneven_branches_and_a_bridgeable_neighbor() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(4, 2), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();
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
    (maze, vec![start, finish, seed, dead_end, long_a, long_b, bridgeable])
}

#[test]
fn grow_front_does_not_cross_into_a_neighbor_component_while_other_frontier_nodes_still_have_candidates() {
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
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();

    for seed_val in 0..30u64 {
        let (mut maze, _) = maze_with_uneven_branches_and_a_bridgeable_neighbor();
        let mut budget = HashMap::from([(RegionClass::Unreachable, 100)]);
        let mut rng = MazeRng::seed_from_u64(seed_val);
        let mut draft = DraftMaze::new(maze);
        let result = grow_front(
            &mut draft, seed, seed_component, &scc, &region_classes, &mut budget,
            0.0, 4, &critical, &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
        );
        let members = result.unwrap_or_else(|| panic!("seed {seed_val}: same-component set alone reaches min_region_size=4, must not need to cross"));
        assert_eq!(members, HashSet::from([seed, dead_end, long_a, long_b]), "seed {seed_val}: must consume all 4 same-component nodes, never touching bridgeable");
        assert_eq!(budget.get(&RegionClass::Unreachable), Some(&100), "seed {seed_val}: excess budget must remain untouched -- no crossing should have happened");
        assert!(draft.maze.graph.edge_between(dead_end, bridgeable).is_none(), "seed {seed_val}: no bridge to bridgeable must have been added");
    }
}

#[test]
fn grow_front_fails_when_frontier_exhausted_and_no_excess_budget_to_cross() {
    let (mut maze, nodes) = maze_with_bridgeable_neighbor();
    let seed = nodes[2];
    let scc = maze.analysis.scc(&maze.graph);
    let region_classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let seed_component = scc.component_of(seed).unwrap();
    let critical: HashSet<NodeId> = [nodes[0], nodes[1]].into_iter().collect();
    let mut budget: HashMap<RegionClass, i32> = HashMap::new();
    let mut rng = MazeRng::seed_from_u64(1);

    let mut draft = DraftMaze::new(maze);
    let result = grow_front(
        &mut draft, seed, seed_component, &scc, &region_classes, &mut budget,
        0.5, 2, &critical, &test_ctx(&HashSet::new(), &PresetState::empty()), &mut rng,
    );

    assert!(result.is_none(), "seed is a singleton component with no bidirectional neighbor and no excess budget -- must fail");
}

/// 3x3 grid: a 5-node plus-shaped Unreachable component (center + 4 arms, all bidirectional)
/// with one extra bidirectional edge from the top arm out to a 6th node OUTSIDE `members` --
/// the external edge `sever_from_parent` must cut, while internal plus-shaped connectivity must
/// survive untouched.
fn maze_with_plus_shaped_region_and_external_edge() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(3, 4), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let n = |x: i32, y: i32| field.node_at(crate::space::SquarePoint { x, y }).unwrap();
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
    (maze, vec![start, finish, center, up, down, left, right, outside])
}

#[test]
fn sever_from_parent_removes_external_edges_but_keeps_internal_connectivity() {
    let (mut maze, nodes) = maze_with_plus_shaped_region_and_external_edge();
    let center = nodes[2];
    let up = nodes[3];
    let down = nodes[4];
    let left = nodes[5];
    let right = nodes[6];
    let outside = nodes[7];
    let members: HashSet<NodeId> = [center, up, down, left, right].into_iter().collect();

    let mut draft = DraftMaze::new(maze);
    assert!(sever_from_parent(&mut draft, &members, &PresetState::empty()));

    assert!(draft.maze.graph.edge_between(up, outside).is_none(), "external edge must be cut (outbound)");
    assert!(draft.maze.graph.edge_between(outside, up).is_none(), "external edge must be cut (inbound)");

    for &(a, b) in &[(center, up), (center, down), (center, left), (center, right)] {
        assert!(draft.maze.graph.edge_between(a, b).is_some(), "internal edge {a:?}->{b:?} must survive severance");
        assert!(draft.maze.graph.edge_between(b, a).is_some(), "internal edge {b:?}->{a:?} must survive severance");
    }

    let scc = draft.maze.analysis.scc(&draft.maze.graph);
    let members_component = scc.component_of(center);
    for &m in &members {
        assert_eq!(scc.component_of(m), members_component, "members must remain one connected SCC after severance");
    }
}

#[test]
fn sever_from_parent_fails_when_a_required_cut_is_preset_blocked() {
    let (mut maze, nodes) = maze_with_plus_shaped_region_and_external_edge();
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
    assert!(!sever_from_parent(&mut draft, &members, &preset_state), "a preset-protected external edge blocks the whole severance");
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
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(9, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
        let (mut maze, nodes) = maze_with_one_bordering_seed_and_decoys();
        let bordering = nodes[2];
        let mut rng = MazeRng::seed_from_u64(seed);
        let mut excess_budget: HashMap<RegionClass, i32> = HashMap::new();
        let ctx = GrowContext {
            committed_nodes: &HashSet::new(), preset_state: &PresetState::empty(),
            inbound_requires_geometry: true, outbound_requires_geometry: true,
        };
        let mut draft = DraftMaze::new(maze);
        let result = try_grow(
            &mut draft, RegionClass::Trap, 0.5, 1,
            &mut excess_budget, &ctx, &mut rng,
        );
        let members = result.unwrap_or_else(|| panic!("seed {seed}: growth must succeed with MAX_GROW_ATTEMPTS covering the bordering seed when priority is ON"));
        assert!(members.contains(&bordering), "seed {seed}: border priority ON must always land on the bordering seed");
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
        let (mut maze, _) = maze_with_one_bordering_seed_and_decoys();
        let mut rng = MazeRng::seed_from_u64(seed);
        let mut excess_budget: HashMap<RegionClass, i32> = HashMap::new();
        let ctx = GrowContext {
            committed_nodes: &HashSet::new(), preset_state: &PresetState::empty(),
            inbound_requires_geometry: false, outbound_requires_geometry: false,
        };
        let mut draft = DraftMaze::new(maze);
        let result = try_grow(
            &mut draft, RegionClass::Trap, 0.5, 1,
            &mut excess_budget, &ctx, &mut rng,
        );
        if result.is_none() {
            saw_a_failure = true;
            break;
        }
    }
    assert!(saw_a_failure, "border priority OFF must let the bordering seed miss the MAX_GROW_ATTEMPTS window (causing a failed attempt) at least once over 40 seeds");
}

#[test]
fn apply_end_to_end_grown_region_has_no_leftover_edge_to_its_original_neighborhood() {
    // Full apply() through try_grow: confirm the end-to-end committed region also ends up
    // severed from anything outside `members` in the final graph, not just in the
    // `sever_from_parent` unit test above.
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(5, 1), &mut ids).unwrap();
    let mut g = G::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[1], EK::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_MIN_REGION_SIZE.to_string(), "2".to_string());
    let params = build_params(
        <MissingRegionsStrategy as RepairStrategy<SquareTessellation, MissingRegionsIssue>>::params(&MissingRegionsStrategy),
        Some(&overrides),
    );

    let issue = issue_for(vec![(RegionClass::Trap, 1)]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(&issue, &mut maze, &mut rng, &params, &PresetState::empty());
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // The Trap region must be exactly one SCC -- nothing left half-connected to the rest of
    // the (now Path-only) graph via a stray edge that would have made it Path/Alternative
    // instead of a clean Trap.
    let classes = maze.analysis.region_classes(&maze.graph, &maze.meta);
    let trap_components: HashSet<_> = classes.iter().filter(|&(_, &c)| c == RegionClass::Trap).map(|(&idx, _)| idx).collect();
    assert_eq!(trap_components.len(), 1, "exactly one Trap component must exist");
}
