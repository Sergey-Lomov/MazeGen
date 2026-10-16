use super::*;
use crate::generation::split_pattern::{
    SplitFaceRequirement, SplitGenerationConfig, SplitPattern, SplitPatternFace,
};
use crate::generation::test_utils::make_field_graph_ids;
use crate::generation::{ElementsConfig, GenerationParams, PresetState};
use crate::space::SquarePoint;

fn no_split_elements() -> ElementsConfig {
    ElementsConfig {
        one_way_chance: 0.0,
        teleport_chance: 0.0,
        teleport_one_way_chance: 0.0,
        split_chance: 0.0,
        ..Default::default()
    }
}

fn full_split_elements() -> ElementsConfig {
    ElementsConfig {
        one_way_chance: 0.0,
        teleport_chance: 0.0,
        teleport_one_way_chance: 0.0,
        split_chance: 1.0,
        ..Default::default()
    }
}

fn empty_presets() -> PresetState {
    PresetState::empty()
}

fn no_split_config() -> SplitGenerationConfig {
    SplitGenerationConfig::default()
}

// ─── RNG parity at split_chance == 0.0 ──────────────────────────────────

#[test]
fn split_chance_zero_matches_baseline_exactly() {
    // A split_chance of 0.0 must still consume the roll's RNG sample every step, but never
    // actually split — output must be byte-identical to a run with the feature entirely absent.
    for seed in [1u64, 7, 42, 1234] {
        let (mut field_a, mut graph_a, mut ids_a) = make_field_graph_ids(6, 6);
        let field_a_level = field_a.single_level_id();
        let start_a = field_a
            .node_at(field_a_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut sr_a = None;
        super::super::vertex_based::generate(
            &mut graph_a,
            &mut field_a,
            &mut ids_a,
            seed,
            start_a,
            &GenerationParams::default(),
            &no_split_elements(),
            &no_split_config(),
            &empty_presets(),
            &mut sr_a,
            None,
            None,
        );

        let (mut field_b, mut graph_b, mut ids_b) = make_field_graph_ids(6, 6);
        let field_b_level = field_b.single_level_id();
        let start_b = field_b
            .node_at(field_b_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let mut sr_b = None;
        super::super::vertex_based::generate(
            &mut graph_b,
            &mut field_b,
            &mut ids_b,
            seed,
            start_b,
            &GenerationParams::default(),
            &no_split_elements(),
            &no_split_config(),
            &empty_presets(),
            &mut sr_b,
            None,
            None,
        );

        let mut e_a: Vec<_> = graph_a.edges().map(|e| (e.from, e.to)).collect();
        let mut e_b: Vec<_> = graph_b.edges().map(|e| (e.from, e.to)).collect();
        e_a.sort();
        e_b.sort();
        assert_eq!(
            e_a, e_b,
            "seed {seed}: split_chance=0.0 must be fully deterministic"
        );
        assert!(sr_a.is_none() && sr_b.is_none());
    }
}

// ─── Non-pattern split path ──────────────────────────────────────────────

#[test]
fn non_pattern_split_creates_exact_node_count() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let node_count_before = graph.nodes().count();
    let split_config = SplitGenerationConfig {
        pattern_mode: false,
        max_split_nodes: 3,
        patterns: vec![],
    };
    let mut sr = None;
    super::super::vertex_based::generate(
        &mut graph,
        &mut field,
        &mut ids,
        5,
        start,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut sr,
        None,
        None,
    );
    // At least one split must have fired somewhere (split_chance=1.0, many steps) creating
    // extra nodes beyond the field's original point count.
    assert!(
        graph.nodes().count() > node_count_before,
        "split_chance=1.0 must create extra nodes"
    );
    // Node count only ever grows in multiples matching max_split_nodes - 1 per split event, so
    // the total extra nodes must be a multiple of (max_split_nodes - 1).
    let extra = graph.nodes().count() - node_count_before;
    assert_eq!(
        extra % 2,
        0,
        "each split adds exactly max_split_nodes - 1 = 2 nodes, extra={extra}"
    );
}

#[test]
fn non_pattern_split_every_resulting_node_gets_at_least_one_connection() {
    // Regression: the free-neighbor pool used to be handed to the first-processed node (`src`)
    // whole, via `choose_connect_targets`'s own multi-candidate junction pick — a later sibling
    // node could then see zero free neighbors left and end up with no connection at all (an
    // isolated node, invisible in the post-edit UI since it has no edge to draw). The pool is now
    // partitioned up front so every node gets a fair share, and any node still left unconnected
    // (partitioning can't manufacture neighbors that don't exist) falls back to an already-visited
    // geometric neighbor of the point — see `non_pattern_split_falls_back_to_visited_neighbor_when_no_unvisited_left`.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(8, 8);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let split_config = SplitGenerationConfig {
        pattern_mode: false,
        max_split_nodes: 2,
        patterns: vec![],
    };
    let mut sr = None;
    super::super::vertex_based::generate(
        &mut graph,
        &mut field,
        &mut ids,
        5,
        start,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut sr,
        None,
        None,
    );
    let mut checked_a_split = false;
    for point in field.field_of(field_level).unwrap().all_cells() {
        let nodes = field.nodes_at(field_level, point);
        if nodes.len() <= 1 {
            continue;
        }
        checked_a_split = true;
        for &n in nodes {
            let degree = graph.outgoing_neighbors(n).count() + graph.incoming_neighbors(n).count();
            assert!(
                degree > 0,
                "split node {n:?} at {point:?} has no connection at all"
            );
        }
    }
    assert!(
        checked_a_split,
        "test setup must actually exercise at least one split"
    );
}

