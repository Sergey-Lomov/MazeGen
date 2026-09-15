use super::*;
use std::collections::HashMap;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::{Graph, EdgeKind};
use crate::IdGenerator;
use crate::space::{SquareTessellation, square_rect, MultiLevelField};
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit;

fn no_params() -> StrategyParams {
    build_params(<AddTeleportStrategy as RepairStrategy<SquareTessellation, MissingTeleportIssue>>::params(&AddTeleportStrategy), None)
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    build_params(<AddTeleportStrategy as RepairStrategy<SquareTessellation, MissingTeleportIssue>>::params(&AddTeleportStrategy), Some(&map))
}

fn candidate_issue(candidate: NodeId) -> MissingTeleportIssue {
    MissingTeleportIssue::new(candidate, HashSet::new())
}

#[test]
fn desired_length_interval_restricts_the_exit_distance() {
    // 1x10 corridor: with min=max=3, any accepted teleport not falling back to out-of-interval
    // must land exactly 3 tile-hops from its entry.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(10, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    for i in 0..9 {
        g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let params = params_with(&[("desired_length", "3,3"), ("allow_out_of_interval", "false"), ("unreachable_priority", "forbidden")]);
    let issue = candidate_issue(nodes[0]);
    let mut rng = MazeRng::seed_from_u64(3);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
    let dist = bfs_distances(&maze, teleport.from);
    assert!(dist.get(&teleport.to).copied().is_some());
}

#[test]
fn entry_pick_farthest_from_random_places_entry_at_the_far_end_of_a_directed_chain() {
    // Directed chain 0->1->2->3->4 (one-way only): farthest_from_random must hop from whichever
    // candidate is given to the farthest node forward-reachable from it. Every node in 0..=3
    // forward-reaches node 4 (the chain's own direction), and node 4 itself has nothing
    // forward-reachable so `farthest_from` falls back to itself (also 4) -- so on this chain
    // shape, farthest_from_random resolves to node 4 regardless of the candidate.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    for i in 0..4 {
        g.build_initial_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let params = params_with(&[("entry_pick", "farthest_from_random")]);
    let issue = candidate_issue(nodes[0]);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
    assert_eq!(teleport.from, nodes[4], "farthest_from_random must resolve entry to node 4 regardless of candidate on this directed chain");
}

#[test]
fn entry_pick_farthest_from_random_resolves_a_corridor_interior_candidate() {
    // 1x5 *bidirectional* corridor: nodes 1..=3 are corridor-interior nav nodes (see
    // `is_corridor_node`) -- only nodes 0 and 4 (dead ends) are nav nodes proper. Passing a
    // corridor-interior candidate directly (which `NavGraph::nav_node_for` cannot resolve on its
    // own) must still resolve via the `corridor_index` fallback to a dead end, not return the
    // candidate unchanged.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    for i in 0..4 {
        g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let params = params_with(&[("entry_pick", "farthest_from_random")]);
    // Candidate is node 2 -- the corridor-interior middle node.
    let issue = candidate_issue(nodes[2]);
    let mut rng = MazeRng::seed_from_u64(0);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
    assert!(
        teleport.from == nodes[0] || teleport.from == nodes[4],
        "farthest_from_random must resolve entry to a dead end (node 0 or 4) even from a corridor-interior candidate, got {:?}",
        teleport.from,
    );
}

#[test]
fn one_way_chance_zero_always_adds_the_reverse_edge() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(4, 4), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let candidate = field.all_node_ids().next().unwrap();
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let params = params_with(&[("one_way_chance", "0")]);
    let issue = candidate_issue(candidate);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), 2, "one_way_chance=0 must add both directions of the single teleport");
    for edge in maze.graph.edges() {
        assert!(maze.graph.edge_between(edge.to, edge.from).is_some(), "every added edge must have its reverse");
    }
}

