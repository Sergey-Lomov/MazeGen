use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use maze_core::{
    graph::Graph,
    space::{Field, Tessellation},
    generation::{generate_maze, generate_maze_with_events, build_preset_state},
};
use crate::generation_config::{GenerateConfig, build_generation_config, build_repair_limits};
use crate::analytics::build_analytics_snapshot;
use crate::result::GenerateResult;

/// Runs the initial (pre-QC/repair) generation pass and returns the generation source's *unmerged*
/// `TapeSource`/event kind/debug-value names (GitHub issue #147 — merging now happens once in
/// `run_generate`, after the QC/repair source is also available, not here), plus the elapsed time
/// for the generation call itself — split out of `run_generate` so this branch-selection/timing
/// logic is testable natively (no `JsValue`/`serde_wasm_bindgen`, which panic outside a real WASM
/// runtime — see GitHub issue #124's `run_initial_generation_tests` below for why `run_generate`
/// itself can't be exercised by `cargo test`).
///
/// QC experiment mode skips the generation algorithm entirely — the graph already holds only
/// preset connections (built by `build_preset_state` before this call), fed straight into
/// `build_maze`'s QC/repair pass. The event tree/checkpoints have nothing to record in this case,
/// so `debug_events` is ignored here rather than erroring.
fn run_initial_generation<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start_id: maze_core::ids::NodeId,
    gen_config: maze_core::generation::GenerationConfig,
    preset_state: &maze_core::generation::PresetState,
    qc_experiment: bool,
    debug_events: bool,
) -> (Option<maze_core::event_log::TapeSource>, Option<maze_core::event_log::EventedEventKind>, Vec<(String, maze_core::event_log::DebugValueKind)>, f64) {
    use maze_core::generation::pipeline::now_ms;

    let initial_build_start = now_ms();
    let (raw_source, event_kind, debug_value_names): (
        Option<maze_core::event_log::TapeSource>,
        Option<maze_core::event_log::EventedEventKind>,
        Vec<(String, maze_core::event_log::DebugValueKind)>,
    ) = if qc_experiment {
        (None, None, Vec::new())
    } else if debug_events {
        let result = generate_maze_with_events(graph, field, seed, start_id, gen_config, preset_state);
        // Only forward this source past the WASM boundary when the web replay engine can
        // actually decode its event kind (GitHub issue #161) — extend `is_web_decodable` once a
        // new event kind gets a web decoder, and that's the only place this list needs to change.
        if is_web_decodable(Some(result.event_kind)) {
            (Some(result.raw_source), Some(result.event_kind), result.debug_value_names)
        } else {
            (None, None, Vec::new())
        }
    } else {
        generate_maze(graph, field, seed, start_id, gen_config, preset_state);
        (None, None, Vec::new())
    };
    let initial_build_ms = now_ms() - initial_build_start;

    (raw_source, event_kind, debug_value_names, initial_build_ms)
}

/// Which [`maze_core::event_log::EventedEventKind`]s the web replay engine (`maze-web/src/debug/
/// eventTape.ts`) can decode today — Recursive Backtracker's, Kruskal's (GitHub issue #146),
/// Wilson's (#145) and `CustomEdgeBased`'s (#144) wire tags. Must stay in sync by hand with the
/// keys registered in `maze-web/src/debug/algorithmRegistry.ts`'s `adapterFor` (GitHub issue
/// #163) — that registry is the web-side source of truth for which kinds have a decoder/apply/
/// narration adapter; no codegen ties the two together across the WASM boundary, so extend both
/// when a new event kind gets a web decoder.
fn is_web_decodable(kind: Option<maze_core::event_log::EventedEventKind>) -> bool {
    matches!(
        kind,
        Some(maze_core::event_log::EventedEventKind::RecursiveBacktracker)
            | Some(maze_core::event_log::EventedEventKind::Kruskal)
            | Some(maze_core::event_log::EventedEventKind::Wilson)
            | Some(maze_core::event_log::EventedEventKind::EdgeBased)
            | Some(maze_core::event_log::EventedEventKind::VertexBased)
            | Some(maze_core::event_log::EventedEventKind::QualityControl)
    )
}

#[cfg(test)]
mod is_web_decodable_tests {
    use super::is_web_decodable;
    use maze_core::event_log::EventedEventKind;

    #[test]
    fn recursive_backtracker_is_web_decodable() {
        assert!(is_web_decodable(Some(EventedEventKind::RecursiveBacktracker)));
    }

    #[test]
    fn kruskal_is_web_decodable() {
        assert!(is_web_decodable(Some(EventedEventKind::Kruskal)));
    }

