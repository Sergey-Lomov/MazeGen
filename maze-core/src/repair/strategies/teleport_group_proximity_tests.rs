use super::*;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::EdgeKind;
use crate::{Graph, IdGenerator};
use crate::space::{SquareTessellation, square_rect};
use crate::quality_control::Issue as _;
use crate::repair::strategies::test_utils::apply_and_commit;

fn params_with_priority(priority: &str) -> StrategyParams {
    let mut overrides = HashMap::new();
    overrides.insert(PARAM_PRIORITY.to_string(), priority.to_string());
    crate::repair::params::build_params(
        <TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation, InvalidTeleportGroupIssue>>::params(&TeleportGroupProximityStrategy),
        Some(&overrides),
    )
}

fn params_with_priority_and_protect(priority: &str, protect_route: bool) -> StrategyParams {
    let mut overrides = HashMap::new();
    overrides.insert(PARAM_PRIORITY.to_string(), priority.to_string());
    overrides.insert(PARAM_PROTECT_ROUTE.to_string(), protect_route.to_string());
    crate::repair::params::build_params(
        <TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation, InvalidTeleportGroupIssue>>::params(&TeleportGroupProximityStrategy),
        Some(&overrides),
    )
}

fn maze_with_two_teleports() -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(4, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    (Maze::new(field, g), id_a, id_b)
}

#[test]
fn apply_succeeds_on_empty_pairs() {
    let (mut maze, _, _) = maze_with_two_teleports();
    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority(PRIORITY_RANDOM), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn random_priority_removes_exactly_one_of_the_pair() {
    let (mut maze, id_a, id_b) = maze_with_two_teleports();
    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority(PRIORITY_RANDOM), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let remaining = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
    assert_eq!(remaining, 1, "exactly one teleport of the pair must survive");
}

#[test]
fn problematic_priority_removes_the_teleport_in_more_pairs() {
    // a is in 2 pairs (with b and with c), b and c are each in 1 pair -- "problematic" must
    // remove a, since removing it resolves both pairs at once.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(6, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, id_b), (id_a, id_c)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority(PRIORITY_PROBLEMATIC), &PresetState::empty(), &[]);
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
    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority(PRIORITY_PROBLEMATIC), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let remaining = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
    assert_eq!(remaining, 1, "a tie must still resolve to removing exactly one of the pair");
}

#[test]
fn missing_priority_override_falls_back_to_problematic_default() {
    // a is in 2 pairs, b and c are each in 1 -- the default (no override) must behave like
    // PRIORITY_PROBLEMATIC and remove a, not pick randomly.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(6, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, id_b), (id_a, id_c)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let no_override_params = crate::repair::params::build_params(
        <TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation, InvalidTeleportGroupIssue>>::params(&TeleportGroupProximityStrategy),
        None,
    );
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &no_override_params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_none(), "default priority must behave like 'problematic' and remove a (member of 2 pairs)");
    assert!(maze.graph.edge(id_b).is_some());
    assert!(maze.graph.edge(id_c).is_some());
}

#[test]
fn strategy_id_and_handles_match_registration() {
    assert_eq!(<TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation, InvalidTeleportGroupIssue>>::strategy_id(&TeleportGroupProximityStrategy), "teleport_group_proximity");
    assert_eq!(InvalidTeleportGroupIssue::KIND, crate::quality_control::INVALID_TELEPORT_GROUP);
}

#[test]
fn already_resolved_pair_via_the_other_side_is_skipped() {
    // Mirror of already_resolved_pair_is_skipped, but the shared teleport (a) sits in the
    // *second* position of the first pair and the *first* position of the second pair --
    // exercises that the skip check looks at both tuple sides, not just the first.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(6, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    // (b, a) then (a, c): a is in the second slot of pair 1, first slot of pair 2.
    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_b, id_a), (id_a, id_c)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority(PRIORITY_PROBLEMATIC), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_none(), "a (member of 2 pairs) must be removed");
    assert!(maze.graph.edge(id_b).is_some());
    assert!(maze.graph.edge(id_c).is_some());
}

