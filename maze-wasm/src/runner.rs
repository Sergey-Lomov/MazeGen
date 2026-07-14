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

/// Runs the initial (pre-QC/repair) generation pass and returns the encoded debug event tape,
/// the encoded intermediate snapshot checkpoints (GitHub issue #128), and the elapsed time for
/// the generation call itself — split out of `run_generate` so this branch-selection/timing
/// logic is testable natively (no `JsValue`/`serde_wasm_bindgen`, which panic outside a real WASM
/// runtime — see GitHub issue #124's `run_initial_generation_tests` below for why `run_generate`
/// itself can't be exercised by `cargo test`).
///
/// QC experiment mode skips the generation algorithm entirely — the graph already holds only
/// preset connections (built by `build_preset_state` before this call), fed straight into
/// `build_maze`'s QC/repair pass. The event tree/checkpoints have nothing to record in this case,
/// so `debug_events` is ignored here rather than erroring.
///
/// Encoding (`DebugTape::encode()`/`CheckpointLog::encode()`) happens *after* the timing window
/// closes — it's a WASM-boundary transfer cost, not part of the generation algorithm, and must
/// not inflate `initial_build_ms` (GitHub issue #56's per-stage timing breakdown).
fn run_initial_generation<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start_id: maze_core::ids::NodeId,
    gen_config: maze_core::generation::GenerationConfig,
    preset_state: &maze_core::generation::PresetState,
    qc_experiment: bool,
    debug_events: bool,
) -> (Option<maze_core::event_log::EncodedTape>, Option<maze_core::event_log::EncodedCheckpoints>, Vec<(String, maze_core::event_log::DebugValueKind)>, Option<maze_core::event_log::EventedEventKind>, f64) {
    use maze_core::generation::pipeline::now_ms;

    let initial_build_start = now_ms();
    let (tape, checkpoints, debug_value_names, event_kind): (
        Option<maze_core::event_log::EncodedTape>,
        Option<maze_core::event_log::CheckpointLog>,
        Vec<(String, maze_core::event_log::DebugValueKind)>,
        Option<maze_core::event_log::EventedEventKind>,
    ) = if qc_experiment {
        (None, None, Vec::new(), None)
    } else if debug_events {
        let result = generate_maze_with_events(graph, field, seed, start_id, gen_config, preset_state);
        // Only forward the tape/checkpoints/names past the WASM boundary when the web replay
        // engine can actually decode this event kind (GitHub issue #161) — Recursive Backtracker
        // and Kruskal (#146) so far. Gating on `event_kind` (a tag the tape itself carries) rather
        // than re-matching on `gen_config.algorithm` means this check can't drift out of sync with
        // which algorithms `generate_maze_with_events` instruments: extend `is_web_decodable`
        // below once a new event kind gets a web decoder, and that's the only place this list
        // needs to change.
        if is_web_decodable(result.event_kind) {
            let names = result.debug_value_names.iter().map(|(name, kind)| (name.to_string(), *kind)).collect();
            (result.tape, result.checkpoints, names, result.event_kind)
        } else {
            (None, None, Vec::new(), None)
        }
    } else {
        generate_maze(graph, field, seed, start_id, gen_config, preset_state);
        (None, None, Vec::new(), None)
    };
    let initial_build_ms = now_ms() - initial_build_start;
    let debug_checkpoints = checkpoints.map(|c| c.encode());

    (tape, debug_checkpoints, debug_value_names, event_kind, initial_build_ms)
}