    #[test]
    fn wilson_is_web_decodable() {
        assert!(is_web_decodable(Some(EventedEventKind::Wilson)));
    }

    #[test]
    fn edge_based_is_web_decodable() {
        assert!(is_web_decodable(Some(EventedEventKind::EdgeBased)));
    }

    #[test]
    fn vertex_based_is_web_decodable() {
        assert!(is_web_decodable(Some(EventedEventKind::VertexBased)));
    }

    #[test]
    fn none_is_not_web_decodable() {
        assert!(!is_web_decodable(None));
    }
}

#[cfg(test)]
mod run_initial_generation_tests {
    use super::run_initial_generation;
    use maze_core::graph::Graph;
    use maze_core::ids::IdGenerator;
    use maze_core::space::{Field, SquareTessellation, SquarePoint};
    use maze_core::generation::{GenerationAlgorithm, GenerationConfig, PresetState, build_preset_state};

    /// A 3x3 square field with no preset connections/locks — enough for Recursive Backtracker
    /// to actually run and emit events.
    fn field_and_state() -> (Graph, Field<SquareTessellation>, PresetState) {
        let points: Vec<SquarePoint> = (0..3).flat_map(|x| (0..3).map(move |y| SquarePoint { x, y })).collect();
        let mut ids = IdGenerator::new();
        let field = Field::<SquareTessellation>::new(points, &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let preset_state = build_preset_state(&mut graph, &field, &[], &[], |x, y| SquarePoint { x, y });
        (graph, field, preset_state)
    }

    fn rb_config() -> GenerationConfig {
        GenerationConfig { algorithm: GenerationAlgorithm::RecursiveBacktracker, ..GenerationConfig::default() }
    }

    #[test]
    fn debug_events_false_yields_no_debug_tape() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 1, start, rb_config(), &preset_state, false, false);
        assert!(raw_source.is_none(), "debug_events: false must not produce a tape");
        assert!(event_kind.is_none(), "debug_events: false must not produce an event kind");
        assert!(debug_value_names.is_empty(), "debug_events: false must not produce debug value names");
    }

    #[test]
    fn debug_events_true_yields_correctly_strided_debug_tape() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (raw_source, _, debug_value_names, _) = run_initial_generation(&mut graph, &field, 2, start, rb_config(), &preset_state, false, true);
        let source = raw_source.expect("debug_events: true must produce a tape");

        assert!(!source.tape.node_table.is_empty(), "a 3x3 RB run must emit at least one event");
        assert_eq!(source.tape.node_table.len() % maze_core::event_log::NODE_RECORD_SIZE, 0, "node table must be a whole number of NodeRecords");
        assert!(!source.tape.payload.is_empty(), "payload arena must hold at least the root scope name");
        assert_eq!(
            debug_value_names,
            vec![
                ("recursion_stack".to_string(), maze_core::event_log::DebugValueKind::Sequence),
                ("visited".to_string(), maze_core::event_log::DebugValueKind::Region),
            ],
            "Recursive Backtracker declares the recursion_stack and visited debug values"
        );
    }

    #[test]
    fn debug_events_true_yields_checkpoint_buffer_shorter_than_checkpoint_interval() {
        // A 3x3 RB run emits far fewer than CHECKPOINT_INTERVAL (500) mutating events, so no
        // checkpoint is ever recorded — but the (empty) table must still be present, since
        // Recursive Backtracker was instrumented (checkpoints: Some/None must track tape: Some/None).
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (raw_source, _, _, _) = run_initial_generation(&mut graph, &field, 2, start, rb_config(), &preset_state, false, true);
        let checkpoints = raw_source.expect("debug_events: true must produce a tape").checkpoints
            .expect("debug_events: true must produce a checkpoint buffer for Recursive Backtracker");
        assert!(checkpoints.table.is_empty(), "a 3x3 RB run has far fewer than CHECKPOINT_INTERVAL mutating events");
        assert_eq!(checkpoints.table.len() % maze_core::event_log::CHECKPOINT_RECORD_SIZE, 0);
    }

    #[test]
    fn debug_events_true_with_custom_vertex_based_yields_a_tape_and_debug_values_but_no_checkpoints() {
        // CustomVertexBased is instrumented in generate_maze_with_events (GitHub issue #143) and
        // its event kind is web-decodable — its arm produces no checkpoints (out of scope for
        // #143, mirroring Kruskal's #146/#161, Wilson's #145, and CustomEdgeBased's #144
        // precedent), but does declare the "visited", "frontier", and "reserve" debug values (all
        // Region-kind).
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::CustomVertexBased(maze_core::generation::GenerationParams::default()), ..GenerationConfig::default() };
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 3, start, config, &preset_state, false, true);
        let source = raw_source.expect("CustomVertexBased's event kind is web-decodable");
        assert!(!source.tape.node_table.is_empty(), "a 3x3 CustomVertexBased run must emit at least one event");
        assert!(source.checkpoints.is_none(), "CustomVertexBased does not produce checkpoints");
        assert_eq!(
            debug_value_names,
            vec![
                ("visited".to_string(), maze_core::event_log::DebugValueKind::Region),
                ("frontier".to_string(), maze_core::event_log::DebugValueKind::Region),
                ("reserve".to_string(), maze_core::event_log::DebugValueKind::Region),
            ],
            "CustomVertexBased declares the visited, frontier, and reserve debug values"
        );
        assert_eq!(event_kind, Some(maze_core::event_log::EventedEventKind::VertexBased));
    }

    #[test]
    fn debug_events_true_with_custom_edge_based_yields_a_tape_and_debug_values_but_no_checkpoints() {
        // CustomEdgeBased is instrumented in generate_maze_with_events (GitHub issue #144) and its
        // event kind is web-decodable — its arm produces no checkpoints (out of scope for #144,
        // mirroring Kruskal's #146/#161 and Wilson's #145 precedent), but does declare the
        // "active" and "visited" debug values (both Region-kind).
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::CustomEdgeBased(maze_core::generation::EdgeBasedParams::default()),
            ..GenerationConfig::default()
        };
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 6, start, config, &preset_state, false, true);
        let source = raw_source.expect("CustomEdgeBased's event kind is web-decodable");
        assert!(!source.tape.node_table.is_empty(), "a 3x3 CustomEdgeBased run must emit at least one event");
        assert!(source.checkpoints.is_none(), "CustomEdgeBased does not produce checkpoints");
        assert_eq!(
            debug_value_names,
            vec![
                ("active".to_string(), maze_core::event_log::DebugValueKind::Region),
                ("visited".to_string(), maze_core::event_log::DebugValueKind::Region),
            ],
            "CustomEdgeBased declares the active and visited debug values"
        );
        assert_eq!(event_kind, Some(maze_core::event_log::EventedEventKind::EdgeBased));
    }

    #[test]
    fn debug_events_true_with_kruskal_yields_a_tape_but_no_checkpoints_or_debug_values() {
        // Kruskal is instrumented in generate_maze_with_events (GitHub issue #146) and its event
        // kind is web-decodable — but Kruskal's arm never produces checkpoints or debug values
        // (out of scope for #146, see Specs/event_log.md's #146/#161 sections).
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::KruskalAlgorithm, ..GenerationConfig::default() };
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 4, start, config, &preset_state, false, true);
        let source = raw_source.expect("Kruskal's event kind is web-decodable");
        assert!(!source.tape.node_table.is_empty(), "a 3x3 Kruskal run must emit at least one event");
        assert!(source.checkpoints.is_none(), "Kruskal does not produce checkpoints");
        assert!(debug_value_names.is_empty(), "Kruskal does not declare debug values");
        assert_eq!(event_kind, Some(maze_core::event_log::EventedEventKind::Kruskal));
    }

    #[test]
    fn debug_events_true_with_wilson_yields_a_tape_and_debug_values_but_no_checkpoints() {
        // Wilson is instrumented in generate_maze_with_events (GitHub issue #145) and its event
        // kind is web-decodable — its arm produces no checkpoints (out of scope for #145,
        // mirroring Kruskal's #146/#161 precedent), but does declare the "visited" and
        // "current_walk" debug values.
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::WilsonAlgorithm, ..GenerationConfig::default() };
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 5, start, config, &preset_state, false, true);
        let source = raw_source.expect("Wilson's event kind is web-decodable");
        assert!(!source.tape.node_table.is_empty(), "a 3x3 Wilson run must emit at least one event");
        assert!(source.checkpoints.is_none(), "Wilson does not produce checkpoints");
        assert_eq!(
            debug_value_names,
            vec![
                ("visited".to_string(), maze_core::event_log::DebugValueKind::Region),
                ("current_walk".to_string(), maze_core::event_log::DebugValueKind::Map),
                ("walk_start".to_string(), maze_core::event_log::DebugValueKind::Vertex),
                ("walk_head".to_string(), maze_core::event_log::DebugValueKind::Vertex),
            ],
            "Wilson declares the visited, current_walk, walk_start, and walk_head debug values"
        );
        assert_eq!(event_kind, Some(maze_core::event_log::EventedEventKind::Wilson));
    }

    #[test]
    fn qc_experiment_ignores_debug_events_and_skips_generation() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 5, start, rb_config(), &preset_state, true, true);
        assert!(raw_source.is_none(), "qc_experiment must skip the event tree entirely");
        assert!(event_kind.is_none(), "qc_experiment must skip the event kind entirely");
        assert!(debug_value_names.is_empty(), "qc_experiment must skip debug value names entirely");
        assert_eq!(graph.edges().count(), 0, "qc_experiment must not run the generation algorithm at all");
    }

    #[test]
    fn initial_build_ms_is_a_plausible_finite_duration() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (_, _, _, initial_build_ms) = run_initial_generation(&mut graph, &field, 6, start, rb_config(), &preset_state, false, true);
        assert!(initial_build_ms.is_finite() && initial_build_ms >= 0.0);
    }
}