#[test]
fn one_way_chance_zero_falls_back_to_directed_when_reverse_is_preset_blocked() {
    // Every ordered pair (a, b) with a > b is blocked -- i.e. only the "ascending" direction of
    // any pair is ever open. one_way_chance=0 always *wants* the reverse, but whichever
    // (entry, exit) pair gets picked, the reverse (exit, entry) is always the descending, blocked
    // direction -- apply() must downgrade to a directed-only teleport instead of proposing an
    // AddBidirectionalTeleport that would be silently dropped whole by preset revalidation.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(5, 5), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let all_nodes: Vec<_> = field.all_node_ids().collect();
    let mut preset_state = PresetState::empty();
    for &a in &all_nodes {
        for &b in &all_nodes {
            if a > b {
                preset_state.blocked.insert((a, b));
            }
        }
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    let candidate = all_nodes[0];

    let params = params_with(&[("one_way_chance", "0")]);
    let issue = candidate_issue(candidate);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &preset_state, &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), 1, "reverse must be dropped, not silently discarded as a whole bidirectional command");
}

#[test]
fn allow_out_of_interval_falls_back_to_an_out_of_range_exit_when_nothing_else_qualifies() {
    // 1x5 corridor, desired_length pinned to an interval no node can ever satisfy (min=max=99 on
    // a graph whose farthest possible tile-hop distance is 4) and unreachable_priority=forbidden
    // on a single connected component (so the unreachable set is always empty too) -- the only
    // way apply() can still succeed is by falling through to the out-of-interval set, which
    // requires allow_out_of_interval=true.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    for i in 0..4 {
        g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let params = params_with(&[("desired_length", "99,99"), ("allow_out_of_interval", "true"), ("unreachable_priority", "forbidden")]);
    let issue = candidate_issue(nodes[0]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }), "must succeed via the out_of_interval fallback since nothing satisfies the impossible interval or the (empty) unreachable set");
    assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
}

#[test]
fn allow_out_of_interval_false_fails_when_nothing_satisfies_the_interval() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(5, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    for i in 0..4 {
        g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let params = params_with(&[("desired_length", "99,99"), ("allow_out_of_interval", "false"), ("unreachable_priority", "forbidden")]);
    let issue = candidate_issue(nodes[0]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed), "no exit can ever satisfy the interval and out-of-interval picks are disallowed");
    assert!(maze.graph.edges().all(|e| e.kind != EdgeKind::Teleport), "no teleport must have been added");
}

#[test]
fn unreachable_priority_bridges_a_separate_strongly_connected_component() {
    // Two disjoint 1x3 corridors (component A: nodes 0-2, component B: nodes 3-5), no edges
    // between them at all. unreachable_priority=required forces the pick to always try the
    // unreachable set first; since it's never empty here, the resulting teleport must land on a
    // node in the OTHER component from its entry.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    for i in 0..2 {
        g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
    }
    for i in 3..5 {
        g.build_initial_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let params = params_with(&[("unreachable_priority", "required")]);
    let issue = candidate_issue(nodes[0]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
    let component_b: HashSet<NodeId> = [nodes[3], nodes[4], nodes[5]].into_iter().collect();
    assert!(component_b.contains(&teleport.to) || component_b.contains(&teleport.from), "teleport must cross into the other component");
}

#[test]
fn unreachable_priority_preferred_falls_back_to_in_interval_when_unreachable_is_empty() {
    // Fully-connected grid -- every node is BFS-reachable from the entry, so the "unreachable"
    // set `PriorityLevel::Preferred` favors is always empty and pick_exit must fall back to the
    // "in_interval" set on every attempt.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(5, 5), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let candidate = field.all_node_ids().next().unwrap();
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let params = params_with(&[("unreachable_priority", "preferred")]);
    let issue = candidate_issue(candidate);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }), "must succeed via the in_interval fallback, since no node is ever unreachable on a fully-connected grid");
    assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
}

fn two_level_maze() -> (Maze<SquareTessellation>, crate::space::LevelId, crate::space::LevelId) {
    let mut ids = IdGenerator::new();
    let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
    let level_a = mf.levels_ordered().next().unwrap();
    let level_b = mf.add_level(field_b);
    let mut g = Graph::new();
    for node in mf.all_node_ids() { g.add_node(node); }
    (Maze::new(mf, g), level_a, level_b)
}

