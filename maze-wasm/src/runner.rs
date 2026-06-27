use std::collections::HashSet;
use wasm_bindgen::prelude::*;
use maze_core::{
    graph::Graph,
    space::{Field, Tessellation},
    generation::{generate_maze, generate_maze_steps, build_preset_state, GenerationStep},
    quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MinLoopsCountCheck, MIN_LOOPS_DEFAULT, MinLoopDensityCheck, MIN_LOOP_DENSITY_DEFAULT, AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, MinLoopLengthCheck, MIN_LOOP_LENGTH_DEFAULT, MaxLoopLengthCheck, MAX_LOOP_LENGTH_DEFAULT, ExternalEscapeDiversityCheck, EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, LoopDistanceFromStartCheck, LOOP_DISTANCE_FROM_START_DEFAULT, LoopDistanceFromFinishCheck, LOOP_DISTANCE_FROM_FINISH_DEFAULT, MaxLoopDensityCheck, MAX_LOOP_DENSITY_DEFAULT, IssueKind, MISSING_ENDPOINTS, UNREACHABLE_FINISH, MISSING_LOOPS, INVALID_LOOP},
    repair::{QcRule, CheckId, RepairEngine, RepairRuleConfig, RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy, InvalidLoopRandomStrategy, InvalidLoopScoredStrategy, MissingLoopsRandomStrategy},
};
use crate::generation_config::{GenerateConfig, build_generation_config, build_repair_limits};
use crate::dto::{EdgeDto, GenerationStepDto};
use crate::analytics::build_analytics_snapshot;

/// Resolves a check type id (`available_checks()`'s `CheckDescriptor.id`) to the `IssueKind`
/// it produces and its `CheckId` — used to validate `QcRuleConfig` (all checks in a rule must
/// share one kind) and to build `CheckId` without needing a `Check<T>` instance.
///
/// Panics on an unknown id — the only call site (`build_qc_and_repair_impl`) only ever passes
/// ids already validated against `config.checks`, which is restricted to this same 8-id set
/// (the `match` in this function's neighboring check-building loop). An `Option` return here
/// would have a `None` arm no caller can actually reach; `unreachable!` documents that instead
/// of silently swallowing a contract violation that should never happen.
fn check_id_info(id: &str) -> (IssueKind, CheckId) {
    match id {
        "missing_endpoints" => (MISSING_ENDPOINTS, CheckId::MissingEndpoints),
        "unreachable_finish" => (UNREACHABLE_FINISH, CheckId::UnreachableFinish),
        "min_loops_count" => (MISSING_LOOPS, CheckId::MinLoopsCount),
        "min_loop_density" => (MISSING_LOOPS, CheckId::MinLoopDensity),
        "min_loop_length" => (INVALID_LOOP, CheckId::MinLoopLength),
        "max_loop_length" => (INVALID_LOOP, CheckId::MaxLoopLength),
        "external_escape_diversity" => (INVALID_LOOP, CheckId::ExternalEscapeDiversity),
        "loop_distance_from_start" => (INVALID_LOOP, CheckId::LoopDistanceFromStart),
        "loop_distance_from_finish" => (INVALID_LOOP, CheckId::LoopDistanceFromFinish),
        "max_loop_density" => (INVALID_LOOP, CheckId::MaxLoopDensity),
        other => unreachable!("check_id_info called with id not in config.checks's validated set: {other}"),
    }
}

pub fn build_qc_and_repair<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<T>, RepairEngine<T>), JsValue> {
    build_qc_and_repair_impl(config).map_err(|e| JsValue::from_str(&e))
}

