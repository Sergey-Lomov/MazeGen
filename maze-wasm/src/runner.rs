use std::collections::HashSet;
use wasm_bindgen::prelude::*;
use maze_core::{
    graph::Graph,
    space::{Field, Tessellation},
    generation::{generate_maze, generate_maze_steps, build_preset_state, GenerationStep},
    quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MinLoopsCountCheck, MIN_LOOPS_DEFAULT, MinLoopDensityCheck, MIN_LOOP_DENSITY_DEFAULT, AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, MinLoopLengthCheck, MIN_LOOP_LENGTH_DEFAULT, MaxLoopLengthCheck, MAX_LOOP_LENGTH_DEFAULT, ExternalEscapeDiversityCheck, EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, LoopDistanceFromStartCheck, LOOP_DISTANCE_FROM_START_DEFAULT, LoopDistanceFromFinishCheck, LOOP_DISTANCE_FROM_FINISH_DEFAULT, MaxLoopDensityCheck, MAX_LOOP_DENSITY_DEFAULT, SccCountCheck, MAX_SCC_COUNT_DEFAULT, MinRegionSizeCheck, MIN_REGION_SIZE_DEFAULT, MinRegionRatioCheck, MIN_REGION_RATIO_DEFAULT, MinRegionCountCheck, MIN_REGION_COUNT_DEFAULT, IssueKind, MISSING_ENDPOINTS, UNREACHABLE_FINISH, MISSING_LOOPS, INVALID_LOOP, EXCESSIVE_SCC_COUNT, REGION_NEEDS_EXPANSION, MISSING_REGIONS},
    repair::{QcRule, RepairEngine, RepairRuleConfig, RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy, InvalidLoopRandomStrategy, InvalidLoopScoredStrategy, MissingLoopsRandomStrategy, ExpandRegionPassageStrategy},
    RegionClass,
};
use crate::generation_config::{GenerateConfig, CheckInstanceConfig, build_generation_config, build_repair_limits};
use crate::dto::{EdgeDto, GenerationStepDto};
use crate::analytics::build_analytics_snapshot;

/// Resolves a check **type** id (`available_checks()`'s `CheckDescriptor.id`) to the `IssueKind`
/// it produces — used to validate `QcRuleConfig` (all checks in a rule must share one kind).
/// Unlike before GitHub issue #60, this no longer also returns a `CheckId`: attribution/routing
/// uses the opaque per-instance composite id (`composite_check_id`) instead, so there is nothing
/// for this function to hand back beyond the `IssueKind`.
///
/// Panics on an unknown id — the only call sites (`build_qc_and_repair_impl`'s check-building and
/// rule-validation loops) only ever pass ids already matched against the same `match` arms below.
/// An `Option` return here would have a `None` arm no caller can actually reach; `unreachable!`
/// documents that instead of silently swallowing a contract violation that should never happen.
fn check_kind_for_type(type_id: &str) -> IssueKind {
    match type_id {
        "missing_endpoints" => MISSING_ENDPOINTS,
        "unreachable_finish" => UNREACHABLE_FINISH,
        "min_loops_count" => MISSING_LOOPS,
        "min_loop_density" => MISSING_LOOPS,
        "min_loop_length" => INVALID_LOOP,
        "max_loop_length" => INVALID_LOOP,
        "external_escape_diversity" => INVALID_LOOP,
        "loop_distance_from_start" => INVALID_LOOP,
        "loop_distance_from_finish" => INVALID_LOOP,
        "max_loop_density" => INVALID_LOOP,
        "scc_count" => EXCESSIVE_SCC_COUNT,
        "min_region_size" => REGION_NEEDS_EXPANSION,
        "min_region_ratio" => REGION_NEEDS_EXPANSION,
        "min_region_count" => MISSING_REGIONS,
        other => unreachable!("check_kind_for_type called with type_id not in the validated set: {other}"),
    }
}

/// The opaque routing/attribution key for one check instance — `Issue.source_checks`/`details`,
/// `QcRule.checks`, and `RepairEngine::check_id_to_rule` all key by this, never by `rule_id`/
/// `local_id` separately (see GitHub issue #60 and `Specs/quality_control.md`). Despite containing
/// `rule_id` as a readable prefix, this is treated as fully opaque outside this module — no code
/// in `maze-core` ever parses it back apart.
fn composite_check_id(rule_id: &str, local_id: &str) -> String {
    format!("{rule_id}:{local_id}")
}

