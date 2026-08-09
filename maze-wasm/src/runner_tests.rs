mod is_web_decodable_tests {
    use super::super::is_web_decodable;
    use maze_core::event_log::EventedEventKind;

    #[test]
    fn preset_setup_is_web_decodable() {
        assert!(is_web_decodable(Some(EventedEventKind::PresetSetup)));
    }

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

mod run_initial_generation_tests {
    use super::super::run_initial_generation;
    use maze_core::graph::Graph;
    use maze_core::ids::IdGenerator;
    use maze_core::space::{Field, SquareTessellation, SquarePoint};
    use maze_core::generation::{GenerationAlgorithm, GenerationConfig, PresetState, build_preset_state};

    /// A 3x3 square field with no preset connections/locks — enough for Recursive Backtracker
    /// to actually run and emit events.
    fn field_and_state() -> (Graph, Field<SquareTessellation>, PresetState, IdGenerator) {
        let points: Vec<SquarePoint> = (0..3).flat_map(|x| (0..3).map(move |y| SquarePoint { x, y })).collect();
        let mut ids = IdGenerator::new();
        let mut field = Field::<SquareTessellation>::new(points, &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let preset_state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], |x, y| SquarePoint { x, y }, None, None).unwrap();
        (graph, field, preset_state, ids)
    }

    fn rb_config() -> GenerationConfig {
        GenerationConfig { algorithm: GenerationAlgorithm::RecursiveBacktracker, ..GenerationConfig::default() }
    }

    #[test]
    fn debug_events_false_yields_no_debug_tape() {
        let (mut graph, mut field, preset_state, mut ids) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let (raw_source, event_kind, debug_value_names, _, _, _) = run_initial_generation(&mut graph, &mut field, &mut ids, 1, start, rb_config(), &preset_state, false, false);
        assert!(raw_source.is_none(), "debug_events: false must not produce a tape");
        assert!(event_kind.is_none(), "debug_events: false must not produce an event kind");
        assert!(debug_value_names.is_empty(), "debug_events: false must not produce debug value names");
    }

    #[test]
    fn debug_events_true_yields_correctly_strided_debug_tape() {
        let (mut graph, mut field, preset_state, mut ids) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let (raw_source, _, debug_value_names, _, _, _) = run_initial_generation(&mut graph, &mut field, &mut ids, 2, start, rb_config(), &preset_state, false, true);
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
    fn debug_events_true_with_custom_vertex_based_yields_a_tape_and_debug_values() {
        // CustomVertexBased is instrumented in generate_maze_with_events (GitHub issue #143) and
        // its event kind is web-decodable — it declares the "visited", "frontier", and "reserve"
        // debug values (all Region-kind).
        let (mut graph, mut field, preset_state, mut ids) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::CustomVertexBased(maze_core::generation::GenerationParams::default()), ..GenerationConfig::default() };
        let (raw_source, event_kind, debug_value_names, _, _, _) = run_initial_generation(&mut graph, &mut field, &mut ids, 3, start, config, &preset_state, false, true);
        let source = raw_source.expect("CustomVertexBased's event kind is web-decodable");
        assert!(!source.tape.node_table.is_empty(), "a 3x3 CustomVertexBased run must emit at least one event");
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
    fn debug_events_true_with_custom_edge_based_yields_a_tape_and_debug_values() {
        // CustomEdgeBased is instrumented in generate_maze_with_events (GitHub issue #144) and its
        // event kind is web-decodable — it declares the "active" and "visited" debug values (both
        // Region-kind).
        let (mut graph, mut field, preset_state, mut ids) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::CustomEdgeBased(maze_core::generation::EdgeBasedParams::default()),
            ..GenerationConfig::default()
        };
        let (raw_source, event_kind, debug_value_names, _, _, _) = run_initial_generation(&mut graph, &mut field, &mut ids, 6, start, config, &preset_state, false, true);
        let source = raw_source.expect("CustomEdgeBased's event kind is web-decodable");
        assert!(!source.tape.node_table.is_empty(), "a 3x3 CustomEdgeBased run must emit at least one event");
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
    fn debug_events_true_with_kruskal_yields_a_tape_but_no_debug_values() {
        // Kruskal is instrumented in generate_maze_with_events (GitHub issue #146) and its event
        // kind is web-decodable — but Kruskal's arm never produces debug values (out of scope for
        // #146, see Specs/event_log.md's #146/#161 sections).
        let (mut graph, mut field, preset_state, mut ids) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::KruskalAlgorithm, ..GenerationConfig::default() };
        let (raw_source, event_kind, debug_value_names, _, _, _) = run_initial_generation(&mut graph, &mut field, &mut ids, 4, start, config, &preset_state, false, true);
        let source = raw_source.expect("Kruskal's event kind is web-decodable");
        assert!(!source.tape.node_table.is_empty(), "a 3x3 Kruskal run must emit at least one event");
        assert!(debug_value_names.is_empty(), "Kruskal does not declare debug values");
        assert_eq!(event_kind, Some(maze_core::event_log::EventedEventKind::Kruskal));
    }

    #[test]
    fn debug_events_true_with_wilson_yields_a_tape_and_debug_values() {
        // Wilson is instrumented in generate_maze_with_events (GitHub issue #145) and its event
        // kind is web-decodable — it declares the "visited" and "current_walk" debug values.
        let (mut graph, mut field, preset_state, mut ids) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::WilsonAlgorithm, ..GenerationConfig::default() };
        let (raw_source, event_kind, debug_value_names, _, _, _) = run_initial_generation(&mut graph, &mut field, &mut ids, 5, start, config, &preset_state, false, true);
        let source = raw_source.expect("Wilson's event kind is web-decodable");
        assert!(!source.tape.node_table.is_empty(), "a 3x3 Wilson run must emit at least one event");
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
        let (mut graph, mut field, preset_state, mut ids) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let (raw_source, event_kind, debug_value_names, _, _, _) = run_initial_generation(&mut graph, &mut field, &mut ids, 5, start, rb_config(), &preset_state, true, true);
        assert!(raw_source.is_none(), "qc_experiment must skip the event tree entirely");
        assert!(event_kind.is_none(), "qc_experiment must skip the event kind entirely");
        assert!(debug_value_names.is_empty(), "qc_experiment must skip debug value names entirely");
        assert_eq!(graph.edges().count(), 0, "qc_experiment must not run the generation algorithm at all");
    }

    #[test]
    fn initial_build_ms_is_a_plausible_finite_duration() {
        let (mut graph, mut field, preset_state, mut ids) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let (_, _, _, initial_build_ms, _, _) = run_initial_generation(&mut graph, &mut field, &mut ids, 6, start, rb_config(), &preset_state, false, true);
        assert!(initial_build_ms.is_finite() && initial_build_ms >= 0.0);
    }
}

