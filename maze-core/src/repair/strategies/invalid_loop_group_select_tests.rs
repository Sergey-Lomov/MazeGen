use super::*;
use crate::graph::EdgeKind;
use crate::random::MazeRng;
use crate::repair::strategies::InvalidLoopRandomStrategy;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::space::{SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

type Cycle = Vec<EdgeId>;

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    crate::repair::params::build_params(
        <InvalidLoopGroupSelectStrategy as RepairStrategy<
            SquareTessellation,
            InvalidLoopGroupIssue,
        >>::params(&InvalidLoopGroupSelectStrategy),
        Some(&map),
    )
}

fn no_params() -> StrategyParams {
    params_with(&[])
}

fn nested_with<T: Tessellation>(
    strategy: Box<dyn crate::repair::ErasedRepairStrategy<T>>,
) -> Vec<NestedStrategyConfig<T>> {
    vec![NestedStrategyConfig {
        slot: &NESTED_SLOTS[0],
        strategy,
        param_overrides: HashMap::new(),
        nested: vec![],
    }]
}

fn cut_target_nested<T: Tessellation>() -> Vec<NestedStrategyConfig<T>> {
    nested_with(Box::new(InvalidLoopRandomStrategy))
}

/// One nested call as seen by a recording stub: the selected cycle plus the full issue it got.
#[derive(Debug, Clone)]
struct Call {
    target: Cycle,
    all: Vec<Cycle>,
    invalid: Vec<usize>,
}

type Calls = Rc<RefCell<Vec<Call>>>;

/// Records every nested call. Reports `Failed` unless `cuts` is set, in which case it removes the
/// first edge of the selected cycle (with its reverse leg, if any) and reports `Fixed`.
struct Recorder {
    calls: Calls,
    cuts: bool,
}

impl<T: Tessellation> RepairStrategy<T, InvalidLoopIssue> for Recorder {
    fn strategy_id(&self) -> &'static str {
        "recorder_stub"
    }
    fn apply(
        &self,
        issue: &InvalidLoopIssue,
        _maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        _preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let target = issue.all[issue.invalid[0]].clone();
        self.calls.borrow_mut().push(Call {
            target: target.to_vec(),
            all: issue.all.iter().map(|c| c.to_vec()).collect(),
            invalid: issue.invalid.clone(),
        });
        if self.cuts {
            (
                RepairResult::Fixed { score: None },
                vec![MutationCommand::RemoveEdgeWithReverse { id: target[0] }],
            )
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}
crate::impl_erased_repair_strategy!(Recorder, InvalidLoopIssue);

fn recorder(cuts: bool) -> (Calls, Box<Recorder>) {
    let calls: Calls = Rc::new(RefCell::new(vec![]));
    (calls.clone(), Box::new(Recorder { calls, cuts }))
}

fn run(
    issue: &InvalidLoopGroupIssue,
    maze: &Maze<SquareTessellation>,
    params: &StrategyParams,
    nested: &[NestedStrategyConfig<SquareTessellation>],
    seed: u64,
) -> (RepairResult, Vec<MutationCommand>) {
    let mut rng = MazeRng::seed_from_u64(seed);
    InvalidLoopGroupSelectStrategy.apply(
        issue,
        maze,
        &mut rng,
        params,
        &PresetState::empty(),
        nested,
    )
}

/// Triangle (3 tile-hops) and a 4-node square loop (4 tile-hops), disjoint edge sets, both
/// flagged invalid.
fn maze_with_two_disjoint_loops() -> (Maze<SquareTessellation>, Cycle, Cycle) {
    let mut ids = IdGenerator::new();
    let field =
        crate::space::MultiLevelField::single_level(Arc::default(), square_rect(7, 1), &mut ids)
            .unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let nodes: Vec<_> = field
        .field_of(field_level)
        .unwrap()
        .all_cells()
        .map(|p| field.node_at(field_level, p).unwrap())
        .collect();
    let e0 = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e1 = g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
    let e2 = g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
    let e3 = g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
    let e4 = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let e5 = g.add_edge(nodes[5], nodes[6], EdgeKind::Basic);
    let e6 = g.add_edge(nodes[6], nodes[3], EdgeKind::Basic);
    (Maze::new(field, g), vec![e0, e1, e2], vec![e3, e4, e5, e6])
}

/// Bowtie: two triangles sharing edge A->B, plus a disjoint valid cycle. Returns
/// `(maze, triangle_abc, triangle_abd, valid_cycle)`.
fn bowtie_maze() -> (Maze<SquareTessellation>, Cycle, Cycle, Cycle) {
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(Arc::default(), square_rect(7, 1), &mut ids)
            .unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let nodes: Vec<_> = field
        .field_of(field_level)
        .unwrap()
        .all_cells()
        .map(|p| field.node_at(field_level, p).unwrap())
        .collect();
    let shared = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic); // A->B (shared)
    let bc = g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
    let ca = g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
    let bd = g.add_edge(nodes[1], nodes[3], EdgeKind::Basic);
    let da = g.add_edge(nodes[3], nodes[0], EdgeKind::Basic);
    let v0 = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let v1 = g.add_edge(nodes[5], nodes[6], EdgeKind::Basic);
    let v2 = g.add_edge(nodes[6], nodes[4], EdgeKind::Basic);
    (
        Maze::new(field, g),
        vec![shared, bc, ca],
        vec![shared, bd, da],
        vec![v0, v1, v2],
    )
}

