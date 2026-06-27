mod dto;
mod generation_config;
mod runner;
mod tessellation_dispatch;
mod analytics;

use serde::Serialize;
use wasm_bindgen::prelude::*;
use maze_core::{
    space::{SquareTessellation, Field, Tessellation},
    space::{SquarePoint, HexPoint, TriPoint},
    ids::IdGenerator,
    graph::{Graph, EdgeKind},
    Maze,
    quality_control::{IssueKind, MISSING_ENDPOINTS, UNREACHABLE_FINISH, MISSING_LOOPS, MIN_LOOPS_DEFAULT, MIN_LOOP_DENSITY_DEFAULT, AVG_LOOP_LENGTH_ESTIMATE_DEFAULT, INVALID_LOOP, MIN_LOOP_LENGTH_DEFAULT, MAX_LOOP_LENGTH_DEFAULT, EXTERNAL_ESCAPE_DIVERSITY_DEFAULT, LOOP_DISTANCE_FROM_START_DEFAULT, LOOP_DISTANCE_FROM_FINISH_DEFAULT, MAX_LOOP_DENSITY_DEFAULT, MAX_SCC_COUNT_DEFAULT, EXCESSIVE_SCC_COUNT},
    repair::{RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy, InvalidLoopRandomStrategy, InvalidLoopScoredStrategy, MissingLoopsRandomStrategy},
};
use generation_config::{GenerateConfig, TessellationType};
use tessellation_dispatch::dispatch_generate;
use dto::ComputeAnalyticsConfig;
use analytics::build_analytics_snapshot;

#[derive(Serialize)]
struct ParamDescriptor {
    id: &'static str,
    label: &'static str,
    kind: ParamKindDto,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ParamKindDto {
    Float { default: f64, min: f64, max: f64 },
    Integer { default: i64, min: i64, max: i64 },
    Bool { default: bool },
    Enum { options: Vec<&'static str>, default: &'static str },
}

#[derive(Serialize)]
struct CheckDescriptor {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    issue_kinds: Vec<&'static str>,
    params: Vec<ParamDescriptor>,
}

#[derive(Serialize)]
struct StrategyDescriptor {
    id: &'static str,
    handles: &'static str,
    params: Vec<ParamDescriptor>,
}

// Helper to turn IssueKind into a &'static str for JSON serialization.
fn kind_str(k: IssueKind) -> &'static str {
    k.as_str()
}

fn param_kind_dto(kind: &maze_core::repair::StrategyParamKind) -> ParamKindDto {
    match kind {
        maze_core::repair::StrategyParamKind::Float { default, min, max } =>
            ParamKindDto::Float { default: *default, min: *min, max: *max },
        maze_core::repair::StrategyParamKind::Bool { default } =>
            ParamKindDto::Bool { default: *default },
        maze_core::repair::StrategyParamKind::Enum { options, default } =>
            ParamKindDto::Enum { options: options.to_vec(), default },
    }
}

fn strategy_params_dto(params: &[maze_core::repair::StrategyParam]) -> Vec<ParamDescriptor> {
    params.iter().map(|p| ParamDescriptor {
        id: p.id,
        label: p.label,
        kind: param_kind_dto(&p.kind),
    }).collect()
}