#[test]
fn already_resolved_pair_is_skipped() {
    // Both pairs share teleport a -- once a is removed resolving the first pair, the second
    // pair (also referencing a) must not attempt a second removal.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(6, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, id_b), (id_a, id_c)]);
    let mut rng = MazeRng::seed_from_u64(1);
    // "problematic" priority deterministically picks `a` (member of both pairs) both times
    // it's evaluated -- the second pair's evaluation must detect `a` is already removed and
    // skip acting on it again, rather than then removing `c` too.
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority(PRIORITY_PROBLEMATIC), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let remaining = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
    assert_eq!(remaining, 2, "removing a resolves both pairs -- b and c both survive, only a is removed");
}

#[test]
fn removing_one_direction_of_a_two_way_teleport_resolves_a_pair_referencing_its_reverse() {
    // a_fwd and a_bwd are the two directions of one physical two-way teleport. a_fwd is a
    // member of 2 pairs ((a_fwd,b) and (a_fwd,d)) -- "problematic" priority deterministically
    // removes a_fwd from both (it strictly outranks b and d, each in only 1 pair). Removing
    // a_fwd must also remove a_bwd via try_remove_teleport_with_reverse -- BEFORE (a_bwd, c),
    // the pair after it in iteration order, is ever evaluated. c is deliberately given a
    // *higher* membership (2 pairs, via an unrelated f) so "problematic" would pick c over
    // a_bwd if (a_bwd, c) were actually evaluated with both sides still present. Instead, by
    // the time that pair comes up, a_bwd is already in `removed` (from a_fwd's reverse), so
    // the pair is skipped as already-resolved and c is never touched. Without
    // try_remove_teleport_with_reverse, a_bwd would still be present when (a_bwd, c) is
    // evaluated, and "problematic" would remove c instead -- so asserting c survives (not
    // a_bwd surviving) is what actually distinguishes the fixed behavior from the bug.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(12, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let a_fwd = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let a_bwd = g.add_edge(nodes[1], nodes[0], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_d = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[6], nodes[7], EdgeKind::Teleport);
    let id_f = g.add_edge(nodes[8], nodes[9], EdgeKind::Teleport);
    let id_g = g.add_edge(nodes[10], nodes[11], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    // a_fwd: 2 pairs (b, d) -- outranks both, gets removed from each.
    // c: 2 pairs (a_bwd, f) -- outranks a_bwd (1 pair), so (a_bwd, c) picks c, not a_bwd.
    // g pairs with f only to keep f's own count from tying with c's.
    let issue = InvalidTeleportGroupIssue::new_from_check("test",
        vec![(a_fwd, id_b), (a_fwd, id_d), (a_bwd, id_c), (id_c, id_f), (id_f, id_g)],
    );
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority(PRIORITY_PROBLEMATIC), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(a_fwd).is_none(), "a_fwd (member of 2 pairs) must be removed");
    assert!(maze.graph.edge(a_bwd).is_none(), "a_bwd must be removed too, as a_fwd's reverse counterpart -- its own pair (a_bwd, c) would otherwise pick c, never a_bwd directly");
    assert!(maze.graph.edge(id_b).is_some(), "b must survive -- only a_fwd is removed from its pair");
    assert!(maze.graph.edge(id_d).is_some(), "d must survive -- only a_fwd is removed from its pair");
    assert!(maze.graph.edge(id_c).is_some(), "c must survive: (a_bwd, c) is skipped as already-resolved once a_bwd is gone via reverse-removal, so c is never itself acted on");
}

#[test]
fn protect_route_falls_back_to_the_non_route_side_of_the_pair() {
    // a (0->1) is the maze's only start->finish route; b (2->3) is an unrelated teleport
    // paired with a. With protect_route enabled and "random" priority forced to pick a,
    // the strategy must remove b instead and leave a in place.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(4, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority_and_protect(PRIORITY_RANDOM, true), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_some(), "route-critical teleport a must survive");
    assert!(maze.graph.edge(id_b).is_none(), "non-route teleport b must be removed instead");
}

