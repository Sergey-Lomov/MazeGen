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

// ─── add_to_frontier / pop_reserve / choose_from_frontier ───────────────

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
fn pop_reserve_returns_none_when_empty() {
    let mut reserve: Vec<NodeId> = vec![];
    let mut in_reserve: HashSet<NodeId> = HashSet::new();
    let params = default_params();

    assert_eq!(pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng(1)), None);
}

#[test]
fn pop_reserve_removes_and_returns_the_only_element() {
    let mut reserve: Vec<NodeId> = vec![7];
    let mut in_reserve: HashSet<NodeId> = [7].into_iter().collect();
    let params = default_params();

    let popped = pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng(1));

    assert_eq!(popped, Some(7));
    assert!(reserve.is_empty());
    assert!(!in_reserve.contains(&7));
}

#[test]
fn pop_reserve_depth_first_one_prefers_last_inserted() {
    let params = GenerationParams { depth_first: 1.0, ..default_params() };
    let mut last_wins = 0;
    for seed in 0..100 {
        let mut reserve: Vec<NodeId> = vec![10, 20, 30];
        let mut in_reserve: HashSet<NodeId> = [10, 20, 30].into_iter().collect();
        if pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng(seed)) == Some(30) {
            last_wins += 1;
        }
    }
    assert!(last_wins >= 95, "depth_first=1.0: last-inserted reserve entry should dominate, got {last_wins}/100");
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
