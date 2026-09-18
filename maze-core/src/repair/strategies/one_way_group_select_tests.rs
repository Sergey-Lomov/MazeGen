use super::*;
use crate::graph::EdgeKind;
use crate::meta::MazeMeta;
use crate::random::MazeRng;
use crate::repair::strategies::group_select::PRIORITY_RANDOM;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::repair::strategies::{OneWayToPassageStrategy, OneWayToWallStrategy};
use crate::space::{SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;

fn strategy(protect_route: bool) -> OneWayGroupSelectStrategy {
    OneWayGroupSelectStrategy { protect_route }
}

fn no_params() -> StrategyParams {
    crate::repair::params::build_params(
        <OneWayGroupSelectStrategy as RepairStrategy<
            SquareTessellation,
            InvalidOneWayGroupIssue,
        >>::params(&strategy(true)),
        None,
    )
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = std::collections::HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    crate::repair::params::build_params(
        <OneWayGroupSelectStrategy as RepairStrategy<
            SquareTessellation,
            InvalidOneWayGroupIssue,
        >>::params(&strategy(true)),
        Some(&map),
    )
}

fn fix_target_nested<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(OneWayToWallStrategy),
        param_overrides: std::collections::HashMap::new(),
        nested: vec![],
    }]
}

fn fix_target_nested_passage<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(OneWayToPassageStrategy),
        param_overrides: std::collections::HashMap::new(),
        nested: vec![],
    }]
}

/// Two disjoint one-way edges on a 4-node row: 0->1 and 2->3.
fn maze_with_two_one_ways() -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    let mut ids = IdGenerator::new();
    let field = square_rect(4, 1);
    let field = crate::space::MultiLevelField::single_level(field, &mut ids).unwrap();
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
    let e1 = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e2 = g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
    (Maze::new(field, g), e1, e2)
}

/// Builds an issue where every group defaults to `to_remove: 1` -- matches the proximity checks'
/// own shape, the case most of this file's tests exercise. Use `group_issue_with_counts` when a
/// test needs an explicit per-group budget (e.g. testing a super-hub-style excess > 1).
fn group_issue(groups: Vec<Vec<EdgeId>>) -> InvalidOneWayGroupIssue {
    let groups = groups.into_iter().map(|g| (g, 1)).collect();
    InvalidOneWayGroupIssue::new_from_check("one_way_group_geometric_proximity", groups)
}

fn group_issue_with_counts(groups: Vec<(Vec<EdgeId>, u32)>) -> InvalidOneWayGroupIssue {
    InvalidOneWayGroupIssue::new_from_check("one_way_group_super_hub", groups)
}

