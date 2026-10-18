//! Field operations over a tessellation instance (GitHub issue #760) — the wire layer
//! `maze-wasm` exports. See `Specs/space.md`'s "Field operations".

use super::tessellation_factory::{CellCodec, TessellationVisitor, build_tessellation};
use crate::config::TessellationConfig;
use maze_core::space::{
    FieldOpError, FieldOperation, FieldOps, Point, Tessellation, TessellationGeometry,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

/// Why a field operation request failed: a core refusal (`FieldOpError`) or a malformed request.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldOpWireError {
    Unavailable,
    NotASymmetry,
    OutsideTessellation,
    InvalidPreset { message: String },
    InvalidRequest { message: String },
}

impl From<FieldOpError> for FieldOpWireError {
    fn from(error: FieldOpError) -> Self {
        match error {
            FieldOpError::Unavailable => FieldOpWireError::Unavailable,
            FieldOpError::NotASymmetry => FieldOpWireError::NotASymmetry,
            FieldOpError::OutsideTessellation => FieldOpWireError::OutsideTessellation,
            FieldOpError::InvalidPreset(message) => FieldOpWireError::InvalidPreset { message },
        }
    }
}

fn invalid_request(message: String) -> FieldOpWireError {
    FieldOpWireError::InvalidRequest { message }
}

/// Which operations and preset shapes a tessellation instance offers.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FieldCapabilities {
    /// `"translate"` / `"reflect"`.
    pub operations: Vec<&'static str>,
    pub presets: Vec<PresetSchema>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PresetSchema {
    pub key: &'static str,
    pub params: Vec<PresetParamSchema>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PresetParamSchema {
    pub name: &'static str,
    pub min: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CapabilitiesRequest {
    pub tessellation: TessellationConfig,
}

/// A preset field shape request: the preset key and its named integer parameters.
#[derive(Debug, Clone, Deserialize)]
pub struct PresetRequest {
    pub tessellation: TessellationConfig,
    pub preset: String,
    pub params: BTreeMap<String, u32>,
}

/// A preset plus the two world directions its extent is measured along.
#[derive(Debug, Clone, Deserialize)]
pub struct PresetExtentsRequest {
    #[serde(flatten)]
    pub preset: PresetRequest,
    pub directions: [[f64; 2]; 2],
}

/// Flatten tolerance (world units, cell area 1) of the boundaries `preset_extents` measures.
const EXTENT_FLATTEN_TOLERANCE: f64 = 1e-6;

#[derive(Debug, Clone, Deserialize)]
pub struct TranslateRequest {
    pub tessellation: TessellationConfig,
    pub cells: Vec<[i32; 2]>,
    /// World-unit translation vector.
    pub vector: [f64; 2],
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReflectRequest {
    pub tessellation: TessellationConfig,
    pub cells: Vec<[i32; 2]>,
    /// Two distinct world points on the mirror axis.
    pub axis: [[f64; 2]; 2],
}

pub fn field_capabilities(request: &CapabilitiesRequest) -> Result<FieldCapabilities, String> {
    build_tessellation(&request.tessellation, Capabilities)
}

pub fn build_preset(request: &PresetRequest) -> Result<Vec<[i32; 2]>, FieldOpWireError> {
    build_tessellation(&request.tessellation, Preset { request }).map_err(invalid_request)?
}

/// Extent of a preset shape's cell boundaries along two world directions: for direction `d`, the
/// `[min, max]` of `d · p` over the boundary points, in the canonical orientation `build_preset`
/// uses. A caller that displays the shape under a rotation reads its on-screen width and height
/// as the extents along the transform's two rows. The print-fit search evaluates many candidate
/// sizes, so this avoids shipping every cell to the caller.
pub fn preset_extents(request: &PresetExtentsRequest) -> Result<[[f64; 2]; 2], FieldOpWireError> {
    for direction in &request.directions {
        require_finite(direction)?;
    }
    build_tessellation(&request.preset.tessellation, PresetExtents { request })
        .map_err(invalid_request)?
}

pub fn translate_cells(request: &TranslateRequest) -> Result<Vec<[i32; 2]>, FieldOpWireError> {
    require_finite(&request.vector)?;
    build_tessellation(&request.tessellation, Translate { request }).map_err(invalid_request)?
}

pub fn reflect_cells(request: &ReflectRequest) -> Result<Vec<[i32; 2]>, FieldOpWireError> {
    require_finite(&request.axis[0])?;
    require_finite(&request.axis[1])?;
    build_tessellation(&request.tessellation, Reflect { request }).map_err(invalid_request)?
}

fn require_finite(point: &[f64; 2]) -> Result<(), FieldOpWireError> {
    if point.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err(invalid_request("coordinates must be finite".to_string()))
    }
}

fn wire<T: Tessellation>(cell: T::CellId, codec: CellCodec<T>) -> [i32; 2] {
    let (x, y) = (codec.to_xy)(cell);
    [x, y]
}

/// Decodes request cells; `OutsideTessellation` for one that is not a cell.
fn decode_cells<T: Tessellation>(
    tessellation: &T,
    cells: &[[i32; 2]],
    codec: CellCodec<T>,
) -> Result<Vec<T::CellId>, FieldOpWireError> {
    cells
        .iter()
        .map(|&[x, y]| (codec.from_xy)(x, y))
        .map(|cell| {
            if tessellation.is_valid_cell(cell) {
                Ok(cell)
            } else {
                Err(FieldOpWireError::OutsideTessellation)
            }
        })
        .collect()
}

struct Capabilities;

impl TessellationVisitor for Capabilities {
    type Output = FieldCapabilities;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, _codec: CellCodec<T>) -> Self::Output {
        let operations = tessellation
            .field_operations()
            .iter()
            .map(|operation| match operation {
                FieldOperation::Translate => "translate",
                FieldOperation::Reflect => "reflect",
            })
            .collect();
        let presets = tessellation
            .presets()
            .iter()
            .map(|preset| PresetSchema {
                key: preset.key,
                params: preset
                    .params
                    .iter()
                    .map(|param| PresetParamSchema {
                        name: param.name,
                        min: param.min,
                    })
                    .collect(),
            })
            .collect();
        FieldCapabilities {
            operations,
            presets,
        }
    }
}

struct Preset<'a> {
    request: &'a PresetRequest,
}

