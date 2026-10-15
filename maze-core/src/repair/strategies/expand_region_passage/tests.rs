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
use std::sync::Arc;

fn params_with(mode: &str, connection_mode: &str, prefer_partial: bool) -> StrategyParams {
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
    build_params(
        <ExpandRegionPassageStrategy as RepairStrategy<
            SquareTessellation,
            RegionNeedsExpansionIssue,
        >>::params(&ExpandRegionPassageStrategy),
        Some(&overrides),
    )
}

fn params_with_mode(mode: &str) -> StrategyParams {
    params_with(mode, CONNECTION_PASSAGE, false)
}

fn default_params() -> StrategyParams {
    build_params(
        <ExpandRegionPassageStrategy as RepairStrategy<
            SquareTessellation,
            RegionNeedsExpansionIssue,
        >>::params(&ExpandRegionPassageStrategy),
        None,
    )
}

/// Builds a `w`x`h` square field with no edges and returns its nodes in `all_points` order
/// (row-major, since `square_rect` yields points row-major and `all_points` is sorted by
/// `NodeId`/creation order) — the common setup every test in this file starts from before
/// wiring up its own edges.
fn build_field(w: usize, h: usize) -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(w, h), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let nodes: Vec<_> = field
        .field_of(field_level)
        .unwrap()
        .all_points()
        .map(|p| field.node_at(field_level, p).unwrap())
        .collect();
    (Maze::new(field, g), nodes)
}

/// 1x4 row of cells, no edges at all -> 4 singleton SCC regions, all geometrically
/// adjacent in a chain: 0-1-2-3.
fn maze_4_singletons() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    build_field(4, 1)
}

fn issue_for(invalid: Vec<usize>) -> RegionNeedsExpansionIssue {
    RegionNeedsExpansionIssue::new_from_check("test", invalid, StdHashMap::new())
}

#[test]
fn apply_fixed_immediately_when_invalid_is_empty() {
    let (mut maze, _) = maze_4_singletons();
    let issue = issue_for(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let edges_before = maze.graph.edges().count();
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
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
fn apply_merges_singleton_region_into_a_neighbor() {
    let (mut maze, nodes) = maze_4_singletons();
    // Flag node[0]'s singleton region (component index unknown ahead of time —
    // look it up via a fresh scc()).
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // node[0]'s only geometric neighbor is node[1] -> must now be a full passage.
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
    assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some());
}

#[test]
fn apply_completes_an_existing_one_way_edge_into_a_full_passage() {
    let (mut maze, nodes) = build_field(2, 1);
    // One-way edge already present: nodes[0] -> nodes[1].
    maze.graph.add_edge(nodes[0], nodes[1], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[1])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(3);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
    assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_some());
    // Exactly one edge added (the missing reverse direction), not a duplicate forward edge.
    assert_eq!(maze.graph.edges().count(), 2);
}

#[test]
fn apply_fails_when_region_has_no_neighbor() {
    // Single isolated cell field -> no geometric neighbor exists at all.
    let (mut maze, _) = build_field(1, 1);
    let region_idx = maze.analysis.scc(&maze.graph).components.len() - 1;
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
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
    let (mut maze, nodes) = maze_4_singletons();
    let mut preset_state = PresetState::empty();
    // Block the only bridge for node[0]'s region (node[0]-node[1]) in both directions.
    preset_state.blocked.insert((nodes[0], nodes[1]));
    preset_state.blocked.insert((nodes[1], nodes[0]));

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &default_params(),
        &preset_state,
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn mode_largest_prefers_the_bigger_neighbor() {
    // 1x5 row: region under test is the lone middle singleton (idx 2), flanked by a
    // 1-cell region on the left (node 1, still singleton) and a pre-merged 2-cell
    // region on the right (nodes 3-4).
    let (mut maze, nodes) = build_field(5, 1);
    maze.graph
        .add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[2])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(11);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with_mode(MODE_LARGEST),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // Must bridge toward the larger (2-cell) region on the right, not the singleton on the left.
    assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_some());
    assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_none());
}

#[test]
fn mode_smallest_prefers_the_smaller_neighbor() {
    let (mut maze, nodes) = build_field(5, 1);
    maze.graph
        .add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[2])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(11);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with_mode(MODE_SMALLEST),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // Must bridge toward the smaller (1-cell) region on the left.
    assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_some());
    assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_none());
}

