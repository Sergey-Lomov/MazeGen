use super::*;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::EdgeKind;
use crate::{Graph, IdGenerator};
use crate::space::{SquareTessellation, square_rect};
use crate::quality_control::IssueKindConst;
use crate::repair::strategies::RemoveTeleportStrategy;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::repair::strategies::group_select::PRIORITY_RANDOM;

fn strategy(protect_route: bool) -> TeleportGroupSelectStrategy {
    TeleportGroupSelectStrategy { protect_route }
}

fn no_params() -> StrategyParams {
    crate::repair::params::build_params(<TeleportGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidTeleportGroupIssue>>::params(&strategy(true)), None)
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = std::collections::HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    crate::repair::params::build_params(<TeleportGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidTeleportGroupIssue>>::params(&strategy(true)), Some(&map))
}

fn fix_target_nested<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(RemoveTeleportStrategy),
        param_overrides: std::collections::HashMap::new(),
        nested: vec![],
    }]
}

fn fix_target_nested_allow_reverse<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    let mut param_overrides = std::collections::HashMap::new();
    param_overrides.insert("allow_reverse".to_string(), "true".to_string());
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(RemoveTeleportStrategy),
        param_overrides,
        nested: vec![],
    }]
}

/// Builds an issue where every pair defaults to `to_remove: 1` -- matches
/// `TeleportGroupProximityCheck`'s own shape.
fn pair_issue(pairs: Vec<(EdgeId, EdgeId)>) -> InvalidTeleportGroupIssue {
    let groups = pairs.into_iter().map(|(a, b)| (vec![a, b], 1)).collect();
    InvalidTeleportGroupIssue::new_from_check("test", groups)
}

fn maze_with_two_teleports() -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    (Maze::new(field, g), id_a, id_b)
}