/// Which [`maze_core::event_log::EventedEventKind`]s the web replay engine (`maze-web/src/debug/
/// eventTape.ts`) can decode today — Recursive Backtracker's and Kruskal's wire tags (GitHub
/// issue #146). Extend this when a new event kind gets a web decoder.
fn is_web_decodable(kind: Option<maze_core::event_log::EventedEventKind>) -> bool {
    matches!(
        kind,
        Some(maze_core::event_log::EventedEventKind::RecursiveBacktracker)
            | Some(maze_core::event_log::EventedEventKind::Kruskal)
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
        let (debug_tape, debug_checkpoints, debug_value_names, _, _) = run_initial_generation(&mut graph, &field, 1, start, rb_config(), &preset_state, false, false);
        assert!(debug_tape.is_none(), "debug_events: false must not produce a tape");
        assert!(debug_checkpoints.is_none(), "debug_events: false must not produce checkpoints");
        assert!(debug_value_names.is_empty(), "debug_events: false must not produce debug value names");
    }

    #[test]
    fn debug_events_true_yields_correctly_strided_debug_tape() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (debug_tape, _, debug_value_names, _, _) = run_initial_generation(&mut graph, &field, 2, start, rb_config(), &preset_state, false, true);
        let tape = debug_tape.expect("debug_events: true must produce a tape");

        assert!(!tape.node_table.is_empty(), "a 3x3 RB run must emit at least one event");
        assert_eq!(tape.node_table.len() % maze_core::event_log::NODE_RECORD_SIZE, 0, "node table must be a whole number of NodeRecords");
        assert!(!tape.payload.is_empty(), "payload arena must hold at least the root scope name");
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
        let (_, debug_checkpoints, _, _, _) = run_initial_generation(&mut graph, &field, 2, start, rb_config(), &preset_state, false, true);
        let checkpoints = debug_checkpoints.expect("debug_events: true must produce a checkpoint buffer for Recursive Backtracker");
        assert!(checkpoints.table.is_empty(), "a 3x3 RB run has far fewer than CHECKPOINT_INTERVAL mutating events");
        assert_eq!(checkpoints.table.len() % maze_core::event_log::CHECKPOINT_RECORD_SIZE, 0);
    }

    #[test]
    fn debug_events_true_with_non_recursive_backtracker_yields_no_tape() {
        // generate_maze_with_events only instruments RecursiveBacktracker (see #123's scope) —
        // debug_events must not panic on other algorithms, just produce no tape.
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::WilsonAlgorithm, ..GenerationConfig::default() };
        let (debug_tape, debug_checkpoints, debug_value_names, _, _) = run_initial_generation(&mut graph, &field, 3, start, config, &preset_state, false, true);
        assert!(debug_tape.is_none(), "only Recursive Backtracker is instrumented so far");
        assert!(debug_checkpoints.is_none(), "only Recursive Backtracker is instrumented so far");
        assert!(debug_value_names.is_empty(), "only Recursive Backtracker declares debug values so far");
    }

    #[test]
    fn debug_events_true_with_kruskal_yields_a_tape_but_no_checkpoints_or_debug_values() {
        // Kruskal is instrumented in generate_maze_with_events (GitHub issue #146) and its event
        // kind is web-decodable — but Kruskal's arm never produces checkpoints or debug values
        // (out of scope for #146, see Specs/event_log.md's #146/#161 sections).
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::KruskalAlgorithm, ..GenerationConfig::default() };
        let (debug_tape, debug_checkpoints, debug_value_names, event_kind, _) = run_initial_generation(&mut graph, &field, 4, start, config, &preset_state, false, true);
        let tape = debug_tape.expect("Kruskal's event kind is web-decodable");
        assert!(!tape.node_table.is_empty(), "a 3x3 Kruskal run must emit at least one event");
        assert!(debug_checkpoints.is_none(), "Kruskal does not produce checkpoints");
        assert!(debug_value_names.is_empty(), "Kruskal does not declare debug values");
        assert_eq!(event_kind, Some(maze_core::event_log::EventedEventKind::Kruskal));
    }

    #[test]
    fn qc_experiment_ignores_debug_events_and_skips_generation() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (debug_tape, debug_checkpoints, debug_value_names, _, _) = run_initial_generation(&mut graph, &field, 5, start, rb_config(), &preset_state, true, true);
        assert!(debug_tape.is_none(), "qc_experiment must skip the event tree entirely");
        assert!(debug_checkpoints.is_none(), "qc_experiment must skip checkpointing entirely");
        assert!(debug_value_names.is_empty(), "qc_experiment must skip debug value names entirely");
        assert_eq!(graph.edges().count(), 0, "qc_experiment must not run the generation algorithm at all");
    }

    #[test]
    fn initial_build_ms_is_a_plausible_finite_duration() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (_, _, _, _, initial_build_ms) = run_initial_generation(&mut graph, &field, 6, start, rb_config(), &preset_state, false, true);
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
        let result = build_generate_result(JsValue::UNDEFINED, None, None, Vec::new(), None);
        assert!(result.debug_tape_bytes().is_none());
        assert!(result.checkpoint_bytes().is_none());
    }

    #[test]
    fn tape_without_checkpoints_yields_only_the_tape() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let result = build_generate_result(
            JsValue::UNDEFINED, Some(tape), None,
            vec![("recursion_stack".to_string(), maze_core::event_log::DebugValueKind::Sequence)],
            Some(maze_core::event_log::EventedEventKind::RecursiveBacktracker),
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
            Some(maze_core::event_log::EventedEventKind::RecursiveBacktracker),
        );
        assert!(result.debug_tape_bytes().is_some());
        assert!(result.checkpoint_bytes().is_some());
    }

    #[test]
    fn kruskal_tape_carries_kruskal_event_kind() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let result = build_generate_result(
            JsValue::UNDEFINED, Some(tape), None, Vec::new(),
            Some(maze_core::event_log::EventedEventKind::Kruskal),
        );
        assert_eq!(result.event_kind_bytes(), Some("kruskal"));
    }

    #[test]
    #[should_panic(expected = "with_checkpoints called without a debug tape")]
    fn checkpoints_without_tape_panics() {
        // Not a real code path (run_initial_generation's tape/checkpoints always come from the
        // same EventedGenerationResult, so they're Some/None together) — but this documents and
        // guards the invariant at the boundary between run_initial_generation and this function.
        let checkpoints = EncodedCheckpoints { table: vec![0u8; CHECKPOINT_RECORD_SIZE], payload: vec![6, 7] };
        build_generate_result(JsValue::UNDEFINED, None, Some(checkpoints), Vec::new(), None);
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
            None,
        );
    }

    #[test]
    #[should_panic(expected = "debug_tape is Some but event_kind is None")]
    fn tape_without_event_kind_panics() {
        // Guards the invariant run_initial_generation always upholds (tape/event_kind produced
        // together) — a future regression that drops event_kind while still forwarding a tape
        // must fail loudly rather than silently mislabeling the tape's decoder on the web side.
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        build_generate_result(JsValue::UNDEFINED, Some(tape), None, Vec::new(), None);
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
    let (debug_tape, debug_checkpoints, debug_value_names, event_kind, initial_build_ms) = run_initial_generation(
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

    let repair_preset_state = preset_state.for_repair(config.qc_experiment);
    let (mut maze, issues, mut timing) = build_maze(field, graph, seed, qc_engine, &repair_preset_state, build_repair_limits(config), preset_start, preset_finish);
    timing.initial_build_ms = initial_build_ms;

    let mut snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), &check_types, point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;
    snapshot.timing = Some(timing_to_dto(timing));

    use serde::Serialize;
    let snapshot_js = snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(build_generate_result(snapshot_js, debug_tape, debug_checkpoints, debug_value_names, event_kind))
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
    event_kind: Option<maze_core::event_log::EventedEventKind>,
) -> GenerateResult {
    let result = match debug_tape {
        Some(tape) => {
            let kind = event_kind.expect("build_generate_result: debug_tape is Some but event_kind is None — run_initial_generation must always produce them together");
            GenerateResult::with_debug_tape(snapshot_js, tape.node_table, tape.payload, debug_value_names, kind)
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
