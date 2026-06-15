use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use maze_core::{
    graph::Graph,
    space::{Field, Tessellation},
    generation::{generate_maze, generate_maze_steps, build_preset_state, GenerationStep},
    quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MinLoopsCountCheck, MIN_LOOPS_DEFAULT, IssueKind},
    repair::{RepairEngine, RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy},
};
use crate::generation_config::{GenerateConfig, build_generation_config};
use crate::dto::{EdgeDto, GenerationStepDto};
use crate::analytics::build_analytics_snapshot;

pub fn build_qc_and_repair<T: Tessellation>(
    config: &GenerateConfig,
) -> Result<(QualityControlEngine<T>, RepairEngine<T>), JsValue> {
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
            other => return Err(JsValue::from_str(&format!("unknown check: {other}"))),
        }
    }
    let qc_engine = QualityControlEngine::new(checks);

    let mut strategies: HashMap<_, Box<dyn RepairStrategy<T>>> = HashMap::new();
    let mut param_overrides: HashMap<IssueKind, HashMap<String, String>> = HashMap::new();

    for (issue_kind_str, strategy_cfg) in &config.strategies {
        let kind = IssueKind::from_str(issue_kind_str.as_str())
            .ok_or_else(|| JsValue::from_str(&format!("unknown issue kind: {issue_kind_str}")))?;
        let strategy: Box<dyn RepairStrategy<T>> = match strategy_cfg.id.as_str() {
            "random_endpoints"   => Box::new(RandomEndpointsStrategy),
            "farthest_endpoints" => Box::new(FarthestEndpointsStrategy),
            "scored_endpoints"   => Box::new(ScoredEndpointsStrategy),
            other => return Err(JsValue::from_str(&format!("unknown strategy: {other}"))),
        };
        strategies.insert(kind, strategy);
        if !strategy_cfg.params.is_empty() {
            param_overrides.insert(kind, strategy_cfg.params.clone());
        }
    }
    let repair_engine = RepairEngine::new(strategies, param_overrides);

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

    let (mut maze, issues) = build_maze(field, graph, seed, qc_engine, repair_engine);

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

    let warnings: Vec<String> = issues.iter().map(|i| i.kind.to_string()).collect();
    let debug_steps = steps_to_dto(raw_steps);

    let mut snapshot = build_analytics_snapshot(&mut maze, None, Some(warnings), point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;
    snapshot.debug_steps = debug_steps;

    serde_wasm_bindgen::to_value(&snapshot).map_err(|e| JsValue::from_str(&e.to_string()))
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