#[test]
fn apply_succeeds_on_empty_groups() {
    let (mut maze, _, _) = maze_with_two_one_ways();
    let issue = group_issue(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_fails_when_nested_is_empty() {
    let (mut maze, e1, e2) = maze_with_two_one_ways();
    let issue = group_issue(vec![vec![e1, e2]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_removes_exactly_one_edge_from_the_pair() {
    let (mut maze, e1, e2) = maze_with_two_one_ways();
    let issue = group_issue(vec![vec![e1, e2]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let e1_alive = maze.graph.edge(e1).is_some();
    let e2_alive = maze.graph.edge(e2).is_some();
    assert!(
        e1_alive != e2_alive,
        "exactly one edge of the pair must be removed, the other must survive"
    );
}

#[test]
fn apply_fixes_exactly_one_edge_from_a_group_larger_than_two() {
    // A 5-edge group (e.g. from OneWayGroupSuperHubCheck on a vertex with 5 incident one-ways
    // and a lower max_connections) -- the strategy is documented as handling any group size, but
    // still picks exactly one edge to fix per apply() call, leaving the rest of the group
    // untouched (full resolution of a large group takes multiple fixpoint iterations, one fix
    // per call -- see GitHub issue #200's follow-up review).
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(square_rect(11, 1), &mut ids).unwrap();
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
    let edges: Vec<EdgeId> = (0..5)
        .map(|i| g.add_edge(nodes[i * 2], nodes[i * 2 + 1], EdgeKind::Basic))
        .collect();
    let mut maze = Maze::new(field, g);

    let issue = group_issue(vec![edges.clone()]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let removed_count = edges
        .iter()
        .filter(|&&id| maze.graph.edge(id).is_none())
        .count();
    assert_eq!(
        removed_count, 1,
        "exactly one edge of a 5-edge group must be fixed per apply() call, the other 4 must survive untouched"
    );
}

#[test]
fn apply_fixes_to_remove_edges_from_a_single_group_in_one_call() {
    // Same 5-edge group as above, but to_remove=3 (e.g. from MaxOneWayCountCheck reporting the
    // whole maze's one-way set with a larger excess, or OneWayGroupSuperHubCheck's own excess
    // count) -- GitHub issue #202 follow-up: a single apply() call must fix `to_remove` edges out
    // of the group, not just one, so a large excess converges without needing one repair
    // iteration per excess edge.
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(square_rect(11, 1), &mut ids).unwrap();
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
    let edges: Vec<EdgeId> = (0..5)
        .map(|i| g.add_edge(nodes[i * 2], nodes[i * 2 + 1], EdgeKind::Basic))
        .collect();
    let mut maze = Maze::new(field, g);

    let issue = group_issue_with_counts(vec![(edges.clone(), 3)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let removed_count = edges
        .iter()
        .filter(|&&id| maze.graph.edge(id).is_none())
        .count();
    assert_eq!(
        removed_count, 3,
        "to_remove=3 must fix exactly 3 edges of the group in one apply() call"
    );
}

#[test]
fn apply_stops_once_to_remove_is_reached_even_with_more_candidates_left() {
    // to_remove=2 on a 5-edge group -- exactly 2 must be fixed, the remaining 3 left untouched
    // (as opposed to draining the whole group).
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(square_rect(11, 1), &mut ids).unwrap();
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
    let edges: Vec<EdgeId> = (0..5)
        .map(|i| g.add_edge(nodes[i * 2], nodes[i * 2 + 1], EdgeKind::Basic))
        .collect();
    let mut maze = Maze::new(field, g);

    let issue = group_issue_with_counts(vec![(edges.clone(), 2)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let removed_count = edges
        .iter()
        .filter(|&&id| maze.graph.edge(id).is_none())
        .count();
    assert_eq!(
        removed_count, 2,
        "exactly to_remove=2 edges must be fixed, the rest of the group left alone"
    );
}

#[test]
fn apply_fixes_a_shared_edge_once_but_decrements_to_remove_in_every_group_it_appears_in() {
    // e_shared is a candidate in both groups. Fixing it once must retire one unit of budget from
    // *each* group that had it as a candidate (GitHub issue #202 follow-up) -- group A's
    // to_remove drops 2->1 (still needs e_a), group B's to_remove drops 1->0 (fully resolved by
    // e_shared alone, e_b survives untouched).
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
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
    let e_shared = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e_a = g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
    let e_b = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let mut maze = Maze::new(field, g);

    let issue = group_issue_with_counts(vec![(vec![e_shared, e_a], 2), (vec![e_shared, e_b], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(
        maze.graph.edge(e_shared).is_none(),
        "e_shared (highest membership) must be picked and fixed first"
    );
    assert!(
        maze.graph.edge(e_a).is_none(),
        "group A still needed 1 more after e_shared -- e_a must be fixed too"
    );
    assert!(
        maze.graph.edge(e_b).is_some(),
        "group B was fully resolved by e_shared alone -- e_b must survive"
    );
}

#[test]
fn problematic_priority_favors_highest_membership_edge_even_when_its_group_is_not_first() {
    // e_shared appears in groups[1] and groups[2] (membership 2); e_solo appears only in
    // groups[0] (membership 1) and is listed first. GitHub issue #202 follow-up: candidate
    // selection is now a single global pass ordered by membership, not a per-group scan in
    // issue.groups order -- e_shared must still be picked first despite its groups not being
    // first in the list.
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(square_rect(8, 1), &mut ids).unwrap();
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
    let e_solo = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e_shared = g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
    let e_x = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let e_y = g.add_edge(nodes[6], nodes[7], EdgeKind::Basic);
    let mut maze = Maze::new(field, g);

    let issue = group_issue_with_counts(vec![
        (vec![e_solo], 1),
        (vec![e_shared, e_x], 1),
        (vec![e_shared, e_y], 1),
    ]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(
        maze.graph.edge(e_shared).is_none(),
        "e_shared (membership 2, in groups 1 and 2) must be picked before e_solo (membership 1, in group 0) despite group 0 being listed first"
    );
    assert!(
        maze.graph.edge(e_x).is_some(),
        "group 1 is fully resolved by e_shared alone -- e_x must survive"
    );
    assert!(
        maze.graph.edge(e_y).is_some(),
        "group 2 is fully resolved by e_shared alone -- e_y must survive"
    );
}

#[test]
fn apply_with_passage_nested_converts_target_to_bidirectional_instead_of_removing() {
    // OneWayToPassageStrategy's commands are AddBidirectionalEdge, not a remove command --
    // removed_edge_ids(nested_commands) is empty for this path (see issue #199 follow-up
    // review). The picked edge's own EdgeId must still be tracked as resolved via the direct
    // `resolved.insert(target)`, not via `removed`, so both edges must survive as live ids and
    // exactly the target direction gets its reverse added.
    let (mut maze, e1, e2) = maze_with_two_one_ways();
    let issue = group_issue(vec![vec![e1, e2]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested_passage();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(
        maze.graph.edge(e1).is_some(),
        "e1 must still exist -- passage strategy converts, never removes"
    );
    assert!(
        maze.graph.edge(e2).is_some(),
        "e2 must still exist -- passage strategy converts, never removes"
    );
    let e1_edge = maze.graph.edge(e1).unwrap();
    let e2_edge = maze.graph.edge(e2).unwrap();
    let e1_reversed = maze.graph.edge_between(e1_edge.to, e1_edge.from).is_some();
    let e2_reversed = maze.graph.edge_between(e2_edge.to, e2_edge.from).is_some();
    assert!(
        e1_reversed != e2_reversed,
        "exactly one of the two must have gained a reverse direction"
    );
}

#[test]
fn apply_with_passage_nested_resolves_a_shared_edge_across_two_groups_without_a_second_fix() {
    // Same shared-edge scenario as `resolving_shared_edge_drops_the_other_group_without_a_second_fix`,
    // but with the passage nested strategy -- confirms `resolved.insert(target)` alone (not
    // `removed_edge_ids`) is what prevents e_shared's second group from being offered to the
    // nested strategy again.
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
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
    let e_shared = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e_a = g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
    let e_b = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let mut maze = Maze::new(field, g);

    let issue = group_issue(vec![vec![e_shared, e_a], vec![e_shared, e_b]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested_passage();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // Only e_shared should have gained a reverse direction -- e_a/e_b must stay pure one-ways,
    // since resolving e_shared's first group must drop its second group from the queue.
    let shared_edge = maze.graph.edge(e_shared).unwrap();
    assert!(
        maze.graph
            .edge_between(shared_edge.to, shared_edge.from)
            .is_some(),
        "e_shared must have been converted"
    );
    let a_edge = maze.graph.edge(e_a).unwrap();
    let b_edge = maze.graph.edge(e_b).unwrap();
    assert!(
        maze.graph.edge_between(a_edge.to, a_edge.from).is_none(),
        "e_a must remain untouched -- its group was already resolved via e_shared"
    );
    assert!(
        maze.graph.edge_between(b_edge.to, b_edge.from).is_none(),
        "e_b must remain untouched -- its group was already resolved via e_shared"
    );
}

#[test]
fn problematic_priority_picks_the_edge_in_more_groups() {
    // e_shared appears in two groups, e_a and e_b appear in one each -- problematic priority
    // must pick e_shared, since its membership count (2) strictly dominates e_a/e_b (1 each).
    // A single seed suffices: this scenario's max-membership edge is unique, so the shuffle's
    // random tie-break is never actually exercised regardless of seed.
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
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
    let e_shared = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e_a = g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
    let e_b = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let mut maze = Maze::new(field, g);

    let issue = group_issue(vec![vec![e_shared, e_a], vec![e_shared, e_b]]);
    let nested = fix_target_nested();
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(
        maze.graph.edge(e_shared).is_none(),
        "e_shared (member of both groups) must always be removed under problematic priority"
    );
    assert!(
        maze.graph.edge(e_a).is_some(),
        "e_a must survive -- dropping e_shared already resolves its group"
    );
    assert!(
        maze.graph.edge(e_b).is_some(),
        "e_b must survive -- dropping e_shared already resolves its group"
    );
}

#[test]
fn random_priority_picks_some_edge_from_the_pair() {
    let (mut maze, e1, e2) = maze_with_two_one_ways();
    let issue = group_issue(vec![vec![e1, e2]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let e1_alive = maze.graph.edge(e1).is_some();
    let e2_alive = maze.graph.edge(e2).is_some();
    assert!(
        e1_alive != e2_alive,
        "random priority must still remove exactly one edge of the pair"
    );
}

#[test]
fn protect_route_disabled_allows_a_route_critical_edge_to_be_picked() {
    let (mut maze, e1, _e2) = maze_with_two_one_ways();
    let nodes: Vec<_> = maze
        .field
        .field_of(maze.field.single_level_id())
        .unwrap()
        .all_points()
        .map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap())
        .collect();
    // e1 (0->1) sits on the only route -- with protect_route disabled it's a legitimate
    // candidate again, unlike `protect_route_falls_back_to_the_other_side_of_the_pair`.
    maze.meta = MazeMeta {
        start: Some(nodes[0]),
        finish: Some(nodes[1]),
    };

    let issue = group_issue(vec![vec![e1]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(false),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(
        maze.graph.edge(e1).is_none(),
        "route-critical e1 must be removable when protect_route is disabled"
    );
}

#[test]
fn resolving_shared_edge_drops_the_other_group_without_a_second_fix() {
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
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
    let e_shared = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e_a = g.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
    let e_b = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let mut maze = Maze::new(field, g);

    let issue = group_issue(vec![vec![e_shared, e_a], vec![e_shared, e_b]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // Only one edge total should have been removed (e_shared) -- e_a and e_b both survive since
    // dropping e_shared already resolves both groups.
    let removed_count = [e_shared, e_a, e_b]
        .iter()
        .filter(|&&id| maze.graph.edge(id).is_none())
        .count();
    assert_eq!(
        removed_count, 1,
        "removing the shared edge must resolve both groups without a second fix"
    );
}

#[test]
fn protect_route_falls_back_to_the_other_side_of_the_pair() {
    let (mut maze, e1, e2) = maze_with_two_one_ways();
    let nodes: Vec<_> = maze
        .field
        .field_of(maze.field.single_level_id())
        .unwrap()
        .all_points()
        .map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap())
        .collect();
    // e1 (0->1) sits on the route; e2 (2->3) does not (disconnected).
    maze.meta = MazeMeta {
        start: Some(nodes[0]),
        finish: Some(nodes[1]),
    };

    let issue = group_issue(vec![vec![e1, e2]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(
        maze.graph.edge(e1).is_some(),
        "route-critical e1 must survive when protect_route is enabled"
    );
    assert!(
        maze.graph.edge(e2).is_none(),
        "e2 (non-route) must be removed instead"
    );
}

#[test]
fn protect_route_leaves_a_fully_protected_group_untouched() {
    // A route-only maze: start(0)->1->2(finish), both one-ways are route hops.
    use crate::space::SquarePoint;
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p: Vec<_> = (0..3)
        .map(|i| {
            field
                .node_at(field_level, SquarePoint { x: i, y: 0 })
                .unwrap()
        })
        .collect();
    let ea = g.add_edge(p[0], p[1], EdgeKind::Basic);
    let eb = g.add_edge(p[1], p[2], EdgeKind::Basic);
    let mut maze = Maze::new(field, g);
    maze.meta = MazeMeta {
        start: Some(p[0]),
        finish: Some(p[2]),
    };

    let issue = group_issue(vec![vec![ea, eb]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "no edge in the batch could be fixed -- both route-protected, nothing succeeded"
    );
    assert!(maze.graph.edge(ea).is_some());
    assert!(maze.graph.edge(eb).is_some());
}

/// Stub nested strategy that always fails without proposing any command -- used to exercise the
/// nested-call-genuinely-fails path in `apply`'s resolution loop. Neither `OneWayToWallStrategy`
/// nor `OneWayToPassageStrategy` (the strategies this actually ships with) ever return `Failed`
/// themselves, so a real nested-failure path needs a dedicated stub, mirroring
/// `InvalidLoopGroupSelectStrategy`'s own `AlwaysFailsStrategy`.
struct AlwaysFailsStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for AlwaysFailsStrategy {
    fn strategy_id(&self) -> &'static str {
        "always_fails_stub"
    }
    fn apply(
        &self,
        _issue: &InvalidOneWayIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        (RepairResult::Failed, vec![])
    }
}
crate::impl_erased_repair_strategy!(AlwaysFailsStrategy, InvalidOneWayIssue);

#[test]
fn apply_fails_when_every_nested_call_genuinely_fails() {
    let (mut maze, e1, e2) = maze_with_two_one_ways();
    let issue = group_issue(vec![vec![e1, e2]]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(AlwaysFailsStrategy),
        param_overrides: std::collections::HashMap::new(),
        nested: vec![],
    }];
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "every nested call failed, so the batch as a whole must be Failed"
    );
    assert!(
        maze.graph.edge(e1).is_some(),
        "a genuinely failed nested call must not remove the edge"
    );
    assert!(
        maze.graph.edge(e2).is_some(),
        "a genuinely failed nested call must not remove the edge"
    );
}

#[test]
fn apply_tries_the_next_candidate_after_a_genuine_nested_failure() {
    // e1 always fails via the stub below; e2 is a normal candidate in a *different* group with
    // its own budget -- a failure on e1 must not stop the whole apply() call, and must not touch
    // any other group's to_remove budget.
    let (mut maze, e1, e2) = maze_with_two_one_ways();
    let issue = group_issue_with_counts(vec![(vec![e1], 1), (vec![e2], 1)]);
    let mut rng = MazeRng::seed_from_u64(1);

    struct FailOnlyE1 {
        e1: EdgeId,
    }
    impl<T: Tessellation> RepairStrategy<T, InvalidOneWayIssue> for FailOnlyE1 {
        fn strategy_id(&self) -> &'static str {
            "fail_only_e1_stub"
        }
        fn apply(
            &self,
            issue: &InvalidOneWayIssue,
            _maze: &Maze<T>,
            _rng: &mut dyn RngCore,
            _params: &StrategyParams,
            _preset_state: &PresetState,
            _nested: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            if issue.invalid == vec![self.e1] {
                (RepairResult::Failed, vec![])
            } else {
                (
                    RepairResult::Fixed { score: None },
                    issue
                        .invalid
                        .iter()
                        .map(|&id| MutationCommand::RemoveEdge { id })
                        .collect(),
                )
            }
        }
    }
    crate::impl_erased_repair_strategy!(FailOnlyE1, InvalidOneWayIssue);

    let nested = vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(FailOnlyE1 { e1 }),
        param_overrides: std::collections::HashMap::new(),
        nested: vec![],
    }];
    let result = apply_and_commit(
        &strategy(true),
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &nested,
    );
    assert!(
        matches!(result, RepairResult::Fixed { score: None }),
        "e2's group must still succeed despite e1's genuine failure"
    );
    assert!(
        maze.graph.edge(e1).is_some(),
        "e1's failed fix must leave it untouched"
    );
    assert!(
        maze.graph.edge(e2).is_none(),
        "e2's own group must still be resolved"
    );
}