#[test]
fn mode_prefer_needy_picks_a_flagged_neighbor_when_available() {
    // 1x3 row, three singletons, all flagged as undersized. node[1]'s region must
    // bridge to one of its two needy neighbors (both flagged) -- either is correct,
    // but the result must be exactly one new bidirectional passage from node[1].
    let (mut maze, nodes) = maze_4_singletons();
    let scc = maze.analysis.scc(&maze.graph);
    let idx0 = scc.component_of(nodes[0]).unwrap();
    let idx1 = scc.component_of(nodes[1]).unwrap();
    let idx2 = scc.component_of(nodes[2]).unwrap();
    let issue = issue_for(vec![idx0, idx1, idx2]);
    let mut rng = MazeRng::seed_from_u64(2);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
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
    let (mut maze_a, nodes_a) = maze_4_singletons();
    let region_idx_a = maze_a
        .analysis
        .scc(&maze_a.graph)
        .component_of(nodes_a[0])
        .unwrap();
    let issue_a = issue_for(vec![region_idx_a]);
    let mut rng_a = MazeRng::seed_from_u64(99);
    apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue_a,
        &mut maze_a,
        &mut rng_a,
        &default_params(),
        &PresetState::empty(),
        &[],
    );

    let (mut maze_b, nodes_b) = maze_4_singletons();
    let region_idx_b = maze_b
        .analysis
        .scc(&maze_b.graph)
        .component_of(nodes_b[0])
        .unwrap();
    let issue_b = issue_for(vec![region_idx_b]);
    let mut rng_b = MazeRng::seed_from_u64(99);
    apply_and_commit(
        &ExpandRegionPassageStrategy,
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
fn random_passage_fast_path_bridges_first_neighbor_found_without_touching_rng() {
    // Explicit prefer_partially_connected=false -> hits the legacy fast path
    // (`find_first_neighbor_passage`), which never consumes `rng` at all. Two runs with
    // deliberately *different* seeds must still produce the identical result, proving no
    // rng draw happened during selection.
    let (mut maze_a, nodes_a) = maze_4_singletons();
    let region_idx_a = maze_a
        .analysis
        .scc(&maze_a.graph)
        .component_of(nodes_a[0])
        .unwrap();
    let issue_a = issue_for(vec![region_idx_a]);
    let mut rng_a = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue_a,
        &mut maze_a,
        &mut rng_a,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let (mut maze_b, nodes_b) = maze_4_singletons();
    let region_idx_b = maze_b
        .analysis
        .scc(&maze_b.graph)
        .component_of(nodes_b[0])
        .unwrap();
    let issue_b = issue_for(vec![region_idx_b]);
    let mut rng_b = MazeRng::seed_from_u64(12345);
    apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue_b,
        &mut maze_b,
        &mut rng_b,
        &params_with(MODE_RANDOM, CONNECTION_PASSAGE, false),
        &PresetState::empty(),
        &[],
    );

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(
        edges_a, edges_b,
        "fast path must not depend on rng state at all"
    );
    // node[0]'s only geometric neighbor is node[1] -> must be the bridge target.
    assert!(maze_a.graph.edge_between(nodes_a[0], nodes_a[1]).is_some());
    assert!(maze_a.graph.edge_between(nodes_a[1], nodes_a[0]).is_some());
}

// ─── connection_mode = one_way ──────────────────────────────────────────

/// 1x4 row: node[0]'s singleton region only has one geometric neighbor (node[1]) and
/// therefore only one bridging cell pair -> one_way mode can't build two separated
/// directions, must fail (no other neighbor to fall back to).
#[test]
fn one_way_fails_when_only_a_single_bridging_pair_exists() {
    let (mut maze, nodes) = maze_4_singletons();
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

/// 2x2 square field, split into two 2-cell regions by column -> each region borders
/// the other along two distinct row positions, giving two independent bridging cell
/// pairs for one_way mode's max-separation placement.
fn maze_2x2_two_columns() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let (mut maze, nodes) = build_field(2, 2);
    // all_points order is sorted by NodeId (creation order), which square_rect yields
    // row-major: (0,0),(1,0),(0,1),(1,1).
    // Left column {nodes[0], nodes[2]} as one region, right column {nodes[1], nodes[3]}
    // as another -> connect within each column only.
    maze.graph
        .add_bidirectional_edge(nodes[0], nodes[2], EK::Basic);
    maze.graph
        .add_bidirectional_edge(nodes[1], nodes[3], EK::Basic);
    (maze, nodes)
}

