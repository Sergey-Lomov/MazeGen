// GitHub issue #337 — VerticalPassage/Elevator generation tests.
use super::tests::{default_params, empty_presets, generate_default_split, no_split};
use super::*;
use crate::generation::test_utils::default_elements;
use crate::space::{Field, SquarePoint, square_rect};
use std::sync::Arc;

fn multi_floor_field(
    w: usize,
    h: usize,
    floors: usize,
) -> (
    MultiLevelField<crate::space::SquareTessellation>,
    Graph,
    IdGenerator,
) {
    let mut ids = IdGenerator::new();
    let fields: Vec<Field<crate::space::SquareTessellation>> = (0..floors)
        .map(|_| Field::new(Arc::default(), square_rect(w, h), &mut ids).unwrap())
        .collect();
    let mf = MultiLevelField::new(Arc::default(), fields);
    let mut graph = Graph::new();
    for node in mf.all_node_ids() {
        graph.add_node(node);
    }
    (mf, graph, ids)
}

fn node_at(
    field: &MultiLevelField<crate::space::SquareTessellation>,
    level_idx: usize,
    x: i32,
    y: i32,
) -> NodeId {
    let level = field.levels_ordered().nth(level_idx).unwrap();
    field.node_at(level, SquarePoint { x, y }).unwrap()
}

fn state_with_visited(graph: &Graph, start: NodeId, extra_visited: &[NodeId]) -> GenState {
    let mut state = GenState::new(graph, 1, start);
    for &n in extra_visited {
        state.visited.insert(n);
    }
    state
}

// --- longest_consecutive_run (pure helper, direct coverage) ---

#[test]
fn longest_consecutive_run_empty_input_yields_empty() {
    let (field, _graph, _ids) = multi_floor_field(1, 1, 3);
    assert_eq!(longest_consecutive_run(&field, &[]), Vec::<NodeId>::new());
}

#[test]
fn longest_consecutive_run_single_candidate_yields_itself() {
    let (field, _graph, _ids) = multi_floor_field(1, 1, 3);
    let n1 = node_at(&field, 1, 0, 0);
    assert_eq!(longest_consecutive_run(&field, &[n1]), vec![n1]);
}

#[test]
fn longest_consecutive_run_all_consecutive_returns_all_in_order() {
    let (field, _graph, _ids) = multi_floor_field(1, 1, 4);
    let (n1, n2, n3) = (
        node_at(&field, 1, 0, 0),
        node_at(&field, 2, 0, 0),
        node_at(&field, 3, 0, 0),
    );
    // Passed out of order — the function sorts by level position internally.
    let run = longest_consecutive_run(&field, &[n3, n1, n2]);
    assert_eq!(run, vec![n1, n2, n3]);
}

#[test]
fn longest_consecutive_run_picks_the_longer_of_two_runs() {
    // 6 floors: candidates at positions 1,2 (run of 2) and 4,5,6->only 5 floors exist so use 0..5
    // Levels: 0(src, excluded by caller convention but harmless here), 1,2 (run A, len 2), 4 (run B, len 1).
    let (field, _graph, _ids) = multi_floor_field(1, 1, 5);
    let (n1, n2, n4) = (
        node_at(&field, 1, 0, 0),
        node_at(&field, 2, 0, 0),
        node_at(&field, 4, 0, 0),
    );
    let run = longest_consecutive_run(&field, &[n1, n2, n4]);
    assert_eq!(run, vec![n1, n2]);
}

#[test]
fn longest_consecutive_run_first_run_wins_on_a_tie() {
    // Two runs of equal length (positions {1,2} and {4,5}) — first-encountered-by-position run wins,
    // since the function only replaces `best` on strictly-greater length.
    let (field, _graph, _ids) = multi_floor_field(1, 1, 6);
    let (n1, n2, n4, n5) = (
        node_at(&field, 1, 0, 0),
        node_at(&field, 2, 0, 0),
        node_at(&field, 4, 0, 0),
        node_at(&field, 5, 0, 0),
    );
    let run = longest_consecutive_run(&field, &[n1, n2, n4, n5]);
    assert_eq!(run, vec![n1, n2]);
}

// --- Elevator floor-count algorithm ---

#[test]
fn elevator_respects_span_min_and_max_clamp() {
    // 5 floors total => 4 unvisited candidates for src on floor 0. span_max=3 means the elevator
    // (src + chosen floors) must top out at 3 total floors, i.e. at most 2 chosen from the pool.
    let (field, mut graph, _ids) = multi_floor_field(2, 2, 5);
    let src = node_at(&field, 0, 0, 0);
    let mut state = GenState::new(&graph, 1, src);
    let elements = ElementsConfig {
        elevator_span_min: 2,
        elevator_span_max: 3,
        elevator_branching: 1.0,
        ..default_elements()
    };
    let preset = empty_presets();
    let built = try_elevator(
        &mut graph, &field, &elements, &preset, &mut state, src, false, None,
    );
    assert!(
        built,
        "elevator should build with 4 unvisited candidate floors available"
    );

    let elevator_edges: Vec<_> = graph
        .edges()
        .filter(|e| e.kind == EdgeKind::Elevator)
        .collect();
    let node_set: std::collections::HashSet<NodeId> =
        elevator_edges.iter().flat_map(|e| [e.from, e.to]).collect();
    assert_eq!(
        node_set.len(),
        3,
        "span_max=3 with branching=1.0 (always grow) must land exactly on the max, got {} nodes",
        node_set.len()
    );
}

