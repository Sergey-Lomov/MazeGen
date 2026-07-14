use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use maze_core::{
    graph::Graph,
    space::{Field, Tessellation},
    generation::{generate_maze, generate_maze_steps, generate_maze_with_events, build_preset_state, GenerationStep},
};
use crate::generation_config::{GenerateConfig, build_generation_config, build_repair_limits};
use crate::dto::{EdgeDto, EdgeKindDto, GenerationStepDto};
use crate::analytics::build_analytics_snapshot;
use crate::result::GenerateResult;

/// Runs the initial (pre-QC/repair) generation pass and returns the legacy step trace, the
/// encoded debug event tape, the encoded intermediate snapshot checkpoints (GitHub issue #128),
/// and the elapsed time for the generation call itself — split out of `run_generate` so this
/// branch-selection/timing logic is testable natively (no `JsValue`/`serde_wasm_bindgen`, which
/// panic outside a real WASM runtime — see GitHub issue #124's `run_initial_generation_tests`
/// below for why `run_generate` itself can't be exercised by `cargo test`).
///
/// QC experiment mode skips the generation algorithm entirely — the graph already holds only
/// preset connections (built by `build_preset_state` before this call), fed straight into
/// `build_maze`'s QC/repair pass. `debug_steps`/the event tree/checkpoints have nothing to record
/// in this case, so `debug_events`/`debug` are ignored here rather than erroring.
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
    debug: bool,
) -> (Vec<GenerationStep>, Option<maze_core::event_log::EncodedTape>, Option<maze_core::event_log::EncodedCheckpoints>, f64) {
    use maze_core::generation::pipeline::now_ms;

    let initial_build_start = now_ms();
    let (raw_steps, tape, checkpoints): (Vec<GenerationStep>, Option<maze_core::event_log::DebugTape<_>>, Option<maze_core::event_log::CheckpointLog>) = if qc_experiment {
        (vec![], None, None)
    } else if debug_events {
        // `debug` and `debug_events` are independent (see GitHub issue #124) — pass `debug`
        // through too so both debug systems can be enabled together during the migration.
        let result = generate_maze_with_events(graph, field, seed, start_id, gen_config, preset_state, debug);
        (result.steps, result.tape, result.checkpoints)
    } else if debug {
        (generate_maze_steps(graph, field, seed, start_id, gen_config, preset_state), None, None)
    } else {
        generate_maze(graph, field, seed, start_id, gen_config, preset_state);
        (vec![], None, None)
    };
    let initial_build_ms = now_ms() - initial_build_start;
    let debug_tape = tape.map(|t| t.encode());
    let debug_checkpoints = checkpoints.map(|c| c.encode());

    (raw_steps, debug_tape, debug_checkpoints, initial_build_ms)
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
        let (_, debug_tape, debug_checkpoints, _) = run_initial_generation(&mut graph, &field, 1, start, rb_config(), &preset_state, false, false, false);
        assert!(debug_tape.is_none(), "debug_events: false must not produce a tape");
        assert!(debug_checkpoints.is_none(), "debug_events: false must not produce checkpoints");
    }

    #[test]
    fn debug_events_true_yields_correctly_strided_debug_tape() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (_, debug_tape, _, _) = run_initial_generation(&mut graph, &field, 2, start, rb_config(), &preset_state, false, true, false);
        let tape = debug_tape.expect("debug_events: true must produce a tape");

        assert!(!tape.node_table.is_empty(), "a 3x3 RB run must emit at least one event");
        assert_eq!(tape.node_table.len() % maze_core::event_log::NODE_RECORD_SIZE, 0, "node table must be a whole number of NodeRecords");
        assert!(!tape.payload.is_empty(), "payload arena must hold at least the root scope name");
    }

    #[test]
    fn debug_events_true_yields_checkpoint_buffer_shorter_than_checkpoint_interval() {
        // A 3x3 RB run emits far fewer than CHECKPOINT_INTERVAL (500) mutating events, so no
        // checkpoint is ever recorded — but the (empty) table must still be present, since
        // Recursive Backtracker was instrumented (checkpoints: Some/None must track tape: Some/None).
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (_, _, debug_checkpoints, _) = run_initial_generation(&mut graph, &field, 2, start, rb_config(), &preset_state, false, true, false);
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
        let (_, debug_tape, debug_checkpoints, _) = run_initial_generation(&mut graph, &field, 3, start, config, &preset_state, false, true, false);
        assert!(debug_tape.is_none(), "only Recursive Backtracker is instrumented so far");
        assert!(debug_checkpoints.is_none(), "only Recursive Backtracker is instrumented so far");
    }

    #[test]
    fn debug_events_and_debug_can_be_enabled_together() {
        // Independent flags (see GitHub issue #124) — combining them must not panic, and both
        // debug systems' output must be present.
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (raw_steps, debug_tape, _, _) = run_initial_generation(&mut graph, &field, 4, start, rb_config(), &preset_state, false, true, true);
        assert!(debug_tape.is_some(), "debug_events: true must still produce a tape when debug is also set");
        assert!(!raw_steps.is_empty(), "debug: true must still collect GenerationStep trace when debug_events is also set");
    }

    #[test]
    fn qc_experiment_ignores_debug_events_and_skips_generation() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (raw_steps, debug_tape, debug_checkpoints, _) = run_initial_generation(&mut graph, &field, 5, start, rb_config(), &preset_state, true, true, false);
        assert!(debug_tape.is_none(), "qc_experiment must skip the event tree entirely");
        assert!(debug_checkpoints.is_none(), "qc_experiment must skip checkpointing entirely");
        assert!(raw_steps.is_empty());
        assert_eq!(graph.edges().count(), 0, "qc_experiment must not run the generation algorithm at all");
    }

    #[test]
    fn initial_build_ms_is_a_plausible_finite_duration() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let (_, _, _, initial_build_ms) = run_initial_generation(&mut graph, &field, 6, start, rb_config(), &preset_state, false, true, false);
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
        let result = build_generate_result(JsValue::UNDEFINED, None, None);
        assert!(result.debug_tape_bytes().is_none());
        assert!(result.checkpoint_bytes().is_none());
    }

    #[test]
    fn tape_without_checkpoints_yields_only_the_tape() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let result = build_generate_result(JsValue::UNDEFINED, Some(tape), None);
        assert!(result.debug_tape_bytes().is_some());
        assert!(result.checkpoint_bytes().is_none());
    }

    #[test]
    fn tape_with_checkpoints_yields_both() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let checkpoints = EncodedCheckpoints { table: vec![0u8; CHECKPOINT_RECORD_SIZE], payload: vec![6, 7] };
        let result = build_generate_result(JsValue::UNDEFINED, Some(tape), Some(checkpoints));
        assert!(result.debug_tape_bytes().is_some());
        assert!(result.checkpoint_bytes().is_some());
    }

    #[test]
    #[should_panic(expected = "with_checkpoints called without a debug tape")]
    fn checkpoints_without_tape_panics() {
        // Not a real code path (run_initial_generation's tape/checkpoints always come from the
        // same EventedGenerationResult, so they're Some/None together) — but this documents and
        // guards the invariant at the boundary between run_initial_generation and this function.
        let checkpoints = EncodedCheckpoints { table: vec![0u8; CHECKPOINT_RECORD_SIZE], payload: vec![6, 7] };
        build_generate_result(JsValue::UNDEFINED, None, Some(checkpoints));
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
    let (raw_steps, debug_tape, debug_checkpoints, initial_build_ms) = run_initial_generation(
        &mut graph, &field, seed, start_id, gen_config, &preset_state, config.qc_experiment, config.debug_events, config.debug,
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

    let debug_steps = steps_to_dto(raw_steps);

    let mut snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), &check_types, point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;
    snapshot.debug_steps = debug_steps;
    snapshot.timing = Some(timing_to_dto(timing));

    use serde::Serialize;
    let snapshot_js = snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(build_generate_result(snapshot_js, debug_tape, debug_checkpoints))
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
) -> GenerateResult {
    let result = match debug_tape {
        Some(tape) => GenerateResult::with_debug_tape(snapshot_js, tape.node_table, tape.payload),
        None => GenerateResult::without_debug_tape(snapshot_js),
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

fn steps_to_dto(raw: Vec<GenerationStep>) -> Vec<GenerationStepDto> {
    raw.into_iter().map(|s| {
        let edges = s.edges.into_iter().filter_map(|e| {
            let kind = match e.kind {
                maze_core::graph::EdgeKind::Basic => EdgeKindDto::Basic,
                maze_core::graph::EdgeKind::Teleport => EdgeKindDto::Teleport,
            };
            Some(EdgeDto {
                from: u32::try_from(e.from).ok()?,
                to:   u32::try_from(e.to).ok()?,
                kind,
            })
        }).collect();
        let active_nodes = s.active_nodes.into_iter()
            .filter_map(|id| u32::try_from(id).ok())
            .collect();
        let current_src = u32::try_from(s.current_src).unwrap_or(0);
        GenerationStepDto { edges, active_nodes, current_src }
    }).collect()
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
