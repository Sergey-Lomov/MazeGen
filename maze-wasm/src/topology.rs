use maze_runner::runner::topology_edit::{
    self as runner_topology, TopologyEditRequest, TopologyFloor,
};
use wasm_bindgen::prelude::*;

/// Activity of every fold, and boundary contours of one floor
/// (GitHub issue #839): the request carries the tessellation, the floor's cell set and its
/// topology. The error is a message naming the reason.
#[wasm_bindgen]
pub fn topology_info(request: JsValue) -> Result<JsValue, JsValue> {
    let request: TopologyFloor = decode(request)?;
    let info = runner_topology::topology_info(&request).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&info).unwrap())
}

/// One transactional topology edit (glue, add / replace / remove group); returns the whole
/// new topology. On error nothing changes and the message names the reason.
#[wasm_bindgen]
pub fn topology_edit(request: JsValue) -> Result<JsValue, JsValue> {
    let request: TopologyEditRequest = decode(request)?;
    let result = runner_topology::topology_edit(&request).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&result).unwrap())
}

fn decode<T: serde::de::DeserializeOwned>(request: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(request)
        .map_err(|e| JsValue::from_str(&format!("invalid request: {e}")))
}
