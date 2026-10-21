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

/// Immutable geometry snapshot of a cell set (boundary as path commands or a flattened polyline,
/// as requested; centers, `cell_scale`, per-face contact points and segments), bound to the tessellation
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

/// Wire shape for the per-point tessellation queries (`tessellation_shapes`,
/// `tessellation_cell_types`): the tessellation to build and the points to query. Every point must
/// be a cell of it, otherwise the query returns an error naming the point.
#[derive(Deserialize)]
struct TessellationPointsConfig {
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
    let cfg: TessellationPointsConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let shapes = tessellation_shapes_for(&cfg).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&shapes).unwrap())
}

fn tessellation_shapes_for(cfg: &TessellationPointsConfig) -> Result<TessellationShapes, String> {
    build_tessellation(
        &cfg.tessellation,
        Shapes {
            points: &cfg.points,
        },
    )?
}

struct Shapes<'a> {
    points: &'a [[i32; 2]],
}

impl TessellationVisitor for Shapes<'_> {
    type Output = Result<TessellationShapes, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let cells = codec.decode_valid(&tessellation, self.points)?;
        Ok(TessellationShapes {
            keys: tessellation
                .shape_descriptors()
                .iter()
                .map(|d| d.key().to_string())
                .collect(),
            point_shapes: cells
                .into_iter()
                .map(|cell| {
                    tessellation
                        .shape_of(cell)
                        .map(|shape| shape.descriptor().key().to_string())
                })
                .collect(),
        })
    }
}

/// Cell types of one tessellation instance (GitHub issue #822): `keys` lists every
/// `CellType::key` the instance provides (`Tessellation::cell_types`), and `point_types[i]` is the
/// type key of `points[i]` (`Tessellation::cell_type_key_of`). Configs that parametrize generation or
/// quality control by cell type name types by these keys.
#[derive(Serialize, Debug, PartialEq)]
struct TessellationCellTypes {
    keys: Vec<String>,
    point_types: Vec<String>,
}

#[wasm_bindgen]
pub fn tessellation_cell_types(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: TessellationPointsConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let types = tessellation_cell_types_for(&cfg).map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&types).unwrap())
}

fn tessellation_cell_types_for(
    cfg: &TessellationPointsConfig,
) -> Result<TessellationCellTypes, String> {
    build_tessellation(
        &cfg.tessellation,
        CellTypes {
            points: &cfg.points,
        },
    )?
}

struct CellTypes<'a> {
    points: &'a [[i32; 2]],
}

impl TessellationVisitor for CellTypes<'_> {
    type Output = Result<TessellationCellTypes, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let cells = codec.decode_valid(&tessellation, self.points)?;
        Ok(TessellationCellTypes {
            keys: tessellation
                .cell_types()
                .iter()
                .map(|t| t.key().to_string())
                .collect(),
            point_types: cells
                .into_iter()
                .map(|cell| tessellation.cell_type_key_of(cell).to_string())
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        TessellationCellTypes, TessellationPointsConfig, TessellationShapes,
        tessellation_cell_types_for, tessellation_shapes_for,
    };
    use crate::generation_config::TessellationConfig;
    use maze_runner::config::TessellationKind;

    #[test]
    fn tessellation_shapes_lists_templates_and_cell_bindings() {
        let cfg = TessellationPointsConfig {
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

    #[test]
    fn tessellation_cell_types_lists_types_and_cell_bindings() {
        let cfg = TessellationPointsConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::SquareOctagon,
                params: serde_json::Map::new(),
            },
            points: vec![[0, 0], [1, 1], [2, 2]],
        };
        assert_eq!(
            tessellation_cell_types_for(&cfg),
            Ok(TessellationCellTypes {
                keys: vec!["octagon".to_string(), "square".to_string()],
                point_types: vec![
                    "octagon".to_string(),
                    "square".to_string(),
                    "octagon".to_string()
                ],
            })
        );
    }

    #[test]
    fn tessellation_cell_types_of_a_uniform_tessellation_is_the_single_default_type() {
        let cfg = TessellationPointsConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::Square,
                params: serde_json::Map::new(),
            },
            points: vec![[0, 0], [3, -2]],
        };
        assert_eq!(
            tessellation_cell_types_for(&cfg),
            Ok(TessellationCellTypes {
                keys: vec!["cell".to_string()],
                point_types: vec!["cell".to_string(), "cell".to_string()],
            })
        );
    }

    #[test]
    fn tessellation_shapes_rejects_a_non_cell_point() {
        let cfg = TessellationPointsConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::SquareOctagon,
                params: serde_json::Map::new(),
            },
            points: vec![[0, 0], [1, 2]],
        };
        assert_eq!(
            tessellation_shapes_for(&cfg),
            Err("invalid cell [1, 2]".to_string())
        );
    }

    #[test]
    fn tessellation_cell_types_rejects_a_non_cell_point() {
        let cfg = TessellationPointsConfig {
            tessellation: TessellationConfig {
                kind: TessellationKind::SquareOctagon,
                params: serde_json::Map::new(),
            },
            points: vec![[0, 0], [1, 2]],
        };
        assert_eq!(
            tessellation_cell_types_for(&cfg),
            Err("invalid cell [1, 2]".to_string())
        );
    }
}