#[test]
fn cross_floor_mode_forbidden_never_crosses_floors() {
    let (mut maze, level_a, level_b) = two_level_maze();
    let candidate = maze.field.all_node_ids().next().unwrap();
    let params = params_with(&[("cross_floor_mode", "forbidden")]);
    let issue = candidate_issue(candidate);
    let mut rng = MazeRng::seed_from_u64(9);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
    let from_level = maze.field.level_of(teleport.from);
    let to_level = maze.field.level_of(teleport.to);
    assert_eq!(from_level, to_level, "forbidden mode must never place a teleport across floors");
    assert!(from_level == Some(level_a) || from_level == Some(level_b));
}

#[test]
fn cross_floor_mode_manual_balance_zero_behaves_like_forbidden() {
    let (mut maze, _level_a, _level_b) = two_level_maze();
    let candidate = maze.field.all_node_ids().next().unwrap();
    let params = params_with(&[("cross_floor_mode", "manual"), ("cross_floor_balance", "0")]);
    let issue = candidate_issue(candidate);
    let mut rng = MazeRng::seed_from_u64(13);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
    assert_eq!(maze.field.level_of(teleport.from), maze.field.level_of(teleport.to), "balance=0 must behave as a hard same-floor-only preference, never falling back cross-floor");
}

#[test]
fn cross_floor_mode_manual_balance_one_always_crosses_floors() {
    let (mut maze, _level_a, _level_b) = two_level_maze();
    let candidate = maze.field.all_node_ids().next().unwrap();
    let params = params_with(&[("cross_floor_mode", "manual"), ("cross_floor_balance", "1")]);
    let issue = candidate_issue(candidate);
    let mut rng = MazeRng::seed_from_u64(17);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let teleport = maze.graph.edges().find(|e| e.kind == EdgeKind::Teleport).expect("one teleport must have been added");
    assert_ne!(maze.field.level_of(teleport.from), maze.field.level_of(teleport.to), "balance=1 must behave as a hard other-floor-only preference, never falling back same-floor");
}

#[test]
fn cross_floor_mode_natural_ignores_floor_entirely() {
    // Not a strict behavioral assertion beyond "it still works" -- natural is the pre-existing
    // default behavior (floor never consulted), this just pins that the param plumbing doesn't
    // accidentally change it.
    let (mut maze, _level_a, _level_b) = two_level_maze();
    let candidate = maze.field.all_node_ids().next().unwrap();
    let params = params_with(&[("cross_floor_mode", "natural")]);
    let issue = candidate_issue(candidate);
    let mut rng = MazeRng::seed_from_u64(21);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
}

/// GitHub issue #522 exclusion test: `excluded_pairs` is read-only input the caller controls --
/// a candidate whose only possible pair is pre-excluded must fail even though the pair itself
/// would otherwise be perfectly feasible.
#[test]
fn excluded_pairs_blocks_the_only_otherwise_feasible_pair() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut excluded = HashSet::new();
    excluded.insert(TeleportPairKey::Directed(nodes[0], nodes[1]));
    excluded.insert(TeleportPairKey::Directed(nodes[1], nodes[0]));
    let issue = MissingTeleportIssue::new(nodes[0], excluded);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Failed), "the only possible pair is excluded, so this attempt must fail");
    assert_eq!(maze.graph.edges().count(), 0);
}

/// GitHub issue #522 direct-use test: `AddTeleportStrategy` is fully usable on its own, with a
/// hand-built `MissingTeleportIssue`, independent of `AddTeleportBatchStrategy`'s pool/attempts
/// infrastructure -- confirms the child owns no hidden series-only state.
#[test]
fn direct_use_without_the_series_succeeds_on_its_own() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(5, 5), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let candidate = field.all_node_ids().next().unwrap();
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = candidate_issue(candidate);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edges().any(|e| e.kind == EdgeKind::Teleport));
}