fn group_issue(invalid: Vec<Cycle>) -> InvalidLoopGroupIssue {
    InvalidLoopGroupIssue::new_from_check("max_loop_density", invalid, vec![], Default::default())
}

fn group_issue_with_valid(invalid: Vec<Cycle>, valid: Vec<Cycle>) -> InvalidLoopGroupIssue {
    InvalidLoopGroupIssue::new_from_check("max_loop_density", invalid, valid, Default::default())
}

fn targets(calls: &Calls) -> Vec<Cycle> {
    calls.borrow().iter().map(|c| c.target.clone()).collect()
}

fn intact(maze: &Maze<SquareTessellation>, cycle: &Cycle) -> bool {
    cycle.iter().all(|&id| maze.graph.edge(id).is_some())
}

#[test]
fn apply_fails_when_nested_is_empty() {
    let (maze, triangle, square) = maze_with_two_disjoint_loops();
    let issue = group_issue(vec![triangle, square]);
    let (result, commands) = run(&issue, &maze, &no_params(), &[], 1);
    assert!(matches!(result, RepairResult::Failed));
    assert!(commands.is_empty());
}

#[test]
fn apply_succeeds_on_empty_invalid_list_even_without_nested() {
    let (maze, _, _) = maze_with_two_disjoint_loops();
    let (result, commands) = run(&group_issue(vec![]), &maze, &no_params(), &[], 1);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(commands.is_empty());
}

#[test]
fn apply_fails_when_nested_slot_id_does_not_match() {
    let (maze, triangle, square) = maze_with_two_disjoint_loops();
    let issue = group_issue(vec![triangle, square]);
    static OTHER_SLOT: NestedSlot = NestedSlot {
        slot_id: "some_other_slot",
        kind: INVALID_LOOP,
        min: 1,
        max: Some(1),
        dispatch_kind: NestedDispatchKind::Unordered,
    };
    let nested = vec![NestedStrategyConfig {
        slot: &OTHER_SLOT,
        strategy: Box::new(InvalidLoopRandomStrategy),
        param_overrides: HashMap::new(),
        nested: vec![],
    }];
    let (result, _) = run(&issue, &maze, &no_params(), &nested, 1);
    assert!(matches!(result, RepairResult::Failed));
}

#[test]
fn shortest_mode_visits_candidates_shortest_first() {
    let (maze, triangle, square) = maze_with_two_disjoint_loops();
    let issue = group_issue(vec![square.clone(), triangle.clone()]);
    let (calls, stub) = recorder(false);
    run(
        &issue,
        &maze,
        &params_with(&[(PARAM_SELECTION_MODE, SELECTION_SHORTEST)]),
        &nested_with(stub),
        1,
    );
    assert_eq!(targets(&calls), vec![triangle, square]);
}