#[test]
fn elevator_branching_zero_always_picks_span_min() {
    let (field, mut graph, _ids) = multi_floor_field(2, 2, 5);
    let src = node_at(&field, 0, 0, 0);
    let elements = ElementsConfig {
        elevator_span_min: 2,
        elevator_span_max: 5,
        elevator_branching: 0.0,
        ..default_elements()
    };
    let preset = empty_presets();
    for seed in 0..20 {
        let mut g = graph.clone();
        let mut state = GenState::new(&g, seed, src);
        let built = try_elevator(
            &mut g, &field, &elements, &preset, &mut state, src, false, None,
        );
        assert!(built);
        let node_set: std::collections::HashSet<NodeId> = g
            .edges()
            .filter(|e| e.kind == EdgeKind::Elevator)
            .flat_map(|e| [e.from, e.to])
            .collect();
        assert_eq!(
            node_set.len(),
            2,
            "seed {seed}: branching=0.0 must always pick exactly span_min floors"
        );
    }
    let _ = &mut graph;
}

#[test]
fn elevator_min_equals_max_slots_rolls_zero_times() {
    // Only 1 unvisited candidate floor exists (2 floors total besides src's own == impossible
    // here; use 2 floors so exactly 1 candidate), span_min == max_slots => no branching roll,
    // deterministic regardless of seed.
    let (field, graph, _ids) = multi_floor_field(2, 2, 2);
    let src = node_at(&field, 0, 0, 0);
    let elements = ElementsConfig {
        elevator_span_min: 2,
        elevator_span_max: 2,
        elevator_branching: 0.5,
        ..default_elements()
    };
    let preset = empty_presets();
    for seed in 0..20 {
        let mut g = graph.clone();
        let mut state = GenState::new(&g, seed, src);
        let built = try_elevator(
            &mut g, &field, &elements, &preset, &mut state, src, false, None,
        );
        assert!(
            built,
            "seed {seed}: exactly span_min candidates available, must succeed deterministically"
        );
        let node_set: std::collections::HashSet<NodeId> = g
            .edges()
            .filter(|e| e.kind == EdgeKind::Elevator)
            .flat_map(|e| [e.from, e.to])
            .collect();
        assert_eq!(node_set.len(), 2);
    }
}

#[test]
fn elevator_fails_when_max_slots_below_span_min() {
    // Only 2 floors total => 1 unvisited candidate, but span_min=3 is unreachable.
    let (field, mut graph, _ids) = multi_floor_field(2, 2, 2);
    let src = node_at(&field, 0, 0, 0);
    let mut state = GenState::new(&graph, 1, src);
    let elements = ElementsConfig {
        elevator_span_min: 3,
        elevator_span_max: 5,
        ..default_elements()
    };
    let preset = empty_presets();
    let built = try_elevator(
        &mut graph, &field, &elements, &preset, &mut state, src, false, None,
    );
    assert!(
        !built,
        "only 1 unvisited candidate floor exists, span_min=3 must fail"
    );
    assert_eq!(
        graph
            .edges()
            .filter(|e| e.kind == EdgeKind::Elevator)
            .count(),
        0,
        "a failed elevator attempt must not add any edges (transactional)"
    );
}

#[test]
fn elevator_non_consecutive_toggle_off_clamps_to_contiguous_run() {
    // 5 floors: src on floor 0. Mark floor 2 visited (a gap), leaving floors 1 and 3,4 unvisited
    // but non-contiguous (1 alone, then 3-4 contiguous). With the toggle off, the pool must clamp
    // to the longest contiguous run (3,4 => len 2), not the full unvisited set (len 3).
    let (field, graph, _ids) = multi_floor_field(2, 2, 5);
    let src = node_at(&field, 0, 0, 0);
    let visited_gap = node_at(&field, 2, 0, 0);
    let mut state = state_with_visited(&graph, src, &[visited_gap]);
    let elements = ElementsConfig {
        elevator_span_min: 2,
        elevator_span_max: 10,
        elevator_branching: 1.0,
        allow_non_consecutive_elevator_floors: false,
        ..default_elements()
    };
    let preset = empty_presets();
    let mut g = graph;
    let built = try_elevator(
        &mut g, &field, &elements, &preset, &mut state, src, false, None,
    );
    assert!(built);
    let node_set: std::collections::HashSet<NodeId> = g
        .edges()
        .filter(|e| e.kind == EdgeKind::Elevator)
        .flat_map(|e| [e.from, e.to])
        .collect();
    // src + contiguous run {3,4} = 3 nodes max, never includes floor 1 (isolated) alongside both
    // 3 and 4 in a way that exceeds the contiguous-run clamp.
    assert!(
        node_set.len() <= 3,
        "non-consecutive floors must be excluded from the growth pool when the toggle is off, got {} nodes",
        node_set.len()
    );
}

