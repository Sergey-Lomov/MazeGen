mod dto;
mod generation_config;
mod dispatch;

use serde::Serialize;
use wasm_bindgen::prelude::*;
use maze_core::{
    space::SquareTessellation,
    quality_control::{IssueKind, MISSING_ENDPOINTS, UNREACHABLE_FINISH},
    repair::{RepairStrategy, RandomEndpointsStrategy, FarthestEndpointsStrategy, ScoredEndpointsStrategy},
};
use generation_config::{GenerateConfig, TessellationConfig};
use dispatch::{dispatch_generate, dispatch_generate_steps, dispatch_expand_field_points};

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
    Bool { default: bool },
    Enum { options: Vec<&'static str>, default: &'static str },
}

#[derive(Serialize)]
struct CheckDescriptor {
    id: &'static str,
    issue_kinds: Vec<&'static str>,
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
        CheckDescriptor { id: kind_str(MISSING_ENDPOINTS), issue_kinds: vec![kind_str(MISSING_ENDPOINTS)] },
        CheckDescriptor { id: kind_str(UNREACHABLE_FINISH), issue_kinds: vec![kind_str(UNREACHABLE_FINISH)] },
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
    ];
    serde_wasm_bindgen::to_value(&strategies).unwrap()
}

#[wasm_bindgen]
pub fn expand_field_points(config: JsValue) -> Result<JsValue, JsValue> {
    let config: TessellationConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let points = dispatch_expand_field_points(&config);
    serde_wasm_bindgen::to_value(&points).map_err(|e| JsValue::from_str(&e.to_string()))
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
pub fn generate_steps(seed: u64, config: JsValue) -> Result<JsValue, JsValue> {
    let config: GenerateConfig = if config.is_null() || config.is_undefined() {
        GenerateConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?
    };
    dispatch_generate_steps(seed, &config)
}