#[wasm_bindgen]
pub fn available_checks() -> JsValue {
    let checks = vec![
        CheckDescriptor {
            id: "missing_endpoints",
            label: "Start and finish present",
            description: "Fires if the maze has no start or no finish.",
            issue_kinds: vec![kind_str(MISSING_ENDPOINTS)],
            params: vec![],
        },
        CheckDescriptor {
            id: "unreachable_finish",
            label: "Finish reachable from start",
            description: "Fires if finish cannot be reached from start via directed traversal.",
            issue_kinds: vec![kind_str(UNREACHABLE_FINISH)],
            params: vec![],
        },
        CheckDescriptor {
            id: "min_loops_count",
            label: "Minimum loop count",
            description: "Fires if the maze has fewer loops than the required minimum.",
            issue_kinds: vec![kind_str(MISSING_LOOPS)],
            params: vec![ParamDescriptor {
                id: "min_loops",
                label: "Min loop count",
                kind: ParamKindDto::Integer { default: MIN_LOOPS_DEFAULT as i64, min: 1, max: 1_000_000 },
            }],
        },
        CheckDescriptor {
            id: "min_loop_density",
            label: "Minimum loop density",
            description: "Fires if too small a share of the field is covered by loops; the missing cell count is converted into a requested loop count via an estimated average loop length.",
            issue_kinds: vec![kind_str(MISSING_LOOPS)],
            params: vec![
                ParamDescriptor {
                    id: "min_density",
                    label: "Min loop density (per 100 cells)",
                    kind: ParamKindDto::Integer { default: MIN_LOOP_DENSITY_DEFAULT as i64, min: 0, max: 100 },
                },
                ParamDescriptor {
                    id: "avg_loop_length_estimate",
                    label: "Average loop length estimate",
                    kind: ParamKindDto::Integer { default: AVG_LOOP_LENGTH_ESTIMATE_DEFAULT as i64, min: 1, max: 100_000 },
                },
            ],
        },
        CheckDescriptor {
            id: "scc_count",
            label: "Maximum SCC region count",
            description: "Fires if the graph is split into more strongly-connected components than the allowed maximum, signalling a fragmented maze.",
            issue_kinds: vec![kind_str(EXCESSIVE_SCC_COUNT)],
            params: vec![ParamDescriptor {
                id: "max_scc_count",
                label: "Max SCC region count",
                kind: ParamKindDto::Integer { default: MAX_SCC_COUNT_DEFAULT as i64, min: 1, max: 1_000_000 },
            }],
        },
        CheckDescriptor {
            id: "min_loop_length",
            label: "Minimum loop length",
            description: "Fires if the maze has simple loops shorter than the required minimum tile length.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "min_loop_length",
                label: "Min loop length",
                kind: ParamKindDto::Integer { default: MIN_LOOP_LENGTH_DEFAULT as i64, min: 1, max: 100_000 },
            }],
        },
        CheckDescriptor {
            id: "max_loop_length",
            label: "Maximum loop length",
            description: "Fires if the maze has simple loops longer than the allowed maximum tile length.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "max_loop_length",
                label: "Max loop length",
                kind: ParamKindDto::Integer { default: MAX_LOOP_LENGTH_DEFAULT as i64, min: 1, max: 100_000 },
            }],
        },
        CheckDescriptor {
            id: "external_escape_diversity",
            label: "External escape diversity",
            description: "Fires if a simple loop's outgoing connections converge on too few distinct destinations outside the loop, instead of spreading out diversely.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "min_distinct_exits",
                label: "Min distinct exits",
                kind: ParamKindDto::Integer { default: EXTERNAL_ESCAPE_DIVERSITY_DEFAULT as i64, min: 0, max: 1_000 },
            }],
        },
        CheckDescriptor {
            id: "loop_distance_from_start",
            label: "Loop distance from start",
            description: "Fires if a simple loop sits closer to start (in tiles, directed graph distance) than the required minimum.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "min_distance_from_start",
                label: "Min distance from start",
                kind: ParamKindDto::Integer { default: LOOP_DISTANCE_FROM_START_DEFAULT as i64, min: 0, max: 100_000 },
            }],
        },
        CheckDescriptor {
            id: "loop_distance_from_finish",
            label: "Loop distance from finish",
            description: "Fires if a simple loop sits closer to finish (in tiles, directed graph distance) than the required minimum.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "min_distance_from_finish",
                label: "Min distance from finish",
                kind: ParamKindDto::Integer { default: LOOP_DISTANCE_FROM_FINISH_DEFAULT as i64, min: 0, max: 100_000 },
            }],
        },
        CheckDescriptor {
            id: "max_loop_density",
            label: "Maximum loop density",
            description: "Fires if too large a share of the field is covered by loops; excess loops are picked at random and flagged until density drops to the allowed maximum.",
            issue_kinds: vec![kind_str(INVALID_LOOP)],
            params: vec![ParamDescriptor {
                id: "max_density",
                label: "Max loop density (per 100 cells)",
                kind: ParamKindDto::Integer { default: MAX_LOOP_DENSITY_DEFAULT as i64, min: 0, max: 100 },
            }],
        },
    ];
    serde_wasm_bindgen::to_value(&checks).unwrap()
}

#[wasm_bindgen]
pub fn available_strategies() -> JsValue {
    let strategies: Vec<StrategyDescriptor> = vec![
        StrategyDescriptor {
            id: "random_endpoints",
            handles: kind_str(MISSING_ENDPOINTS),
            params: strategy_params_dto(<RandomEndpointsStrategy as RepairStrategy<SquareTessellation>>::params(&RandomEndpointsStrategy)),
        },
        StrategyDescriptor {
            id: "farthest_endpoints",
            handles: kind_str(MISSING_ENDPOINTS),
            params: strategy_params_dto(<FarthestEndpointsStrategy as RepairStrategy<SquareTessellation>>::params(&FarthestEndpointsStrategy)),
        },
        StrategyDescriptor {
            id: "scored_endpoints",
            handles: kind_str(MISSING_ENDPOINTS),
            params: strategy_params_dto(<ScoredEndpointsStrategy as RepairStrategy<SquareTessellation>>::params(&ScoredEndpointsStrategy)),
        },
        StrategyDescriptor {
            id: "invalid_loop_random",
            handles: kind_str(INVALID_LOOP),
            params: strategy_params_dto(<InvalidLoopRandomStrategy as RepairStrategy<SquareTessellation>>::params(&InvalidLoopRandomStrategy)),
        },
        StrategyDescriptor {
            id: "invalid_loop_scored",
            handles: kind_str(INVALID_LOOP),
            params: strategy_params_dto(<InvalidLoopScoredStrategy as RepairStrategy<SquareTessellation>>::params(&InvalidLoopScoredStrategy)),
        },
        StrategyDescriptor {
            id: "missing_loops_random",
            handles: kind_str(MISSING_LOOPS),
            params: strategy_params_dto(<MissingLoopsRandomStrategy as RepairStrategy<SquareTessellation>>::params(&MissingLoopsRandomStrategy)),
        },
    ];
    serde_wasm_bindgen::to_value(&strategies).unwrap()
}

