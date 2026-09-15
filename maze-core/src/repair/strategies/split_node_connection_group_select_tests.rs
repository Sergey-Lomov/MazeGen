use super::*;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::EdgeKind;
use crate::{Graph, IdGenerator};
use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
use crate::meta::MazeMeta;
use crate::repair::strategies::RemoveSplitNodeConnectionStrategy;
use crate::repair::strategies::test_utils::apply_and_commit;

fn no_params() -> StrategyParams {
    crate::repair::params::build_params(<SplitNodeConnectionGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidSplitNodeConnectionGroupIssue>>::params(&SplitNodeConnectionGroupSelectStrategy), None)
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = std::collections::HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    crate::repair::params::build_params(<SplitNodeConnectionGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidSplitNodeConnectionGroupIssue>>::params(&SplitNodeConnectionGroupSelectStrategy), Some(&map))
}

fn fix_target_nested<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(RemoveSplitNodeConnectionStrategy),
        param_overrides: std::collections::HashMap::new(),
        nested: vec![],
    }]
}

fn group_issue(groups: Vec<(Vec<EdgeId>, u32)>) -> InvalidSplitNodeConnectionGroupIssue {
    InvalidSplitNodeConnectionGroupIssue::new_from_check("split_node_connection_per_neighbor", groups)
}

