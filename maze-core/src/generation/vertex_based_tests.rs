use super::*;
use crate::generation::test_utils::{default_elements, make_field_graph_ids};
use crate::generation::split_pattern::SplitGenerationConfig;
use rand::SeedableRng;

pub(super) fn rng(seed: u64) -> MazeRng { MazeRng::seed_from_u64(seed) }
pub(super) fn default_params() -> GenerationParams { GenerationParams::default() }
pub(super) fn no_split() -> SplitGenerationConfig { SplitGenerationConfig::default() }

/// Calls `generate` with split-related params defaulted to "feature off" (`no_split()`,
/// `start_reassignment: &mut None`) — every existing test predates GitHub issue #222 and asserts
/// pre-split behavior, so this keeps call sites close to their pre-#222 shape instead of every
/// one repeating the same 3 extra no-op arguments.
#[allow(clippy::too_many_arguments)]
pub(super) fn generate_default_split<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    seed: u64,
    start: NodeId,
    params: &GenerationParams,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    event_log: Option<&mut EventLog<VertexBasedEvent>>,
) {
    let mut start_reassignment = None;
    generate(graph, field, ids, seed, start, params, elements, &no_split(), preset_state, &mut start_reassignment, event_log, None);
}

pub(super) fn empty_presets() -> super::PresetState { super::PresetState::empty() }

// ─── handle_empty_frontier / reserve scan (GitHub issue #356 regression) ───────────────

/// Regression for GitHub issue #356: generation used to stop early, ignoring part of the reserve,
/// under certain configurations. The reserve scan used to pop candidates via a weighted-random
/// draw, re-pushing rejects and aborting on the first repeat — since the draw isn't round-robin,
/// a not-yet-reachable candidate could resurface (and trip the abort) long before every other
/// reserve entry got a turn, even though a reachable one was still sitting in the reserve
/// untried. This is inherently seed-dependent under the old pop-loop (some seeds got lucky and
/// drew the reachable candidate first try), so the regression is asserted over many seeds rather
/// than pinned to one: with the fix (a single deterministic linear pass over the reserve), the
/// lone reachable candidate (`x1`, the only one adjacent to the visited `x0`) must be found and
/// generation must keep going on every seed, not just favorable ones.
#[test]
fn handle_empty_frontier_finds_the_lone_reachable_candidate_behind_several_unreachable_ones() {
    for seed in 0..50 {
        let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 1);
        let level = field.levels_ordered().next().unwrap();
        let node = |x: i32| field.node_at(level, crate::space::SquarePoint { x, y: 0 }).unwrap();
        let (x0, x1, x2, x3, x4, x5) = (node(0), node(1), node(2), node(3), node(4), node(5));

        let mut state = GenState::new(&graph, seed, x0);
        // Only x1 is geometrically adjacent to the visited x0; x2/x3/x4/x5 have no visited
        // neighbor. x1 is queued last, the position a depth_first-weighted draw favors least.
        state.reserve = vec![x2, x3, x4, x5, x1];
        state.in_reserve = [x2, x3, x4, x5, x1].into_iter().collect();
        state.frontier.clear();
        state.in_frontier.clear();

        let params = default_params();
        let elements = default_elements();
        let preset_state = empty_presets();
        let mut start_reassignment = None;

        let keep_going = handle_empty_frontier(
            &mut graph, &mut field, &mut ids, &params, &elements, &no_split(), &preset_state,
            &mut state, x0, &mut start_reassignment, None, None,
        );

        assert!(keep_going, "seed {seed}: a reachable candidate (x1) was present in the reserve — generation must not stop");
        assert!(state.visited.contains(&x1), "seed {seed}: x1 must have been picked (only candidate with a visited neighbor)");
        for n in [x2, x3, x4, x5] {
            assert!(!state.visited.contains(&n), "seed {seed}: {n:?} has no visited neighbor yet and must stay unvisited");
            assert!(state.reserve.contains(&n) && state.in_reserve.contains(&n),
                "seed {seed}: not-yet-reachable candidate {n:?} must remain in the reserve for a later pass");
        }
    }
}

