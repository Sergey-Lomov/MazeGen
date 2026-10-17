use maze_runner::runner::field_ops::{
    self as runner_field_ops, CapabilitiesRequest, FieldOpWireError, PresetExtentsRequest,
    PresetRequest, ReflectRequest, TranslateRequest,
};
use wasm_bindgen::prelude::*;

/// Which field operations and preset shapes (with parameter schemas) a tessellation offers.
#[wasm_bindgen]
pub fn field_capabilities(request: JsValue) -> Result<JsValue, JsValue> {
    let request: CapabilitiesRequest = decode(request)?;
    let capabilities =
        runner_field_ops::field_capabilities(&request).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&capabilities).unwrap())
}

/// Cells of a preset field shape (`rect`, `circle`, …) built from named params, around the
/// tessellation origin. The error is `{ kind, message? }` (`FieldOpWireError`).
#[wasm_bindgen]
pub fn field_preset(request: JsValue) -> Result<JsValue, JsValue> {
    let request: PresetRequest = decode(request)?;
    cells_result(runner_field_ops::build_preset(&request))
}

/// `[[min, max], [min, max]]` of a preset shape's cell boundaries along two world directions
/// (`directions`, each `[x, y]`). The error is `{ kind, message? }` (`FieldOpWireError`).
#[wasm_bindgen]
pub fn field_preset_extents(request: JsValue) -> Result<JsValue, JsValue> {
    let request: PresetExtentsRequest = decode(request)?;
    match runner_field_ops::preset_extents(&request) {
        Ok(extents) => Ok(serde_wasm_bindgen::to_value(&extents).unwrap()),
        Err(error) => Err(serde_wasm_bindgen::to_value(&error).unwrap()),
    }
}

/// Cells moved by a world vector that must be a translation symmetry of the tessellation.
#[wasm_bindgen]
pub fn field_translate_cells(request: JsValue) -> Result<JsValue, JsValue> {
    let request: TranslateRequest = decode(request)?;
    cells_result(runner_field_ops::translate_cells(&request))
}

/// Cells mirrored across a world axis that must be a reflection symmetry of the tessellation.
#[wasm_bindgen]
pub fn field_reflect_cells(request: JsValue) -> Result<JsValue, JsValue> {
    let request: ReflectRequest = decode(request)?;
    cells_result(runner_field_ops::reflect_cells(&request))
}

fn decode<T: serde::de::DeserializeOwned>(request: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(request)
        .map_err(|e| JsValue::from_str(&format!("invalid request: {e}")))
}

fn cells_result(result: Result<Vec<[i32; 2]>, FieldOpWireError>) -> Result<JsValue, JsValue> {
    match result {
        Ok(cells) => Ok(serde_wasm_bindgen::to_value(&cells).unwrap()),
        Err(error) => Err(serde_wasm_bindgen::to_value(&error).unwrap()),
    }
}