/// Builds one `Box<dyn Check<T>>` from a `CheckInstanceConfig`, dispatching on its `type_id`.
/// `instance_id` is the composite routing key (`composite_check_id`) already computed by the
/// caller — every check struct gets one uniformly, including the two zero-field structs, so
/// there is no two-tier "some checks support multiple instances, some don't" model to document
/// separately.
fn build_check<T: Tessellation>(
    instance: &CheckInstanceConfig,
    instance_id: String,
) -> Result<Box<dyn maze_core::quality_control::Check<T>>, String> {
    let check: Box<dyn maze_core::quality_control::Check<T>> = match instance.type_id.as_str() {
        "missing_endpoints" => Box::new(MissingEndpointsCheck { instance_id }),
        "unreachable_finish" => Box::new(UnreachableFinishCheck { instance_id }),
        "min_loops_count" => {
            let min_loops = instance.params
                .get("min_loops")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_LOOPS_DEFAULT);
            Box::new(MinLoopsCountCheck { instance_id, min_loops })
        }
        "min_loop_density" => {
            let min_density = instance.params
                .get("min_density")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MIN_LOOP_DENSITY_DEFAULT);
            let avg_loop_length_estimate = instance.params
                .get("avg_loop_length_estimate")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(AVG_LOOP_LENGTH_ESTIMATE_DEFAULT);
            Box::new(MinLoopDensityCheck { instance_id, min_density, avg_loop_length_estimate })
        }
        "min_loop_length" => {
            let min_loop_length = instance.params
                .get("min_loop_length")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_LOOP_LENGTH_DEFAULT);
            Box::new(MinLoopLengthCheck { instance_id, min_loop_length })
        }
        "max_loop_length" => {
            let max_loop_length = instance.params
                .get("max_loop_length")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MAX_LOOP_LENGTH_DEFAULT);
            Box::new(MaxLoopLengthCheck { instance_id, max_loop_length })
        }
        "external_escape_diversity" => {
            let min_distinct_exits = instance.params
                .get("min_distinct_exits")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(EXTERNAL_ESCAPE_DIVERSITY_DEFAULT);
            Box::new(ExternalEscapeDiversityCheck { instance_id, min_distinct_exits })
        }
        "loop_distance_from_start" => {
            let min_distance_from_start = instance.params
                .get("min_distance_from_start")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(LOOP_DISTANCE_FROM_START_DEFAULT);
            Box::new(LoopDistanceFromStartCheck { instance_id, min_distance_from_start })
        }
        "loop_distance_from_finish" => {
            let min_distance_from_finish = instance.params
                .get("min_distance_from_finish")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(LOOP_DISTANCE_FROM_FINISH_DEFAULT);
            Box::new(LoopDistanceFromFinishCheck { instance_id, min_distance_from_finish })
        }
        "max_loop_density" => {
            let max_density = instance.params
                .get("max_density")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MAX_LOOP_DENSITY_DEFAULT);
            Box::new(MaxLoopDensityCheck { instance_id, max_density })
        }
        "scc_count" => {
            let max_scc_count = instance.params
                .get("max_scc_count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MAX_SCC_COUNT_DEFAULT);
            Box::new(SccCountCheck { instance_id, max_scc_count })
        }
        "min_region_size" => {
            let min_region_size = instance.params
                .get("min_region_size")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(1) as u32)
                .unwrap_or(MIN_REGION_SIZE_DEFAULT);
            Box::new(MinRegionSizeCheck { instance_id, min_region_size })
        }
        "min_region_ratio" => {
            let min_region_ratio = instance.params
                .get("min_region_ratio")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.clamp(0, 100) as u32)
                .unwrap_or(MIN_REGION_RATIO_DEFAULT);
            Box::new(MinRegionRatioCheck { instance_id, min_region_ratio })
        }
        "min_region_count" => {
            let region_class = instance.params
                .get("region_class")
                .and_then(|v| RegionClass::from_str(v))
                .unwrap_or(RegionClass::Trap);
            let min_count = instance.params
                .get("count")
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v.max(0) as u32)
                .unwrap_or(MIN_REGION_COUNT_DEFAULT);
            Box::new(MinRegionCountCheck { instance_id, region_class, min_count })
        }
        other => return Err(format!("unknown check: {other}")),
    };
    Ok(check)
}

