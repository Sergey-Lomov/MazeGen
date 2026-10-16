use crate::generation_config::TessellationConfig;
use maze_core::space::Tessellation;
use maze_runner::runner::tessellation_factory::{
    CellCodec, TessellationVisitor, build_tessellation,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

/// Wire shape for `cartesian_coords` — a standalone point list plus its tessellation config,
/// independent of `GenerateConfig`'s `level_fields` (which carry no `points` themselves — see
/// GitHub issue #338). This endpoint answers a single geometry query, not a multi-level
/// generation config.
#[derive(Deserialize)]
struct CartesianCoordsConfig {
    tessellation: TessellationConfig,
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
    let coords = cartesian_coords_for(&cfg).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&coords).unwrap())
}

fn cartesian_coords_for(cfg: &CartesianCoordsConfig) -> Result<Vec<[f64; 2]>, String> {
    build_tessellation(
        &cfg.tessellation,
        Project {
            points: &cfg.points,
        },
    )
}

/// Projects wire points through the built tessellation instance.
struct Project<'a> {
    points: &'a [[i32; 2]],
}

impl TessellationVisitor for Project<'_> {
    type Output = Vec<[f64; 2]>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        self.points
            .iter()
            .map(|&[x, y]| {
                let (cx, cy) = tessellation.cartesian((codec.from_xy)(x, y));
                [cx, cy]
            })
            .collect()
    }
}

/// Wire shape for `tessellation_shapes`: a tessellation config plus the cells whose own template
/// the caller needs.
#[derive(Deserialize)]
struct TessellationShapesConfig {
    tessellation: TessellationConfig,
    points: Vec<[i32; 2]>,
}

/// Shape templates of one tessellation instance (GitHub issue #758): `keys` lists every
/// `ShapeDescriptor::key` the instance provides (`Tessellation::shape_descriptors`), and
/// `point_shapes[i]` is the template key of `points[i]` (`Tessellation::shape_of`), `None` for a
/// cell without a template. `maze-web` reads this instead of keeping its own copy of the registry:
/// it decides which split patterns survive a tessellation change and which template a newly
/// authored pattern belongs to.
#[derive(Serialize, Debug, PartialEq)]
struct TessellationShapes {
    keys: Vec<String>,
    point_shapes: Vec<Option<String>>,
}

#[wasm_bindgen]
pub fn tessellation_shapes(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: TessellationShapesConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let shapes = tessellation_shapes_for(&cfg).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&shapes).unwrap())
}

fn tessellation_shapes_for(cfg: &TessellationShapesConfig) -> Result<TessellationShapes, String> {
    build_tessellation(
        &cfg.tessellation,
        Shapes {
            points: &cfg.points,
        },
    )
}

struct Shapes<'a> {
    points: &'a [[i32; 2]],
}

impl TessellationVisitor for Shapes<'_> {
    type Output = TessellationShapes;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        TessellationShapes {
            keys: tessellation
                .shape_descriptors()
                .iter()
                .map(|d| d.key().to_string())
                .collect(),
            point_shapes: self
                .points
                .iter()
                .map(|&[x, y]| {
                    tessellation
                        .shape_of((codec.from_xy)(x, y))
                        .map(|shape| shape.descriptor().key().to_string())
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CartesianCoordsConfig, TessellationShapes, TessellationShapesConfig, cartesian_coords_for,
        tessellation_shapes_for,
    };
    use crate::generation_config::TessellationConfig;
    use maze_runner::config::TessellationKind;

    #[test]
    fn cairo_cartesian_projection_preserves_wire_coordinates() {
        let cfg = CartesianCoordsConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::Cairo,
                params: serde_json::Map::new(),
            },
            points: vec![[-6, -5], [3, 2]],
        };
        assert_eq!(
            cartesian_coords_for(&cfg),
            Ok(vec![[-6.0, -5.0], [3.0, 2.0]])
        );
    }

    #[test]
    fn tessellation_shapes_lists_templates_and_cell_bindings() {
        let cfg = TessellationShapesConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::Square,
                params: serde_json::Map::new(),
            },
            points: vec![[0, 0], [3, -2]],
        };
        assert_eq!(
            tessellation_shapes_for(&cfg),
            Ok(TessellationShapes {
                keys: vec!["regular:4".to_string()],
                point_shapes: vec![Some("regular:4".to_string()), Some("regular:4".to_string())],
            })
        );
    }
}
