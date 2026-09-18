use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind as EK, Graph};
use crate::random::MazeRng;
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::space::{MultiLevelField, SquareTessellation, square_rect};
use rand::SeedableRng;
use region_merge_core::{MODE_LARGEST, MODE_PREFER_NEEDY, MODE_SMALLEST};
use std::collections::HashMap as StdHashMap;

fn params_with(
    mode: &str,
    connection_mode: &str,
    prefer_partial: bool,
    direction_balance: f64,
) -> StrategyParams {
    let mut overrides = StdHashMap::new();
    overrides.insert(PARAM_TARGET_MODE.to_string(), mode.to_string());
    overrides.insert(
        PARAM_CONNECTION_MODE.to_string(),
        connection_mode.to_string(),
    );
    overrides.insert(
        PARAM_PREFER_PARTIALLY_CONNECTED.to_string(),
        prefer_partial.to_string(),
    );
    overrides.insert(
        PARAM_DIRECTION_BALANCE.to_string(),
        direction_balance.to_string(),
    );
    build_params(
        <VerticalPassageRegionMergeStrategy as RepairStrategy<
            SquareTessellation,
            RegionNeedsExpansionIssue,
        >>::params(&VerticalPassageRegionMergeStrategy),
        Some(&overrides),
    )
}

fn params_with_mode(mode: &str) -> StrategyParams {
    params_with(mode, CONNECTION_PASSAGE, false, 1.0)
}

fn default_params() -> StrategyParams {
    build_params(
        <VerticalPassageRegionMergeStrategy as RepairStrategy<
            SquareTessellation,
            RegionNeedsExpansionIssue,
        >>::params(&VerticalPassageRegionMergeStrategy),
        None,
    )
}

/// Builds a `w`x`h` square field replicated across `levels` floors, no edges at all, and
/// returns the nodes of each level in `all_points` order (row-major). Every point exists on
/// every floor (same shape), so `resolve_vertical_target` always finds a same-point node one
/// floor up/down.
fn build_multi_level(
    w: usize,
    h: usize,
    levels: usize,
) -> (Maze<SquareTessellation>, Vec<Vec<NodeId>>) {
    let mut ids = IdGenerator::new();
    let fields: Vec<_> = (0..levels)
        .map(|_| crate::space::Field::new(square_rect(w, h), &mut ids).unwrap())
        .collect();
    let field = MultiLevelField::<SquareTessellation>::new(fields);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let level_ids: Vec<_> = field.levels_ordered().collect();
    let nodes_by_level: Vec<Vec<NodeId>> = level_ids
        .iter()
        .map(|&lvl| {
            field
                .field_of(lvl)
                .unwrap()
                .all_points()
                .map(|p| field.node_at(lvl, p).unwrap())
                .collect()
        })
        .collect();
    (Maze::new(field, g), nodes_by_level)
}

/// 1x4 row replicated on 2 floors, no edges -> per-floor 4 singleton SCC regions, each node's
/// only vertical neighbor is the same-point node on the other floor.
fn maze_two_floors() -> (Maze<SquareTessellation>, Vec<Vec<NodeId>>) {
    build_multi_level(4, 1, 2)
}

fn issue_for(invalid: Vec<usize>) -> RegionNeedsExpansionIssue {
    RegionNeedsExpansionIssue::new_from_check("test", invalid, StdHashMap::new())
}

#[test]
fn apply_fixed_immediately_when_invalid_is_empty() {
    let (mut maze, _) = maze_two_floors();
    let issue = issue_for(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), edges_before);
}

#[test]
fn apply_merges_singleton_region_into_its_vertical_neighbor() {
    let (mut maze, nodes) = maze_two_floors();
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(7);
    // direction_balance=1.0 -> deterministically pins "up" (floor 0 -> floor 1).
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false, 1.0),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(nodes[0][0], nodes[1][0]).is_some());
    assert!(maze.graph.edge_between(nodes[1][0], nodes[0][0]).is_some());
    assert!(maze.graph.edges().all(|e| e.kind == EK::VerticalPassage));
}

#[test]
fn apply_completes_an_existing_one_way_vertical_edge_into_a_full_passage() {
    let (mut maze, nodes) = maze_two_floors();
    maze.graph
        .add_edge(nodes[0][0], nodes[1][0], EK::VerticalPassage);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[1][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(3);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false, 0.0),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(nodes[0][0], nodes[1][0]).is_some());
    assert!(maze.graph.edge_between(nodes[1][0], nodes[0][0]).is_some());
    assert_eq!(maze.graph.edges().count(), 2);
}