#[test]
fn elevator_non_consecutive_toggle_on_allows_full_pool() {
    let (field, graph, _ids) = multi_floor_field(2, 2, 5);
    let src = node_at(&field, 0, 0, 0);
    let visited_gap = node_at(&field, 2, 0, 0);
    let mut state = state_with_visited(&graph, src, &[visited_gap]);
    let elements = ElementsConfig {
        elevator_span_min: 2,
        elevator_span_max: 10,
        elevator_branching: 1.0,
        allow_non_consecutive_elevator_floors: true,
        ..default_elements()
    };
    let preset = empty_presets();
    let mut g = graph;
    let built = try_elevator(
        &mut g, &field, &elements, &preset, &mut state, src, false, None,
    );
    assert!(built);
    let node_set: std::collections::HashSet<NodeId> = g
        .edges()
        .filter(|e| e.kind == EdgeKind::Elevator)
        .flat_map(|e| [e.from, e.to])
        .collect();
    // src + floors {1,3,4} all eligible (floor 2 is visited/excluded) = up to 4 nodes.
    assert_eq!(
        node_set.len(),
        4,
        "toggle on: all 3 unvisited floors (1,3,4) should be reachable despite the gap"
    );
}

#[test]
fn elevator_cyclic_context_guarantees_one_visited_floor_and_allows_gap() {
    // Cyclic elevator: exactly one visited floor (floor 2) must be included, even though it's not
    // contiguous with the unvisited run (floors 3,4) — the plan explicitly excludes the cyclic
    // floor from the consecutive-run constraint.
    let (field, graph, _ids) = multi_floor_field(2, 2, 5);
    let src = node_at(&field, 0, 0, 0);
    let visited_floor = node_at(&field, 2, 0, 0);
    let mut state = state_with_visited(&graph, src, &[visited_floor]);
    let elements = ElementsConfig {
        elevator_span_min: 2,
        elevator_span_max: 10,
        elevator_branching: 1.0,
        allow_non_consecutive_elevator_floors: false,
        ..default_elements()
    };
    let preset = empty_presets();
    let mut g = graph;
    let built = try_elevator(
        &mut g, &field, &elements, &preset, &mut state, src, true, None,
    );
    assert!(
        built,
        "cyclic elevator with one visited floor available must succeed"
    );
    let node_set: std::collections::HashSet<NodeId> = g
        .edges()
        .filter(|e| e.kind == EdgeKind::Elevator)
        .flat_map(|e| [e.from, e.to])
        .collect();
    assert!(
        node_set.contains(&visited_floor),
        "the guaranteed visited floor must be part of the elevator's node set"
    );
}

#[test]
fn elevator_cyclic_context_fails_without_any_visited_floor() {
    let (field, mut graph, _ids) = multi_floor_field(2, 2, 3);
    let src = node_at(&field, 0, 0, 0);
    let mut state = GenState::new(&graph, 1, src);
    let elements = ElementsConfig {
        elevator_span_min: 2,
        elevator_span_max: 10,
        ..default_elements()
    };
    let preset = empty_presets();
    let built = try_elevator(
        &mut graph, &field, &elements, &preset, &mut state, src, true, None,
    );
    assert!(
        !built,
        "cyclic elevator attempt with no visited floor at all must fail (nothing to realize)"
    );
}

#[test]
fn elevator_deterministic_cyclic_floor_pick_with_multiple_visited_candidates() {
    // Two visited floors available (2 and 3) — the cyclic slot must pick the first by
    // levels_ordered() position deterministically, not via an RNG roll.
    let (field, graph, _ids) = multi_floor_field(2, 2, 5);
    let src = node_at(&field, 0, 0, 0);
    let visited_a = node_at(&field, 2, 0, 0);
    let visited_b = node_at(&field, 3, 0, 0);
    let elements = ElementsConfig {
        elevator_span_min: 2,
        elevator_span_max: 2,
        ..default_elements()
    };
    let preset = empty_presets();
    for seed in 0..10 {
        let mut state = state_with_visited(&graph, src, &[visited_a, visited_b]);
        state.rng = MazeRng::seed_from_u64(seed);
        let mut g = graph.clone();
        let built = try_elevator(
            &mut g, &field, &elements, &preset, &mut state, src, true, None,
        );
        assert!(built);
        let node_set: std::collections::HashSet<NodeId> = g
            .edges()
            .filter(|e| e.kind == EdgeKind::Elevator)
            .flat_map(|e| [e.from, e.to])
            .collect();
        assert!(
            node_set.contains(&visited_a),
            "seed {seed}: first visited floor by levels_ordered() position must always be chosen"
        );
        assert!(
            !node_set.contains(&visited_b),
            "seed {seed}: only one visited floor should be included when span caps at 2"
        );
    }
}

// --- Elevator fail -> VerticalPassage fallback (growth context) ---