impl TessellationVisitor for Preset<'_> {
    type Output = Result<Vec<[i32; 2]>, FieldOpWireError>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let params: Vec<(&str, u32)> = self
            .request
            .params
            .iter()
            .map(|(name, &value)| (name.as_str(), value))
            .collect();
        let cells = tessellation.build_preset(&self.request.preset, &params)?;
        Ok(cells.into_iter().map(|cell| wire(cell, codec)).collect())
    }
}

struct PresetExtents<'a> {
    request: &'a PresetExtentsRequest,
}

impl TessellationVisitor for PresetExtents<'_> {
    type Output = Result<[[f64; 2]; 2], FieldOpWireError>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, _codec: CellCodec<T>) -> Self::Output {
        let preset = &self.request.preset;
        let params: Vec<(&str, u32)> = preset
            .params
            .iter()
            .map(|(name, &value)| (name.as_str(), value))
            .collect();
        let cells = tessellation.build_preset(&preset.preset, &params)?;
        let directions = self.request.directions;
        let along =
            |point: Point, direction: [f64; 2]| direction[0] * point.x + direction[1] * point.y;

        // Pass 1: the cells whose centers reach furthest each way. A boundary point lies within a
        // cell's reach of its center, so only cells with centers near those limits can hold the
        // extremes; flattening every boundary of a large field would dominate the print-fit search.
        let mut limits = [[f64::INFINITY, f64::NEG_INFINITY]; 2];
        let mut reach: f64 = 0.0;
        let centers: Vec<Point> = cells
            .iter()
            .map(|&cell| tessellation.center(cell))
            .collect();
        for center in &centers {
            for (limit, direction) in limits.iter_mut().zip(directions) {
                let value = along(*center, direction);
                limit[0] = limit[0].min(value);
                limit[1] = limit[1].max(value);
            }
        }
        if centers.is_empty() {
            return Err(FieldOpWireError::InvalidPreset {
                message: "the shape contains no cells".to_string(),
            });
        }
        let cell_reach = |cell: T::CellId, center: Point| -> f64 {
            tessellation
                .boundary_path(cell)
                .flatten(EXTENT_FLATTEN_TOLERANCE)
                .iter()
                .map(|point| (point.x - center.x).hypot(point.y - center.y))
                .fold(0.0, f64::max)
        };
        // Cells are near-uniform, so the reach of the cells at the limits stands for every cell.
        for (&cell, &center) in cells.iter().zip(&centers) {
            let at_limit = limits.iter().zip(directions).any(|(limit, direction)| {
                let value = along(center, direction);
                value == limit[0] || value == limit[1]
            });
            if at_limit {
                reach = reach.max(cell_reach(cell, center));
            }
        }

        // Pass 2: exact extents over the candidates.
        let mut extents = [[f64::INFINITY, f64::NEG_INFINITY]; 2];
        for (&cell, &center) in cells.iter().zip(&centers) {
            let candidate = limits.iter().zip(directions).any(|(limit, direction)| {
                let margin = 2.0 * reach * direction[0].hypot(direction[1]);
                let value = along(center, direction);
                value <= limit[0] + margin || value >= limit[1] - margin
            });
            if !candidate {
                continue;
            }
            for point in tessellation
                .boundary_path(cell)
                .flatten(EXTENT_FLATTEN_TOLERANCE)
            {
                for (extent, direction) in extents.iter_mut().zip(directions) {
                    let value = along(point, direction);
                    extent[0] = extent[0].min(value);
                    extent[1] = extent[1].max(value);
                }
            }
        }
        Ok(extents)
    }
}