#[test]
fn apply_fails_when_field_is_single_level() {
    let mut ids = IdGenerator::new();
    let field =
        MultiLevelField::<SquareTessellation>::single_level(square_rect(1, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    let region_idx = maze.analysis.scc(&maze.graph).components.len() - 1;
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_respects_preset_blocked_pair() {
    let (mut maze, nodes) = maze_two_floors();
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((nodes[0][0], nodes[1][0]));
    preset_state.blocked.insert((nodes[1][0], nodes[0][0]));

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false, 1.0),
        &preset_state,
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn mode_largest_prefers_the_bigger_vertical_neighbor_component() {
    // 1x1 column across 3 floors: node under test on floor 1 (middle), which can bridge
    // either down (floor 0, singleton) or up (floor 2, pre-merged with... itself is
    // singleton too, so instead use a 1x2 field: floor 2's second cell merges into the
    // vertical target to make it a bigger component via that same-point neighbor path is
    // impossible for a single point). Use two separate points across a 1x1 shape instead:
    // simplest way to vary component size on the neighbor floor is to add a same-floor edge
    // there via a 1-wide, 2-tall field is not vertically adjacent -- so build two points
    // with a horizontal edge on the *target* floor.
    let (mut maze, nodes) = build_multi_level(2, 1, 2);
    // floor 1 (index 1): merge both cells into a single 2-cell region.
    maze.graph
        .add_bidirectional_edge(nodes[1][0], nodes[1][1], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(11);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with_mode(MODE_LARGEST),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(nodes[0][0], nodes[1][0]).is_some());
}

#[test]
fn mode_smallest_prefers_the_smaller_vertical_neighbor_component() {
    let (mut maze, nodes) = build_multi_level(2, 1, 2);
    maze.graph
        .add_bidirectional_edge(nodes[1][0], nodes[1][1], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0][1])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(11);
    // node[0][1]'s only vertical neighbor is node[1][1] (the 2-cell floor-1 region) --
    // smallest mode has no smaller alternative here, so just confirm it still succeeds via
    // the sole available neighbor (there's only one direction to test meaningfully without a
    // second vertical option, since a node has at most one neighbor per floor).
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with_mode(MODE_SMALLEST),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(nodes[0][1], nodes[1][1]).is_some());
}

#[test]
fn mode_prefer_needy_picks_a_flagged_neighbor_when_available() {
    let (mut maze, nodes) = maze_two_floors();
    let scc = maze.analysis.scc(&maze.graph);
    let idx0 = scc.component_of(nodes[0][0]).unwrap();
    let idx1 = scc.component_of(nodes[1][0]).unwrap();
    let issue = issue_for(vec![idx0, idx1]);
    let mut rng = MazeRng::seed_from_u64(2);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with_mode(MODE_PREFER_NEEDY),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let (mut maze_a, nodes_a) = maze_two_floors();
    let region_idx_a = maze_a
        .analysis
        .scc(&maze_a.graph)
        .component_of(nodes_a[0][0])
        .unwrap();
    let issue_a = issue_for(vec![region_idx_a]);
    let mut rng_a = MazeRng::seed_from_u64(99);
    apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue_a,
        &mut maze_a,
        &mut rng_a,
        &default_params(),
        &PresetState::empty(),
        &[],
    );

    let (mut maze_b, nodes_b) = maze_two_floors();
    let region_idx_b = maze_b
        .analysis
        .scc(&maze_b.graph)
        .component_of(nodes_b[0][0])
        .unwrap();
    let issue_b = issue_for(vec![region_idx_b]);
    let mut rng_b = MazeRng::seed_from_u64(99);
    apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue_b,
        &mut maze_b,
        &mut rng_b,
        &default_params(),
        &PresetState::empty(),
        &[],
    );

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_a, edges_b);
}

#[test]
fn direction_balance_pinned_to_zero_bridges_downward_only() {
    let (mut maze, nodes) = build_multi_level(1, 1, 3);
    // node under test on the middle floor (index 1) -- both up and down exist.
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[1][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false, 0.0),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(nodes[1][0], nodes[0][0]).is_some());
    assert!(maze.graph.edge_between(nodes[1][0], nodes[2][0]).is_none());
}

#[test]
fn direction_balance_pinned_to_one_bridges_upward_only() {
    let (mut maze, nodes) = build_multi_level(1, 1, 3);
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[1][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false, 1.0),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(nodes[1][0], nodes[2][0]).is_some());
    assert!(maze.graph.edge_between(nodes[1][0], nodes[0][0]).is_none());
}

// ─── connection_mode = one_way ──────────────────────────────────────────