#[test]
fn apply_succeeds_on_empty_pairs() {
    let (mut maze, _, _) = maze_with_two_teleports();
    let issue = pair_issue(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_fails_when_nested_is_empty() {
    let (mut maze, id_a, id_b) = maze_with_two_teleports();
    let issue = pair_issue(vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn apply_succeeds_on_empty_pairs_even_with_no_nested_configured() {
    // Nothing to fix -- an empty issue must report Fixed regardless of whether a nested
    // fix_target strategy is even configured, since group_select_apply is never reached.
    let (mut maze, _, _) = maze_with_two_teleports();
    let issue = pair_issue(vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn random_priority_removes_exactly_one_of_the_pair() {
    let (mut maze, id_a, id_b) = maze_with_two_teleports();
    let issue = pair_issue(vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let remaining = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
    assert_eq!(remaining, 1, "exactly one teleport of the pair must survive");
}

#[test]
fn problematic_priority_removes_the_teleport_in_more_pairs() {
    // a is in 2 pairs (with b and with c), b and c are each in 1 pair -- "problematic" must
    // remove a, since removing it resolves both pairs at once.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = pair_issue(vec![(id_a, id_b), (id_a, id_c)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_none(), "a (member of 2 pairs) must be removed");
    assert!(maze.graph.edge(id_b).is_some(), "b (member of 1 pair) must survive");
    assert!(maze.graph.edge(id_c).is_some(), "c (member of 1 pair) must survive");
}

#[test]
fn problematic_priority_removes_exactly_one_on_a_tie() {
    // a and b are each in exactly 1 pair -- membership is tied, so "problematic" falls back
    // to a random pick between them, but must still remove exactly one, never both/neither.
    let (mut maze, id_a, id_b) = maze_with_two_teleports();
    let issue = pair_issue(vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let remaining = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
    assert_eq!(remaining, 1, "a tie must still resolve to removing exactly one of the pair");
}

#[test]
fn missing_priority_override_falls_back_to_problematic_default() {
    // a is in 2 pairs, b and c are each in 1 -- the default (no override) must behave like
    // PRIORITY_PROBLEMATIC and remove a, not pick randomly.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = pair_issue(vec![(id_a, id_b), (id_a, id_c)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_none(), "default priority must behave like 'problematic' and remove a (member of 2 pairs)");
    assert!(maze.graph.edge(id_b).is_some());
    assert!(maze.graph.edge(id_c).is_some());
}

#[test]
fn strategy_id_and_handles_match_registration() {
    assert_eq!(<TeleportGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidTeleportGroupIssue>>::strategy_id(&strategy(true)), "teleport_group_select");
    assert_eq!(InvalidTeleportGroupIssue::KIND, crate::quality_control::INVALID_TELEPORT_GROUP);
}

#[test]
fn already_resolved_pair_is_skipped() {
    // Both pairs share teleport a -- once a is removed resolving the first pair, the second
    // pair (also referencing a) must not attempt a second removal.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = pair_issue(vec![(id_a, id_b), (id_a, id_c)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    // "problematic" priority deterministically picks `a` (member of both pairs) -- the
    // second pair's evaluation must detect `a` is already gone and skip acting on it again,
    // rather than then removing `c` too.
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let remaining = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
    assert_eq!(remaining, 2, "removing a resolves both pairs -- b and c both survive, only a is removed");
}

#[test]
fn removing_a_teleport_also_resolves_a_pair_referencing_its_reverse_direction() {
    // a_fwd and a_bwd are the two directions of one physical two-way teleport; b is an
    // unrelated teleport paired only with a_bwd (not a_fwd). "problematic" priority
    // deterministically picks a_fwd (membership 2, via two pairs with c/d) over a_bwd
    // (membership 1) -- removing a_fwd via RemoveTeleportStrategy's default
    // (allow_reverse=false) also removes a_bwd as its reverse counterpart, which must resolve
    // (a_bwd, b)'s pair too, without b itself ever being touched.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(8, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let a_fwd = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let a_bwd = g.add_edge(nodes[1], nodes[0], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let id_d = g.add_edge(nodes[6], nodes[7], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    // a_fwd: 2 pairs (c, d) -- outranks a_bwd (1 pair) and gets picked first.
    let issue = pair_issue(vec![(a_fwd, id_c), (a_fwd, id_d), (a_bwd, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(a_fwd).is_none(), "a_fwd (member of 2 pairs) must be picked and removed");
    assert!(maze.graph.edge(a_bwd).is_none(), "a_bwd must be removed too, as a_fwd's reverse counterpart");
    assert!(maze.graph.edge(id_b).is_some(), "b must survive -- its pair (a_bwd, b) is resolved by a_bwd's reverse-removal alone, never touching b directly");
    assert!(maze.graph.edge(id_c).is_some(), "c must survive -- only a_fwd is removed from its pair");
    assert!(maze.graph.edge(id_d).is_some(), "d must survive -- only a_fwd is removed from its pair");
}

#[test]
fn protect_route_falls_back_to_the_non_route_side_of_the_pair() {
    // a (0->1) is the maze's only start->finish route; b (2->3) is an unrelated teleport
    // paired with a. With protect_route enabled, a is excluded from the candidate pool up
    // front, so the strategy removes b instead and leaves a in place -- no per-pair fallback
    // code needed, since a was never offered as a candidate to begin with.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let issue = pair_issue(vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_some(), "route-critical teleport a must survive");
    assert!(maze.graph.edge(id_b).is_none(), "non-route teleport b must be removed instead");
}

#[test]
fn protect_route_leaves_pair_untouched_and_fails_when_both_sides_are_route_critical() {
    // a and b are both on the (only) start->finish route -- e.g. two parallel teleport
    // hops each individually required. Neither may be removed. Behavior change from
    // pre-#209 (GitHub issue #209): this pair has no allowed candidate at all, and since it's
    // the only pair in the issue, the call as a whole is now Failed (not the old "leave the
    // pair untouched, still report Fixed") -- this permanently skips the rule for the rest of
    // the repair stage's fixpoint loop instead of silently re-"resolving" a no-op every future
    // iteration.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[1], nodes[2], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);

    let issue = pair_issue(vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Failed), "no pair in the batch could be fixed -- both route-protected, nothing succeeded");

    assert!(maze.graph.edge(id_a).is_some(), "a is route-critical and must survive");
    assert!(maze.graph.edge(id_b).is_some(), "b is route-critical and must survive");
}

#[test]
fn protect_route_untouched_pair_does_not_block_a_different_fixable_pair() {
    // a/b are both route-critical (wholly-protected pair); c/d are an unrelated, unprotected
    // pair. The wholly-protected pair must not drag the whole call down to Failed when another
    // pair in the same issue genuinely gets fixed.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(7, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[1], nodes[2], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[3], nodes[4], EdgeKind::Teleport);
    let id_d = g.add_edge(nodes[5], nodes[6], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);

    let issue = pair_issue(vec![(id_a, id_b), (id_c, id_d)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }), "the fixable pair's own progress must make the whole call Fixed");

    assert!(maze.graph.edge(id_a).is_some(), "a is route-critical and must survive");
    assert!(maze.graph.edge(id_b).is_some(), "b is route-critical and must survive");
    let cd_remaining = [id_c, id_d].iter().filter(|&&id| maze.graph.edge(id).is_some()).count();
    assert_eq!(cd_remaining, 1, "exactly one of the unprotected pair must be removed");
}

#[test]
fn protect_route_falls_back_correctly_across_multiple_pairs_sharing_the_protected_teleport() {
    // a is route-critical and appears in two problematic pairs: (a, b) and (a, c). protect_route
    // excludes a from the candidate pool entirely, so each pair falls back to its own
    // non-route side independently.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let issue = pair_issue(vec![(id_a, id_b), (id_a, id_c)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_PROBLEMATIC)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_some(), "a is route-critical and must survive both pair resolutions");
    assert!(maze.graph.edge(id_b).is_none(), "b must be removed as the fallback for the first pair");
    assert!(maze.graph.edge(id_c).is_none(), "c must be removed as the fallback for the second pair");
}

#[test]
fn protect_route_fallback_removal_also_removes_the_fallback_side_reverse() {
    // a is route-critical; b is a two-way teleport (b_fwd, b_bwd), paired with a, and not on
    // the route. protect_route excludes a, so b is the only candidate -- and since b is
    // two-way, RemoveTeleportStrategy's default removes both b_fwd and b_bwd.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let b_fwd = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let b_bwd = g.add_edge(nodes[3], nodes[2], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let issue = pair_issue(vec![(id_a, b_fwd)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_some(), "route-critical a must survive");
    assert!(maze.graph.edge(b_fwd).is_none(), "b_fwd must be removed as the fallback");
    assert!(maze.graph.edge(b_bwd).is_none(), "b_bwd must be removed too, as b_fwd's reverse counterpart");
}

#[test]
fn nested_allow_reverse_removes_only_the_flagged_direction_of_a_two_way_teleport() {
    // a_fwd/a_bwd are the two directions of one physical two-way teleport, paired with b.
    // "random" priority is forced to pick a_fwd. With the nested RemoveTeleportStrategy's own
    // allow_reverse=true, only a_fwd must be removed -- a_bwd must survive, downgrading the
    // teleport to one-way instead of removing it.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let a_fwd = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let a_bwd = g.add_edge(nodes[1], nodes[0], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = pair_issue(vec![(a_fwd, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested_allow_reverse();
    let result = apply_and_commit(&strategy(false), &issue, &mut maze, &mut rng,
        &params_with(&[(PARAM_PRIORITY, PRIORITY_RANDOM)]),
        &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    // Either a_fwd or b was removed ("random" priority) -- whichever it is, its reverse (if
    // any) must survive under allow_reverse.
    if maze.graph.edge(a_fwd).is_none() {
        assert!(maze.graph.edge(a_bwd).is_some(), "allow_reverse must leave a_bwd intact when a_fwd is removed");
        assert!(maze.graph.edge(id_b).is_some());
    } else {
        assert!(maze.graph.edge(a_bwd).is_some(), "a_bwd must survive: only a_fwd or b was targeted, never a_bwd");
        assert!(maze.graph.edge(id_b).is_none());
    }
}

#[test]
fn protect_route_default_is_true_when_no_override_is_given() {
    // Mirrors missing_priority_override_falls_back_to_problematic_default, but for
    // protect_route: constructing the strategy with protect_route: true (the RuleParams
    // default) must survive a route-critical teleport even with no priority override.
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let issue = pair_issue(vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let nested = fix_target_nested();
    let result = apply_and_commit(&strategy(true), &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_some(), "route-critical a must survive: protect_route defaults to true with no override");
    assert!(maze.graph.edge(id_b).is_none(), "non-route b must still be removed");
}