/// GitHub issue #417: when the reserve scan finds nothing reachable but unvisited nodes remain,
/// `handle_empty_frontier` must restart growth from one of them as a new, unbridged component
/// instead of ending generation. `x3`/`x4`/`x5` are never queued into the reserve at all — the
/// spec change explicitly covers this case ("regardless of whether it was ever queued into the
/// reserve"), so the fix must search `all_nodes`, not just `reserve`.
#[test]
fn handle_empty_frontier_restarts_from_an_unvisited_node_when_the_reserve_is_fully_exhausted() {
    for seed in 0..50 {
        let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 1);
        let level = field.levels_ordered().next().unwrap();
        let node = |x: i32| field.node_at(level, crate::space::SquarePoint { x, y: 0 }).unwrap();
        let (x0, x3, x4, x5) = (node(0), node(3), node(4), node(5));

        let mut state = GenState::new(&graph, seed, x0);
        // Reserve holds only unreachable-from-visited candidates (no edge from x0's side reaches
        // them) — the scan must find nothing, forcing the restart path.
        state.reserve = vec![node(1), node(2)];
        state.in_reserve = [node(1), node(2)].into_iter().collect();
        state.visited = [x0, node(1), node(2)].into_iter().collect();
        state.frontier.clear();
        state.in_frontier.clear();

        let params = default_params();
        let elements = default_elements();
        let preset_state = empty_presets();
        let mut start_reassignment = None;

        let keep_going = handle_empty_frontier(
            &mut graph, &mut field, &mut ids, &params, &elements, &no_split(), &preset_state,
            &mut state, x0, &mut start_reassignment, None, None,
        );

        assert!(keep_going, "seed {seed}: x3/x4/x5 are unvisited — generation must restart, not stop");
        let new_root = [x3, x4, x5].into_iter().find(|n| state.visited.contains(n));
        assert!(new_root.is_some(), "seed {seed}: exactly one of x3/x4/x5 must have been picked as the new component's root");
        let new_root = new_root.unwrap();
        assert!(state.in_frontier.contains(&new_root), "seed {seed}: the new root must be pushed to the frontier");
        assert!(state.frontier.iter().any(|e| e.node == new_root && e.parent.is_none()),
            "seed {seed}: the new root must have no parent — it isn't bridged to the already-visited set");
        assert!(graph.edges().count() == 0, "seed {seed}: no edge should be added when restarting a new component");
    }
}

#[test]
fn handle_empty_frontier_reports_done_when_no_unvisited_node_remains_anywhere() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(2, 1);
    let level = field.levels_ordered().next().unwrap();
    let node = |x: i32| field.node_at(level, crate::space::SquarePoint { x, y: 0 }).unwrap();
    let (x0, x1) = (node(0), node(1));

    let mut state = GenState::new(&graph, 0, x0);
    state.visited = [x0, x1].into_iter().collect();
    state.reserve.clear();
    state.in_reserve.clear();
    state.frontier.clear();
    state.in_frontier.clear();

    let params = default_params();
    let elements = default_elements();
    let preset_state = empty_presets();
    let mut start_reassignment = None;

    let keep_going = handle_empty_frontier(
        &mut graph, &mut field, &mut ids, &params, &elements, &no_split(), &preset_state,
        &mut state, x0, &mut start_reassignment, None, None,
    );

    assert!(!keep_going, "every node is already visited — generation must actually end");
}

// ─── add_to_frontier / choose_from_frontier ───────────────