#[test]
fn elevator_fail_falls_back_to_vertical_passage_in_growth_context() {
    // 2 floors only, span_min=3 makes elevator impossible; balance close to (but not exactly)
    // 1.0 still strongly prefers elevator via roll_vertical_balance, so pin the RNG seed until
    // it lands on the elevator branch, then confirm the passage fallback kicks in.
    let (field, graph, _ids) = multi_floor_field(2, 2, 2);
    let src = node_at(&field, 0, 0, 0);
    let elements = ElementsConfig {
        elevator_span_min: 3,
        elevator_span_max: 5,
        vertical_passage_elevator_balance: 0.999999, // near-certain elevator roll, but not == 1.0
        ..default_elements()
    };
    let preset = empty_presets();
    let mut found = false;
    for seed in 0..50 {
        let mut g = graph.clone();
        let mut state = GenState::new(&g, seed, src);
        try_vertical_growth_connect(&mut g, &field, &elements, &preset, &mut state, src, None);
        let passage_edges = g
            .edges()
            .filter(|e| e.kind == EdgeKind::VerticalPassage)
            .count();
        if passage_edges > 0 {
            found = true;
            break;
        }
    }
    assert!(
        found,
        "elevator fail (span_min unreachable) must fall back to a VerticalPassage edge when balance != 1.0"
    );
}

#[test]
fn elevator_fail_blocked_fallback_when_balance_fully_committed_to_elevator() {
    let (field, mut graph, _ids) = multi_floor_field(2, 2, 2);
    let src = node_at(&field, 0, 0, 0);
    let mut state = GenState::new(&graph, 1, src);
    let elements = ElementsConfig {
        elevator_span_min: 3,
        elevator_span_max: 5,
        vertical_passage_elevator_balance: 1.0, // balance == 1.0 blocks the fallback to passage
        ..default_elements()
    };
    let preset = empty_presets();
    try_vertical_growth_connect(
        &mut graph, &field, &elements, &preset, &mut state, src, None,
    );
    assert_eq!(
        graph.edges().count(),
        0,
        "balance == 1.0 must block the elevator-fail -> passage fallback entirely"
    );
}

#[test]
fn passage_fail_falls_back_to_elevator_in_growth_context() {
    // Force VerticalPassage to fail: make the only adjacent-floor node already visited so the
    // growth-context passage attempt (target must be unvisited) fails. Balance close to (but not
    // exactly) 0.0 still picks passage first via roll_vertical_balance, while leaving the
    // elevator fallback un-blocked (balance == 0.0 would block it per the plan's rule).
    let (field, graph, _ids) = multi_floor_field(2, 2, 3);
    let src = node_at(&field, 0, 0, 0);
    let up_neighbor = node_at(&field, 1, 0, 0);
    let elements = ElementsConfig {
        vertical_passage_elevator_balance: 0.000001, // near-certain passage roll, but not == 0.0
        elevator_span_min: 2,
        elevator_span_max: 2,
        ..default_elements()
    };
    let preset = empty_presets();
    let mut found = false;
    for seed in 0..50 {
        let mut g = graph.clone();
        let mut state = state_with_visited(&graph, src, &[up_neighbor]);
        state.rng = MazeRng::seed_from_u64(seed);
        try_vertical_growth_connect(&mut g, &field, &elements, &preset, &mut state, src, None);
        if g.edges().any(|e| e.kind == EdgeKind::Elevator) {
            found = true;
            break;
        }
    }
    assert!(
        found,
        "passage fail (only neighbor already visited) must fall back to elevator when balance != 0.0"
    );
}

#[test]
fn passage_fail_blocked_fallback_when_balance_fully_committed_to_passage() {
    let (field, graph, _ids) = multi_floor_field(2, 2, 3);
    let src = node_at(&field, 0, 0, 0);
    let up_neighbor = node_at(&field, 1, 0, 0);
    let mut state = state_with_visited(&graph, src, &[up_neighbor]);
    let elements = ElementsConfig {
        vertical_passage_elevator_balance: 0.0, // balance == 0.0 blocks the fallback to elevator
        elevator_span_min: 2,
        elevator_span_max: 2,
        ..default_elements()
    };
    let preset = empty_presets();
    let mut g = graph;
    try_vertical_growth_connect(&mut g, &field, &elements, &preset, &mut state, src, None);
    assert_eq!(
        g.edges().count(),
        0,
        "balance == 0.0 must block the passage-fail -> elevator fallback entirely"
    );
}

// --- node_at -> None on differently-shaped floors ---

