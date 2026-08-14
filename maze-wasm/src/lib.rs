mod dto;
mod generation_config;
mod result;
mod runner;
mod tessellation_dispatch;
mod analytics;
pub mod checks_catalog;
pub mod check_descriptor;
pub mod strategies_catalog;
mod geometry;

use wasm_bindgen::prelude::*;
use generation_config::GenerateConfig;
use result::GenerateResult;
use tessellation_dispatch::dispatch_generate;

pub use checks_catalog::available_checks;
pub use strategies_catalog::available_strategies;
pub use check_descriptor::available_rule_params;
pub use geometry::cartesian_coords;
pub use analytics::compute_analytics;

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
