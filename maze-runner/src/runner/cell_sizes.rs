//! Sizes of the cells of a field by cell type (GitHub issue #948): how many cells of each type the
//! field holds and how long their sides and diameter are, measured from the real cell geometry, so a
//! mixed tessellation reports every type separately.
//!
//! Lengths are in world units; the caller converts them to physical units.

use super::field_ops::FieldOpWireError;
use super::tessellation_factory::{CellCodec, TessellationVisitor, build_tessellation};
use crate::config::TessellationConfig;
use maze_core::space::{FieldOpError, GEOM_EPS, Point, Tessellation, TessellationGeometry};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

/// Lengths closer than this (world units) are the same length.
const LENGTH_TOLERANCE: f64 = 1e-6;

#[derive(Debug, Clone, Deserialize)]
pub struct CellSizesRequest {
    pub tessellation: TessellationConfig,
    /// Preset shapes whose cells are measured; core builds them, so their cells never cross the wire.
    #[serde(default)]
    pub presets: Vec<PresetSource>,
    /// Cells given by hand (a custom field), measured as they are.
    #[serde(default)]
    pub cells: Vec<[i32; 2]>,
}

/// A preset shape and its params, as `field_preset` takes them.
#[derive(Debug, Clone, Deserialize)]
pub struct PresetSource {
    pub preset: String,
    pub params: BTreeMap<String, u32>,
    /// How many floors hold this shape: its cells are built and measured once and counted this many
    /// times.
    #[serde(default = "one")]
    pub times: usize,
}

fn one() -> usize {
    1
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CellTypeSizes {
    /// The cell type key (`Tessellation::cell_types`).
    pub key: String,
    pub count: usize,
    /// The distinct side lengths of one cell, longest first; empty when `regular` is false.
    pub sides: Vec<f64>,
    /// Diameter of the circle centered at the cell's center through its farthest vertex (the
    /// circumcircle of a cyclic polygon); `0` when `regular` is false.
    pub diameter: f64,
    /// Every cell of the type has the same sides and diameter. A type whose cells differ (Voronoi,
    /// the rings of a radial field) has no well-defined size.
    pub regular: bool,
}

/// What core reports about the requested cells: only numbers, never the cells themselves.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CellSizesReport {
    /// Every cell type that occurs among the cells, in the order of the tessellation's cell types.
    pub types: Vec<CellTypeSizes>,
    /// The cells of one floor of each `request.presets` entry (not multiplied by `times`), in
    /// request order; `0` for a preset core refuses.
    pub preset_counts: Vec<usize>,
}

/// The sizes of every cell type that occurs among the cells of `request.presets` and
/// `request.cells` together, and the cell count of each preset. A preset core refuses as
/// `invalid_preset` (it holds no cells, or is too large) is an empty field, as in `field_preset`.
pub fn cell_sizes(request: &CellSizesRequest) -> Result<CellSizesReport, FieldOpWireError> {
    build_tessellation(&request.tessellation, CellSizes { request })
        .map_err(|message| FieldOpWireError::InvalidRequest { message })?
}

struct CellSizes<'a> {
    request: &'a CellSizesRequest,
}

impl TessellationVisitor for CellSizes<'_> {
    type Output = Result<CellSizesReport, FieldOpWireError>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        // Each cell with how many times it counts.
        let mut cells: Vec<(T::CellId, usize)> = codec
            .decode_valid(&tessellation, &self.request.cells)
            .map_err(|message| FieldOpWireError::InvalidRequest { message })?
            .into_iter()
            .map(|cell| (cell, 1))
            .collect();
        let mut preset_counts = Vec::with_capacity(self.request.presets.len());
        for source in &self.request.presets {
            let params: Vec<(&str, u32)> = source
                .params
                .iter()
                .map(|(name, &value)| (name.as_str(), value))
                .collect();
            match tessellation.build_preset(&source.preset, &params) {
                Ok(built) => {
                    preset_counts.push(built.len());
                    cells.extend(built.into_iter().map(|cell| (cell, source.times)));
                }
                Err(FieldOpError::InvalidPreset(_)) => preset_counts.push(0),
                Err(error) => return Err(error.into()),
            }
        }
        let types = tessellation.cell_types();
        let mut measured: Vec<Option<Measure>> = vec![None; types.len()];
        for (cell, times) in cells {
            let index = tessellation.cell_type_of(cell).index();
            let size = measure(&*tessellation, cell);
            match &mut measured[index] {
                slot @ None => {
                    *slot = Some(Measure {
                        count: times,
                        size,
                        regular: true,
                    })
                }
                Some(known) => {
                    known.count += times;
                    known.regular &= same_size(&known.size, &size);
                }
            }
        }
        let types = types
            .iter()
            .zip(measured)
            .filter_map(|(cell_type, measure)| {
                let Measure {
                    count,
                    size,
                    regular,
                } = measure?;
                Some(CellTypeSizes {
                    key: cell_type.key().to_string(),
                    count,
                    sides: if regular { size.sides } else { Vec::new() },
                    diameter: if regular { size.diameter } else { 0.0 },
                    regular,
                })
            })
            .collect();
        Ok(CellSizesReport {
            types,
            preset_counts,
        })
    }
}

#[derive(Clone)]
struct Measure {
    count: usize,
    /// The size of the first cell met; the others are compared against it.
    size: Size,
    regular: bool,
}

#[derive(Clone)]
struct Size {
    /// Distinct side lengths, longest first.
    sides: Vec<f64>,
    diameter: f64,
}

fn measure<T: Tessellation>(tessellation: &T, cell: T::CellId) -> Size {
    let path = tessellation.boundary_path(cell);
    let mut sides: Vec<f64> = path
        .faces()
        .iter()
        .map(|face| face.iter().map(|segment| segment.length()).sum())
        .collect();
    sides.sort_by(|a, b| b.total_cmp(a));
    sides.dedup_by(|a, b| (*a - *b).abs() <= LENGTH_TOLERANCE);

    let center = tessellation.center(cell);
    let radius = path
        .flatten(GEOM_EPS)
        .into_iter()
        .map(|vertex: Point| vertex.distance(center))
        .fold(0.0, f64::max);
    Size {
        sides,
        diameter: 2.0 * radius,
    }
}

fn same_size(a: &Size, b: &Size) -> bool {
    a.sides.len() == b.sides.len()
        && a.sides
            .iter()
            .zip(&b.sides)
            .all(|(x, y)| (x - y).abs() <= LENGTH_TOLERANCE)
        && (a.diameter - b.diameter).abs() <= LENGTH_TOLERANCE
}

#[cfg(test)]
#[path = "cell_sizes_tests.rs"]
mod tests;