#[test]
fn resolve_vertical_passage_target_none_when_node_at_misses() {
    let mut ids = IdGenerator::new();
    let bottom =
        Field::<crate::space::SquareTessellation>::new(Arc::default(), square_rect(3, 3), &mut ids)
            .unwrap();
    // Top floor is smaller — (2,2) doesn't exist there.
    let top = Field::new(Arc::default(), square_rect(2, 2), &mut ids).unwrap();
    let mf = MultiLevelField::new(Arc::default(), vec![bottom, top]);

    let bottom_level = mf.levels_ordered().next().unwrap();
    let corner = mf
        .node_at(bottom_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    assert_eq!(
        resolve_vertical_passage_target(&mf, corner, true),
        None,
        "top floor has no (2,2) cell, must resolve to None, not panic or guess"
    );
}

#[test]
fn elevator_floor_candidates_skips_floors_missing_node_at() {
    let mut ids = IdGenerator::new();
    let bottom =
        Field::<crate::space::SquareTessellation>::new(Arc::default(), square_rect(3, 3), &mut ids)
            .unwrap();
    let small_top = Field::new(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
    let full_top = Field::new(Arc::default(), square_rect(3, 3), &mut ids).unwrap();
    let mf = MultiLevelField::new(Arc::default(), vec![bottom, small_top, full_top]);

    let bottom_level = mf.levels_ordered().next().unwrap();
    let corner = mf
        .node_at(bottom_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let candidates = elevator_floor_candidates(&mf, corner);
    assert_eq!(
        candidates.len(),
        1,
        "the 1x1 middle floor has no (2,2) cell and must be excluded, only the full-size top floor remains"
    );
}

// --- VerticalPassage boundary cases ---

#[test]
fn resolve_vertical_passage_target_on_bottom_boundary_has_no_downward_neighbor() {
    let (field, _graph, _ids) = multi_floor_field(2, 2, 3);
    let src = node_at(&field, 0, 0, 0); // bottom floor
    assert_eq!(
        resolve_vertical_passage_target(&field, src, false),
        None,
        "the bottom floor has no floor below it"
    );
    assert!(
        resolve_vertical_passage_target(&field, src, true).is_some(),
        "the bottom floor still has an upward neighbor"
    );
}

#[test]
fn resolve_vertical_passage_target_on_top_boundary_has_no_upward_neighbor() {
    let (field, _graph, _ids) = multi_floor_field(2, 2, 3);
    let src = node_at(&field, 2, 0, 0); // top floor
    assert_eq!(
        resolve_vertical_passage_target(&field, src, true),
        None,
        "the top floor has no floor above it"
    );
    assert!(
        resolve_vertical_passage_target(&field, src, false).is_some(),
        "the top floor still has a downward neighbor"
    );
}

#[test]
fn growth_vertical_passage_on_boundary_floor_uses_the_single_available_neighbor() {
    // Bottom floor: only "upward" resolves. The growth-context passage attempt must still
    // succeed via that sole candidate, no special-casing needed at the call site.
    let (field, graph, _ids) = multi_floor_field(2, 2, 3);
    let src = node_at(&field, 0, 0, 0);
    let mut state = GenState::new(&graph, 1, src);
    let elements = default_elements();
    let preset = empty_presets();
    let mut g = graph;
    let built =
        try_growth_vertical_passage(&mut g, &field, &elements, &preset, &mut state, src, None);
    assert!(built);
    let passage_targets: std::collections::HashSet<NodeId> = g
        .edges()
        .filter(|e| e.kind == EdgeKind::VerticalPassage)
        .flat_map(|e| [e.from, e.to])
        .filter(|&n| n != src)
        .collect();
    assert_eq!(passage_targets.len(), 1);
    assert_eq!(
        *passage_targets.iter().next().unwrap(),
        node_at(&field, 1, 0, 0),
        "boundary floor's only possible target is its single upward neighbor"
    );
}

// --- RNG-parity: single-floor mazes must not roll vertical/cross-floor-teleport at all ---

#[test]
fn single_floor_run_ordinary_step_body_consumes_identical_rng_regardless_of_vertical_params() {
    // GitHub issue #337's RNG-parity policy: vertical_chance/cross_floor_teleport_balance rolls
    // are gated on field.level_count() > 1. On a single-floor field, setting those params to
    // extreme "always fire" values must not change the RNG sequence consumed at all, compared to
    // leaving them at their off defaults — proving the roll is genuinely skipped, not just a
    // no-op branch that still consumes randomness.
    let (field, graph, _ids) = multi_floor_field(4, 4, 1);
    let src = node_at(&field, 0, 0, 0);
    let params = default_params();
    let elements = default_elements();

    let mut state_a = GenState::new(&graph, 99, src);
    let mut g_a = graph.clone();
    run_ordinary_step_body_for_node(
        &mut g_a,
        &field,
        &params,
        &elements,
        &empty_presets(),
        &mut state_a,
        src,
        None,
        true,
        None,
        None,
    );

    let extreme_elements = ElementsConfig {
        vertical_chance: 1.0,
        vertical_passage_elevator_balance: 0.5,
        one_way_vertical_passage_chance: 1.0,
        vertical_up_down_balance: 0.5,
        cross_floor_teleport_balance: 1.0,
        ..default_elements()
    };
    let mut state_b = GenState::new(&graph, 99, src);
    let mut g_b = graph;
    run_ordinary_step_body_for_node(
        &mut g_b,
        &field,
        &params,
        &extreme_elements,
        &empty_presets(),
        &mut state_b,
        src,
        None,
        true,
        None,
        None,
    );

    let mut edges_a: Vec<_> = g_a.edges().map(|e| (e.from, e.to, e.kind)).collect();
    let mut edges_b: Vec<_> = g_b.edges().map(|e| (e.from, e.to, e.kind)).collect();
    edges_a.sort();
    edges_b.sort();
    assert_eq!(
        edges_a, edges_b,
        "single-floor field: extreme vertical/cross-floor params must have zero effect on the resulting graph"
    );

    // Also confirm the RNG cursor itself ended up in the same place, not just that the (possibly
    // still-different) rolls happened to produce the same edges by coincidence.
    let next_a = state_a.rng.random::<f64>();
    let next_b = state_b.rng.random::<f64>();
    assert_eq!(
        next_a, next_b,
        "RNG sequence must be byte-identical after the step on a single-floor field"
    );
}

// --- Teleport-cyclic geometric fallback (GitHub issue #337, floor_count-independent) ---

#[test]
fn cyclic_with_teleport_falls_back_to_geometric_candidates_when_widened_pool_is_empty() {
    // The teleport-widened pool (state.all_nodes) is always a superset of the geometric pool
    // (field.neighbors(src)) under identical visited/can_connect/edge_between filters, so the
    // fallback path only ever triggers when the geometric pool is *also* empty — in which case
    // both return (None, false). This test pins that invariant: with no visited node anywhere
    // besides src, the cyclic edge fails cleanly (no candidate found, teleport roll not spent),
    // rather than panicking or silently mis-reporting the teleport roll as consumed.
    let (field, graph, _ids) = multi_floor_field(3, 1, 1);
    let src = node_at(&field, 0, 1, 0);
    let mut state = GenState::new(&graph, 1, src);
    let preset = empty_presets();
    let (dst, teleport_spent) =
        roll_cyclic_edge(&graph, &field, &preset, &mut state, src, true, true, None);
    assert_eq!(
        dst, None,
        "no visited node anywhere else in the graph, both widened and geometric pools are empty"
    );
    assert!(
        !teleport_spent,
        "a failed cyclic attempt must not report the teleport roll as spent"
    );
}

#[test]
fn cyclic_with_teleport_widened_pool_finds_a_non_geometric_visited_node() {
    // The widened pool's whole purpose: it can find a cyclic target that is visited but NOT a
    // geometric neighbor of src (impossible for the plain geometric pool). Confirms the widened
    // branch actually returns teleport_spent == true when it succeeds.
    let (field, graph, _ids) = multi_floor_field(5, 1, 1);
    let src = node_at(&field, 0, 2, 0); // middle node
    let far = node_at(&field, 0, 0, 0); // not a geometric neighbor of src
    let mut state = state_with_visited(&graph, src, &[far]);
    let preset = empty_presets();
    let (dst, teleport_spent) =
        roll_cyclic_edge(&graph, &field, &preset, &mut state, src, true, true, None);
    assert_eq!(
        dst,
        Some(far),
        "the widened pool must reach a visited node that isn't a geometric neighbor"
    );
    assert!(
        teleport_spent,
        "a widened-pool hit must report the teleport roll as spent on this edge"
    );
}

#[test]
fn cyclic_without_teleport_still_uses_geometric_candidates_only() {
    let (field, graph, _ids) = multi_floor_field(3, 1, 1);
    let src = node_at(&field, 0, 1, 0);
    let left = node_at(&field, 0, 0, 0);
    let mut state = state_with_visited(&graph, src, &[left]);
    let preset = empty_presets();
    let (dst, teleport_spent) =
        roll_cyclic_edge(&graph, &field, &preset, &mut state, src, true, false, None);
    assert_eq!(dst, Some(left));
    assert!(!teleport_spent);
}

// --- Cross-floor teleport balance: fallback at extreme balance values ---

#[test]
fn cross_floor_teleport_balance_one_falls_back_to_same_floor_when_other_floor_pool_empty() {
    // balance == 1.0 means "always prefer other floor" — but if no other-floor candidate exists
    // in the pool, the fallback to same-floor must still happen (extreme value = strong
    // preference, not a hard ban per the plan).
    let (field, graph, _ids) = multi_floor_field(2, 2, 2);
    let src = node_at(&field, 0, 0, 0);
    let same_floor_candidate = node_at(&field, 0, 1, 0);
    let mut state = GenState::new(&graph, 1, src);
    let elements = ElementsConfig {
        cross_floor_teleport_balance: 1.0,
        ..default_elements()
    };
    let pool = vec![same_floor_candidate];
    let result =
        filter_teleport_pool_by_floor(&field, &elements, &mut state, src, pool.clone(), None);
    assert_eq!(
        result, pool,
        "other-floor pool is empty; balance==1.0 must still fall back to the same-floor candidates"
    );
}

#[test]
fn cross_floor_teleport_balance_zero_falls_back_to_other_floor_when_same_floor_pool_empty() {
    let (field, graph, _ids) = multi_floor_field(2, 2, 2);
    let src = node_at(&field, 0, 0, 0);
    let other_floor_candidate = node_at(&field, 1, 0, 0);
    let mut state = GenState::new(&graph, 1, src);
    let elements = ElementsConfig {
        cross_floor_teleport_balance: 0.0,
        ..default_elements()
    };
    let pool = vec![other_floor_candidate];
    let result =
        filter_teleport_pool_by_floor(&field, &elements, &mut state, src, pool.clone(), None);
    assert_eq!(
        result, pool,
        "same-floor pool is empty; balance==0.0 must still fall back to the other-floor candidates"
    );
}

#[test]
fn cross_floor_teleport_prefers_matching_group_when_both_non_empty() {
    let (field, graph, _ids) = multi_floor_field(2, 2, 2);
    let src = node_at(&field, 0, 0, 0);
    let same_floor = node_at(&field, 0, 1, 0);
    let other_floor = node_at(&field, 1, 0, 0);
    let mut state = GenState::new(&graph, 1, src);
    let pool = vec![same_floor, other_floor];

    let elements_prefer_other = ElementsConfig {
        cross_floor_teleport_balance: 1.0,
        ..default_elements()
    };
    let mut state_a = GenState::new(&graph, 1, src);
    let result_a = filter_teleport_pool_by_floor(
        &field,
        &elements_prefer_other,
        &mut state_a,
        src,
        pool.clone(),
        None,
    );
    assert_eq!(result_a, vec![other_floor]);

    let elements_prefer_same = ElementsConfig {
        cross_floor_teleport_balance: 0.0,
        ..default_elements()
    };
    let result_b =
        filter_teleport_pool_by_floor(&field, &elements_prefer_same, &mut state, src, pool, None);
    assert_eq!(result_b, vec![same_floor]);
}

// --- Frontier-empty vertical reserve-bridge (GitHub issue #337 follow-up, revised by #416) ---
//
// `run_ordinary_step_body_for_node` queues *geometric* free neighbors into `reserve`, and also
// pushes each `src`'s vertical neighbors so `handle_empty_frontier`'s `has_visited_neighbor` scan
// can find a floor whose only visited neighbor is a vertical partner. This lets a floor that never
// won the ordinary per-step `vertical_chance` roll get pulled in by the reserve-bridge fallback —
// but only when `vertical_chance > 0.0`. `vertical_chance == 0.0` is a hard disable (GitHub issue
// #416): no vertical connection may ever be created, including as a reserve-bridge fallback, even
// if that leaves a floor with no geometric bridge option unreachable.

#[test]
fn frontier_empty_reserve_bridge_leaves_a_second_floor_isolated_when_vertical_chance_is_zero() {
    // `vertical_chance: 0.0` disables vertical connections entirely — floor 1 has no geometric
    // path to floor 0, so it can never be *bridged* to floor 0's component via a vertical edge.
    // Since GitHub issue #417, floor 1's nodes still end up visited: once the reserve/bridge
    // mechanism is exhausted, generation restarts growth from a random unvisited node (here,
    // necessarily on floor 1) as a brand-new, disconnected component — no vertical edge involved.
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let start = node_at(&field, 0, 0, 0);
    let elements = default_elements(); // vertical_chance defaults to 0.0
    let params = default_params();

    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        1,
        start,
        &params,
        &elements,
        &empty_presets(),
        None,
    );

    let visited: std::collections::HashSet<NodeId> = graph
        .edges()
        .flat_map(|e| [e.from, e.to])
        .chain([start])
        .collect();
    for x in 0..3 {
        for y in 0..3 {
            let node = node_at(&field, 0, x, y);
            assert!(
                visited.contains(&node),
                "node at floor 0 ({x},{y}) was never connected"
            );
        }
    }
    assert!(
        !graph
            .edges()
            .any(|e| e.kind == EdgeKind::VerticalPassage || e.kind == EdgeKind::Elevator),
        "no vertical edge should ever be created when vertical_chance == 0.0",
    );
    for x in 0..3 {
        for y in 0..3 {
            let node = node_at(&field, 1, x, y);
            assert!(
                visited.contains(&node),
                "node at floor 1 ({x},{y}) should now be visited as a new, disconnected component (GitHub issue #417)"
            );
        }
    }
}

#[test]
fn frontier_empty_reserve_bridge_still_falls_back_to_vertical_on_a_missed_roll_when_chance_is_nonzero()
 {
    // A low but nonzero `vertical_chance` will miss its own per-candidate roll most of the time,
    // but the fallback (`geometric_neighbors.is_empty() && !vertical_neighbors.is_empty()`) must
    // still fire whenever a reserve candidate's only reachable neighbor is vertical — floor 1 has
    // no geometric neighbor on floor 0, so it can only ever join via the vertical fallback here.
    let (mut field, mut graph, mut ids) = multi_floor_field(3, 3, 2);
    let start = node_at(&field, 0, 0, 0);
    let elements = ElementsConfig {
        vertical_chance: 0.01,
        ..default_elements()
    };
    let params = default_params();

    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        1,
        start,
        &params,
        &elements,
        &empty_presets(),
        None,
    );

    let visited: std::collections::HashSet<NodeId> = graph
        .edges()
        .flat_map(|e| [e.from, e.to])
        .chain([start])
        .collect();
    for level_idx in 0..2 {
        for x in 0..3 {
            for y in 0..3 {
                let node = node_at(&field, level_idx, x, y);
                assert!(
                    visited.contains(&node),
                    "node at floor {level_idx} ({x},{y}) was never connected"
                );
            }
        }
    }
    assert!(
        graph
            .edges()
            .any(|e| e.kind == EdgeKind::VerticalPassage || e.kind == EdgeKind::Elevator),
        "floor 1 only reconnects via a vertical edge somewhere — none was created",
    );
}

#[test]
fn frontier_empty_reserve_bridge_prefers_vertical_when_vertical_chance_is_one() {
    // The reserve-bridge's own `vertical_chance` roll (independent of the ordinary per-step roll)
    // must also be respected on a hit, not just as a last-resort fallback on a miss.
    let (mut field, mut graph, mut ids) = multi_floor_field(2, 2, 2);
    let start = node_at(&field, 0, 0, 0);
    let elements = ElementsConfig {
        vertical_chance: 1.0,
        ..default_elements()
    };
    let params = default_params();

    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        7,
        start,
        &params,
        &elements,
        &empty_presets(),
        None,
    );

    let visited: std::collections::HashSet<NodeId> = graph
        .edges()
        .flat_map(|e| [e.from, e.to])
        .chain([start])
        .collect();
    for level_idx in 0..2 {
        for x in 0..2 {
            for y in 0..2 {
                let node = node_at(&field, level_idx, x, y);
                assert!(
                    visited.contains(&node),
                    "node at floor {level_idx} ({x},{y}) was never connected"
                );
            }
        }
    }
}

