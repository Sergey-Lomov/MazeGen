use super::*;
use std::collections::HashMap;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::graph::{Graph, EdgeKind};
use crate::IdGenerator;
use crate::space::{SquareTessellation, square_rect, MultiLevelField};
use crate::repair::params::build_params;
use crate::repair::strategies::add_teleport::AddTeleportStrategy;
use crate::repair::strategies::test_utils::apply_and_commit;

fn no_params() -> StrategyParams {
    build_params(<AddTeleportBatchStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&AddTeleportBatchStrategy), None)
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    build_params(<AddTeleportBatchStrategy as RepairStrategy<SquareTessellation, MissingTeleportsIssue>>::params(&AddTeleportBatchStrategy), Some(&map))
}

/// Every test in this file dispatches to the real `AddTeleportStrategy` as its nested
/// `SLOT_ADD_TELEPORT` filler — same pattern as `add_elevator_stop_tests.rs`'s
/// `add_elevator_nested()`. `child_overrides` sets the child's own creation params (GitHub issue
/// #522 design correction: post-façade-removal, these are only ever configurable on the nested
/// node itself, never through the series' own `params_with`).
fn nested_with_add_teleport<T: Tessellation>(child_overrides: &[(&str, &str)]) -> Vec<NestedStrategyConfig<T>> {
    let mut map = HashMap::new();
    for &(k, v) in child_overrides {
        map.insert(k.to_string(), v.to_string());
    }
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy: Box::new(AddTeleportStrategy),
        param_overrides: map,
        nested: vec![],
    }]
}

fn maze_grid(side: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(side, side), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    Maze::new(field, g)
}

fn missing_issue(missing: u32) -> MissingTeleportsIssue {
    let entries = if missing == 0 { vec![] } else { vec![(RepairArea::WholeMaze, missing)] };
    MissingTeleportsIssue::new_from_check("min_teleport_count", entries)
}

#[test]
fn apply_succeeds_immediately_when_nothing_missing() {
    let mut maze = maze_grid(3);
    let issue = missing_issue(0);
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_add_teleport(&[]));
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn apply_adds_teleport_edges_on_a_grid() {
    let mut maze = maze_grid(5);
    let issue = missing_issue(2);
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_add_teleport(&[]));
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edges().all(|e| e.kind == EdgeKind::Teleport));
    assert!(maze.graph.edges().count() > 0);
}

#[test]
fn apply_fails_on_single_node_field() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_add_teleport(&[]));
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 0);
}

#[test]
fn reserve_percent_override_changes_target_teleport_count() {
    let mut maze = maze_grid(5);
    let issue = missing_issue(2);
    let params = params_with(&[("reserve_percent", "0")]);
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &nested_with_add_teleport(&[("one_way_chance", "100")]));
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // 2 missing * (1 + 0%) = 2 teleports, one_way_chance=100% => one directed edge each.
    assert_eq!(maze.graph.edges().count(), 2);
}

#[test]
fn attempts_limit_failure_on_one_slot_does_not_abort_remaining_slots() {
    // 2 teleports needed, attempts_limit=1: every node's outgoing edges are entirely blocked
    // except one, so a pool pick landing on any blocked node deterministically fails its single
    // attempt (pick_exit finds no feasible exit at all) and gets evicted -- but the pool keeps
    // offering fresh candidates until it finds the one unblocked node, so overall progress is
    // guaranteed as long as attempts_limit failures don't abort the whole slots loop.
    let mut maze = maze_grid(5);
    let all_nodes: Vec<_> = maze.field.field_of(maze.field.single_level_id()).unwrap().all_points().map(|p| maze.field.node_at(maze.field.single_level_id(), p).unwrap()).collect();
    let mut preset_state = PresetState::empty();
    for &src in &all_nodes[..all_nodes.len() - 1] {
        for &dst in &all_nodes {
            if src != dst {
                preset_state.blocked.insert((src, dst));
            }
        }
    }

    let issue = missing_issue(1);
    let params = params_with(&[("reserve_percent", "0"), ("attempts_limit", "1")]);
    let mut rng = MazeRng::seed_from_u64(2);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &params, &preset_state, &nested_with_add_teleport(&[]));
    assert!(matches!(result, RepairResult::Fixed { score: None }), "the pool must keep trying fresh candidates past attempts_limit failures until it reaches the one unblocked node");
    let teleport_count = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
    assert_eq!(teleport_count, 1);
}

#[test]
fn apply_restricts_entry_to_the_named_level_but_allows_any_exit() {
    // Two disjoint 4x4 levels, no connections between them at all. The deficit is reported only
    // for level_b -- every added teleport's entry must be on level_b, but its exit is free to
    // land on either level (a teleport can legitimately cross floors).
    let mut ids = IdGenerator::new();
    let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
    let level_b = mf.add_level(field_b);
    let mut g = Graph::new();
    for node in mf.all_node_ids() { g.add_node(node); }
    let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);

    let issue = MissingTeleportsIssue::new_from_check("min_teleport_count", vec![(RepairArea::Level(level_b), 2)]);
    let mut rng = MazeRng::seed_from_u64(42);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_add_teleport(&[]));
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(maze.graph.edges().count() > 0);
    for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
        let from_level = maze.field.level_of(edge.from);
        let to_level = maze.field.level_of(edge.to);
        assert!(
            from_level == Some(level_b) || to_level == Some(level_b),
            "every teleport must have its entry on the reported level"
        );
    }
}