#[test]
fn longest_mode_visits_candidates_longest_first() {
    let (maze, triangle, square) = maze_with_two_disjoint_loops();
    let issue = group_issue(vec![triangle.clone(), square.clone()]);
    let (calls, stub) = recorder(false);
    run(
        &issue,
        &maze,
        &params_with(&[(PARAM_SELECTION_MODE, SELECTION_LONGEST)]),
        &nested_with(stub),
        1,
    );
    assert_eq!(targets(&calls), vec![square, triangle]);
}

#[test]
fn random_mode_visits_every_candidate_once_and_is_seed_reproducible() {
    let (maze, triangle, square) = maze_with_two_disjoint_loops();
    let issue = group_issue(vec![triangle.clone(), square.clone()]);
    let order_for = |seed| {
        let (calls, stub) = recorder(false);
        run(
            &issue,
            &maze,
            &params_with(&[(PARAM_SELECTION_MODE, SELECTION_RANDOM)]),
            &nested_with(stub),
            seed,
        );
        targets(&calls)
    };
    let first = order_for(7);
    assert_eq!(first, order_for(7), "same seed must give the same order");
    let mut sorted = first.clone();
    sorted.sort();
    let mut expected = vec![triangle, square];
    expected.sort();
    assert_eq!(sorted, expected, "each candidate visited exactly once");
}

#[test]
fn every_independent_cycle_is_removed_in_one_apply() {
    let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
    let issue = group_issue(vec![triangle.clone(), square.clone()]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &InvalidLoopGroupSelectStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &cut_target_nested(),
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert!(!intact(&maze, &triangle), "triangle must be cut");
    assert!(!intact(&maze, &square), "square must be cut");
}

#[test]
fn shared_edge_removal_invalidates_the_other_cycle_without_a_second_nested_call() {
    let (maze, abc, abd, _) = bowtie_maze();
    let issue = group_issue(vec![abc.clone(), abd.clone()]);
    let (calls, stub) = recorder(true);
    let (result, commands) = run(&issue, &maze, &no_params(), &nested_with(stub), 1);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    // Both triangles start with the shared edge, so the first cut breaks both.
    assert_eq!(calls.borrow().len(), 1, "no duplicate nested repair");
    assert_eq!(commands.len(), 1);
}

/// Two triangles over the same three corridors, traversed in opposite directions, so they share
/// no `EdgeId` but every cut of one leg (with its reverse) breaks both.
fn opposite_direction_triangles() -> (Maze<SquareTessellation>, Cycle, Cycle) {
    opposite_direction_triangles_of(EdgeKind::Basic)
}

fn opposite_direction_triangles_of(kind: EdgeKind) -> (Maze<SquareTessellation>, Cycle, Cycle) {
    let mut ids = IdGenerator::new();
    let field: crate::space::MultiLevelField<SquareTessellation> =
        crate::space::MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids)
            .unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let n: Vec<_> = field
        .field_of(field_level)
        .unwrap()
        .all_cells()
        .map(|p| field.node_at(field_level, p).unwrap())
        .collect();
    let forward = vec![
        g.add_edge(n[0], n[1], kind),
        g.add_edge(n[1], n[2], kind),
        g.add_edge(n[2], n[0], kind),
    ];
    let backward = vec![
        g.add_edge(n[1], n[0], kind),
        g.add_edge(n[2], n[1], kind),
        g.add_edge(n[0], n[2], kind),
    ];
    (Maze::new(field, g), forward, backward)
}

#[test]
fn reverse_leg_removal_invalidates_the_opposite_direction_cycle() {
    let (maze, forward, backward) = opposite_direction_triangles();
    let issue = group_issue(vec![forward, backward]);
    let (calls, stub) = recorder(true);
    let (result, _) = run(&issue, &maze, &no_params(), &nested_with(stub), 1);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(
        calls.borrow().len(),
        1,
        "the reverse leg removed with the cut already broke the other cycle"
    );
}