mod build_generate_result_tests {
    use super::super::build_generate_result;
    use maze_core::event_log::EncodedTape;
    use wasm_bindgen::JsValue;

    #[test]
    fn no_tape_yields_none() {
        let result = build_generate_result(JsValue::UNDEFINED, None, Vec::new(), Vec::new(), JsValue::UNDEFINED);
        assert!(result.debug_tape_bytes().is_none());
    }

    #[test]
    fn tape_yields_the_tape() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let result = build_generate_result(
            JsValue::UNDEFINED, Some(tape),
            vec![("recursion_stack".to_string(), maze_core::event_log::DebugValueKind::Sequence)],
            vec![("generation", maze_core::event_log::EventedEventKind::RecursiveBacktracker)],
            JsValue::UNDEFINED,
        );
        assert!(result.debug_tape_bytes().is_some());
        assert_eq!(result.debug_value_names_bytes(), &["recursion_stack".to_string()]);
        assert_eq!(result.debug_value_kinds_bytes(), &["sequence".to_string()]);
    }

    #[test]
    fn kruskal_tape_carries_kruskal_event_kind() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let result = build_generate_result(
            JsValue::UNDEFINED, Some(tape), Vec::new(),
            vec![("generation", maze_core::event_log::EventedEventKind::Kruskal)],
            JsValue::UNDEFINED,
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
            JsValue::UNDEFINED, Some(tape),
            vec![
                ("visited".to_string(), maze_core::event_log::DebugValueKind::Region),
                ("current_walk".to_string(), maze_core::event_log::DebugValueKind::Map),
                ("walk_start".to_string(), maze_core::event_log::DebugValueKind::Vertex),
                ("walk_head".to_string(), maze_core::event_log::DebugValueKind::Vertex),
            ],
            vec![("generation", maze_core::event_log::EventedEventKind::Wilson)],
            JsValue::UNDEFINED,
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
    #[should_panic(expected = "debug_value_names is non-empty but debug_tape is None")]
    fn debug_value_names_without_tape_panics() {
        // Not a real code path (RB only ever produces a non-empty debug_value_names alongside
        // Some(tape)) — but guards the invariant so a future regression fails loudly instead of
        // silently dropping the names.
        build_generate_result(
            JsValue::UNDEFINED, None,
            vec![("recursion_stack".to_string(), maze_core::event_log::DebugValueKind::Sequence)],
            Vec::new(),
            JsValue::UNDEFINED,
        );
    }

    #[test]
    #[should_panic(expected = "debug_tape is Some but sources is empty")]
    fn tape_without_sources_panics() {
        // Guards the invariant run_initial_generation always upholds (tape/sources produced
        // together) — a future regression that drops sources while still forwarding a tape must
        // fail loudly rather than silently mislabeling the tape's decoder on the web side.
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        build_generate_result(JsValue::UNDEFINED, Some(tape), Vec::new(), Vec::new(), JsValue::UNDEFINED);
    }
}

