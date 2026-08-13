use wasm_bindgen::prelude::*;
use serde::Deserialize;
use maze_core::space::{SquareTessellation, SquarePoint, HexPoint, TriPoint, Tessellation};
use crate::generation_config::TessellationType;

/// Wire shape for `cartesian_coords` — a standalone point list plus its tessellation kind,
/// independent of `GenerateConfig`'s own `TessellationConfig`/`level_fields` (which carry no
/// `points` themselves — see GitHub issue #338). This endpoint answers a single geometry query,
/// not a multi-level generation config.
#[derive(Deserialize)]
struct CartesianCoordsConfig {
    tessellation_type: TessellationType,
    points: Vec<[i32; 2]>,
}

/// Canonical (unrotated, unit-tile-scale) Cartesian projection of each point in `points`, via
/// `Tessellation::cartesian` — see `maze-core::space`'s doc comment for why this carries no
/// rendering-specific orientation/rotation (a display-only concept that stays entirely on the
/// web side). `maze-web`'s `tessellationGeometry.ts` is the single caller: it scales this by
/// `TILE_SIZE`/`TRI_TILE_SIZE` and applies the configured orientation's rotation to get pixel
/// coordinates, rather than duplicating the projection formulas in TypeScript.
#[wasm_bindgen]
pub fn cartesian_coords(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: CartesianCoordsConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let coords: Vec<[f64; 2]> = match cfg.tessellation_type {
        TessellationType::Square => cfg.points.iter()
            .map(|&[x, y]| {
                let (cx, cy) = SquareTessellation::cartesian(SquarePoint { x, y });
                [cx, cy]
            })
            .collect(),
        TessellationType::Hex => cfg.points.iter()
            .map(|&[q, r]| {
                let (cx, cy) = maze_core::space::HexTessellation::cartesian(HexPoint { q, r });
                [cx, cy]
            })
            .collect(),
        TessellationType::Tri => cfg.points.iter()
            .map(|&[col, row]| {
                let (cx, cy) = maze_core::space::TriTessellation::cartesian(TriPoint { col, row });
                [cx, cy]
            })
            .collect(),
    };
    Ok(serde_wasm_bindgen::to_value(&coords).unwrap())
}