#[test]
fn protect_route_leaves_pair_untouched_when_both_sides_are_route_critical() {
    // a and b are both on the (only) start->finish route -- e.g. two parallel teleport
    // hops each individually required. Neither may be removed; the pair still resolves.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(3, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[1], nodes[2], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[2]);

    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority_and_protect(PRIORITY_RANDOM, true), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }), "pair must still report Fixed even when neither side is removed");

    assert!(maze.graph.edge(id_a).is_some(), "a is route-critical and must survive");
    assert!(maze.graph.edge(id_b).is_some(), "b is route-critical and must survive");
}

#[test]
fn protect_route_falls_back_correctly_across_multiple_pairs_sharing_the_protected_teleport() {
    // a is route-critical and appears in two problematic pairs: (a, b) and (a, c). Neither
    // b nor c is removed while resolving the other's pair (a survives both fallback picks),
    // so this must not stop at "a already resolved once" -- each pair independently falls
    // back to its own non-route side. With "problematic" priority, a (member of 2 pairs)
    // would normally be picked for removal both times; protect_route must override that in
    // both iterations, since a is never actually removed to trip the `removed` early-skip.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(6, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let id_c = g.add_edge(nodes[4], nodes[5], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, id_b), (id_a, id_c)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority_and_protect(PRIORITY_PROBLEMATIC, true), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_some(), "a is route-critical and must survive both pair resolutions");
    assert!(maze.graph.edge(id_b).is_none(), "b must be removed as the fallback for the first pair");
    assert!(maze.graph.edge(id_c).is_none(), "c must be removed as the fallback for the second pair");
}

#[test]
fn protect_route_fallback_removal_also_removes_the_fallback_side_reverse() {
    // a is route-critical; b is a two-way teleport (b_fwd, b_bwd), paired with a, and not on
    // the route. protect_route must fall back to removing b instead of a -- and since b is
    // two-way, both b_fwd and b_bwd must be removed, not just whichever direction the pair
    // happened to reference.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(4, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let b_fwd = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let b_bwd = g.add_edge(nodes[3], nodes[2], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, b_fwd)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &params_with_priority_and_protect(PRIORITY_RANDOM, true), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_some(), "route-critical a must survive");
    assert!(maze.graph.edge(b_fwd).is_none(), "b_fwd must be removed as the fallback");
    assert!(maze.graph.edge(b_bwd).is_none(), "b_bwd must be removed too, as b_fwd's reverse counterpart");
}

#[test]
fn protect_route_default_is_true_when_no_override_is_given() {
    // Mirrors missing_priority_override_falls_back_to_problematic_default, but for
    // protect_route: build_params with no override must apply the Bool { default: true }
    // descriptor, so a route-critical teleport survives even without an explicit override.
    let mut ids = IdGenerator::new();
    let field = crate::space::Field::new(square_rect(4, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    let id_a = g.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);
    let id_b = g.add_edge(nodes[2], nodes[3], EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(nodes[0]);
    maze.meta.finish = Some(nodes[1]);

    let issue = InvalidTeleportGroupIssue::new_from_check("test", vec![(id_a, id_b)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let no_override_params = crate::repair::params::build_params(
        <TeleportGroupProximityStrategy as RepairStrategy<SquareTessellation, InvalidTeleportGroupIssue>>::params(&TeleportGroupProximityStrategy),
        None,
    );
    let result = apply_and_commit(&TeleportGroupProximityStrategy, &issue, &mut maze, &mut rng, &no_override_params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.graph.edge(id_a).is_some(), "route-critical a must survive: protect_route defaults to true with no override");
    assert!(maze.graph.edge(id_b).is_none(), "non-route b must still be removed");
}