/// Third element: composite check id -> type id, for every active check across all rules —
/// `analytics.rs` threads this onto `IssueDto.source_check_types` so the web UI can resolve a
/// check-specific detail label (keyed by type id) from an `Issue.source_checks` entry (now an
/// opaque composite id, not a `CheckId` it could format itself) — see GitHub issue #60.
pub fn build_qc_and_repair<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<T>, RepairEngine<T>, std::collections::HashMap<String, String>), JsValue> {
    build_qc_and_repair_impl(config).map_err(|e| JsValue::from_str(&e))
}

/// Pure-`String`-error core of `build_qc_and_repair` — split out so the rule/strategy
/// validation logic can be unit-tested without going through `JsValue`, which calls into real
/// JS bindgen externs and aborts when run outside an actual wasm/JS host (e.g. plain
/// `cargo test` on a native target).
fn build_qc_and_repair_impl<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<T>, RepairEngine<T>, std::collections::HashMap<String, String>), String> {
    let mut checks: Vec<Box<dyn maze_core::quality_control::Check<T>>> = Vec::new();
    let mut check_types: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut all_rules: Vec<QcRule> = Vec::new();
    let mut repair_rules: Vec<RepairRuleConfig<T>> = Vec::new();

    for rule_cfg in &config.check_rules {
        if rule_cfg.checks.is_empty() {
            return Err(format!("rule {} has no checks", rule_cfg.id));
        }
        let mut kind: Option<IssueKind> = None;
        let mut composite_ids: Vec<String> = Vec::with_capacity(rule_cfg.checks.len());
        // Duplicate `local_id` within one rule is the only thing left to validate here — "a
        // check belongs to at most one rule" no longer needs checking at all, since a check is
        // now declared inline inside exactly one rule's `checks` and simply can't appear in two
        // (see GitHub issue #60). This is a defense against malformed/hand-edited configs, not a
        // path the UI's own `local_id` counter can ever trigger.
        let mut seen_local_ids: HashSet<&str> = HashSet::new();
        for instance in &rule_cfg.checks {
            if !seen_local_ids.insert(instance.local_id.as_str()) {
                return Err(format!("rule {} has duplicate local_id: {}", rule_cfg.id, instance.local_id));
            }
            let this_kind = check_kind_for_type(&instance.type_id);
            match kind {
                None => kind = Some(this_kind),
                Some(k) if k == this_kind => {}
                Some(_) => return Err(format!("checks in rule {} produce different issue kinds", rule_cfg.id)),
            }
            let instance_id = composite_check_id(&rule_cfg.id, &instance.local_id);
            check_types.insert(instance_id.clone(), instance.type_id.clone());
            checks.push(build_check::<T>(instance, instance_id.clone())?);
            composite_ids.push(instance_id);
        }
        let kind = kind.expect("non-empty rule always resolves a kind");
        let rule = QcRule { id: rule_cfg.id.clone(), kind, checks: composite_ids.clone() };

        if let Some(strategy_cfg) = &rule_cfg.strategy {
            let strategy: Box<dyn RepairStrategy<T>> = match strategy_cfg.id.as_str() {
                "random_endpoints"   => Box::new(RandomEndpointsStrategy),
                "farthest_endpoints" => Box::new(FarthestEndpointsStrategy),
                "scored_endpoints"   => Box::new(ScoredEndpointsStrategy),
                "invalid_loop_random" => Box::new(InvalidLoopRandomStrategy),
                "invalid_loop_scored" => Box::new(InvalidLoopScoredStrategy),
                "missing_loops_random" => Box::new(MissingLoopsRandomStrategy),
                "expand_region_passage" => Box::new(ExpandRegionPassageStrategy),
                other => return Err(format!("unknown strategy: {other}")),
            };
            repair_rules.push(RepairRuleConfig {
                rule: QcRule { id: rule_cfg.id.clone(), kind, checks: composite_ids },
                strategy,
                param_overrides: strategy_cfg.params.clone(),
            });
        }
        all_rules.push(rule);
    }
    // `QualityControlEngine` runs every check independently and performs no dedup by `type_id`
    // — multiple instances of the same check type are a normal, expected case here (the whole
    // point of GitHub issue #60), not an edge case worth special-casing or collapsing.
    let qc_engine = QualityControlEngine::new(checks);
    let repair_engine = RepairEngine::new(repair_rules, all_rules);

    Ok((qc_engine, repair_engine, check_types))
}

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

    let (qc_engine, repair_engine, check_types) = build_qc_and_repair::<T>(config)?;

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
    use super::*;
    use crate::generation_config::{QcRuleConfig, CheckInstanceConfig};
    use maze_core::space::SquareTessellation;

    fn check(local_id: &str, type_id: &str) -> CheckInstanceConfig {
        CheckInstanceConfig { local_id: local_id.to_string(), type_id: type_id.to_string(), params: std::collections::HashMap::new() }
    }

    fn err_msg(config: &GenerateConfig) -> String {
        build_qc_and_repair_impl::<SquareTessellation>(config)
            .err()
            .expect("expected an error")
    }

    #[test]
    fn empty_rule_is_rejected() {
        let config = GenerateConfig {
            check_rules: vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![],
                strategy: None,
            }],
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("no checks"), "unexpected message: {msg}");
    }

    #[test]
    fn duplicate_local_id_within_one_rule_is_rejected() {
        let config = GenerateConfig {
            check_rules: vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![check("a", "missing_endpoints"), check("a", "missing_endpoints")],
                strategy: None,
            }],
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("duplicate local_id"), "unexpected message: {msg}");
    }

    #[test]
    fn mixed_kind_rule_is_rejected() {
        let config = GenerateConfig {
            check_rules: vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![check("a", "missing_endpoints"), check("b", "unreachable_finish")],
                strategy: None,
            }],
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
            check_rules: vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![check("a", "missing_endpoints")],
                strategy: Some(StrategyConfig { id: "not_a_real_strategy".to_string(), params: HashMap::new() }),
            }],
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("unknown strategy"), "unexpected message: {msg}");
    }

    #[test]
    fn single_rule_with_no_strategy_succeeds() {
        let config = GenerateConfig {
            check_rules: vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec![check("a", "missing_endpoints")],
                strategy: None,
            }],
            ..GenerateConfig::default()
        };
        assert!(build_qc_and_repair_impl::<SquareTessellation>(&config).is_ok());
    }

    #[test]
    fn two_independent_rules_with_distinct_strategies_succeed() {
        use crate::generation_config::StrategyConfig;
        use std::collections::HashMap;

        let config = GenerateConfig {
            check_rules: vec![
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
            ],
            ..GenerateConfig::default()
        };
        assert!(build_qc_and_repair_impl::<SquareTessellation>(&config).is_ok());
    }

    /// Two `min_region_count` instances (different `region_class`) in two different rules — the
    /// core scenario GitHub issue #60 exists for. Each routes/merges independently.
    #[test]
    fn two_instances_of_same_check_type_in_different_rules_succeed_independently() {
        use std::collections::HashMap;
        let config = GenerateConfig {
            check_rules: vec![
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
            ],
            ..GenerateConfig::default()
        };
        let (_, repair_engine, check_types) = build_qc_and_repair_impl::<SquareTessellation>(&config).unwrap();
        let routing = repair_engine.check_id_to_rule();
        assert_eq!(routing.get("r_trap:a"), Some(&"r_trap".to_string()));
        assert_eq!(routing.get("r_alt:b"), Some(&"r_alt".to_string()));
        assert_eq!(check_types.get("r_trap:a"), Some(&"min_region_count".to_string()));
        assert_eq!(check_types.get("r_alt:b"), Some(&"min_region_count".to_string()));
    }

    /// Two `min_region_count` instances in the *same* rule — both route to the one rule, merging
    /// normally (no special-casing for "same type" vs "different type" checks in one rule).
    #[test]
    fn two_instances_of_same_check_type_in_one_rule_succeed() {
        use std::collections::HashMap;
        let config = GenerateConfig {
            check_rules: vec![QcRuleConfig {
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
            }],
            ..GenerateConfig::default()
        };
        let (_, repair_engine, _) = build_qc_and_repair_impl::<SquareTessellation>(&config).unwrap();
        let routing = repair_engine.check_id_to_rule();
        assert_eq!(routing.get("r1:a"), Some(&"r1".to_string()));
        assert_eq!(routing.get("r1:b"), Some(&"r1".to_string()));
    }
}
