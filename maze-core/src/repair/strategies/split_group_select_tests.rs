use super::*;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::{Graph, IdGenerator};
use crate::space::{SquareTessellation, SquarePoint, square_rect};
use crate::repair::strategies::RemoveSplitStrategy;
use crate::repair::strategies::test_utils::apply_and_commit;

fn no_params() -> StrategyParams {
    crate::repair::params::build_params(<SplitGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidSplitTileGroupIssue>>::params(&SplitGroupSelectStrategy), None)
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = std::collections::HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    crate::repair::params::build_params(<SplitGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidSplitTileGroupIssue>>::params(&SplitGroupSelectStrategy), Some(&map))
}

fn fix_target_nested<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(RemoveSplitStrategy),
        param_overrides: std::collections::HashMap::new(),
        nested: vec![],
    }]
}

/// Two split tiles (extra node each) on a 3-node row.
fn maze_with_two_split_tiles() -> (Maze<SquareTessellation>, NodeId, NodeId) {
    let mut ids = IdGenerator::new();
    let mut field: crate::space::Field<SquareTessellation> = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
    let extra1 = field.add_node_at(SquarePoint { x: 0, y: 0 }, &mut ids);
    let extra2 = field.add_node_at(SquarePoint { x: 2, y: 0 }, &mut ids);
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    (Maze::new(field, g), extra1, extra2)
}

fn tile(nodes: Vec<NodeId>) -> SplitTileNodes {
    SplitTileNodes::new(nodes)
}

fn group_issue(groups: Vec<(Vec<SplitTileNodes>, u32)>) -> InvalidSplitTileGroupIssue {
    InvalidSplitTileGroupIssue::new_from_check("split_group_geometric_proximity", groups)
}