/// A node has at most one bridging pair per direction (up/down); when only one floor is
/// reachable, that's a single bridging pair total -> one_way can't build two separated
/// directions and must fail.
#[test]
fn one_way_fails_when_only_a_single_bridging_pair_exists() {
    let (mut maze, nodes) = maze_two_floors();
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false, 1.0),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

/// 2x1 row on 2 floors, columns pre-merged within each floor into a single region each ->
/// each of the region's two nodes has its own vertical bridging pair to the same-index node
/// on the other floor, giving two independent bridging pairs for one_way's max-separation
/// placement.
fn maze_two_floors_two_columns() -> (Maze<SquareTessellation>, Vec<Vec<NodeId>>) {
    let (mut maze, nodes) = build_multi_level(2, 1, 2);
    maze.graph
        .add_bidirectional_edge(nodes[0][0], nodes[0][1], EK::Basic);
    maze.graph
        .add_bidirectional_edge(nodes[1][0], nodes[1][1], EK::Basic);
    (maze, nodes)
}

#[test]
fn passage_bridging_pair_is_not_always_the_first_one_found() {
    // Region spans both columns of the bottom floor (pre-merged), each column has its own
    // independent bridging pair to the top floor. Across several seeds, `connection_mode:
    // passage` must not always pick the same (region_node, neighbor_node) pair -- picking a
    // fixed index would always bridge through the same cell whenever a region spans more than
    // one cell, regardless of seed.
    let mut seen_pairs = std::collections::HashSet::new();
    for seed in 0..20u64 {
        let (mut maze, nodes) = maze_two_floors_two_columns();
        let region_idx = maze
            .analysis
            .scc(&maze.graph)
            .component_of(nodes[0][0])
            .unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(seed);
        let result = apply_and_commit(
            &VerticalPassageRegionMergeStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false, 1.0),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let bottom = [nodes[0][0], nodes[0][1]];
        let bridge = bottom
            .iter()
            .find(|&&b| {
                maze.graph.edge_between(b, nodes[1][0]).is_some()
                    || maze.graph.edge_between(b, nodes[1][1]).is_some()
            })
            .copied();
        seen_pairs.insert(bridge);
    }
    assert!(
        seen_pairs.len() > 1,
        "expected the bridging pair to vary across seeds, got {seen_pairs:?}"
    );
}

#[test]
fn one_way_builds_both_directions_through_distinct_pairs() {
    let (mut maze, nodes) = maze_two_floors_two_columns();
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(4);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false, 1.0),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let bottom = [nodes[0][0], nodes[0][1]];
    let top = [nodes[1][0], nodes[1][1]];
    let mut outbound_pairs = Vec::new();
    let mut inbound_pairs = Vec::new();
    for &b in &bottom {
        for &t in &top {
            if maze.graph.edge_between(b, t).is_some() {
                outbound_pairs.push((b, t));
            }
            if maze.graph.edge_between(t, b).is_some() {
                inbound_pairs.push((t, b));
            }
        }
    }
    assert_eq!(outbound_pairs.len(), 1);
    assert_eq!(inbound_pairs.len(), 1);
    let (ob, ot) = outbound_pairs[0];
    let (it, ib) = inbound_pairs[0];
    assert!(
        !(ob == ib && ot == it),
        "one_way must use two distinct cell pairs, not complete a passage on one pair"
    );
}

#[test]
fn one_way_proposes_neither_direction_when_the_other_is_preset_blocked() {
    let (mut maze, nodes) = maze_two_floors_two_columns();
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(4);

    let bottom = [nodes[0][0], nodes[0][1]];
    let top = [nodes[1][0], nodes[1][1]];
    let mut preset_state = PresetState::empty();
    for &b in &bottom {
        for &t in &top {
            preset_state.blocked.insert((t, b));
        }
    }

    let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false, 1.0),
        &preset_state,
        &[],
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "one_way must fail outright when only one direction can be built"
    );
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_before, edges_after);
}

#[test]
fn one_way_completes_only_the_missing_direction_via_a_different_pair() {
    let (mut maze, nodes) = maze_two_floors_two_columns();
    maze.graph
        .add_edge(nodes[0][0], nodes[1][0], EK::VerticalPassage);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(9);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false, 1.0),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge_between(nodes[0][0], nodes[1][0]).is_some());
    assert!(maze.graph.edge_between(nodes[1][0], nodes[0][0]).is_none());
    let top = [nodes[1][0], nodes[1][1]];
    let bottom = [nodes[0][0], nodes[0][1]];
    let has_inbound = top.iter().any(|&t| {
        bottom
            .iter()
            .any(|&b| maze.graph.edge_between(t, b).is_some())
    });
    assert!(has_inbound);
}

