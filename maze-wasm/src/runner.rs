use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use maze_core::{
    graph::Graph,
    space::{Field, Tessellation},
    generation::{generate_maze, generate_maze_steps, build_preset_state, GenerationStep},
};
use crate::generation_config::{GenerateConfig, build_generation_config, build_repair_limits};
use crate::dto::{EdgeDto, GenerationStepDto};
use crate::analytics::build_analytics_snapshot;

pub fn run_generate<T: Tessellation>(
    seed: u64,
    field: Field<T>,
    start: T::Point,
    config: &GenerateConfig,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<JsValue, JsValue> {
    use maze_core::generation::pipeline::{build_maze, now_ms};

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
    let initial_build_start = now_ms();
    let raw_steps: Vec<GenerationStep> = if config.debug {
        generate_maze_steps(&mut graph, &field, seed, start_id, gen_config, &preset_state)
    } else {
        generate_maze(&mut graph, &field, seed, start_id, gen_config, &preset_state);
        vec![]
    };
    let initial_build_ms = now_ms() - initial_build_start;

    let (qc_engine, repair_engine, check_types) = build_qc_and_repair_with_types::<T>(config)
        .map_err(|e| JsValue::from_str(&e))?;

    let (mut maze, issues, mut timing) = build_maze(field, graph, seed, qc_engine, repair_engine, &preset_state, build_repair_limits(config));
    timing.initial_build_ms = initial_build_ms;

    if let Some([fx, fy]) = config.preset_finish {
        if let Some(finish_id) = maze.field.all_points()
            .find(|&p| point_to_xy(p) == (fx, fy))
            .and_then(|p| maze.field.node_at(p))
        {
            maze.meta.finish = Some(finish_id);
        }
    }
    if let Some([sx, sy]) = config.preset_start {
        if let Some(start_override) = maze.field.all_points()
            .find(|&p| point_to_xy(p) == (sx, sy))
            .and_then(|p| maze.field.node_at(p))
        {
            maze.meta.start = Some(start_override);
        }
    }

    let debug_steps = steps_to_dto(raw_steps);

    let mut snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), &check_types, point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;
    snapshot.debug_steps = debug_steps;
    snapshot.timing = Some(timing_to_dto(timing));

    use serde::Serialize;
    snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Thin wrapper that also returns `check_types` map needed by `build_analytics_snapshot`.
pub fn build_qc_and_repair_with_types<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(maze_core::quality_control::QualityControlEngine<T>, maze_core::repair::RepairEngine<T>, HashMap<String, String>), String> {
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

    let (qc_engine, repair_engine) = maze_runner::runner::build_qc_and_repair::<T>(config)?;
    Ok((qc_engine, repair_engine, check_types))
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
            Some(EdgeDto {
                from: u32::try_from(e.from).ok()?,
                to:   u32::try_from(e.to).ok()?,
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
                strategy: Some(StrategyConfig { id: "not_a_real_strategy".to_string(), params: HashMap::new() }),
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
                    strategy: Some(StrategyConfig { id: "farthest_endpoints".to_string(), params: HashMap::new() }),
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
        let (_, repair_engine) = build_qc_and_repair::<SquareTessellation>(&config).unwrap();
        let routing = repair_engine.check_id_to_rule();
        assert_eq!(routing.get("r_trap:a"), Some(&"r_trap".to_string()));
        assert_eq!(routing.get("r_alt:b"), Some(&"r_alt".to_string()));
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
        let (_, repair_engine) = build_qc_and_repair::<SquareTessellation>(&config).unwrap();
        let routing = repair_engine.check_id_to_rule();
        assert_eq!(routing.get("r1:a"), Some(&"r1".to_string()));
        assert_eq!(routing.get("r1:b"), Some(&"r1".to_string()));
    }

    // --- Stages (issue #65) ---

    // Note: "rule with a strategy not assigned to any stage" (`build_qc_and_repair`'s
    // "not assigned to any stage" error) is unreachable from this function's own input shape —
    // `stage.rules` is the sole source of both rule definitions and stage membership (see plan's
    // "Отдельное 'stages', check_rules уходит"), so every strategy-bearing rule parsed here is
    // always added to that same stage's `rule_ids`. The check exists as a defensive invariant on
    // `RepairEngine::new`'s caller contract, exercised directly at the `maze-core` level instead
    // — see `pipeline_test.rs`'s stage tests and `engine.rs`'s
    // `strategy_rule_ids_for_stage_intersects_stage_and_strategy_rules`.

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
                        strategy: Some(StrategyConfig { id: "farthest_endpoints".to_string(), params: HashMap::new() }),
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
        let (_, repair_engine) = build_qc_and_repair::<SquareTessellation>(&config).unwrap();
        assert_eq!(repair_engine.stages().len(), 2);
        assert_eq!(repair_engine.stages()[0].id, "stage_1");
        assert_eq!(repair_engine.stages()[1].id, "stage_2");
    }
}
