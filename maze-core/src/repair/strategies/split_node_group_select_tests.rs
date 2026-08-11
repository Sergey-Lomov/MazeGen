use super::*;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::EdgeKind;
use crate::{Graph, IdGenerator};
use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
use crate::repair::strategies::RemoveSplitNodeStrategy;
use crate::repair::strategies::test_utils::apply_and_commit;

fn no_params() -> StrategyParams {
    crate::repair::params::build_params(<SplitNodeGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidSplitNodeGroupIssue>>::params(&SplitNodeGroupSelectStrategy), None)
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = std::collections::HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    crate::repair::params::build_params(<SplitNodeGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidSplitNodeGroupIssue>>::params(&SplitNodeGroupSelectStrategy), Some(&map))
}

fn fix_target_nested<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(RemoveSplitNodeStrategy),
        param_overrides: std::collections::HashMap::new(),
        nested: vec![],
    }]
}

fn group_issue(groups: Vec<(Vec<NodeId>, u32)>) -> InvalidSplitNodeGroupIssue {
    InvalidSplitNodeGroupIssue::new_from_check("max_split_tile_node_count", groups)
}

/// A 3-node split tile (slot0 + two extras), no outside connections needed for these tests.
fn maze_with_three_node_split() -> (Maze<SquareTessellation>, NodeId, NodeId, NodeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(field_level, p).unwrap();
    let extra1 = field.add_node_at(field_level, p, &mut ids);
    let extra2 = field.add_node_at(field_level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    (Maze::new(field, g), slot0, extra1, extra2)
}

#[test]
fn apply_succeeds_on_empty_groups() {
    let (mut maze, ..) = maze_with_three_node_split();
    let issue = group_issue(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_succeeds_when_nested_is_empty_and_groups_are_also_empty() {
    let (mut maze, ..) = maze_with_three_node_split();
    let issue = group_issue(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_fails_when_nested_is_empty() {
    let (mut maze, slot0, extra1, extra2) = maze_with_three_node_split();
    let issue = group_issue(vec![(vec![slot0, extra1, extra2], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn selects_slot0_when_it_is_the_only_offered_candidate_and_a_sibling_remains() {
    // Slot-0 is no longer special: with siblings still at the point (not offered as candidates
    // here, but still present in the field), slot0 isn't the point's last remaining node, so it's
    // just as removable as any other split node.
    let (mut maze, slot0, extra1, extra2) = maze_with_three_node_split();
    let issue = group_issue(vec![(vec![slot0], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.field.point_of(slot0).is_none(), "slot0 must be removed since it isn't the point's last remaining node");
    assert!(maze.field.point_of(extra1).is_some());
    assert!(maze.field.point_of(extra2).is_some());
}

#[test]
fn removes_exactly_one_node_of_the_group() {
    let (mut maze, slot0, extra1, extra2) = maze_with_three_node_split();
    let issue = group_issue(vec![(vec![slot0, extra1, extra2], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let removed_count = [slot0, extra1, extra2].iter().filter(|&&n| maze.field.point_of(n).is_none()).count();
    assert_eq!(removed_count, 1, "to_remove=1 must remove exactly one node");
}

#[test]
fn apply_fixes_to_remove_multiple_nodes_from_a_single_group_in_one_call() {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(field_level, p).unwrap();
    let extra1 = field.add_node_at(field_level, p, &mut ids);
    let extra2 = field.add_node_at(field_level, p, &mut ids);
    let extra3 = field.add_node_at(field_level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let mut maze = Maze::new(field, g);

    let issue = group_issue(vec![(vec![slot0, extra1, extra2, extra3], 2)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let removed_count = [extra1, extra2, extra3].iter().filter(|&&n| maze.field.point_of(n).is_none()).count();
    assert_eq!(removed_count, 2, "to_remove=2 must remove exactly 2 nodes of the group in one apply() call");
    assert!(maze.field.point_of(slot0).is_some());
}

#[test]
fn selection_most_connected_picks_the_more_connected_extra_node() {
    let (mut maze, _slot0, extra1, extra2) = maze_with_three_node_split();
    let far = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
    maze.graph.add_edge(extra1, far, EdgeKind::Basic);

    let issue = group_issue(vec![(vec![extra1, extra2], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_SELECTION, SELECTION_MOST_CONNECTED)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.field.point_of(extra1).is_none(), "extra1 (higher degree) must be picked under most_connected");
    assert!(maze.field.point_of(extra2).is_some());
}

#[test]
fn selection_least_connected_picks_the_less_connected_extra_node() {
    let (mut maze, _slot0, extra1, extra2) = maze_with_three_node_split();
    let far = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
    maze.graph.add_edge(extra1, far, EdgeKind::Basic);

    let issue = group_issue(vec![(vec![extra1, extra2], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_SELECTION, SELECTION_LEAST_CONNECTED)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.field.point_of(extra2).is_none(), "extra2 (lower degree) must be picked under least_connected");
    assert!(maze.field.point_of(extra1).is_some());
}

#[test]
fn preset_protected_candidate_is_excluded_and_group_reports_failed() {
    let (mut maze, _slot0, extra1, _extra2) = maze_with_three_node_split();
    let far = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
    maze.graph.add_edge(extra1, far, EdgeKind::Basic);
    let mut preset = PresetState::empty();
    preset.preset_edges.insert((extra1, far));

    let issue = group_issue(vec![(vec![extra1], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &no_params(), &preset, &nested);
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.field.point_of(extra1).is_some(), "preset-protected node must survive");
}

#[test]
fn partially_preset_protected_group_removes_only_the_unprotected_candidate() {
    let (mut maze, _slot0, extra1, extra2) = maze_with_three_node_split();
    let far = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
    maze.graph.add_edge(extra1, far, EdgeKind::Basic);
    let mut preset = PresetState::empty();
    preset.preset_edges.insert((extra1, far));

    let issue = group_issue(vec![(vec![extra1, extra2], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &no_params(), &preset, &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.field.point_of(extra1).is_some(), "preset-protected node must survive");
    assert!(maze.field.point_of(extra2).is_none(), "unprotected node must be the one removed");
}