#[cfg(test)]
mod build_generate_result_tests {
    use super::build_generate_result;
    use maze_core::event_log::{EncodedTape, EncodedCheckpoints, CHECKPOINT_RECORD_SIZE};
    use wasm_bindgen::JsValue;

    #[test]
    fn no_tape_no_checkpoints_yields_neither() {
        let result = build_generate_result(JsValue::UNDEFINED, None, None, Vec::new(), Vec::new());
        assert!(result.debug_tape_bytes().is_none());
        assert!(result.checkpoint_bytes().is_none());
    }

    #[test]
    fn tape_without_checkpoints_yields_only_the_tape() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let result = build_generate_result(
            JsValue::UNDEFINED, Some(tape), None,
            vec![("recursion_stack".to_string(), maze_core::event_log::DebugValueKind::Sequence)],
            vec![("generation", maze_core::event_log::EventedEventKind::RecursiveBacktracker)],
        );
        assert!(result.debug_tape_bytes().is_some());
        assert!(result.checkpoint_bytes().is_none());
        assert_eq!(result.debug_value_names_bytes(), &["recursion_stack".to_string()]);
        assert_eq!(result.debug_value_kinds_bytes(), &["sequence".to_string()]);
    }

    #[test]
    fn tape_with_checkpoints_yields_both() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let checkpoints = EncodedCheckpoints { table: vec![0u8; CHECKPOINT_RECORD_SIZE], payload: vec![6, 7] };
        let result = build_generate_result(
            JsValue::UNDEFINED, Some(tape), Some(checkpoints),
            vec![("recursion_stack".to_string(), maze_core::event_log::DebugValueKind::Sequence)],
            vec![("generation", maze_core::event_log::EventedEventKind::RecursiveBacktracker)],
        );
        assert!(result.debug_tape_bytes().is_some());
        assert!(result.checkpoint_bytes().is_some());
    }

    #[test]
    fn kruskal_tape_carries_kruskal_event_kind() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let result = build_generate_result(
            JsValue::UNDEFINED, Some(tape), None, Vec::new(),
            vec![("generation", maze_core::event_log::EventedEventKind::Kruskal)],
        );
        assert_eq!(result.source_event_kinds_bytes(), &["kruskal".to_string()]);
        assert_eq!(result.source_scope_names_bytes(), &["generation".to_string()]);
    }

    #[test]
    fn wilson_tape_carries_wilson_event_kind_and_map_vertex_kind_debug_values() {
        // Guards build_generate_result's forwarding of Wilson's event kind and Map/Vertex-kind
        // debug values specifically (GitHub issue #145's follow-up) — the other tests in this
        // module only ever exercise RecursiveBacktracker/Kruskal fixtures.
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let result = build_generate_result(
            JsValue::UNDEFINED, Some(tape), None,
            vec![
                ("visited".to_string(), maze_core::event_log::DebugValueKind::Region),
                ("current_walk".to_string(), maze_core::event_log::DebugValueKind::Map),
                ("walk_start".to_string(), maze_core::event_log::DebugValueKind::Vertex),
                ("walk_head".to_string(), maze_core::event_log::DebugValueKind::Vertex),
            ],
            vec![("generation", maze_core::event_log::EventedEventKind::Wilson)],
        );
        assert_eq!(result.source_event_kinds_bytes(), &["wilson".to_string()]);
        assert_eq!(
            result.debug_value_names_bytes(),
            &["visited".to_string(), "current_walk".to_string(), "walk_start".to_string(), "walk_head".to_string()]
        );
        assert_eq!(
            result.debug_value_kinds_bytes(),
            &["region".to_string(), "map".to_string(), "vertex".to_string(), "vertex".to_string()]
        );
    }

    #[test]
    #[should_panic(expected = "with_checkpoints called without a debug tape")]
    fn checkpoints_without_tape_panics() {
        // Not a real code path (run_initial_generation's tape/checkpoints always come from the
        // same EventedGenerationResult, so they're Some/None together) — but this documents and
        // guards the invariant at the boundary between run_initial_generation and this function.
        let checkpoints = EncodedCheckpoints { table: vec![0u8; CHECKPOINT_RECORD_SIZE], payload: vec![6, 7] };
        build_generate_result(JsValue::UNDEFINED, None, Some(checkpoints), Vec::new(), Vec::new());
    }

    #[test]
    #[should_panic(expected = "debug_value_names is non-empty but debug_tape is None")]
    fn debug_value_names_without_tape_panics() {
        // Not a real code path either (same reasoning as checkpoints_without_tape_panics) — RB
        // only ever produces a non-empty debug_value_names alongside Some(tape) — but guards the
        // invariant so a future regression fails loudly instead of silently dropping the names.
        build_generate_result(
            JsValue::UNDEFINED, None, None,
            vec![("recursion_stack".to_string(), maze_core::event_log::DebugValueKind::Sequence)],
            Vec::new(),
        );
    }

    #[test]
    #[should_panic(expected = "debug_tape is Some but sources is empty")]
    fn tape_without_sources_panics() {
        // Guards the invariant run_initial_generation always upholds (tape/sources produced
        // together) — a future regression that drops sources while still forwarding a tape must
        // fail loudly rather than silently mislabeling the tape's decoder on the web side.
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        build_generate_result(JsValue::UNDEFINED, Some(tape), None, Vec::new(), Vec::new());
    }
}