#[test]
fn cycle_broken_by_matches_primary_and_reverse_ids_only() {
    let (maze, forward, backward) = opposite_direction_triangles();
    let cut = [MutationCommand::RemoveEdgeWithReverse { id: forward[0] }];
    assert!(cycle_broken_by(&forward, &cut, &maze), "primary id");
    assert!(cycle_broken_by(&backward, &cut, &maze), "reverse id");

    let plain = [MutationCommand::RemoveEdge { id: forward[0] }];
    assert!(cycle_broken_by(&forward, &plain, &maze));
    assert!(
        !cycle_broken_by(&backward, &plain, &maze),
        "a plain removal leaves the reverse leg in place"
    );
    assert!(!cycle_broken_by(&forward, &[], &maze));
}

#[test]
fn teleport_and_vertical_reverse_removals_resolve_their_opposite_leg() {
    for (kind, command) in [
        (
            EdgeKind::Teleport,
            (|id| MutationCommand::RemoveTeleportWithReverse { id }) as fn(EdgeId) -> _,
        ),
        (EdgeKind::VerticalPassage, |id| {
            MutationCommand::RemoveVerticalPassageWithReverse { id }
        }),
    ] {
        let (maze, forward, backward) = opposite_direction_triangles_of(kind);
        let cut = [command(forward[0])];
        assert!(
            cycle_broken_by(&backward, &cut, &maze),
            "{kind:?} reverse leg"
        );
        assert!(
            cycle_broken_by(&forward, &cut, &maze),
            "{kind:?} primary leg"
        );
    }
}

#[test]
fn nested_issue_carries_selected_cycle_other_live_cycles_and_original_valid_context() {
    let (maze, triangle, square) = maze_with_two_disjoint_loops();
    let valid_a: Cycle = vec![100, 101, 102];
    let valid_b: Cycle = vec![200, 201, 202, 203];
    let issue = group_issue_with_valid(
        vec![triangle.clone(), square.clone()],
        vec![valid_a.clone(), valid_b.clone()],
    );
    let (calls, stub) = recorder(true);
    run(
        &issue,
        &maze,
        &params_with(&[(PARAM_SELECTION_MODE, SELECTION_SHORTEST)]),
        &nested_with(stub),
        1,
    );
    let calls = calls.borrow();
    assert_eq!(calls.len(), 2);
    for call in calls.iter() {
        assert_eq!(
            call.invalid,
            vec![0],
            "the selected cycle is the only target"
        );
        assert_eq!(call.all[0], call.target);
        for valid in [&valid_a, &valid_b] {
            assert!(
                call.all.contains(valid),
                "original valid context must survive every nested call"
            );
        }
    }
    // First call (triangle) still sees the square as a live invalid cycle; second (square) sees
    // only valid context since the triangle was already handled.
    assert!(calls[0].all.contains(&square));
    assert_eq!(calls[0].all.len(), 4);
    assert!(!calls[1].all.contains(&triangle));
    assert_eq!(calls[1].all.len(), 3);
}

#[test]
fn failed_candidates_are_never_retried_and_batch_is_failed() {
    let (maze, triangle, square) = maze_with_two_disjoint_loops();
    let issue = group_issue(vec![triangle, square]);
    let (calls, stub) = recorder(false);
    let (result, commands) = run(&issue, &maze, &no_params(), &nested_with(stub), 1);
    assert!(matches!(result, RepairResult::Failed));
    assert!(commands.is_empty());
    assert_eq!(calls.borrow().len(), 2, "each candidate tried exactly once");
}

#[test]
fn apply_is_fixed_when_only_some_nested_calls_succeed() {
    // Stub cuts only the triangle; the square fails. One success is enough for `Fixed`, and the
    // successful call's commands are kept.
    struct CutsTriangleOnly;
    impl<T: Tessellation> RepairStrategy<T, InvalidLoopIssue> for CutsTriangleOnly {
        fn strategy_id(&self) -> &'static str {
            "cuts_triangle_only"
        }
        fn apply(
            &self,
            issue: &InvalidLoopIssue,
            _: &Maze<T>,
            _: &mut dyn RngCore,
            _: &StrategyParams,
            _: &PresetState,
            _: &[NestedStrategyConfig<T>],
        ) -> (RepairResult, Vec<MutationCommand>) {
            let target = &issue.all[issue.invalid[0]];
            if target.len() == 3 {
                (
                    RepairResult::Fixed { score: None },
                    vec![MutationCommand::RemoveEdge { id: target[0] }],
                )
            } else {
                (RepairResult::Failed, vec![])
            }
        }
    }
    crate::impl_erased_repair_strategy!(CutsTriangleOnly, InvalidLoopIssue);

    let (maze, triangle, square) = maze_with_two_disjoint_loops();
    let issue = group_issue(vec![triangle, square]);
    let (result, commands) = run(
        &issue,
        &maze,
        &no_params(),
        &nested_with(Box::new(CutsTriangleOnly)),
        1,
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(commands.len(), 1);
}