#[test]
fn one_way_builds_both_directions_through_distinct_pairs() {
    let (mut maze, nodes) = maze_2x2_two_columns();
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(4);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // Exactly one outbound (left -> right) and one inbound (right -> left) edge,
    // through two different cell pairs.
    let left = [nodes[0], nodes[2]];
    let right = [nodes[1], nodes[3]];
    let mut outbound_pairs = Vec::new();
    let mut inbound_pairs = Vec::new();
    for &l in &left {
        for &r in &right {
            if maze.graph.edge_between(l, r).is_some() {
                outbound_pairs.push((l, r));
            }
            if maze.graph.edge_between(r, l).is_some() {
                inbound_pairs.push((r, l));
            }
        }
    }
    assert_eq!(outbound_pairs.len(), 1);
    assert_eq!(inbound_pairs.len(), 1);
    // Must not be the same cell pair (that would just be an ordinary passage).
    let (ol, or_) = outbound_pairs[0];
    let (il, ir) = inbound_pairs[0];
    assert!(
        !(ol == ir && or_ == il),
        "one_way must use two distinct cell pairs, not complete a passage on one pair"
    );
}

/// Both bridging pairs exist (so `one_way` picks two distinct pairs, one per direction), but
/// every inbound (right -> left) pair is preset-blocked — only the outbound direction could
/// ever succeed. `apply_one_way` must not propose that lone outbound edge on its own: a
/// partial one-way silently completing into a full passage on a later repair pass (via
/// `try_add_bidirectional_edge`'s completion-aware behavior) would defeat the caller's
/// `connection_mode` choice. Both directions' feasibility is checked (via `pair_edge_blocked`,
/// no mutation) before either command is proposed, so the whole attempt fails outright with no
/// command proposed for either direction — there is nothing to roll back, since nothing was
/// ever tentatively applied in the first place.
#[test]
fn one_way_proposes_neither_direction_when_the_other_is_preset_blocked() {
    let (mut maze, nodes) = maze_2x2_two_columns();
    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(4);

    let left = [nodes[0], nodes[2]];
    let right = [nodes[1], nodes[3]];
    let mut preset_state = PresetState::empty();
    for &l in &left {
        for &r in &right {
            preset_state.blocked.insert((r, l)); // block every possible inbound direction
        }
    }

    let edges_before: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false),
        &preset_state,
        &[],
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "one_way must fail outright when only one direction can be built"
    );
    let edges_after: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(
        edges_before, edges_after,
        "neither direction's command must be proposed when the pair as a whole can't be fully built"
    );
}

