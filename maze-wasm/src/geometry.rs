use crate::generation_config::TessellationConfig;
use maze_core::space::Tessellation;
use maze_runner::runner::geometry::{
    self as runner_geometry, CellAtRequest, CellsInRegionRequest, GeometrySnapshotRequest,
};
use maze_runner::runner::tessellation_factory::{
    CellCodec, TessellationVisitor, build_tessellation,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

/// Wire shape for `cell_centers` — a standalone point list plus its tessellation config,
/// independent of `GenerateConfig`'s `level_fields`.
#[derive(Deserialize)]
struct CellCentersConfig {
    tessellation: TessellationConfig,
    points: Vec<[i32; 2]>,
}

/// World-unit center (`Tessellation::center`, math convention, no display orientation) of each
/// point in `points`, in order. `maze-web`'s `cartesianCache.ts` is the single caller: it scales
/// these to pixels and applies the display orientation. Superseded by `geometry_snapshot` once the
/// web consumes core geometry (GitHub issue #761).
#[wasm_bindgen]
pub fn cell_centers(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: CellCentersConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let centers = cell_centers_for(&cfg).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&centers).unwrap())
}

fn cell_centers_for(cfg: &CellCentersConfig) -> Result<Vec<[f64; 2]>, String> {
    build_tessellation(
        &cfg.tessellation,
        Centers {
            points: &cfg.points,
        },
    )?
}

struct Centers<'a> {
    points: &'a [[i32; 2]],
}

impl TessellationVisitor for Centers<'_> {
    type Output = Result<Vec<[f64; 2]>, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        self.points
            .iter()
            .map(|&[x, y]| {
                let cell = (codec.from_xy)(x, y);
                if !tessellation.is_valid_cell(cell) {
                    return Err(format!("invalid cell [{x}, {y}]"));
                }
                let center = tessellation.center(cell);
                Ok([center.x, center.y])
            })
            .collect()
    }
}

/// Immutable geometry snapshot of a cell set (boundary path commands, flattened polylines,
/// centers, `cell_scale`, per-face contact points and segments), bound to the tessellation
/// instance and the caller's field version — see `maze_runner::runner::geometry`.
#[wasm_bindgen]
pub fn geometry_snapshot(request: JsValue) -> Result<JsValue, JsValue> {
    let request: GeometrySnapshotRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|e| JsValue::from_str(&format!("invalid request: {e}")))?;
    let snapshot =
        runner_geometry::geometry_snapshot(&request).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&snapshot).unwrap())
}

/// Point query: the cell at a world point, within an optional cell-set scope.
#[wasm_bindgen]
pub fn geometry_cell_at(request: JsValue) -> Result<JsValue, JsValue> {
    let request: CellAtRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|e| JsValue::from_str(&format!("invalid request: {e}")))?;
    let cell = runner_geometry::cell_at(&request).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&cell).unwrap())
}

/// Region query: cells matching a closed polygon under a mode, within an optional scope.
#[wasm_bindgen]
pub fn geometry_cells_in_region(request: JsValue) -> Result<JsValue, JsValue> {
    let request: CellsInRegionRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|e| JsValue::from_str(&format!("invalid request: {e}")))?;
    let cells = runner_geometry::cells_in_region(&request).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&cells).unwrap())
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
        CellCentersConfig, TessellationShapes, TessellationShapesConfig, cell_centers_for,
        tessellation_shapes_for,
    };
    use crate::generation_config::TessellationConfig;
    use maze_runner::config::TessellationKind;

    #[test]
    fn cell_centers_are_core_centers_in_point_order() {
        let cfg = CellCentersConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::Square,
                params: serde_json::Map::new(),
            },
            points: vec![[2, -1], [0, 0]],
        };
        assert_eq!(cell_centers_for(&cfg), Ok(vec![[2.5, -0.5], [0.5, 0.5]]));
    }

    #[test]
    fn cell_centers_rejects_invalid_cells() {
        let cfg = CellCentersConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::Cairo,
                params: serde_json::Map::new(),
            },
            points: vec![[0, 0]],
        };
        assert!(cell_centers_for(&cfg).is_err());
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
