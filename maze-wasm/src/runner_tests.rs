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
    fn field_and_state() -> (Graph, Field<SquareTessellation>, PresetState) {
        let points: Vec<SquarePoint> = (0..3).flat_map(|x| (0..3).map(move |y| SquarePoint { x, y })).collect();
        let mut ids = IdGenerator::new();
        let mut field = Field::<SquareTessellation>::new(points, &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let preset_state = build_preset_state(&mut graph, &mut field, &mut ids, &[], &[], &[], |x, y| SquarePoint { x, y }, None).unwrap();
        (graph, field, preset_state)
    }

    fn rb_config() -> GenerationConfig {
        GenerationConfig { algorithm: GenerationAlgorithm::RecursiveBacktracker, ..GenerationConfig::default() }
    }

    #[test]
    fn debug_events_false_yields_no_debug_tape() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 1, start, rb_config(), &preset_state, false, false);
        assert!(raw_source.is_none(), "debug_events: false must not produce a tape");
        assert!(event_kind.is_none(), "debug_events: false must not produce an event kind");
        assert!(debug_value_names.is_empty(), "debug_events: false must not produce debug value names");
    }

    #[test]
    fn debug_events_true_yields_correctly_strided_debug_tape() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
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
    fn debug_events_true_with_custom_vertex_based_yields_a_tape_and_debug_values() {
        // CustomVertexBased is instrumented in generate_maze_with_events (GitHub issue #143) and
        // its event kind is web-decodable — it declares the "visited", "frontier", and "reserve"
        // debug values (all Region-kind).
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::CustomVertexBased(maze_core::generation::GenerationParams::default()), ..GenerationConfig::default() };
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 3, start, config, &preset_state, false, true);
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
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let config = GenerationConfig {
            algorithm: GenerationAlgorithm::CustomEdgeBased(maze_core::generation::EdgeBasedParams::default()),
            ..GenerationConfig::default()
        };
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 6, start, config, &preset_state, false, true);
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
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::KruskalAlgorithm, ..GenerationConfig::default() };
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 4, start, config, &preset_state, false, true);
        let source = raw_source.expect("Kruskal's event kind is web-decodable");
        assert!(!source.tape.node_table.is_empty(), "a 3x3 Kruskal run must emit at least one event");
        assert!(debug_value_names.is_empty(), "Kruskal does not declare debug values");
        assert_eq!(event_kind, Some(maze_core::event_log::EventedEventKind::Kruskal));
    }

    #[test]
    fn debug_events_true_with_wilson_yields_a_tape_and_debug_values() {
        // Wilson is instrumented in generate_maze_with_events (GitHub issue #145) and its event
        // kind is web-decodable — it declares the "visited" and "current_walk" debug values.
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let config = GenerationConfig { algorithm: GenerationAlgorithm::WilsonAlgorithm, ..GenerationConfig::default() };
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 5, start, config, &preset_state, false, true);
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
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let (raw_source, event_kind, debug_value_names, _) = run_initial_generation(&mut graph, &field, 5, start, rb_config(), &preset_state, true, true);
        assert!(raw_source.is_none(), "qc_experiment must skip the event tree entirely");
        assert!(event_kind.is_none(), "qc_experiment must skip the event kind entirely");
        assert!(debug_value_names.is_empty(), "qc_experiment must skip debug value names entirely");
        assert_eq!(graph.edges().count(), 0, "qc_experiment must not run the generation algorithm at all");
    }

    #[test]
    fn initial_build_ms_is_a_plausible_finite_duration() {
        let (mut graph, field, preset_state) = field_and_state();
        let start = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let (_, _, _, initial_build_ms) = run_initial_generation(&mut graph, &field, 6, start, rb_config(), &preset_state, false, true);
        assert!(initial_build_ms.is_finite() && initial_build_ms >= 0.0);
    }
}

mod build_generate_result_tests {
    use super::super::build_generate_result;
    use maze_core::event_log::EncodedTape;
    use wasm_bindgen::JsValue;

    #[test]
    fn no_tape_yields_none() {
        let result = build_generate_result(JsValue::UNDEFINED, None, Vec::new(), Vec::new());
        assert!(result.debug_tape_bytes().is_none());
    }

    #[test]
    fn tape_yields_the_tape() {
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        let result = build_generate_result(
            JsValue::UNDEFINED, Some(tape),
            vec![("recursion_stack".to_string(), maze_core::event_log::DebugValueKind::Sequence)],
            vec![("generation", maze_core::event_log::EventedEventKind::RecursiveBacktracker)],
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
        );
    }

    #[test]
    #[should_panic(expected = "debug_tape is Some but sources is empty")]
    fn tape_without_sources_panics() {
        // Guards the invariant run_initial_generation always upholds (tape/sources produced
        // together) — a future regression that drops sources while still forwarding a tape must
        // fail loudly rather than silently mislabeling the tape's decoder on the web side.
        let tape = EncodedTape { node_table: vec![1, 2, 3], payload: vec![4, 5] };
        build_generate_result(JsValue::UNDEFINED, Some(tape), Vec::new(), Vec::new());
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