// --- Preset Elevator/VerticalPassage discovery via free_preset (GitHub issue #371 regression) ---
//
// Before this fix, a preset Elevator/VerticalPassage partner on another floor was never pulled
// into `all_free`/`free_preset` by ordinary per-node growth (`field.neighbors` is geometric-only,
// same floor) — the partner floor only ever got picked up later by `handle_empty_frontier`'s
// reserve-bridge fallback, which fires whenever `geometric_neighbors` is empty regardless of
// `vertical_chance`, and didn't check whether an edge between the pair already existed. With
// `vertical_chance: 0.0` that produced a spurious extra `VerticalPassage`/`Elevator` edge on top
// of the preset-planted one instead of the preset elevator alone accounting for all inter-floor
// connectivity.

#[test]
fn preset_elevator_partner_is_discovered_via_free_preset_with_no_extra_vertical_edge() {
    let (mut field, mut graph, mut ids) = multi_floor_field(1, 1, 2);
    let elevator = crate::generation::PresetElevator {
        floors: vec![
            crate::generation::PresetEndpoint::original((0, 0)),
            crate::generation::PresetEndpoint {
                point: (0, 0),
                slot: None,
                level: Some(1),
            },
        ],
    };
    let preset_state = crate::generation::build_preset_state(
        &mut graph,
        &mut field,
        &mut ids,
        &[],
        &[],
        &[elevator],
        &[],
        &[],
        |x, y| SquarePoint { x, y },
        None,
        None,
    )
    .unwrap();

    let start = node_at(&field, 0, 0, 0);
    let elements = default_elements(); // vertical_chance defaults to 0.0
    let params = default_params();
    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        1,
        start,
        &params,
        &elements,
        &preset_state,
        None,
    );

    let floor1_node = node_at(&field, 1, 0, 0);
    let visited: std::collections::HashSet<NodeId> = graph
        .edges()
        .flat_map(|e| [e.from, e.to])
        .chain([start])
        .collect();
    assert!(
        visited.contains(&floor1_node),
        "preset elevator partner on floor 1 was never visited"
    );

    let vertical_edge_count = graph
        .edges()
        .filter(|e| e.kind == EdgeKind::Elevator || e.kind == EdgeKind::VerticalPassage)
        .count();
    assert_eq!(
        vertical_edge_count, 2,
        "with vertical_chance=0.0, only the preset elevator's own two directed edges should exist — got {vertical_edge_count}, generation likely added a spurious extra vertical connection"
    );
}

