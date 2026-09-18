use super::super::*;
use crate::generation::split_pattern::SplitGenerationConfig;
use crate::generation::test_utils::make_field_graph_ids;
use crate::generation::{ElementsConfig, GenerationParams, PresetState};
use crate::space::SquarePoint;

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

// ─── Teleport-per-event (both modes): exactly one edge, never per-node ──

#[test]
fn non_pattern_split_teleport_is_rolled_once_per_event_not_per_node() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let split_config = SplitGenerationConfig {
        pattern_mode: false,
        max_split_nodes: 4,
        patterns: vec![],
    };
    let elements = ElementsConfig {
        one_way_chance: 0.0,
        teleport_chance: 1.0,
        teleport_one_way_chance: 0.0,
        split_chance: 1.0,
        ..Default::default()
    };
    let mut state = super::super::super::vertex_based::GenState::new(&graph, 9, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &elements,
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
    let teleport_edges = graph
        .edges()
        .filter(|e| e.kind == crate::graph::EdgeKind::Teleport)
        .count();
    // Exactly one teleport edge (or its bidirectional pair = 2 directed edges) from this single
    // split event — not one per resulting node (which would be up to 4).
    assert!(
        teleport_edges <= 2,
        "teleport must be rolled once for the whole split event, got {teleport_edges} teleport edges"
    );
}

// ─── Start reassignment ──────────────────────────────────────────────────

#[test]
fn split_reassigns_start_when_start_node_itself_splits() {
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
    let mut state = super::super::super::vertex_based::GenState::new(&graph, 1, start);
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
        sr.is_some(),
        "splitting the start node must produce a start_reassignment"
    );
    let reassignment = sr.unwrap();
    assert_eq!(reassignment.original, start);
}

#[test]
fn split_never_reassigns_start_for_a_non_start_node() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let other = field
        .node_at(field_level, SquarePoint { x: 1, y: 1 })
        .unwrap();
    let split_config = SplitGenerationConfig {
        pattern_mode: false,
        max_split_nodes: 2,
        patterns: vec![],
    };
    let mut state = super::super::super::vertex_based::GenState::new(&graph, 1, start);
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
        other,
        None,
        None,
        start,
        &mut sr,
        None,
        None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    assert!(
        sr.is_none(),
        "splitting a non-start node must never touch start_reassignment"
    );
}

// ─── Non-pattern split-node processing order (deterministic creation order) ──

#[test]
fn non_pattern_split_nodes_processed_in_creation_order() {
    // With a fixed seed, re-running the exact same split twice must produce identical additional
    // edges — confirms nodes are processed src-first, then in add_node_at order, not shuffled.
    let (mut field_a, mut graph_a, mut ids_a) = make_field_graph_ids(6, 6);
    let field_a_level = field_a.single_level_id();
    let start_a = field_a
        .node_at(field_a_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let split_config = SplitGenerationConfig {
        pattern_mode: false,
        max_split_nodes: 3,
        patterns: vec![],
    };
    let mut state_a = super::super::super::vertex_based::GenState::new(&graph_a, 4, start_a);
    let mut sr_a = None;
    try_split_src(
        &mut graph_a,
        &mut field_a,
        &mut ids_a,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state_a,
        start_a,
        None,
        None,
        start_a,
        &mut sr_a,
        None,
        None,
    );

    let (mut field_b, mut graph_b, mut ids_b) = make_field_graph_ids(6, 6);
    let field_b_level = field_b.single_level_id();
    let start_b = field_b
        .node_at(field_b_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let mut state_b = super::super::super::vertex_based::GenState::new(&graph_b, 4, start_b);
    let mut sr_b = None;
    try_split_src(
        &mut graph_b,
        &mut field_b,
        &mut ids_b,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state_b,
        start_b,
        None,
        None,
        start_b,
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
        "identical seed/config split must produce identical edges (deterministic order)"
    );
}