/// Pure-`String`-error core of `build_qc_and_repair` — split out so the rule/strategy
/// validation logic can be unit-tested without going through `JsValue`, which calls into real
/// JS bindgen externs and aborts when run outside an actual wasm/JS host (e.g. plain
/// `cargo test` on a native target).
fn build_qc_and_repair_impl<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<T>, RepairEngine<T>), String> {
    let mut checks: Vec<Box<dyn maze_core::quality_control::Check<T>>> = Vec::new();
    for id in &config.checks {
        match id.as_str() {
            "missing_endpoints" => checks.push(Box::new(MissingEndpointsCheck)),
            "unreachable_finish" => checks.push(Box::new(UnreachableFinishCheck)),
            "min_loops_count" => {
                let min_loops = config.check_params
                    .get("min_loops_count")
                    .and_then(|p| p.get("min_loops"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.max(1) as u32)
                    .unwrap_or(MIN_LOOPS_DEFAULT);
                checks.push(Box::new(MinLoopsCountCheck { min_loops }));
            }
            "min_loop_density" => {
                let min_density = config.check_params
                    .get("min_loop_density")
                    .and_then(|p| p.get("min_density"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.clamp(0, 100) as u32)
                    .unwrap_or(MIN_LOOP_DENSITY_DEFAULT);
                let avg_loop_length_estimate = config.check_params
                    .get("min_loop_density")
                    .and_then(|p| p.get("avg_loop_length_estimate"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.max(1) as u32)
                    .unwrap_or(AVG_LOOP_LENGTH_ESTIMATE_DEFAULT);
                checks.push(Box::new(MinLoopDensityCheck { min_density, avg_loop_length_estimate }));
            }
            "min_loop_length" => {
                let min_loop_length = config.check_params
                    .get("min_loop_length")
                    .and_then(|p| p.get("min_loop_length"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.max(1) as u32)
                    .unwrap_or(MIN_LOOP_LENGTH_DEFAULT);
                checks.push(Box::new(MinLoopLengthCheck { min_loop_length }));
            }
            "max_loop_length" => {
                let max_loop_length = config.check_params
                    .get("max_loop_length")
                    .and_then(|p| p.get("max_loop_length"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.max(1) as u32)
                    .unwrap_or(MAX_LOOP_LENGTH_DEFAULT);
                checks.push(Box::new(MaxLoopLengthCheck { max_loop_length }));
            }
            "external_escape_diversity" => {
                let min_distinct_exits = config.check_params
                    .get("external_escape_diversity")
                    .and_then(|p| p.get("min_distinct_exits"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.max(0) as u32)
                    .unwrap_or(EXTERNAL_ESCAPE_DIVERSITY_DEFAULT);
                checks.push(Box::new(ExternalEscapeDiversityCheck { min_distinct_exits }));
            }
            "loop_distance_from_start" => {
                let min_distance_from_start = config.check_params
                    .get("loop_distance_from_start")
                    .and_then(|p| p.get("min_distance_from_start"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.max(0) as u32)
                    .unwrap_or(LOOP_DISTANCE_FROM_START_DEFAULT);
                checks.push(Box::new(LoopDistanceFromStartCheck { min_distance_from_start }));
            }
            "loop_distance_from_finish" => {
                let min_distance_from_finish = config.check_params
                    .get("loop_distance_from_finish")
                    .and_then(|p| p.get("min_distance_from_finish"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.max(0) as u32)
                    .unwrap_or(LOOP_DISTANCE_FROM_FINISH_DEFAULT);
                checks.push(Box::new(LoopDistanceFromFinishCheck { min_distance_from_finish }));
            }
            "max_loop_density" => {
                let max_density = config.check_params
                    .get("max_loop_density")
                    .and_then(|p| p.get("max_density"))
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v.clamp(0, 100) as u32)
                    .unwrap_or(MAX_LOOP_DENSITY_DEFAULT);
                checks.push(Box::new(MaxLoopDensityCheck { max_density }));
            }
            other => return Err(format!("unknown check: {other}")),
        }
    }
    let qc_engine = QualityControlEngine::new(checks);

    // Validate: every check id in a rule is a known active check, every rule is non-empty
    // and single-kind, and a check id belongs to at most one rule.
    let mut seen_check_ids: HashSet<&str> = HashSet::new();
    let mut all_rules: Vec<QcRule> = Vec::new();
    let mut repair_rules: Vec<RepairRuleConfig<T>> = Vec::new();

    for rule_cfg in &config.check_rules {
        if rule_cfg.checks.is_empty() {
            return Err(format!("rule {} has no checks", rule_cfg.id));
        }
        let mut kind: Option<IssueKind> = None;
        let mut checks: Vec<CheckId> = Vec::with_capacity(rule_cfg.checks.len());
        for check_id in &rule_cfg.checks {
            if !config.checks.contains(check_id) {
                return Err(format!("rule {} references inactive check: {check_id}", rule_cfg.id));
            }
            if !seen_check_ids.insert(check_id.as_str()) {
                return Err(format!("check {check_id} belongs to more than one rule"));
            }
            let (this_kind, check_id) = check_id_info(check_id);
            match kind {
                None => kind = Some(this_kind),
                Some(k) if k == this_kind => {}
                Some(_) => return Err(format!("checks in rule {} produce different issue kinds", rule_cfg.id)),
            }
            checks.push(check_id);
        }
        let kind = kind.expect("non-empty rule always resolves a kind");
        let rule = QcRule { id: rule_cfg.id.clone(), kind, checks: checks.clone() };

        if let Some(strategy_cfg) = &rule_cfg.strategy {
            let strategy: Box<dyn RepairStrategy<T>> = match strategy_cfg.id.as_str() {
                "random_endpoints"   => Box::new(RandomEndpointsStrategy),
                "farthest_endpoints" => Box::new(FarthestEndpointsStrategy),
                "scored_endpoints"   => Box::new(ScoredEndpointsStrategy),
                "invalid_loop_random" => Box::new(InvalidLoopRandomStrategy),
                "invalid_loop_scored" => Box::new(InvalidLoopScoredStrategy),
                "missing_loops_random" => Box::new(MissingLoopsRandomStrategy),
                other => return Err(format!("unknown strategy: {other}")),
            };
            repair_rules.push(RepairRuleConfig {
                rule: QcRule { id: rule_cfg.id.clone(), kind, checks },
                strategy,
                param_overrides: strategy_cfg.params.clone(),
            });
        }
        all_rules.push(rule);
    }
    let repair_engine = RepairEngine::new(repair_rules, all_rules);

    Ok((qc_engine, repair_engine))
}

pub fn run_generate<T: Tessellation>(
    seed: u64,
    field: Field<T>,
    start: T::Point,
    config: &GenerateConfig,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<JsValue, JsValue> {
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
    let raw_steps: Vec<GenerationStep> = if config.debug {
        generate_maze_steps(&mut graph, &field, seed, start_id, gen_config, &preset_state)
    } else {
        generate_maze(&mut graph, &field, seed, start_id, gen_config, &preset_state);
        vec![]
    };

    let (qc_engine, repair_engine) = build_qc_and_repair::<T>(config)?;

    let (mut maze, issues) = build_maze(field, graph, seed, qc_engine, repair_engine, &preset_state, build_repair_limits(config));

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

    let mut snapshot = build_analytics_snapshot(&mut maze, None, Some(issues), point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;
    snapshot.debug_steps = debug_steps;

    use serde::Serialize;
    snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
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
    use crate::generation_config::QcRuleConfig;
    use maze_core::space::SquareTessellation;

    fn err_msg(config: &GenerateConfig) -> String {
        build_qc_and_repair_impl::<SquareTessellation>(config)
            .err()
            .expect("expected an error")
    }

    #[test]
    fn empty_rule_is_rejected() {
        let config = GenerateConfig {
            checks: vec!["missing_endpoints".to_string()],
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
    fn rule_referencing_inactive_check_is_rejected() {
        let config = GenerateConfig {
            checks: vec!["missing_endpoints".to_string()],
            check_rules: vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec!["unreachable_finish".to_string()],
                strategy: None,
            }],
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("inactive check"), "unexpected message: {msg}");
    }

    #[test]
    fn check_in_two_rules_is_rejected() {
        let config = GenerateConfig {
            checks: vec!["missing_endpoints".to_string()],
            check_rules: vec![
                QcRuleConfig { id: "r1".to_string(), checks: vec!["missing_endpoints".to_string()], strategy: None },
                QcRuleConfig { id: "r2".to_string(), checks: vec!["missing_endpoints".to_string()], strategy: None },
            ],
            ..GenerateConfig::default()
        };
        let msg = err_msg(&config);
        assert!(msg.contains("more than one rule"), "unexpected message: {msg}");
    }

    #[test]
    fn mixed_kind_rule_is_rejected() {
        let config = GenerateConfig {
            checks: vec!["missing_endpoints".to_string(), "unreachable_finish".to_string()],
            check_rules: vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec!["missing_endpoints".to_string(), "unreachable_finish".to_string()],
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
            checks: vec!["missing_endpoints".to_string()],
            check_rules: vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec!["missing_endpoints".to_string()],
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
            checks: vec!["missing_endpoints".to_string()],
            check_rules: vec![QcRuleConfig {
                id: "r1".to_string(),
                checks: vec!["missing_endpoints".to_string()],
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
            checks: vec!["missing_endpoints".to_string(), "unreachable_finish".to_string()],
            check_rules: vec![
                QcRuleConfig {
                    id: "r1".to_string(),
                    checks: vec!["missing_endpoints".to_string()],
                    strategy: Some(StrategyConfig { id: "farthest_endpoints".to_string(), params: HashMap::new() }),
                },
                QcRuleConfig {
                    id: "r2".to_string(),
                    checks: vec!["unreachable_finish".to_string()],
                    strategy: None,
                },
            ],
            ..GenerateConfig::default()
        };
        assert!(build_qc_and_repair_impl::<SquareTessellation>(&config).is_ok());
    }
}