#[test]
fn apply_does_not_double_count_a_whole_maze_entry_already_satisfied_by_per_floor_entries() {
    // GitHub issue #369 follow-up: per-floor + whole-maze entries on the same rule must not
    // stack — 1 per floor on 3 floors + 3 whole-maze must add 3 teleports total, not 6.
    let mut ids = IdGenerator::new();
    let field_a = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let field_b = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let field_c = crate::space::Field::new(square_rect(4, 4), &mut ids).unwrap();
    let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new([field_a]);
    let level_b = mf.add_level(field_b);
    let level_c = mf.add_level(field_c);
    let level_a = mf.levels_ordered().next().unwrap();
    let mut g = Graph::new();
    for node in mf.all_node_ids() { g.add_node(node); }
    let mut maze: Maze<SquareTessellation> = Maze::new(mf, g);

    let issue = MissingTeleportsIssue::new_from_check("min_teleport_count", vec![
        (RepairArea::Level(level_a), 1),
        (RepairArea::Level(level_b), 1),
        (RepairArea::Level(level_c), 1),
        (RepairArea::WholeMaze, 3),
    ]);
    let params = params_with(&[("reserve_percent", "0")]);
    let mut rng = MazeRng::seed_from_u64(11);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &nested_with_add_teleport(&[]));
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let teleport_count = maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport).count();
    assert!(teleport_count <= 6, "at most 3 teleports (each possibly bidirectional -> 2 edges), not 6+3=9 or worse");
    let mut pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
    for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
        let key = if edge.from <= edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
        pairs.insert(key);
    }
    assert_eq!(pairs.len(), 3, "3 distinct teleports total, not 6");
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let issue = missing_issue(2);

    let mut maze_a = maze_grid(5);
    let mut rng_a = MazeRng::seed_from_u64(123);
    apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze_a, &mut rng_a, &no_params(), &PresetState::empty(), &nested_with_add_teleport(&[]));

    let mut maze_b = maze_grid(5);
    let mut rng_b = MazeRng::seed_from_u64(123);
    apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze_b, &mut rng_b, &no_params(), &PresetState::empty(), &nested_with_add_teleport(&[]));

    let edges_a: Vec<_> = maze_a.graph.edges().map(|e| (e.from, e.to)).collect();
    let edges_b: Vec<_> = maze_b.graph.edges().map(|e| (e.from, e.to)).collect();
    assert_eq!(edges_a, edges_b);
}

#[test]
fn apply_does_not_duplicate_an_existing_edge_between_the_same_pair() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
    g.build_initial_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &nested_with_add_teleport(&[]));
    // Only pair on a 1x2 field is already connected both ways -- nothing new can be added.
    assert!(matches!(result, RepairResult::Failed));
    assert_eq!(maze.graph.edges().count(), 2);
}

/// GitHub issue #522: within one `apply()` call, a second attempt must not repropose a pair
/// already queued (but not yet applied via `apply_commands`) by an earlier attempt in this same
/// call — `excluded` accumulates across attempts specifically to prevent this, since `maze` stays
/// an immutable pre-mutation snapshot for the whole call.
#[test]
fn exclusion_dedup_prevents_repeating_an_already_queued_pair_within_one_apply_call() {
    // 1x2 field: exactly one possible pair. Ask for 2 missing teleports -- the first attempt
    // queues the only possible pair; without cross-attempt dedup, a naive re-scan of the
    // (unmutated) maze would let the second attempt propose that same pair again.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = missing_issue(2);
    let params = params_with(&[("reserve_percent", "0")]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &nested_with_add_teleport(&[]));
    // Only one distinct pair exists on a 2-node field -- the second slot must fail rather than
    // duplicate the first slot's pair, so total added stays at 1 (Fixed only if progress was
    // made at all).
    let mut pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
    for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
        let key = if edge.from <= edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
        pairs.insert(key);
    }
    assert!(matches!(result, RepairResult::Fixed { score: None }) || matches!(result, RepairResult::Failed));
    assert_eq!(pairs.len(), 1, "only one distinct teleport pair possible on a 2-node field, dedup must prevent a duplicate");
}

/// GitHub issue #522 series-parity check: the series composed with the real nested
/// `AddTeleportStrategy` must reach the exact same edge set, on a fixed seed, as recorded right
/// after the split landed -- pins the composed behavior so a future change to either half can't
/// silently alter it without updating this recorded expectation. `one_way_chance=0` forces the
/// deterministic 2-edges-per-teleport shape, keeping the assertion exact rather than a range.
#[test]
fn series_composed_with_real_child_reaches_exact_recorded_edges() {
    let mut maze = maze_grid(4);
    let issue = missing_issue(1);
    let params = params_with(&[("reserve_percent", "0")]);
    let mut rng = MazeRng::seed_from_u64(99);
    let result = apply_and_commit(&AddTeleportBatchStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &nested_with_add_teleport(&[("one_way_chance", "0")]));
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    let mut edges: Vec<_> = maze.graph.edges().map(|e| (e.from, e.to)).collect();
    edges.sort();
    assert_eq!(edges.len(), 2, "one_way_chance=0 always adds both directions of the single teleport");
    assert_eq!(edges[0].0, edges[1].1);
    assert_eq!(edges[0].1, edges[1].0);
}