mod merge_debug_sources_tests {
    use super::super::merge_debug_sources;
    use maze_core::event_log::{EncodedTape, EventedEventKind, EventLog, TapeSource};
    use maze_core::quality_control::QcEvent;

    fn generation_tape_source() -> TapeSource {
        let mut log = EventLog::new();
        log.emit(maze_core::generation::RecursiveBacktrackerEvent::EdgeAdded { from: 0, to: 1, bidirectional: true });
        TapeSource { scope_name: "generation", tape: log.finish().encode() }
    }

    fn preset_setup_tape_source() -> TapeSource {
        let mut log = EventLog::new();
        log.emit(maze_core::generation::PresetSetupEvent::PassageEstablished { from: 0, to: 1 });
        TapeSource { scope_name: maze_core::generation::PRESET_SETUP_SCOPE_NAME, tape: log.finish().encode() }
    }

    fn qc_tape_with_one_event() -> EncodedTape {
        let mut log = EventLog::new();
        log.emit(QcEvent::StartSet(0));
        log.finish().encode()
    }

    fn empty_qc_tape() -> EncodedTape {
        EventLog::<QcEvent>::new().finish().encode()
    }

    #[test]
    fn nothing_present_yields_no_tape() {
        let (tape, names, sources) = merge_debug_sources(None, None, None, Vec::new(), None);
        assert!(tape.is_none());
        assert!(names.is_empty());
        assert!(sources.is_empty());
    }

    #[test]
    fn qc_only_no_other_source_still_yields_a_tape_with_just_the_quality_control_scope() {
        // GitHub issue #173: qc_experiment mode never has a generation_source, but QC/repair's own
        // tape must still surface, not be dropped.
        let (tape, names, sources) = merge_debug_sources(None, None, None, Vec::new(), Some(qc_tape_with_one_event()));
        assert!(tape.is_some(), "a standalone QC tape must still produce a merged tape");
        assert_eq!(sources, vec![("quality_control", EventedEventKind::QualityControl)]);
        assert!(names.is_empty());
    }

    #[test]
    fn generation_only_no_qc_tape_yields_just_the_generation_scope() {
        let (tape, _names, sources) = merge_debug_sources(
            None, Some(generation_tape_source()), Some(EventedEventKind::RecursiveBacktracker), Vec::new(), None,
        );
        assert!(tape.is_some());
        assert_eq!(sources, vec![("generation", EventedEventKind::RecursiveBacktracker)]);
    }

    #[test]
    fn generation_plus_qc_yields_both_scopes_in_order() {
        let (tape, _names, sources) = merge_debug_sources(
            None, Some(generation_tape_source()), Some(EventedEventKind::RecursiveBacktracker), Vec::new(), Some(qc_tape_with_one_event()),
        );
        assert!(tape.is_some());
        assert_eq!(sources, vec![
            ("generation", EventedEventKind::RecursiveBacktracker),
            ("quality_control", EventedEventKind::QualityControl),
        ]);
    }

    #[test]
    fn generation_with_a_missing_qc_tape_omits_the_quality_control_scope() {
        let (tape, _names, sources) = merge_debug_sources(
            None, Some(generation_tape_source()), Some(EventedEventKind::RecursiveBacktracker), Vec::new(), None,
        );
        assert!(tape.is_some());
        assert_eq!(sources.len(), 1, "no quality_control scope when qc_tape is None");
    }