#[wasm_bindgen]
pub fn generate(seed: u64, config: JsValue) -> Result<JsValue, JsValue> {
    let config: GenerateConfig = if config.is_null() || config.is_undefined() {
        GenerateConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?
    };
    dispatch_generate(seed, &config)
}

#[wasm_bindgen]
pub fn compute_analytics(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: ComputeAnalyticsConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    dispatch_compute_analytics(cfg)
}

fn dispatch_compute_analytics(cfg: ComputeAnalyticsConfig) -> Result<JsValue, JsValue> {
    match cfg.tessellation.tessellation_type {
        TessellationType::Square => {
            let pts: Vec<SquarePoint> = cfg.tessellation.points.iter()
                .map(|&[x, y]| SquarePoint { x, y }).collect();
            run_compute_analytics::<maze_core::space::SquareTessellation>(cfg, pts, |p: SquarePoint| (p.x, p.y))
        }
        TessellationType::Hex => {
            let pts: Vec<HexPoint> = cfg.tessellation.points.iter()
                .map(|&[q, r]| HexPoint { q, r }).collect();
            run_compute_analytics::<maze_core::space::HexTessellation>(cfg, pts, |p: HexPoint| (p.q, p.r))
        }
        TessellationType::Tri => {
            let pts: Vec<TriPoint> = cfg.tessellation.points.iter()
                .map(|&[col, row]| TriPoint { col, row }).collect();
            run_compute_analytics::<maze_core::space::TriTessellation>(cfg, pts, |p: TriPoint| (p.col, p.row))
        }
    }
}

fn run_compute_analytics<T: Tessellation>(
    cfg: ComputeAnalyticsConfig,
    pts: Vec<T::Point>,
    point_to_xy: impl Fn(T::Point) -> (i32, i32),
) -> Result<JsValue, JsValue>
where
    T::Point: Copy,
{
    if pts.is_empty() {
        return Err(JsValue::from_str("tessellation points must not be empty"));
    }

    let mut ids = IdGenerator::new();
    let field = Field::<T>::new(pts, &mut ids)
        .map_err(|e| JsValue::from_str(e))?;

    let mut graph = Graph::new();
    field.build_nodes(&mut graph);

    // Build graph from post-edit edges (passages only; walls = absence of edge)
    for e in &cfg.edges {
        let from_id = e.from as u64;
        let to_id   = e.to   as u64;
        match e.kind.as_str() {
            "basic" => {
                graph.add_edge(from_id, to_id, EdgeKind::Basic);
                graph.add_edge(to_id, from_id, EdgeKind::Basic);
            }
            "one_way" => {
                // Direction already normalized: from→to is the actual passage direction
                graph.add_edge(from_id, to_id, EdgeKind::Basic);
            }
            other => return Err(JsValue::from_str(&format!("unknown edge kind: {other}"))),
        }
    }

    let mut maze = Maze::<T>::new(field, graph);
    maze.meta.start  = cfg.start.map(|id| id as u64);
    maze.meta.finish = cfg.finish.map(|id| id as u64);

    // Build QC engine from config (no repair). `check_rules` is explicitly empty, not
    // `..GenerateConfig::default()`'s hardcoded `default_missing_endpoints` rule — that default
    // assumes `missing_endpoints` is active, which isn't guaranteed here (`cfg.checks` is
    // caller-supplied), and `build_qc_and_repair`'s validation rejects any rule referencing a
    // check not in `checks`. Rules only matter for repair dispatch, which this path discards
    // anyway (`let (qc_engine, _) = ...` below), so an empty list is correct, not just safe.
    let qc_config = GenerateConfig {
        tessellation: cfg.tessellation,
        checks: cfg.checks,
        check_rules: vec![],
        check_params: cfg.check_params,
        ..GenerateConfig::default()
    };
    let (qc_engine, _) = runner::build_qc_and_repair::<T>(&qc_config)?;

    let snapshot = build_analytics_snapshot(&mut maze, Some(&qc_engine), None, point_to_xy)
        .map_err(|e| JsValue::from_str(&e))?;

    snapshot.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