#[test]
fn add_to_frontier_appends_new_node_with_parent() {
    let mut frontier: Vec<FrontierEntry> = vec![];
    let mut in_frontier: HashSet<NodeId> = HashSet::new();

    add_to_frontier(1, Some(0), &mut frontier, &mut in_frontier);

    assert_eq!(frontier.len(), 1);
    assert_eq!(frontier[0].node, 1);
    assert_eq!(frontier[0].parent, Some(0));
    assert!(in_frontier.contains(&1));
}

#[test]
fn add_to_frontier_ignores_duplicate_node() {
    let mut frontier: Vec<FrontierEntry> = vec![];
    let mut in_frontier: HashSet<NodeId> = HashSet::new();

    add_to_frontier(1, Some(0), &mut frontier, &mut in_frontier);
    add_to_frontier(1, Some(5), &mut frontier, &mut in_frontier); // different parent, same node

    assert_eq!(frontier.len(), 1, "node already in frontier must not be pushed again");
    assert_eq!(frontier[0].parent, Some(0), "first insertion's parent must be preserved");
}

#[test]
fn choose_from_frontier_single_entry_returns_zero() {
    let frontier = vec![FrontierEntry { node: 42, parent: None }];
    let params = default_params();
    for seed in 0..20 {
        assert_eq!(choose_from_frontier(&frontier, &params, &mut rng(seed)), 0);
    }
}

#[test]
fn choose_from_frontier_result_always_in_bounds() {
    let frontier = vec![
        FrontierEntry { node: 1, parent: None },
        FrontierEntry { node: 2, parent: None },
        FrontierEntry { node: 3, parent: None },
    ];
    let params = GenerationParams { depth_first: 0.5, ..default_params() };
    for seed in 0..200 {
        let idx = choose_from_frontier(&frontier, &params, &mut rng(seed));
        assert!(idx < frontier.len(), "seed {seed}: index {idx} out of bounds");
    }
}

#[test]
fn junction_count_branching_zero_always_two() {
    let params = GenerationParams { branching: 0.0, ..default_params() };
    for seed in 0..50 {
        assert_eq!(junction_count(10, &params, &mut rng(seed), None), 2);
    }
}

#[test]
fn junction_count_branching_one_always_max() {
    let params = GenerationParams { branching: 1.0, ..default_params() };
    for max in 2..=6 {
        for seed in 0..20 {
            assert_eq!(junction_count(max, &params, &mut rng(seed), None), max);
        }
    }
}

#[test]
fn junction_count_max_two_always_two_regardless_of_branching() {
    for branching in [0.0, 0.5, 1.0] {
        let params = GenerationParams { branching, ..default_params() };
        for seed in 0..20 {
            assert_eq!(junction_count(2, &params, &mut rng(seed), None), 2);
        }
    }
}

#[test]
fn junction_count_result_in_range() {
    let params = GenerationParams { branching: 0.5, ..default_params() };
    for max in 2..=8 {
        for seed in 0..50 {
            let count = junction_count(max, &params, &mut rng(seed), None);
            assert!(count >= 2 && count <= max, "count={count} not in [2,{max}]");
        }
    }
}

#[test]
fn vertex_based_visits_all_nodes() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let node_count = graph.nodes().count();
    let start = field.node_at(field_level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &default_elements(), &empty_presets(), None);
    assert_eq!(graph.edges().count(), 2 * (node_count - 1));
}

#[test]
fn vertex_based_is_deterministic() {
    let (mut field, mut g1, mut ids) = make_field_graph_ids(4, 4);
    let field_level = field.single_level_id();
    let (_, mut g2, mut ids2) = make_field_graph_ids(4, 4);
    let start = field.node_at(field_level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut g1, &mut field, &mut ids, 7, start, &default_params(), &default_elements(), &empty_presets(), None);
    let mut field2 = field.clone();
    generate_default_split(&mut g2, &mut field2, &mut ids2, 7, start, &default_params(), &default_elements(), &empty_presets(), None);
    let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    e1.sort();
    e2.sort();
    assert_eq!(e1, e2);
}
