mod analytics;
pub mod check_descriptor;
pub mod checks_catalog;
mod dto;
mod dto_analytics_config;
mod dto_issues;
mod dto_statistics;
mod field_ops;
mod generation_config;
mod geometry;
mod result;
mod runner;
pub mod strategies_catalog;
mod tessellation_dispatch;

use generation_config::GenerateConfig;
use result::GenerateResult;
use tessellation_dispatch::dispatch_generate;
use wasm_bindgen::prelude::*;

pub use analytics::compute_analytics;
pub use check_descriptor::available_rule_params;
pub use checks_catalog::available_checks;
pub use field_ops::{field_capabilities, field_preset, field_reflect_cells, field_translate_cells};
pub use geometry::{
    geometry_cell_at, geometry_cells_in_region, geometry_snapshot, tessellation_shapes,
};
pub use strategies_catalog::available_strategies;

#[wasm_bindgen]
pub fn generate(seed: u64, config: JsValue) -> Result<GenerateResult, JsValue> {
    let config: GenerateConfig = if config.is_null() || config.is_undefined() {
        GenerateConfig::default()
    } else {
        serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?
    };
    dispatch_generate(seed, &config)
}