    #[test]
    fn generation_with_an_empty_qc_tape_still_adds_a_zero_step_quality_control_scope() {
        // An empty QC tape (e.g. debug_events on but zero repair iterations ran) next to a real
        // generation source still becomes its own scope — QcEvent's own is_mutating split (not
        // presence/absence of a scope) is what keeps an empty QC contribution from adding visible
        // steps to totalSteps; the scope itself existing is harmless and lets narration show
        // "quality control did nothing" rather than silently omitting the phase.
        let (tape, _names, sources) = merge_debug_sources(
            None, Some(generation_tape_source()), Some(EventedEventKind::RecursiveBacktracker), Vec::new(), Some(empty_qc_tape()),
        );
        assert!(tape.is_some());
        assert_eq!(sources, vec![
            ("generation", EventedEventKind::RecursiveBacktracker),
            ("quality_control", EventedEventKind::QualityControl),
        ]);
    }

    #[test]
    fn qc_only_with_an_empty_qc_tape_still_yields_a_zero_step_quality_control_scope() {
        // GitHub issue #173: qc_experiment mode on a graph with no preset connections and no
        // repair mutations (e.g. an empty field where no strategy can act) — QC's tape is empty,
        // but with no other source it's the only thing there is to show, so it must still surface
        // as a (zero-step) scope rather than yield no debug arena at all.
        let (tape, names, sources) = merge_debug_sources(None, None, None, Vec::new(), Some(empty_qc_tape()));
        assert!(tape.is_some(), "an empty QC tape must still produce a merged tape when it's the only source");
        assert_eq!(sources, vec![("quality_control", EventedEventKind::QualityControl)]);
        assert!(names.is_empty());
    }

    #[test]
    fn preset_setup_always_comes_first_when_present() {
        // GitHub issue #225: preset setup, generation, and QC can each independently be present;
        // when all three are, preset setup must lead.
        let (tape, _names, sources) = merge_debug_sources(
            Some(preset_setup_tape_source()),
            Some(generation_tape_source()), Some(EventedEventKind::RecursiveBacktracker),
            Vec::new(), Some(qc_tape_with_one_event()),
        );
        assert!(tape.is_some());
        assert_eq!(sources, vec![
            (maze_core::generation::PRESET_SETUP_SCOPE_NAME, EventedEventKind::PresetSetup),
            ("generation", EventedEventKind::RecursiveBacktracker),
            ("quality_control", EventedEventKind::QualityControl),
        ]);
    }