pub fn run_generate<T: Tessellation + 'static>(
    seed: u64,
    field: Field<T>,
    start: T::Point,
    config: &GenerateConfig,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<GenerateResult, JsValue> {
    use maze_core::generation::pipeline::build_maze;

    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    let start_id = field
        .node_at(start)
        .ok_or_else(|| JsValue::from_str("start node not found"))?;

    let gen_config = build_generation_config(config);
    let preset_state = build_preset_state(
        &mut graph, &field,
        &gen_config.preset_connections,
        &gen_config.locked_nodes,
        |x, y| field.all_points().find(|&p| point_to_xy(p) == (x, y)).unwrap_or(start),
    );
    let (generation_source, generation_kind, generation_debug_value_names, initial_build_ms) = run_initial_generation(
        &mut graph, &field, seed, start_id, gen_config, &preset_state, config.qc_experiment, config.debug_events,
    );

    let (qc_engine, check_types) = build_qc_and_repair_with_types::<T>(config)
        .map_err(|e| JsValue::from_str(&e))?;

    let preset_start = config.preset_start.and_then(|[sx, sy]| {
        field.all_points().find(|&p| point_to_xy(p) == (sx, sy)).and_then(|p| field.node_at(p))
    });
    let preset_finish = config.preset_finish.and_then(|[fx, fy]| {
        field.all_points().find(|&p| point_to_xy(p) == (fx, fy)).and_then(|p| field.node_at(p))
    });

    // QC/repair gets its own `EventLog<QcEvent>` only when `debug_events` is on and generation
    // itself produced a forwardable source — a QC tape with no generation tape to merge it
    // against isn't useful (the web replay engine has nothing to anchor step 0 against), so this
    // deliberately doesn't run QC logging independently of `generation_source`'s presence.
    let mut qc_log = (config.debug_events && generation_source.is_some())
        .then(maze_core::event_log::EventLog::new);

    let repair_preset_state = preset_state.for_repair(config.qc_experiment);
    let (mut maze, issues, mut timing) = build_maze(
        field, graph, seed, qc_engine, &repair_preset_state, build_repair_limits(config), preset_start, preset_finish,
        qc_log.as_mut(),
    );
    timing.initial_build_ms = initial_build_ms;

    let mut snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), &check_types, point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;
    snapshot.timing = Some(timing_to_dto(timing));

    use serde::Serialize;
    let snapshot_js = snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Single `merge_tapes` call for the whole pipeline (GitHub issue #147/#169) — folds
    // generation's and QC's independently-produced sources into one merged arena, in execution
    // order (generation always finishes before QC/repair starts). QC's tape is only added when it
    // actually emitted at least one node (an empty stage sequence, or a run that converged with
    // zero repair iterations, produces an empty `DebugTape` — merging an empty source would still
    // add an empty top-level "quality_control" scope, which is harmless but pointless noise).
    let (debug_tape, debug_checkpoints, debug_value_names, sources) = match generation_source {
        Some(generation_source) => {
            let mut sources_meta = vec![(generation_source.scope_name, generation_kind.expect("generation_source implies generation_kind"))];
            let mut tape_sources = vec![generation_source];
            let mut debug_value_name_sources = vec![("generation", generation_debug_value_names)];

            if let Some(qc_tape) = qc_log.map(|log| log.finish().encode()).filter(|tape| !tape.node_table.is_empty()) {
                sources_meta.push(("quality_control", maze_core::event_log::EventedEventKind::QualityControl));
                tape_sources.push(maze_core::event_log::TapeSource { scope_name: "quality_control", tape: qc_tape, checkpoints: None });
                debug_value_name_sources.push(("quality_control", Vec::new()));
            }

            let (merged_tape, merged_checkpoints) = maze_core::event_log::merge_tapes(tape_sources);
            let debug_value_name_sources: Vec<(&'static str, Vec<(&str, maze_core::event_log::DebugValueKind)>)> = debug_value_name_sources
                .iter()
                .map(|(scope_name, names)| (*scope_name, names.iter().map(|(name, kind)| (name.as_str(), *kind)).collect()))
                .collect();
            let debug_value_names = maze_core::generation::qualify_debug_value_names(&debug_value_name_sources);
            (Some(merged_tape), merged_checkpoints, debug_value_names, sources_meta)
        }
        None => (None, None, Vec::new(), Vec::new()),
    };

    Ok(build_generate_result(snapshot_js, debug_tape, debug_checkpoints, debug_value_names, sources))
}

/// Assembles the final `GenerateResult` from the encoded debug tape/checkpoint buffers — split
/// out of `run_generate` so this small piece of pure matching logic is testable natively.
/// `JsValue` itself doesn't require a real WASM runtime to construct/pass around (only
/// `serde_wasm_bindgen` serialization does, which already happened by the time this is called) —
/// unlike `run_generate` as a whole, this function is exercisable by `cargo test`.
fn build_generate_result(
    snapshot_js: JsValue,
    debug_tape: Option<maze_core::event_log::EncodedTape>,
    debug_checkpoints: Option<maze_core::event_log::EncodedCheckpoints>,
    debug_value_names: Vec<(String, maze_core::event_log::DebugValueKind)>,
    sources: Vec<(&'static str, maze_core::event_log::EventedEventKind)>,
) -> GenerateResult {
    let result = match debug_tape {
        Some(tape) => {
            assert!(
                !sources.is_empty(),
                "build_generate_result: debug_tape is Some but sources is empty — \
                 run_initial_generation must always produce them together"
            );
            GenerateResult::with_debug_tape(snapshot_js, tape.node_table, tape.payload, debug_value_names, sources)
        }
        None => {
            assert!(
                debug_value_names.is_empty(),
                "build_generate_result: debug_value_names is non-empty but debug_tape is None — \
                 generate_maze_with_events only produces debug value names alongside a tape (see \
                 EventedGenerationResult's tape/debug_value_names pairing); without_debug_tape has \
                 nowhere to carry them, so this would otherwise silently drop them instead of \
                 surfacing the broken invariant"
            );
            assert!(sources.is_empty(), "build_generate_result: sources is non-empty but debug_tape is None");
            GenerateResult::without_debug_tape(snapshot_js)
        }
    };
    match debug_checkpoints {
        Some(checkpoints) => result.with_checkpoints(checkpoints.table, checkpoints.payload),
        None => result,
    }
}

/// Thin wrapper that also returns `check_types` map needed by `build_analytics_snapshot`.
pub fn build_qc_and_repair_with_types<T: Tessellation + 'static>(
    config: &GenerateConfig,
) -> Result<(maze_core::quality_control::QualityControlEngine<T>, HashMap<String, String>), String> {
    use std::collections::HashSet;

    let mut check_types: HashMap<String, String> = HashMap::new();
    for stage_cfg in &config.stages {
        for rule_cfg in &stage_cfg.rules {
            let mut seen_local_ids: HashSet<&str> = HashSet::new();
            for instance in &rule_cfg.checks {
                if seen_local_ids.insert(instance.local_id.as_str()) {
                    let instance_id = format!("{}:{}", rule_cfg.id, instance.local_id);
                    check_types.insert(instance_id, instance.type_id.clone());
                }
            }
        }
    }

    let qc_engine = maze_runner::runner::build_qc_and_repair::<T>(config)?;
    Ok((qc_engine, check_types))
}

fn timing_to_dto(timing: maze_core::GenerationTiming) -> crate::dto::GenerationTimingDto {
    use crate::dto::{GenerationTimingDto, TimingEntryDto};
    let to_dto_map = |map: std::collections::HashMap<&'static str, maze_core::TimingEntry>| {
        map.into_iter()
            .map(|(id, entry)| (id.to_string(), TimingEntryDto { total_ms: entry.total_ms, calls: entry.calls }))
            .collect()
    };
    GenerationTimingDto {
        initial_build_ms: timing.initial_build_ms,
        qc_total_ms: timing.qc_total_ms,
        repair_total_ms: timing.repair_total_ms,
        per_check: to_dto_map(timing.per_check),
        per_strategy: to_dto_map(timing.per_strategy),
    }
}