#[test]
fn one_way_completes_only_the_missing_direction_via_a_different_pair() {
    let (mut maze, nodes) = maze_2x2_two_columns();
    // Pre-existing partial connection: nodes[0] (left) -> nodes[1] (right).
    maze.graph.add_edge(nodes[0], nodes[1], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(9);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // Forward edge unchanged (still exactly the original nodes[0]->nodes[1]).
    assert!(maze.graph.edge_between(nodes[0], nodes[1]).is_some());
    // Missing (inbound) direction must be added via a different pair than (0,1) —
    // i.e. not nodes[1]->nodes[0].
    assert!(maze.graph.edge_between(nodes[1], nodes[0]).is_none());
    // The inbound edge must exist somewhere from the right column back to the left.
    let right = [nodes[1], nodes[3]];
    let left = [nodes[0], nodes[2]];
    let has_inbound = right.iter().any(|&r| {
        left.iter()
            .any(|&l| maze.graph.edge_between(r, l).is_some())
    });
    assert!(has_inbound);
}

#[test]
fn one_way_completes_missing_direction_maximizing_min_distance_to_all_occupied_pairs() {
    // 5 rows x 2 cols: left/right regions share 5 bridging cell pairs (one per row, 0..4).
    // Rows 0 and 4 (the two ends) already carry an outbound edge; rows 1, 2, 3 are free.
    // A single-reference implementation (picking "farthest from row 0 only", the first
    // occupied pair found) would compute row 4 as farthest from row 0 -- but row 4 is
    // itself occupied, so it isn't even a valid candidate; among the remaining candidates
    // it would then pick row 3 (second-farthest from row 0), which sits right next to the
    // other occupied pair (row 4). The correct max-min-distance choice is row 2, maximizing
    // the *minimum* distance to both occupied pairs (row 0 and row 4) at once.
    let (mut maze, nodes) = build_field(2, 5);
    // all_points sorted by NodeId (row-major): row_i = [nodes[2*i], nodes[2*i+1]].
    let left: Vec<NodeId> = (0..5).map(|i| nodes[2 * i]).collect();
    let right: Vec<NodeId> = (0..5).map(|i| nodes[2 * i + 1]).collect();
    for i in 0..4 {
        maze.graph
            .add_bidirectional_edge(left[i], left[i + 1], EK::Basic);
        maze.graph
            .add_bidirectional_edge(right[i], right[i + 1], EK::Basic);
    }
    // Pre-existing outbound edges via row 0's and row 4's pairs (both left -> right).
    maze.graph.add_edge(left[0], right[0], EK::Basic);
    maze.graph.add_edge(left[4], right[4], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(left[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_RANDOM, CONNECTION_ONE_WAY, false),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // Original outbound edges preserved.
    assert!(maze.graph.edge_between(left[0], right[0]).is_some());
    assert!(maze.graph.edge_between(left[4], right[4]).is_some());
    // Missing inbound direction must land on row 2's pair -- maximizing the minimum
    // distance to both occupied pairs (row 0 and row 4), not just the farthest from row 0.
    assert!(
        maze.graph.edge_between(right[2], left[2]).is_some(),
        "must pick row 2, the max-min-distance choice from both occupied pairs"
    );
    assert!(maze.graph.edge_between(right[0], left[0]).is_none());
    assert!(maze.graph.edge_between(right[1], left[1]).is_none());
    assert!(maze.graph.edge_between(right[3], left[3]).is_none());
    assert!(maze.graph.edge_between(right[4], left[4]).is_none());
}

#[test]
fn prefer_partially_connected_picks_partial_neighbor_over_unconnected_one() {
    // Middle region already has a one-way edge to one neighbor; the other neighbor
    // (also eligible, also flagged as needy) has no connection at all. With
    // prefer_partially_connected=true, the partially-connected neighbor must win
    // regardless of target_mode's usual tie-break.
    let (mut maze, nodes) = build_field(5, 1);
    maze.graph
        .add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
    // Pre-existing partial (outbound only) connection from the region-under-test
    // (node[2]) to its left neighbor (node[1]).
    maze.graph.add_edge(nodes[2], nodes[1], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[2])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_LARGEST, CONNECTION_PASSAGE, true),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // Must bridge toward the partially-connected left neighbor, not the larger right one
    // (MODE_LARGEST would otherwise pick nodes[3]/nodes[4]'s 2-cell region).
    assert!(maze.graph.edge_between(nodes[1], nodes[2]).is_some());
    assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_none());
}

#[test]
fn prefer_partially_connected_false_ignores_partial_neighbor_and_falls_back_to_target_mode() {
    // Same fixture as `prefer_partially_connected_picks_partial_neighbor_over_unconnected_one`,
    // but with the preference explicitly turned off -> MODE_LARGEST must win normally and
    // pick the bigger (2-cell) right-hand neighbor, ignoring the left neighbor's partial
    // connection entirely.
    let (mut maze, nodes) = build_field(5, 1);
    maze.graph
        .add_bidirectional_edge(nodes[3], nodes[4], EK::Basic);
    maze.graph.add_edge(nodes[2], nodes[1], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(nodes[2])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_LARGEST, CONNECTION_PASSAGE, false),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge_between(nodes[2], nodes[3]).is_some());
    assert!(
        maze.graph.edge_between(nodes[1], nodes[2]).is_none()
            || maze.graph.edge_between(nodes[2], nodes[1]).is_some()
    );
}