#[test]
fn apply_succeeds_on_empty_groups() {
    let (mut maze, _, _) = maze_with_two_split_tiles();
    let issue = group_issue(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_succeeds_on_empty_groups_even_with_no_nested_configured() {
    // Nothing to fix -- an empty issue must report Fixed regardless of whether a nested
    // fix_target strategy is even configured, since group_select_apply is never reached.
    let (mut maze, _, _) = maze_with_two_split_tiles();
    let issue = group_issue(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_fails_when_nested_is_empty() {
    let (mut maze, extra1, extra2) = maze_with_two_split_tiles();
    let issue = group_issue(vec![(vec![tile(vec![extra1]), tile(vec![extra2])], 2)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_removes_both_tiles_when_to_remove_covers_the_whole_group() {
    let (mut maze, extra1, extra2) = maze_with_two_split_tiles();
    let issue = group_issue(vec![(vec![tile(vec![extra1]), tile(vec![extra2])], 2)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.field.point_of(extra1).is_none(), "both tiles must be collapsed");
    assert!(maze.field.point_of(extra2).is_none());
}

#[test]
fn apply_stops_once_to_remove_is_reached() {
    let (mut maze, extra1, extra2) = maze_with_two_split_tiles();
    let issue = group_issue(vec![(vec![tile(vec![extra1]), tile(vec![extra2])], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let removed_count = [extra1, extra2].iter().filter(|&&n| maze.field.point_of(n).is_none()).count();
    assert_eq!(removed_count, 1, "only to_remove=1 tile must be collapsed, the other tile left untouched");
}

#[test]
fn apply_never_removes_slot0_even_if_flagged() {
    let (mut maze, extra1, _extra2) = maze_with_two_split_tiles();
    let slot0 = maze.field.nodes_at(SquarePoint { x: 0, y: 0 })[0];
    let issue = group_issue(vec![(vec![tile(vec![slot0, extra1])], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);

    assert!(maze.field.point_of(slot0).is_some(), "slot-0 must never be removed");
}

/// Two split points: `small` carries 1 extra node (2 nodes total), `big` carries 2 extra nodes
/// (3 nodes total) -- `big`'s `SplitTileNodes` is strictly more voluminous.
fn maze_with_a_small_and_a_big_split_tile() -> (Maze<SquareTessellation>, SplitTileNodes, SplitTileNodes) {
    let mut ids = IdGenerator::new();
    let mut field: crate::space::Field<SquareTessellation> = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
    field.add_node_at(SquarePoint { x: 0, y: 0 }, &mut ids);
    field.add_node_at(SquarePoint { x: 2, y: 0 }, &mut ids);
    field.add_node_at(SquarePoint { x: 2, y: 0 }, &mut ids);
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let small = SplitTileNodes::new(field.nodes_at(SquarePoint { x: 0, y: 0 }).to_vec());
    let big = SplitTileNodes::new(field.nodes_at(SquarePoint { x: 2, y: 0 }).to_vec());
    (Maze::new(field, g), small, big)
}

/// Whether every *extra* node of `tile` (slot-0 excluded -- it's never removed) is gone.
fn tile_collapsed(maze: &Maze<SquareTessellation>, tile: &SplitTileNodes) -> bool {
    tile.0.iter().skip(1).all(|&n| maze.field.point_of(n).is_none())
}

/// Whether every *extra* node of `tile` still exists (nothing was touched).
fn tile_untouched(maze: &Maze<SquareTessellation>, tile: &SplitTileNodes) -> bool {
    tile.0.iter().skip(1).all(|&n| maze.field.point_of(n).is_some())
}

#[test]
fn most_voluminous_priority_picks_the_bigger_tile() {
    let (mut maze, small, big) = maze_with_a_small_and_a_big_split_tile();
    let issue = group_issue(vec![(vec![small.clone(), big.clone()], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_MOST_VOLUMINOUS)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(tile_collapsed(&maze, &big), "the bigger tile must be collapsed");
    assert!(tile_untouched(&maze, &small), "the smaller tile must survive");
}

#[test]
fn least_voluminous_priority_picks_the_smaller_tile() {
    let (mut maze, small, big) = maze_with_a_small_and_a_big_split_tile();
    let issue = group_issue(vec![(vec![small.clone(), big.clone()], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_LEAST_VOLUMINOUS)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(tile_collapsed(&maze, &small), "the smaller tile must be collapsed");
    assert!(tile_untouched(&maze, &big), "the bigger tile must survive");
}

/// Two single-extra-node split points: `hub`'s slot-0 carries an extra edge to a third node,
/// `plain`'s does not -- `hub`'s tile is strictly more connected.
fn maze_with_a_plain_and_a_hub_split_tile() -> (Maze<SquareTessellation>, SplitTileNodes, SplitTileNodes) {
    let mut ids = IdGenerator::new();
    let mut field: crate::space::Field<SquareTessellation> = crate::space::Field::new(square_rect(4, 1), &mut ids).unwrap();
    field.add_node_at(SquarePoint { x: 0, y: 0 }, &mut ids);
    field.add_node_at(SquarePoint { x: 2, y: 0 }, &mut ids);
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let hub_slot0 = field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
    let far = field.node_at(SquarePoint { x: 3, y: 0 }).unwrap();
    g.add_bidirectional_edge(hub_slot0, far, EdgeKind::Basic);
    let plain = SplitTileNodes::new(field.nodes_at(SquarePoint { x: 0, y: 0 }).to_vec());
    let hub = SplitTileNodes::new(field.nodes_at(SquarePoint { x: 2, y: 0 }).to_vec());
    (Maze::new(field, g), plain, hub)
}

#[test]
fn most_connected_priority_picks_the_more_connected_tile() {
    let (mut maze, plain, hub) = maze_with_a_plain_and_a_hub_split_tile();
    let issue = group_issue(vec![(vec![plain.clone(), hub.clone()], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_MOST_CONNECTED)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(tile_collapsed(&maze, &hub), "the more-connected tile must be collapsed");
    assert!(tile_untouched(&maze, &plain), "the less-connected tile must survive");
}

#[test]
fn least_connected_priority_picks_the_less_connected_tile() {
    let (mut maze, plain, hub) = maze_with_a_plain_and_a_hub_split_tile();
    let issue = group_issue(vec![(vec![plain.clone(), hub.clone()], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_LEAST_CONNECTED)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(tile_collapsed(&maze, &plain), "the less-connected tile must be collapsed");
    assert!(tile_untouched(&maze, &hub), "the more-connected tile must survive");
}

#[test]
fn random_priority_still_resolves_the_group() {
    let (mut maze, extra1, extra2) = maze_with_two_split_tiles();
    let issue = group_issue(vec![(vec![tile(vec![extra1]), tile(vec![extra2])], 2)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.field.point_of(extra1).is_none());
    assert!(maze.field.point_of(extra2).is_none());
}