#[test]
fn apply_is_deterministic_for_fixed_seed() {
    let run_once = || {
        let (mut maze, triangle, square) = maze_with_two_disjoint_loops();
        let issue = group_issue(vec![triangle, square]);
        let mut rng = MazeRng::seed_from_u64(42);
        apply_and_commit(
            &InvalidLoopGroupSelectStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &no_params(),
            &PresetState::empty(),
            &cut_target_nested(),
        );
        maze.graph.edges().map(|e| e.id).collect::<Vec<_>>()
    };
    assert_eq!(run_once(), run_once());
}

/// `count` distinct synthetic cycles of `len` edge ids each, drawn deterministically from a pool of
/// `pool` ids so neighbouring cycles share edges. Ids need not exist in the maze graph.
fn synthetic_cycles(count: usize, len: usize, pool: usize) -> Vec<Cycle> {
    (0..count)
        .map(|i| {
            (0..len)
                .map(|j| ((i * 7 + j * 13 + (i * j) % 5) % pool) as EdgeId)
                .collect::<Cycle>()
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// `(target, others, valid)` of one nested call.
type LoggedCall = (Cycle, Vec<Cycle>, Vec<Cycle>);

/// Full call log of one large pass: `(target, others, valid)` per nested call, plus commands.
fn large_pass(
    mode: &str,
    seed: u64,
    cycles: &[Cycle],
    valid: &[Cycle],
) -> (Vec<LoggedCall>, Vec<MutationCommand>) {
    let (maze, ..) = maze_with_two_disjoint_loops();
    let issue = group_issue_with_valid(cycles.to_vec(), valid.to_vec());
    let (calls, rec) = recorder(true);
    let (result, commands) = run(
        &issue,
        &maze,
        &params_with(&[(PARAM_SELECTION_MODE, mode)]),
        &nested_with(rec),
        seed,
    );
    assert!(matches!(result, RepairResult::Fixed { .. }));
    let log = calls
        .borrow()
        .iter()
        .map(|c| {
            let others_end = c.all.len() - valid.len();
            (
                c.target.clone(),
                c.all[1..others_end].to_vec(),
                c.all[others_end..].to_vec(),
            )
        })
        .collect();
    (log, commands)
}

#[test]
fn large_pass_is_reproducible_and_keeps_nested_context_invariants() {
    let cycles = synthetic_cycles(400, 10, 900);
    let valid = vec![vec![5000, 5001, 5002], vec![5003, 5004, 5005]];
    for mode in [SELECTION_RANDOM, SELECTION_LONGEST, SELECTION_SHORTEST] {
        let (log, commands) = large_pass(mode, 7, &cycles, &valid);
        assert_eq!(
            large_pass(mode, 7, &cycles, &valid),
            (log.clone(), commands.clone())
        );
        assert!(
            log.len() > 10,
            "{mode}: scenario must exercise many nested calls"
        );

        // Replays the pass: each call's `others` must be exactly the ascending, still-unbroken
        // cycles other than the target, and `valid` must be passed through untouched.
        let mut removed: HashSet<EdgeId> = HashSet::new();
        let mut visited: HashSet<Cycle> = HashSet::new();
        for (target, others, call_valid) in &log {
            assert!(
                visited.insert(target.clone()),
                "{mode}: target visited twice"
            );
            assert_eq!(call_valid, &valid);
            assert!(!others.contains(target));
            assert!(
                others.windows(2).all(|w| w[0] < w[1]),
                "{mode}: others not ascending"
            );
            for other in others {
                assert!(
                    !other.iter().any(|e| removed.contains(e)),
                    "{mode}: already-broken cycle leaked into `others`"
                );
            }
            removed.insert(target[0]);
        }
        // The Recorder cuts `target[0]` only, so every cycle ends up either visited or broken by
        // a cut of one of its edges.
        for cycle in &cycles {
            assert!(
                visited.contains(cycle) || cycle.iter().any(|e| removed.contains(e)),
                "{mode}: a flagged cycle was neither fixed nor invalidated"
            );
        }
        assert_eq!(commands.len(), log.len());
    }
}

/// Manual timing of the candidate pass at scale (GitHub issue #904): the nested stub does O(1)
/// work, so the time is the engine's own `others`/invalidation cost.
/// `cargo test -p maze-core --release --lib candidate_pass_scale -- --ignored --nocapture`
#[test]
#[ignore = "manual profiling aid"]
fn candidate_pass_scale_timing() {
    let cycles = synthetic_cycles(5000, 10, 20_000);
    let start = std::time::Instant::now();
    let (log, _) = large_pass(SELECTION_RANDOM, 1, &cycles, &[]);
    println!(
        "cycles={} nested_calls={} elapsed={:?}",
        cycles.len(),
        log.len(),
        start.elapsed()
    );
}

/// `side x side` grid with one directed ring per unit square, all flagged invalid -- a realistic
/// graph for the real nested strategies (`(side - 1)^2` cycles of 4 edges, adjacent rings sharing
/// a corridor in opposite directions).
fn ring_grid(side: i32) -> (Maze<SquareTessellation>, Vec<Cycle>) {
    use crate::space::SquarePoint;
    let mut ids = IdGenerator::new();
    let field = crate::space::MultiLevelField::single_level(
        Arc::default(),
        square_rect(side as usize, side as usize),
        &mut ids,
    )
    .unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let node = |x: i32, y: i32| field.node_at(level, SquarePoint { x, y }).unwrap();
    let mut edge_ids: HashMap<(i32, i32, i32, i32), EdgeId> = HashMap::new();
    let mut edge = |g: &mut Graph, a: (i32, i32), b: (i32, i32)| {
        *edge_ids
            .entry((a.0, a.1, b.0, b.1))
            .or_insert_with(|| g.add_edge(node(a.0, a.1), node(b.0, b.1), EdgeKind::Basic))
    };
    let mut cycles = Vec::new();
    for y in 0..side - 1 {
        for x in 0..side - 1 {
            let ring = [(x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1), (x, y)];
            cycles.push(
                ring.windows(2)
                    .map(|w| edge(&mut g, w[0], w[1]))
                    .collect::<Cycle>(),
            );
        }
    }
    (Maze::new(field, g), cycles)
}

/// Manual timing of the whole pass with the REAL nested strategy (GitHub issue #904), to split the
/// cost between the engine and `InvalidLoopScoredStrategy`'s own overlap computation. Compare with
/// `candidate_pass_scale_timing` (O(1) nested stub, same cycle count).
/// `cargo test -p maze-core --release --lib candidate_pass_real_nested -- --ignored --nocapture`
#[test]
#[ignore = "manual profiling aid"]
fn candidate_pass_real_nested_timing() {
    let (maze, cycles) = ring_grid(72);
    let issue = group_issue(cycles.clone());
    for (label, nested) in [
        (
            "scored",
            nested_with(Box::new(
                crate::repair::strategies::InvalidLoopScoredStrategy,
            )),
        ),
        ("random", cut_target_nested()),
    ] {
        let start = std::time::Instant::now();
        let (result, commands) = run(&issue, &maze, &no_params(), &nested, 1);
        println!(
            "nested={label} cycles={} fixed={} commands={} elapsed={:?}",
            cycles.len(),
            matches!(result, RepairResult::Fixed { .. }),
            commands.len(),
            start.elapsed()
        );
    }
}

#[test]
fn sampling_params_are_gone() {
    let ids: Vec<&str> = <InvalidLoopGroupSelectStrategy as RepairStrategy<
        SquareTessellation,
        InvalidLoopGroupIssue,
    >>::params(&InvalidLoopGroupSelectStrategy)
    .iter()
    .map(|p| p.id)
    .collect();
    assert_eq!(ids, vec![PARAM_SELECTION_MODE]);
}