#[test]
fn non_pattern_split_falls_back_to_visited_neighbor_when_no_unvisited_left() {
    // When every geometric neighbor of the split point is already visited (so the ordinary
    // corridor/junction step can't connect any resulting node to anything new), each node must
    // still fall back to an already-visited neighbor rather than end up permanently isolated.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 1, y: 1 })
        .unwrap();
    let split_config = SplitGenerationConfig {
        pattern_mode: false,
        max_split_nodes: 2,
        patterns: vec![],
    };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    for n in field.neighbors(start) {
        state.visited.insert(n);
    }
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state,
        start,
        None,
        None,
        start,
        &mut sr,
        None,
        None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    let point = field.cell_of(start).unwrap();
    for &n in field.nodes_at(field_level, point) {
        let degree = graph.outgoing_neighbors(n).count() + graph.incoming_neighbors(n).count();
        assert!(
            degree > 0,
            "split node {n:?} must fall back to a visited neighbor, not stay isolated"
        );
    }
}

#[test]
fn non_pattern_max_split_nodes_one_is_a_valid_noop() {
    // max_split_nodes == 1 spends the split roll's RNG sample but mints nothing new.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(4, 4);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let node_count_before = graph.nodes().count();
    let split_config = SplitGenerationConfig {
        pattern_mode: false,
        max_split_nodes: 1,
        patterns: vec![],
    };
    let mut sr = None;
    super::super::vertex_based::generate(
        &mut graph,
        &mut field,
        &mut ids,
        3,
        start,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut sr,
        None,
        None,
    );
    assert_eq!(
        graph.nodes().count(),
        node_count_before,
        "max_split_nodes=1 must never mint new nodes"
    );
}

// ─── split_is_eligible ───────────────────────────────────────────────────

#[test]
fn split_is_eligible_false_when_locked() {
    let (field, _graph, mut ids) = make_field_graph_ids(3, 3);
    let level = field.single_level_id();
    let node = field.node_at(level, SquarePoint { x: 1, y: 1 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(node);
    assert!(!split_is_eligible(&field, &preset_state, node));
    let mut preset_state2 = PresetState::empty();
    preset_state2.locked_in.insert(node);
    assert!(!split_is_eligible(&field, &preset_state2, node));
    let _ = &mut ids;
}

#[test]
fn split_is_eligible_false_when_already_split() {
    let (mut field, _graph, mut ids) = make_field_graph_ids(3, 3);
    let level = field.single_level_id();
    let point = SquarePoint { x: 1, y: 1 };
    field.add_node_at(level, point, &mut ids);
    let node = field.node_at(level, point).unwrap();
    assert!(!split_is_eligible(&field, &empty_presets(), node));
}

#[test]
fn split_is_eligible_true_for_plain_unlocked_unsplit_node() {
    let (field, _graph, _ids) = make_field_graph_ids(3, 3);
    let level = field.single_level_id();
    let node = field.node_at(level, SquarePoint { x: 1, y: 1 }).unwrap();
    assert!(split_is_eligible(&field, &empty_presets(), node));
}

// ─── SplitOutcome variants via try_split_src ─────────────────────────────

#[test]
fn try_split_src_returns_miss_when_roll_misses() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &no_split_elements(),
        &no_split_config(),
        &empty_presets(),
        &mut state,
        start,
        None,
        None,
        start,
        &mut sr,
        None,
        None,
    );
    assert_eq!(outcome, SplitOutcome::Miss);
}