    #[test]
    fn preset_setup_plus_qc_only_qc_experiment_still_leads_with_preset_setup() {
        // qc_experiment mode skips generation but still has preset edges and a QC tape.
        let (tape, _names, sources) = merge_debug_sources(
            Some(preset_setup_tape_source()), None, None, Vec::new(), Some(qc_tape_with_one_event()),
        );
        assert!(tape.is_some());
        assert_eq!(sources, vec![
            (maze_core::generation::PRESET_SETUP_SCOPE_NAME, EventedEventKind::PresetSetup),
            ("quality_control", EventedEventKind::QualityControl),
        ]);
    }
}

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
                params: std::collections::HashMap::new(),
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
                params: std::collections::HashMap::new(),
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
                params: std::collections::HashMap::new(),
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
                params: HashMap::new(),
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
                params: std::collections::HashMap::new(),
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
                    params: HashMap::new(),
                },
                QcRuleConfig {
                    id: "r2".to_string(),
                    checks: vec![check("b", "unreachable_finish")],
                    strategy: None,
                    params: HashMap::new(),
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
                    params: HashMap::new(),
                },
                QcRuleConfig {
                    id: "r_alt".to_string(),
                    checks: vec![CheckInstanceConfig {
                        local_id: "b".to_string(),
                        type_id: "min_region_count".to_string(),
                        params: HashMap::from([("region_class".to_string(), "alternative".to_string()), ("count".to_string(), "2".to_string())]),
                    }],
                    strategy: None,
                    params: HashMap::new(),
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
                params: HashMap::new(),
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
                StageConfig { id: "stage_1".to_string(), name: "Stage 1".to_string(), rules: vec![QcRuleConfig { id: "r1".to_string(), checks: vec![check("a", "missing_endpoints")], strategy: None, params: std::collections::HashMap::new() }] },
                StageConfig { id: "stage_1".to_string(), name: "Stage 1 (dup)".to_string(), rules: vec![QcRuleConfig { id: "r2".to_string(), checks: vec![check("b", "unreachable_finish")], strategy: None, params: std::collections::HashMap::new() }] },
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
                StageConfig { id: "stage_1".to_string(), name: "Stage 1".to_string(), rules: vec![QcRuleConfig { id: "r1".to_string(), checks: vec![check("a", "missing_endpoints")], strategy: None, params: std::collections::HashMap::new() }] },
                StageConfig { id: "stage_2".to_string(), name: "Stage 2".to_string(), rules: vec![QcRuleConfig { id: "r1".to_string(), checks: vec![check("b", "unreachable_finish")], strategy: None, params: std::collections::HashMap::new() }] },
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
                        params: HashMap::new(),
                    }],
                },
                StageConfig {
                    id: "stage_2".to_string(), name: "Stage 2".to_string(),
                    rules: vec![QcRuleConfig {
                        id: "r2".to_string(),
                        checks: vec![check("b", "unreachable_finish")],
                        strategy: None,
                        params: HashMap::new(),
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

/// `timing_node_to_dto`/`timing_to_dto` are plain struct-to-struct conversions with no
/// `JsValue`/`serde_wasm_bindgen` involved, so — unlike most of this module — they're exercisable
/// directly by `cargo test` (see GitHub issue #285).
mod timing_dto_tests {
    use super::super::{timing_node_to_dto, timing_to_dto};
    use maze_core::{GenerationTiming, TimingEntry, TimingNode};

    #[test]
    fn leaf_node_converts_with_empty_children() {
        let node = TimingNode::new("min_loop_length", TimingEntry { total_ms: 12.5, calls: 3 }, vec![]);
        let dto = timing_node_to_dto(node);
        assert_eq!(dto.id, "min_loop_length");
        assert_eq!(dto.total_ms, 12.5);
        assert_eq!(dto.calls, 3);
        assert!(dto.children.is_empty());
    }

    #[test]
    fn nested_children_convert_recursively_preserving_order() {
        let check = TimingNode::new("check_a", TimingEntry { total_ms: 1.0, calls: 1 }, vec![]);
        let strategy = TimingNode::new("strategy_a", TimingEntry { total_ms: 2.0, calls: 1 }, vec![]);
        let rule = TimingNode::new("rule_1", TimingEntry { total_ms: 3.0, calls: 0 }, vec![check, strategy]);
        let stage = TimingNode::new("stage_1", TimingEntry { total_ms: 3.0, calls: 5 }, vec![rule]);

        let dto = timing_node_to_dto(stage);
        assert_eq!(dto.id, "stage_1");
        assert_eq!(dto.calls, 5);
        assert_eq!(dto.children.len(), 1);
        let rule_dto = &dto.children[0];
        assert_eq!(rule_dto.id, "rule_1");
        assert_eq!(rule_dto.children.len(), 2);
        assert_eq!(rule_dto.children[0].id, "check_a");
        assert_eq!(rule_dto.children[1].id, "strategy_a");
    }

    #[test]
    fn generation_timing_converts_initial_build_ms_and_qc_tree() {
        let stage = TimingNode::new("stage_1", TimingEntry { total_ms: 5.0, calls: 2 }, vec![]);
        let timing = GenerationTiming { initial_build_ms: 42.0, qc: vec![stage] };
        let dto = timing_to_dto(timing);
        assert_eq!(dto.initial_build_ms, 42.0);
        assert_eq!(dto.qc.len(), 1);
        assert_eq!(dto.qc[0].id, "stage_1");
    }

    #[test]
    fn generation_timing_with_no_stages_converts_to_empty_qc() {
        let timing = GenerationTiming { initial_build_ms: 0.0, qc: vec![] };
        let dto = timing_to_dto(timing);
        assert!(dto.qc.is_empty());
    }
}

/// GitHub issue #245: end-to-end check that `run_generate`'s real `repair_preset_state` actually
/// reaches `build_analytics_snapshot`'s `resolve_issue_payload` call, not just that the resolver
/// itself is correct in isolation (covered by `maze-core`'s own `issue_payload.rs` unit tests).
/// Fixture mirrors issue #230's own regression test (`maze-core/src/repair/strategies/
/// invalid_loop_random.rs`'s `apply_reports_failed_when_the_whole_cycle_is_preset_protected`): a
/// 3-node triangle whose every edge is a preset connection — genuinely unfixable by repair.
mod preset_locked_end_to_end_tests {
    use std::collections::HashMap;
    use maze_core::{Graph, IdGenerator, Maze};
    use maze_core::space::{Field, SquareTessellation, square_rect};
    use maze_core::graph::EdgeKind;
    use maze_core::generation::{PresetState, pipeline::{build_maze, RepairLimits}};
    use maze_core::quality_control::{
        QualityControlEngine, Rule, RuleTrait, Stage,
        LoopLengthCheck, Comparison, CycleKind, InvalidLoopIssue,
    };
    use maze_core::repair::InvalidLoopRandomStrategy;
    use crate::analytics::build_analytics_snapshot;

    /// Same 3-node triangle as `invalid_loop_random.rs`'s `maze_with_triangle` — every edge below
    /// the check's `length: 10` threshold, so `LoopLengthCheck` always flags it.
    fn maze_with_triangle() -> (Maze<SquareTessellation>, Vec<maze_core::ids::EdgeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.nodes_at(p)[0]).collect();
        let e0 = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        let e1 = g.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let e2 = g.build_initial_edge(nodes[2], nodes[0], EdgeKind::Basic);
        (Maze::new(field, g), vec![e0, e1, e2])
    }

    fn engine_with_loop_length_rule() -> QualityControlEngine<SquareTessellation> {
        let check = LoopLengthCheck { instance_id: "min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any };
        let rule: Rule<SquareTessellation, InvalidLoopIssue> = Rule::new(
            "r".to_string(),
            vec![("min_loop_length".to_string(), Box::new(check) as Box<dyn maze_core::quality_control::Check<SquareTessellation, InvalidLoopIssue>>)],
            Some(Box::new(InvalidLoopRandomStrategy)),
            HashMap::new(),
            vec![],
        );
        QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![Box::new(rule) as Box<dyn RuleTrait<SquareTessellation>>])])
    }

    #[test]
    fn fully_preset_protected_cycle_reaches_the_snapshot_marked_preset_locked() {
        let (field_maze, cycle_edges) = maze_with_triangle();
        let Maze { field, graph, .. } = field_maze;

        let mut preset_state = PresetState::empty();
        for &edge_id in &cycle_edges {
            let edge = graph.edge(edge_id).unwrap();
            preset_state.preset_edges.insert((edge.from, edge.to));
        }

        let qc = engine_with_loop_length_rule();
        let (mut maze, issues, _timing) = build_maze(field, graph, 7, qc, &preset_state, RepairLimits::default(), None, None, None, None);

        // Sanity: the issue really did survive repair unresolved (same conclusion #230's own test
        // draws) -- otherwise this test would trivially pass with no InvalidLoop issue at all.
        assert!(issues.iter().any(|i| i.kind() == maze_core::quality_control::INVALID_LOOP), "the fully preset-protected cycle must remain in remaining_issues -- repair can't fix it");

        let snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), &HashMap::new(), &preset_state, |p| (p.x, p.y), |_, _, pos| pos as u32).unwrap();

        let invalid_loop_issue = snapshot.issues.iter().find(|i| i.kind == "invalid_loop").expect("snapshot must carry the invalid_loop issue");
        let crate::dto::IssuePayloadDto::InvalidLoop { edges } = &invalid_loop_issue.payload else {
            panic!("expected InvalidLoop payload, got {:?}", invalid_loop_issue.payload)
        };
        let all_elements: Vec<_> = edges.values().flatten().collect();
        assert!(!all_elements.is_empty(), "payload must carry at least one flagged cycle element");
        assert!(all_elements.iter().all(|e| e.preset_locked), "every edge of the flagged cycle is preset-protected -- the resolved element must be preset_locked");
    }

    // GitHub issue #245 follow-up: user report that preset_locked "doesn't work for splits" --
    // this drives the exact real config path (`build_preset_state`, not a hand-built PresetState)
    // for `split_node_connection_per_neighbor`, whose flagged edges originate at a split node --
    // confirms the split-slot preset endpoint actually resolves end-to-end, not just in the
    // resolver-level unit test (`issue_payload.rs`'s
    // `invalid_split_node_connection_group_issue_carries_preset_locked_through_the_invalid_one_way_reuse`,
    // which hand-builds `PresetState` and never exercises `build_preset_state`'s own split-point/
    // endpoint resolution).
    #[test]
    fn split_node_connection_preset_locked_via_real_preset_connection_reaches_the_snapshot() {
        use maze_core::generation::{build_preset_state, PresetConnection, PresetConnectionState, PresetEndpoint};
        use maze_core::quality_control::{SplitNodeConnectionPerNeighborCheck, InvalidSplitNodeConnectionGroupIssue};
        use maze_core::repair::{SplitNodeConnectionGroupSelectStrategy, RemoveSplitNodeConnectionStrategy};
        use maze_core::repair::strategy::{NestedStrategyConfig, RepairStrategy};
        use maze_core::space::SquarePoint;

        // 3x1 field: split point at (1,0) (slot0 + one extra slot), both wired to the neighbor at
        // (0,0) -- same converging-on-one-neighbor shape as maze_with_triangle's sibling fixture
        // in split_node_connection_group_select_tests.rs, but built via the real config path.
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);

        let xy_to_point = |x: i32, y: i32| SquarePoint { x, y };
        let split_points = vec![((1, 0), 0u32)];
        // Both slot0's and the extra slot's connections to the neighbor are preset Passages --
        // the whole group must resolve preset_locked: true (all_preset_locked requires *every*
        // edge in the group to be protected, not just one).
        let preset_connections = vec![
            PresetConnection {
                from: PresetEndpoint::original((1, 0)),
                to: PresetEndpoint::original((0, 0)),
                state: PresetConnectionState::Passage,
            },
            PresetConnection {
                from: PresetEndpoint { point: (1, 0), slot: Some(0) },
                to: PresetEndpoint::original((0, 0)),
                state: PresetConnectionState::Passage,
            },
        ];
        let preset_state = build_preset_state(
            &mut graph, &mut field, &mut ids, &preset_connections, &[], &split_points, xy_to_point, None, None,
        ).unwrap();

        let check = SplitNodeConnectionPerNeighborCheck { instance_id: "split_node_connection_per_neighbor".to_string(), max: 1 };
        let nested: Vec<NestedStrategyConfig<SquareTessellation>> = vec![NestedStrategyConfig {
            slot: &<SplitNodeConnectionGroupSelectStrategy as RepairStrategy<SquareTessellation, InvalidSplitNodeConnectionGroupIssue>>::expected_nested(&SplitNodeConnectionGroupSelectStrategy)[0],
            strategy: Box::new(RemoveSplitNodeConnectionStrategy),
            param_overrides: HashMap::new(),
            nested: vec![],
        }];
        let rule: Rule<SquareTessellation, InvalidSplitNodeConnectionGroupIssue> = Rule::new(
            "r".to_string(),
            vec![("split_node_connection_per_neighbor".to_string(), Box::new(check) as Box<dyn maze_core::quality_control::Check<SquareTessellation, InvalidSplitNodeConnectionGroupIssue>>)],
            Some(Box::new(SplitNodeConnectionGroupSelectStrategy)),
            HashMap::new(),
            nested,
        );
        let qc = QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![Box::new(rule) as Box<dyn RuleTrait<SquareTessellation>>])]);

        let (mut maze, issues, _timing) = build_maze(field, graph, 7, qc, &preset_state, RepairLimits::default(), None, None, None, None);

        assert!(issues.iter().any(|i| i.kind() == maze_core::quality_control::INVALID_SPLIT_NODE_CONNECTION_GROUP),
            "the fully preset-protected group must remain in remaining_issues -- repair can't fix it");

        let snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), &HashMap::new(), &preset_state, |p| (p.x, p.y), |_, _, pos| pos as u32).unwrap();

        let issue_dto = snapshot.issues.iter().find(|i| i.kind == "invalid_split_node_connection_group")
            .expect("snapshot must carry the invalid_split_node_connection_group issue");
        // Reused wire shape (GitHub issue #245's doc comment on resolve_issue_payload) -- payload.kind
        // stays "invalid_one_way", not "invalid_split_node_connection_group".
        let crate::dto::IssuePayloadDto::InvalidOneWay { groups } = &issue_dto.payload else {
            panic!("expected InvalidOneWay (reused wire shape), got {:?}", issue_dto.payload)
        };
        let all_elements: Vec<_> = groups.values().flatten().collect();
        assert!(!all_elements.is_empty(), "payload must carry at least one flagged group element");
        assert!(all_elements.iter().all(|e| e.preset_locked), "every edge of the flagged group is preset-protected -- the resolved element must be preset_locked");
    }
}