// `handle_empty_frontier`'s own reserve-bridge fallback must not add a redundant vertical edge
// when the reserve candidate is already connected to its vertical neighbor by an edge planted
// before generation started (e.g. a preset) — this is the fallback path's own half of the fix,
// isolated from `free_preset` discovery (which the test above already covers and which normally
// prevents the fallback from ever seeing a preset-connected pair in the first place).
#[test]
fn handle_empty_frontier_reserve_bridge_skips_a_vertical_neighbor_already_edge_connected() {
    let (mut field, mut graph, mut ids) = multi_floor_field(1, 1, 2);
    let src = node_at(&field, 0, 0, 0);
    let bridge = node_at(&field, 1, 0, 0);
    graph.add_bidirectional_edge(src, bridge, EdgeKind::VerticalPassage);

    let mut state = state_with_visited(&graph, src, &[src]);
    state.reserve = vec![bridge];
    state.in_reserve = [bridge].into_iter().collect();
    state.frontier.clear();
    state.in_frontier.clear();

    let params = default_params();
    let elements = default_elements(); // vertical_chance defaults to 0.0
    let preset_state = empty_presets();
    let mut start_reassignment = None;

    let keep_going = handle_empty_frontier(
        &mut graph,
        &mut field,
        &mut ids,
        &params,
        &elements,
        &no_split(),
        &preset_state,
        &mut state,
        src,
        &mut start_reassignment,
        None,
        None,
    );

    // `bridge` is already edge-connected to `src`, so the reserve holds no reachable candidate —
    // but `bridge` is itself unvisited, so it now seeds a fresh growth component (GitHub issue
    // #417) instead of generation reporting done, and no redundant edge is added for it.
    assert!(
        keep_going,
        "bridge is unvisited, so generation must restart growth from it as a new component"
    );
    assert!(
        state.visited.contains(&bridge),
        "bridge must become the new component's root"
    );
    let vertical_edge_count = graph
        .edges()
        .filter(|e| e.kind == EdgeKind::VerticalPassage)
        .count();
    assert_eq!(
        vertical_edge_count, 2,
        "the pre-existing bidirectional edge must be untouched — no extra VerticalPassage added on top of it"
    );
}