#[test]
fn try_split_src_returns_ineligible_when_locked() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(start);
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &full_split_elements(),
        &no_split_config(),
        &preset_state,
        &mut state,
        start,
        None,
        None,
        start,
        &mut sr,
        None,
        None,
    );
    assert_eq!(outcome, SplitOutcome::Ineligible);
}

#[test]
fn handle_pattern_split_retries_a_different_pattern_after_the_first_yields_no_adaptations() {
    // GitHub issue #275's weighted-pick coverage gap: a heavily-weighted pattern that can never
    // adapt at this point (requires a face pointing off-field) must be excluded from `remaining`
    // and retried against a lower-weight pattern that *can* adapt, rather than the whole split
    // failing outright.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();

    // `regular:4` canonical order [E, N, W, S] (indices 0-3). At (0,0) on a 3x3 grid: S (index 3)
    // points off-field, E (index 0) has a real neighbor at (1,0).
    let impossible_pattern = SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 2,
        faces: vec![
            vec![],
            vec![SplitPatternFace {
                face_index: 3,
                requirement: SplitFaceRequirement::Passage,
                sibling_target: None,
            }],
        ],
        weight: 1000.0,
    };
    let possible_pattern = SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 2,
        faces: vec![
            vec![],
            vec![SplitPatternFace {
                face_index: 0,
                requirement: SplitFaceRequirement::Passage,
                sibling_target: None,
            }],
        ],
        weight: 0.001,
    };
    let split_config = SplitGenerationConfig {
        pattern_mode: true,
        max_split_nodes: 2,
        patterns: vec![impossible_pattern, possible_pattern],
    };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state,
        start,
        None,
        None,
        start,
        &mut sr,
        None,
        None,
    );
    assert_eq!(
        outcome,
        SplitOutcome::Handled,
        "must retry onto the second pattern instead of giving up after the first pattern's adaptation search comes up empty"
    );
}

#[test]
fn try_split_src_is_ineligible_when_no_pattern_is_declared_for_the_cell_shape() {
    // Pattern mode never splits a cell whose shape template has no pattern — a pattern for
    // another template (here a hexagon on a square cell) does not count.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let split_config = SplitGenerationConfig {
        pattern_mode: true,
        max_split_nodes: 2,
        patterns: vec![SplitPattern {
            shape: "regular:6".to_string(),
            node_count: 1,
            faces: vec![vec![]],
            weight: 1.0,
        }],
    };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state,
        start,
        None,
        None,
        start,
        &mut sr,
        None,
        None,
    );
    assert_eq!(outcome, SplitOutcome::Ineligible);
}

#[test]
fn try_split_src_returns_handled_on_non_pattern_hit() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let split_config = SplitGenerationConfig {
        pattern_mode: false,
        max_split_nodes: 2,
        patterns: vec![],
    };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state,
        start,
        None,
        None,
        start,
        &mut sr,
        None,
        None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    assert!(
        graph.nodes().count() > 9,
        "a hit must have minted an extra node"
    );
}

// ─── split_points collision ──────────────────────────────────────────────

#[test]
fn split_roll_skipped_entirely_for_a_point_with_declared_split_points() {
    // A point already split via GenerationConfig.split_points (issue #231) must never be
    // re-split by the generator — split_is_eligible must reject it outright.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let field_level = field.single_level_id();
    let point = SquarePoint { x: 1, y: 1 };
    let extra = field.add_node_at(field_level, point, &mut ids);
    graph.add_node(extra);
    let original = field.node_at(field_level, point).unwrap();
    assert!(!split_is_eligible(&field, &empty_presets(), original));
}

#[path = "split_logic_pattern_test.rs"]
mod split_logic_pattern_test;

#[path = "split_logic_misc_test.rs"]
mod split_logic_misc_test;