/// A split point (slot0 + extra) both connected out to the same outside neighbor `left`.
fn maze_with_split_converging_on_one_neighbor() -> (Maze<SquareTessellation>, crate::ids::NodeId, crate::ids::NodeId, EdgeId, EdgeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(field_level, p).unwrap();
    let extra = field.add_node_at(field_level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let left = field.node_at(field_level, SquarePoint { x: 0, y: 0 }).unwrap();
    let e_slot0 = g.add_edge(slot0, left, EdgeKind::Basic);
    let e_extra = g.add_edge(extra, left, EdgeKind::Basic);
    (Maze::new(field, g), slot0, extra, e_slot0, e_extra)
}

#[test]
fn apply_succeeds_on_empty_groups() {
    let (mut maze, ..) = maze_with_split_converging_on_one_neighbor();
    let issue = group_issue(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_succeeds_when_nested_is_empty_and_groups_are_also_empty() {
    // Distinct from apply_succeeds_on_empty_groups (which has a nested strategy configured) and
    // apply_fails_when_nested_is_empty (which has groups to fix) -- when there is nothing to fix
    // AND no nested strategy configured, there is still nothing to fail on, so this must report
    // Fixed rather than Failed.
    let (mut maze, ..) = maze_with_split_converging_on_one_neighbor();
    let issue = group_issue(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_fails_when_nested_is_empty() {
    let (mut maze, _slot0, _extra, e_slot0, e_extra) = maze_with_split_converging_on_one_neighbor();
    let issue = group_issue(vec![(vec![e_slot0, e_extra], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn protect_original_excludes_slot0s_own_connection_from_removal() {
    let (mut maze, slot0, _extra, e_slot0, e_extra) = maze_with_split_converging_on_one_neighbor();
    let issue = group_issue(vec![(vec![e_slot0, e_extra], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PROTECT_ORIGINAL, "true")]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(e_slot0).is_some(), "slot0's own connection must survive when protect_original is enabled");
    assert!(maze.graph.edge(e_extra).is_none(), "extra's connection must be the one removed");
    let _ = slot0;
}

#[test]
fn protect_original_disabled_allows_slot0s_connection_to_be_picked() {
    let (mut maze, _slot0, _extra, e_slot0, _e_extra) = maze_with_split_converging_on_one_neighbor();
    // Only slot0's own edge is offered -- with protect_original disabled it must be a legitimate
    // candidate.
    let issue = group_issue(vec![(vec![e_slot0], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PROTECT_ORIGINAL, "false")]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edge(e_slot0).is_none(), "slot0's connection must be removable when protect_original is disabled");
}

#[test]
fn protect_original_only_group_reports_failed() {
    // Only slot0's own edge is offered, and protect_original is enabled -- nothing can be fixed.
    let (mut maze, _slot0, _extra, e_slot0, _e_extra) = maze_with_split_converging_on_one_neighbor();
    let issue = group_issue(vec![(vec![e_slot0], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PROTECT_ORIGINAL, "true")]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Failed));
    assert!(maze.graph.edge(e_slot0).is_some());
}

#[test]
fn protect_route_excludes_a_route_critical_connection() {
    let (mut maze, slot0, _extra, e_slot0, e_extra) = maze_with_split_converging_on_one_neighbor();
    let left = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
    maze.meta = MazeMeta { start: Some(slot0), finish: Some(left) };

    let issue = group_issue(vec![(vec![e_slot0, e_extra], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PROTECT_ORIGINAL, "false"), (PARAM_PROTECT_ROUTE, "true")]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(e_slot0).is_some(), "route-critical slot0->left must survive when protect_route is enabled");
    assert!(maze.graph.edge(e_extra).is_none(), "non-route extra->left must be removed instead");
}

#[test]
fn selection_most_connected_picks_the_edge_from_the_more_connected_origin_node() {
    // extra has an extra edge to a third, unrelated neighbor on top of its outside connection
    // (not part of the group), giving it strictly higher total degree than slot0 -- most_connected
    // must pick extra's own outside connection from the group.
    let (mut maze, _slot0, extra, e_slot0, e_extra) = maze_with_split_converging_on_one_neighbor();
    let far = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
    maze.graph.add_edge(extra, far, EdgeKind::Basic);

    let issue = group_issue(vec![(vec![e_slot0, e_extra], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PROTECT_ORIGINAL, "false"), (PARAM_SELECTION, SELECTION_MOST_CONNECTED)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(e_extra).is_none(), "extra (higher degree) must be picked under most_connected");
    assert!(maze.graph.edge(e_slot0).is_some());
}

#[test]
fn selection_least_connected_picks_the_edge_from_the_less_connected_origin_node() {
    let (mut maze, _slot0, extra, e_slot0, e_extra) = maze_with_split_converging_on_one_neighbor();
    let far = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
    maze.graph.add_edge(extra, far, EdgeKind::Basic);

    let issue = group_issue(vec![(vec![e_slot0, e_extra], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PROTECT_ORIGINAL, "false"), (PARAM_SELECTION, SELECTION_LEAST_CONNECTED)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(e_slot0).is_none(), "slot0 (lower degree) must be picked under least_connected");
    assert!(maze.graph.edge(e_extra).is_some());
}

#[test]
fn preset_protected_candidate_is_excluded_and_group_reports_failed() {
    // Both candidates are preset-locked (both directions) -- nothing in the group is actually
    // removable, so the strategy must report Failed instead of falsely resolving the group's
    // budget and leaving the graph unchanged (GitHub issue #251 bug report: this used to loop
    // the repair fixpoint to its limit on a preset-locked split).
    let (mut maze, slot0, extra, e_slot0, e_extra) = maze_with_split_converging_on_one_neighbor();
    let left = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
    let mut preset = PresetState::empty();
    preset.preset_edges.insert((slot0, left));
    preset.preset_edges.insert((extra, left));

    let issue = group_issue(vec![(vec![e_slot0, e_extra], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PROTECT_ORIGINAL, "false")]), &preset, &nested);
    assert!(matches!(result, RepairResult::Failed));

    assert!(maze.graph.edge(e_slot0).is_some(), "preset-protected edge must survive");
    assert!(maze.graph.edge(e_extra).is_some(), "preset-protected edge must survive");
}

#[test]
fn partially_preset_protected_group_removes_only_the_unprotected_candidate() {
    // slot0's connection is preset-locked, extra's is not -- the strategy must pick extra and
    // still report Fixed, never offering the preset-locked slot0 edge as a candidate.
    let (mut maze, slot0, _extra, e_slot0, e_extra) = maze_with_split_converging_on_one_neighbor();
    let left = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).unwrap();
    let mut preset = PresetState::empty();
    preset.preset_edges.insert((slot0, left));

    let issue = group_issue(vec![(vec![e_slot0, e_extra], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PROTECT_ORIGINAL, "false")]), &preset, &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(e_slot0).is_some(), "preset-protected edge must survive");
    assert!(maze.graph.edge(e_extra).is_none(), "unprotected edge must be the one removed");
}

#[test]
fn apply_fixes_to_remove_edges_from_a_single_group_in_one_call() {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
    let p = SquarePoint { x: 5, y: 0 };
    let slot0 = field.node_at(field_level, p).unwrap();
    let extra1 = field.add_node_at(field_level, p, &mut ids);
    let extra2 = field.add_node_at(field_level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let neighbor = field.node_at(field_level, SquarePoint { x: 4, y: 0 }).unwrap();
    let e1 = g.add_edge(slot0, neighbor, EdgeKind::Basic);
    let e2 = g.add_edge(extra1, neighbor, EdgeKind::Basic);
    let e3 = g.add_edge(extra2, neighbor, EdgeKind::Basic);
    let mut maze = Maze::new(field, g);

    let issue = group_issue(vec![(vec![e1, e2, e3], 2)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&SplitNodeConnectionGroupSelectStrategy, &issue, &mut maze,
        &mut rng, &params_with(&[(PARAM_PROTECT_ORIGINAL, "false")]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let removed_count = [e1, e2, e3].iter().filter(|&&id| maze.graph.edge(id).is_none()).count();
    assert_eq!(removed_count, 2, "to_remove=2 must fix exactly 2 edges of the group in one apply() call");
}