#[test]
fn prefer_partially_connected_applies_to_one_way_mode_too() {
    // 2 rows x 4 cols, three regions by column-pair: left = {col0,col1} (4 cells, larger,
    // unconnected), middle = {col2} (2 cells, region under test), right = {col3} (2 cells,
    // partial neighbor: pre-existing outbound-only edge from middle into it). Both middle's
    // neighbors have 2 bridging cell pairs (one per row), enough for one_way's two-pairs
    // requirement. With prefer_partially_connected=true and MODE_LARGEST, the
    // partially-connected (but smaller) right neighbor must still win over the larger,
    // unconnected left neighbor, and one_way mode completes the missing inbound direction
    // through the *other* row's pair (not the one already carrying the outbound edge).
    let (mut maze, nodes) = build_field(4, 2);
    // all_points sorted by NodeId (creation/row-major order): row0 = nodes[0..4],
    // row1 = nodes[4..8], each row laid out col0..col3.
    let left = [nodes[0], nodes[1], nodes[4], nodes[5]]; // cols 0-1, both rows
    let middle = [nodes[2], nodes[6]]; // col 2, both rows
    let right = [nodes[3], nodes[7]]; // col 3, both rows
    maze.graph
        .add_bidirectional_edge(nodes[0], nodes[1], EK::Basic);
    maze.graph
        .add_bidirectional_edge(nodes[4], nodes[5], EK::Basic);
    maze.graph
        .add_bidirectional_edge(nodes[0], nodes[4], EK::Basic);
    maze.graph
        .add_bidirectional_edge(middle[0], middle[1], EK::Basic);
    maze.graph
        .add_bidirectional_edge(right[0], right[1], EK::Basic);
    // Partial (outbound-only) connection from middle into right, via row 0's pair.
    maze.graph.add_edge(middle[0], right[0], EK::Basic);

    let region_idx = maze
        .analysis
        .scc(&maze.graph)
        .component_of(middle[0])
        .unwrap();
    let issue = issue_for(vec![region_idx]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_LARGEST, CONNECTION_ONE_WAY, true),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // Original outbound edge preserved; must not touch the larger, unconnected left region.
    assert!(maze.graph.edge_between(middle[0], right[0]).is_some());
    assert!(
        left.iter().all(|&l| middle.iter().all(|&m| {
            maze.graph.edge_between(l, m).is_none() && maze.graph.edge_between(m, l).is_none()
        })),
        "must prefer the partially-connected right neighbor over the larger unconnected left one"
    );
    // Missing inbound direction must land on row 1's pair, not duplicate row 0's.
    assert!(maze.graph.edge_between(right[1], middle[1]).is_some());
    assert!(maze.graph.edge_between(right[0], middle[0]).is_none());
}

#[test]
fn mode_prefer_needy_picks_a_flagged_neighbor_in_one_way_mode_too() {
    // 2 rows x 3 cols, three column regions (left/middle/right), each 2 cells (one per
    // row) -> every region has exactly 2 bridging cell pairs to each geometric neighbor,
    // enough for one_way's two-distinct-pairs requirement. Middle (region under test) and
    // its left neighbor are both flagged as undersized (needy); the right neighbor is not.
    // MODE_PREFER_NEEDY + connection_mode=one_way must bridge into the needy left neighbor,
    // building both one-way directions through the left neighbor's two distinct row pairs.
    let (mut maze, nodes) = build_field(3, 2);
    // all_points sorted by NodeId (row-major): row0 = nodes[0..3], row1 = nodes[3..6].
    let left = [nodes[0], nodes[3]];
    let middle = [nodes[1], nodes[4]];
    let right = [nodes[2], nodes[5]];
    maze.graph
        .add_bidirectional_edge(left[0], left[1], EK::Basic);
    maze.graph
        .add_bidirectional_edge(middle[0], middle[1], EK::Basic);
    maze.graph
        .add_bidirectional_edge(right[0], right[1], EK::Basic);

    let scc = maze.analysis.scc(&maze.graph);
    let middle_idx = scc.component_of(middle[0]).unwrap();
    let left_idx = scc.component_of(left[0]).unwrap();
    let issue = issue_for(vec![middle_idx, left_idx]); // right neighbor not flagged
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &ExpandRegionPassageStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params_with(MODE_PREFER_NEEDY, CONNECTION_ONE_WAY, false),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // Must bridge toward the needy left neighbor, never toward the non-needy right one.
    let touches_right = right.iter().any(|&r| {
        middle.iter().any(|&m| {
            maze.graph.edge_between(r, m).is_some() || maze.graph.edge_between(m, r).is_some()
        })
    });
    assert!(
        !touches_right,
        "must not bridge into the non-needy right neighbor"
    );

    let outbound_to_left = left.iter().any(|&l| {
        middle
            .iter()
            .any(|&m| maze.graph.edge_between(m, l).is_some())
    });
    let inbound_from_left = left.iter().any(|&l| {
        middle
            .iter()
            .any(|&m| maze.graph.edge_between(l, m).is_some())
    });
    assert!(
        outbound_to_left && inbound_from_left,
        "one_way must build both directions toward the needy left neighbor"
    );
}