struct Translate<'a> {
    request: &'a TranslateRequest,
}

impl TessellationVisitor for Translate<'_> {
    type Output = Result<Vec<[i32; 2]>, FieldOpWireError>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let cells = decode_cells(&*tessellation, &self.request.cells, codec)?;
        let [x, y] = self.request.vector;
        let moved = tessellation.translate_cells(&cells, Point::new(x, y))?;
        Ok(moved.into_iter().map(|cell| wire(cell, codec)).collect())
    }
}

struct Reflect<'a> {
    request: &'a ReflectRequest,
}

impl TessellationVisitor for Reflect<'_> {
    type Output = Result<Vec<[i32; 2]>, FieldOpWireError>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let cells = decode_cells(&*tessellation, &self.request.cells, codec)?;
        let [[ax, ay], [bx, by]] = self.request.axis;
        let mirrored =
            tessellation.reflect_cells(&cells, (Point::new(ax, ay), Point::new(bx, by)))?;
        Ok(mirrored.into_iter().map(|cell| wire(cell, codec)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TessellationKind;

    fn config(kind: TessellationKind) -> TessellationConfig {
        TessellationConfig {
            kind,
            params: serde_json::Map::new(),
        }
    }

    fn preset(kind: TessellationKind, key: &str, params: &[(&str, u32)]) -> PresetRequest {
        PresetRequest {
            tessellation: config(kind),
            preset: key.to_string(),
            params: params.iter().map(|&(n, v)| (n.to_string(), v)).collect(),
        }
    }

    #[test]
    fn capabilities_list_operations_and_preset_schemas() {
        let capabilities = field_capabilities(&CapabilitiesRequest {
            tessellation: config(TessellationKind::Square),
        })
        .unwrap();
        assert_eq!(capabilities.operations, ["translate", "reflect"]);
        let keys: Vec<_> = capabilities.presets.iter().map(|p| p.key).collect();
        assert_eq!(keys, ["rect", "circle", "triangle"]);
        assert_eq!(
            capabilities.presets[0].params,
            [
                PresetParamSchema {
                    name: "cols",
                    min: 1
                },
                PresetParamSchema {
                    name: "rows",
                    min: 1
                },
            ]
        );
    }

    #[test]
    fn preset_cells_come_back_as_wire_points() {
        let cells = build_preset(&preset(
            TessellationKind::Square,
            "rect",
            &[("cols", 3), ("rows", 2)],
        ))
        .unwrap();
        assert_eq!(cells.len(), 6);
        assert!(cells.contains(&[0, 0]));
    }

    #[test]
    fn preset_extents_measure_the_shape_along_each_direction() {
        let extents = preset_extents(&PresetExtentsRequest {
            preset: preset(
                TessellationKind::Square,
                "rect",
                &[("cols", 3), ("rows", 2)],
            ),
            directions: [[1.0, 0.0], [0.0, 2.0]],
        })
        .unwrap();
        // A 3x2 block of unit cells: 3 along x, and 2 along y scaled by the direction's length 2.
        assert!((extents[0][1] - extents[0][0] - 3.0).abs() < 1e-9);
        assert!((extents[1][1] - extents[1][0] - 4.0).abs() < 1e-9);
    }

    #[test]
    fn preset_extents_match_a_brute_force_scan_on_every_lattice() {
        use crate::runner::tessellation_factory::build_tessellation;
        struct BruteForce<'a>(&'a PresetExtentsRequest);
        impl TessellationVisitor for BruteForce<'_> {
            type Output = [[f64; 2]; 2];
            fn visit<T: Tessellation>(
                self,
                tessellation: Arc<T>,
                _codec: CellCodec<T>,
            ) -> Self::Output {
                let preset = &self.0.preset;
                let params: Vec<(&str, u32)> = preset
                    .params
                    .iter()
                    .map(|(n, &v)| (n.as_str(), v))
                    .collect();
                let mut extents = [[f64::INFINITY, f64::NEG_INFINITY]; 2];
                for cell in tessellation.build_preset(&preset.preset, &params).unwrap() {
                    for point in tessellation.boundary_path(cell).flatten(1e-6) {
                        for (extent, d) in extents.iter_mut().zip(self.0.directions) {
                            let value = d[0] * point.x + d[1] * point.y;
                            extent[0] = extent[0].min(value);
                            extent[1] = extent[1].max(value);
                        }
                    }
                }
                extents
            }
        }
        let cases = [
            (TessellationKind::Square, "circle", vec![("radius", 5)]),
            (TessellationKind::Hex, "hexagon", vec![("radius", 4)]),
            (
                TessellationKind::Hex,
                "rect",
                vec![("cols", 7), ("rows", 5)],
            ),
            (TessellationKind::Tri, "hexagon", vec![("radius", 3)]),
            (TessellationKind::Tri, "triangle", vec![("side", 6)]),
            (
                TessellationKind::Cairo,
                "rect",
                vec![("cols", 5), ("rows", 4)],
            ),
            (
                TessellationKind::SquareOctagon,
                "rect",
                vec![("cols", 5), ("rows", 4)],
            ),
            (
                TessellationKind::SquareOctagon,
                "circle",
                vec![("radius", 4)],
            ),
        ];
        for (kind, key, params) in cases {
            let request = PresetExtentsRequest {
                preset: preset(kind, key, &params),
                directions: [[0.8, 0.6], [-0.6, 0.8]],
            };
            let expected =
                build_tessellation(&request.preset.tessellation, BruteForce(&request)).unwrap();
            let actual = preset_extents(&request).unwrap();
            for (a, e) in actual.iter().flatten().zip(expected.iter().flatten()) {
                assert!((a - e).abs() < 1e-9, "{key}: {actual:?} != {expected:?}");
            }
        }
    }

    #[test]
    fn preset_extents_reject_non_finite_directions_and_empty_shapes() {
        let bad = preset_extents(&PresetExtentsRequest {
            preset: preset(
                TessellationKind::Square,
                "rect",
                &[("cols", 3), ("rows", 2)],
            ),
            directions: [[f64::NAN, 0.0], [0.0, 1.0]],
        });
        assert!(matches!(bad, Err(FieldOpWireError::InvalidRequest { .. })));
    }

    #[test]
    fn preset_errors_keep_their_reason() {
        assert_eq!(
            build_preset(&preset(
                TessellationKind::Square,
                "hexagon",
                &[("radius", 2)]
            )),
            Err(FieldOpWireError::Unavailable)
        );
        assert!(matches!(
            build_preset(&preset(TessellationKind::Square, "rect", &[("cols", 3)])),
            Err(FieldOpWireError::InvalidPreset { .. })
        ));
    }

    #[test]
    fn non_finite_coordinates_are_invalid_requests() {
        let translate = translate_cells(&TranslateRequest {
            tessellation: config(TessellationKind::Square),
            cells: vec![[0, 0]],
            vector: [f64::NAN, 0.0],
        });
        assert!(matches!(
            translate,
            Err(FieldOpWireError::InvalidRequest { .. })
        ));
        let reflect = reflect_cells(&ReflectRequest {
            tessellation: config(TessellationKind::Square),
            cells: vec![[0, 0]],
            axis: [[0.0, 0.0], [f64::INFINITY, 1.0]],
        });
        assert!(matches!(
            reflect,
            Err(FieldOpWireError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn translate_and_reflect_round_trip_through_the_wire() {
        let moved = translate_cells(&TranslateRequest {
            tessellation: config(TessellationKind::Square),
            cells: vec![[0, 0], [1, 0]],
            vector: [2.0, 1.0],
        })
        .unwrap();
        assert_eq!(moved, [[2, 1], [3, 1]]);

        let mirrored = reflect_cells(&ReflectRequest {
            tessellation: config(TessellationKind::Square),
            cells: vec![[0, 0], [1, 0]],
            axis: [[2.0, 0.0], [2.0, 1.0]],
        })
        .unwrap();
        assert_eq!(mirrored, [[2, 0], [3, 0]]);
    }

    #[test]
    fn invalid_cells_and_non_symmetries_report_their_reason() {
        assert_eq!(
            translate_cells(&TranslateRequest {
                tessellation: config(TessellationKind::Cairo),
                cells: vec![[0, 0]],
                vector: [0.0, 0.0],
            }),
            Err(FieldOpWireError::OutsideTessellation)
        );
        assert_eq!(
            translate_cells(&TranslateRequest {
                tessellation: config(TessellationKind::Square),
                cells: vec![[0, 0]],
                vector: [0.5, 0.0],
            }),
            Err(FieldOpWireError::NotASymmetry)
        );
    }
}