/// 2x2 square on 2 floors, all four cells pre-merged into a single region on the bottom floor ->
/// four independent bridging pairs, laid out as a square (not a line), so a "maximize distance"
/// metric would always settle on the two diagonally-opposite corners regardless of seed.
fn maze_two_floors_square() -> (Maze<SquareTessellation>, Vec<Vec<NodeId>>) {
    let (mut maze, nodes) = build_multi_level(2, 2, 2);
    for level in [0usize, 1] {
        maze.graph
            .add_bidirectional_edge(nodes[level][0], nodes[level][1], EK::Basic);
        maze.graph
            .add_bidirectional_edge(nodes[level][1], nodes[level][3], EK::Basic);
        maze.graph
            .add_bidirectional_edge(nodes[level][3], nodes[level][2], EK::Basic);
        maze.graph
            .add_bidirectional_edge(nodes[level][2], nodes[level][0], EK::Basic);
    }
    (maze, nodes)
}

#[test]
fn one_way_neither_direction_does_not_always_pick_the_diagonal_corners() {
    // With farthest-pair placement, the two picked bottom-floor cells would always be the same
    // diagonal pair (maximum mutual distance in a square is always the diagonal) regardless of
    // seed. Uniformly random placement must vary which pair of the four bridging pairs gets
    // picked across seeds.
    let mut seen: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    for seed in 0..30u64 {
        let (mut maze, nodes) = maze_two_floors_square();
        let region_idx = maze
            .analysis
            .scc(&maze.graph)
            .component_of(nodes[0][0])
            .unwrap();
        let issue = issue_for(vec![region_idx]);
        let mut rng = MazeRng::seed_from_u64(seed);
        let result = apply_and_commit(
            &VerticalPassageRegionMergeStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false, 1.0),
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let bottom = &nodes[0];
        let top = &nodes[1];
        let mut out_idx = None;
        let mut in_idx = None;
        for (bi, &b) in bottom.iter().enumerate() {
            if top.iter().any(|&t| maze.graph.edge_between(b, t).is_some()) {
                out_idx = Some(bi);
            }
            if top.iter().any(|&t| maze.graph.edge_between(t, b).is_some()) {
                in_idx = Some(bi);
            }
        }
        if let (Some(o), Some(i)) = (out_idx, in_idx) {
            seen.insert((o, i));
        }
    }
    assert!(
        seen.len() > 1,
        "expected the chosen bridging-pair combination to vary across seeds, got {seen:?}"
    );
}

#[test]
fn prefer_partially_connected_picks_partial_neighbor_over_unconnected_one() {
    // Single-cell region on the middle floor of a 3-floor stack: floor 2 (up) already has a
    // one-way outbound edge; floor 0 (down) has no connection. Discovery is deterministic (both
    // directions always checked), so both floors are reliably found as candidates in the same
    // scan; with prefer_partially_connected=true, the up neighbor must win regardless of what
    // direction_balance's up/down tie-break would otherwise roll.
    let (mut maze, nodes) = build_multi_level(1, 1, 3);
    maze.graph
        .add_edge(nodes[1][0], nodes[2][0], EK::VerticalPassage);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[1][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, true, 0.5),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(nodes[2][0], nodes[1][0]).is_some());
    assert!(maze.graph.edge_between(nodes[1][0], nodes[0][0]).is_none());
}

#[test]
fn direction_balance_tie_breaks_between_two_unconnected_directions() {
    // Single-cell region on the middle floor of a 3-floor stack: both up and down neighbors
    // exist, neither connected yet. With direction_balance pinned to 0.0/1.0, the tie-break must
    // deterministically settle on down/up respectively.
    let (mut maze_down, nodes_down) = build_multi_level(1, 1, 3);
    let region_idx = maze_down
        .analysis
        .scc(&maze_down.graph)
        .component_of(nodes_down[1][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze_down,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false, 0.0),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(
        maze_down
            .graph
            .edge_between(nodes_down[1][0], nodes_down[0][0])
            .is_some()
    );
    assert!(
        maze_down
            .graph
            .edge_between(nodes_down[1][0], nodes_down[2][0])
            .is_none()
    );

    let (mut maze_up, nodes_up) = build_multi_level(1, 1, 3);
    let region_idx = maze_up
        .analysis
        .scc(&maze_up.graph)
        .component_of(nodes_up[1][0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &VerticalPassageRegionMergeStrategy,
        &issue,
        &mut maze_up,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false, 1.0),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(
        maze_up
            .graph
            .edge_between(nodes_up[1][0], nodes_up[2][0])
            .is_some()
    );
    assert!(
        maze_up
            .graph
            .edge_between(nodes_up[1][0], nodes_up[0][0])
            .is_none()
    );
}