#[cfg(test)]
mod build_qc_and_repair_tests {
    use maze_runner::runner::build_qc_and_repair;
    use crate::generation_config::{GenerateConfig, StageConfig, QcRuleConfig, CheckInstanceConfig};
    use maze_core::space::SquareTessellation;

    fn check(local_id: &str, type_id: &str) -> CheckInstanceConfig {
        CheckInstanceConfig { local_id: local_id.to_string(), type_id: type_id.to_string(), params: std::collections::HashMap::new() }
    }

    /// Wraps `rules` in a single default stage — most tests below don't care about staging
    /// itself, just about `build_qc_and_repair`'s per-rule validation, so they use one stage
    /// containing every rule (mirrors the pre-#65 flat `check_rules` shape).
    fn one_stage(rules: Vec<QcRuleConfig>) -> Vec<StageConfig> {
        vec![StageConfig { id: "stage_1".to_string(), name: "Stage 1".to_string(), rules }]
    }

    fn err_msg(config: &GenerateConfig) -> String {
        build_qc_and_repair::<SquareTessellation>(config)
            .err()
            .expect("expected an error")
    }

    #[test]
    fn empty_rule_is_rejected() {
        let config = GenerateConfig {
            stages: one_stage(vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![],
                strategy: None,
            }]),
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("no checks"), "unexpected message: {msg}");
    }

    #[test]
    fn duplicate_local_id_within_one_rule_is_rejected() {
        let config = GenerateConfig {
            stages: one_stage(vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![check("a", "missing_endpoints"), check("a", "missing_endpoints")],
                strategy: None,
            }]),
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("duplicate local_id"), "unexpected message: {msg}");
    }

    #[test]
    fn mixed_kind_rule_is_rejected() {
        let config = GenerateConfig {
            stages: one_stage(vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![check("a", "missing_endpoints"), check("b", "unreachable_finish")],
                strategy: None,
            }]),
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("different issue kinds"), "unexpected message: {msg}");
    }

    #[test]
    fn unknown_strategy_id_is_rejected() {
        use crate::generation_config::StrategyConfig;
        use std::collections::HashMap;

        let config = GenerateConfig {
            stages: one_stage(vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![check("a", "missing_endpoints")],
                strategy: Some(StrategyConfig { id: "not_a_real_strategy".to_string(), params: HashMap::new(), slot_id: None, nested: vec![] }),
            }]),
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("unknown strategy"), "unexpected message: {msg}");
    }

    #[test]
    fn single_rule_with_no_strategy_succeeds() {
        let config = GenerateConfig {
            stages: one_stage(vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![check("a", "missing_endpoints")],
                strategy: None,
            }]),
            ..GenerateConfig::default()
        };
        assert!(build_qc_and_repair::<SquareTessellation>(&config).is_ok());
    }

    #[test]
    fn two_independent_rules_with_distinct_strategies_succeed() {
        use crate::generation_config::StrategyConfig;
        use std::collections::HashMap;

        let config = GenerateConfig {
            stages: one_stage(vec![
                QcRuleConfig {
                    id: "r1".to_string(),
                    checks: vec![check("a", "missing_endpoints")],
                    strategy: Some(StrategyConfig { id: "farthest_endpoints".to_string(), params: HashMap::new(), slot_id: None, nested: vec![] }),
                },
                QcRuleConfig {
                    id: "r2".to_string(),
                    checks: vec![check("b", "unreachable_finish")],
                    strategy: None,
                },
            ]),
            ..GenerateConfig::default()
        };
        assert!(build_qc_and_repair::<SquareTessellation>(&config).is_ok());
    }

    #[test]
    fn two_instances_of_same_check_type_in_different_rules_succeed_independently() {
        use std::collections::HashMap;
        let config = GenerateConfig {
            stages: one_stage(vec![
                QcRuleConfig {
                    id: "r_trap".to_string(),
                    checks: vec![CheckInstanceConfig {
                        local_id: "a".to_string(),
                        type_id: "min_region_count".to_string(),
                        params: HashMap::from([("region_class".to_string(), "trap".to_string()), ("count".to_string(), "2".to_string())]),
                    }],
                    strategy: None,
                },
                QcRuleConfig {
                    id: "r_alt".to_string(),
                    checks: vec![CheckInstanceConfig {
                        local_id: "b".to_string(),
                        type_id: "min_region_count".to_string(),
                        params: HashMap::from([("region_class".to_string(), "alternative".to_string()), ("count".to_string(), "2".to_string())]),
                    }],
                    strategy: None,
                },
            ]),
            ..GenerateConfig::default()
        };
        assert!(build_qc_and_repair::<SquareTessellation>(&config).is_ok());
    }

    #[test]
    fn two_instances_of_same_check_type_in_one_rule_succeed() {
        use std::collections::HashMap;
        let config = GenerateConfig {
            stages: one_stage(vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![
                    CheckInstanceConfig {
                        local_id: "a".to_string(),
                        type_id: "min_region_count".to_string(),
                        params: HashMap::from([("region_class".to_string(), "trap".to_string())]),
                    },
                    CheckInstanceConfig {
                        local_id: "b".to_string(),
                        type_id: "min_region_count".to_string(),
                        params: HashMap::from([("region_class".to_string(), "alternative".to_string())]),
                    },
                ],
                strategy: None,
            }]),
            ..GenerateConfig::default()
        };
        assert!(build_qc_and_repair::<SquareTessellation>(&config).is_ok());
    }

    // --- Stages (issue #65) ---

    // Note: "rule with a strategy not assigned to any stage" can no longer even be expressed,
    // let alone happen — since GitHub issue #106, a `Rule` is constructed and pushed directly
    // into the `Stage` it's configured under (see `maze-runner/src/runner.rs::build_qc_and_repair`),
    // there is no separate "all rules" list a strategy-bearing rule could fail to appear in.
    // `stage.rules` is the sole source of both rule definitions and stage membership.

    #[test]
    fn duplicate_stage_id_is_rejected() {
        let config = GenerateConfig {
            stages: vec![
                StageConfig { id: "stage_1".to_string(), name: "Stage 1".to_string(), rules: vec![QcRuleConfig { id: "r1".to_string(), checks: vec![check("a", "missing_endpoints")], strategy: None }] },
                StageConfig { id: "stage_1".to_string(), name: "Stage 1 (dup)".to_string(), rules: vec![QcRuleConfig { id: "r2".to_string(), checks: vec![check("b", "unreachable_finish")], strategy: None }] },
            ],
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("duplicate stage id"), "unexpected message: {msg}");
    }

    #[test]
    fn duplicate_rule_id_across_stages_is_rejected() {
        let config = GenerateConfig {
            stages: vec![
                StageConfig { id: "stage_1".to_string(), name: "Stage 1".to_string(), rules: vec![QcRuleConfig { id: "r1".to_string(), checks: vec![check("a", "missing_endpoints")], strategy: None }] },
                StageConfig { id: "stage_2".to_string(), name: "Stage 2".to_string(), rules: vec![QcRuleConfig { id: "r1".to_string(), checks: vec![check("b", "unreachable_finish")], strategy: None }] },
            ],
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("duplicate rule id"), "unexpected message: {msg}");
    }

    #[test]
    fn two_stages_build_successfully_with_distinct_rule_and_stage_ids() {
        use crate::generation_config::StrategyConfig;
        use std::collections::HashMap;

        let config = GenerateConfig {
            stages: vec![
                StageConfig {
                    id: "stage_1".to_string(), name: "Stage 1".to_string(),
                    rules: vec![QcRuleConfig {
                        id: "r1".to_string(),
                        checks: vec![check("a", "missing_endpoints")],
                        strategy: Some(StrategyConfig { id: "farthest_endpoints".to_string(), params: HashMap::new(), slot_id: None, nested: vec![] }),
                    }],
                },
                StageConfig {
                    id: "stage_2".to_string(), name: "Stage 2".to_string(),
                    rules: vec![QcRuleConfig {
                        id: "r2".to_string(),
                        checks: vec![check("b", "unreachable_finish")],
                        strategy: None,
                    }],
                },
            ],
            ..GenerateConfig::default()
        };
        let qc_engine = build_qc_and_repair::<SquareTessellation>(&config).unwrap();
        assert_eq!(qc_engine.stages().len(), 2);
        assert_eq!(qc_engine.stages()[0].id, "stage_1");
        assert_eq!(qc_engine.stages()[1].id, "stage_2");
    }
}
