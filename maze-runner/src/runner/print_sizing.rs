//! Print sizing of a preset field shape (GitHub issue #939): the size of a standard shape that fills
//! a printable area with the most cells, searched next to the geometry so one call replaces the
//! dozens of measurements a caller would otherwise make across the wasm boundary.
//!
//! The caller keeps the paper (size, orientation, margins) and sends the usable area plus the
//! physical side of one cell; the answer is the shape's parameters.

use super::field_ops::{FieldOpWireError, measure_extents};
use super::tessellation_factory::{CellCodec, TessellationVisitor, build_tessellation};
use crate::config::TessellationConfig;
use maze_core::space::Tessellation;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// Largest dimension of a rectangular shape searched.
const MAX_RECT_DIMENSION: u32 = 1000;
/// Largest smallest-block dimension of any lattice; a block this large is always accepted.
const MIN_PROBE_DIMENSION: u32 = 4;
/// Largest radius (or side) of a radial shape searched.
const MAX_RADIUS: u32 = 500;
/// Most times a cylinder or torus is made smaller to fit the sheet.
const MAX_SHRINK_STEPS: usize = 64;
/// How far from the wanted size a size that closes up is looked for.
const SNAP_RANGE: u32 = 16;
/// Tolerance of "the field fits the sheet", in physical units.
const FIT_EPSILON: f64 = 1e-9;

pub type ShapeParams = BTreeMap<String, u32>;

#[derive(Debug, Clone, Deserialize)]
pub struct PrintSizingRequest {
    pub tessellation: TessellationConfig,
    /// The preset to size and its current params; switches (`net`, `mode`, `aspect`, `axis`) are kept.
    pub preset: String,
    pub params: ShapeParams,
    /// The two world directions the field's on-screen width and height are measured along.
    pub directions: [[f64; 2]; 2],
    /// Length of one cell side in the units of `directions` times world units.
    pub cell_side: f64,
    pub usable_width_mm: f64,
    pub usable_height_mm: f64,
    /// Physical length of one cell side.
    pub cell_side_mm: f64,
    /// A rectangle of an axis-aligned lattice is sized by division, without measuring.
    pub axis_aligned: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PrintSizingResult {
    pub params: ShapeParams,
    /// Display-space size of the result in cell sides.
    pub width: f64,
    pub height: f64,
    /// The search cap the answer sits on (`MAX_RECT_DIMENSION` or `MAX_RADIUS`), when the sheet may
    /// hold a larger field than the search covers.
    pub limit: Option<u32>,
}

/// `None` when nothing fits the sheet.
pub fn print_sizing(
    request: &PrintSizingRequest,
) -> Result<Option<PrintSizingResult>, FieldOpWireError> {
    for direction in &request.directions {
        if !direction.iter().all(|v| v.is_finite()) {
            return Err(FieldOpWireError::InvalidRequest {
                message: "coordinates must be finite".to_string(),
            });
        }
    }
    build_tessellation(&request.tessellation, PrintSizing { request })
        .map_err(|message| FieldOpWireError::InvalidRequest { message })?
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    width: f64,
    height: f64,
}

struct PrintSizing<'a> {
    request: &'a PrintSizingRequest,
}

impl TessellationVisitor for PrintSizing<'_> {
    type Output = Result<Option<PrintSizingResult>, FieldOpWireError>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, _codec: CellCodec<T>) -> Self::Output {
        let mut sizer = Sizer {
            tessellation: &*tessellation,
            request: self.request,
            closes: HashMap::new(),
        };
        sizer.run()
    }
}

struct Sizer<'a, T: Tessellation> {
    tessellation: &'a T,
    request: &'a PrintSizingRequest,
    closes: HashMap<(String, u32, u32, u32), bool>,
}

fn is_glued(preset: &str) -> bool {
    preset == "cylinder" || preset == "torus"
}

fn get(params: &ShapeParams, name: &str) -> u32 {
    params.get(name).copied().unwrap_or(0)
}

fn with(params: &ShapeParams, changes: &[(&str, u32)]) -> ShapeParams {
    let mut next = params.clone();
    for &(name, value) in changes {
        next.insert(name.to_string(), value);
    }
    next
}

impl<T: Tessellation> Sizer<'_, T> {
    fn run(&mut self) -> Result<Option<PrintSizingResult>, FieldOpWireError> {
        let request = self.request;
        let valid = |v: f64| v.is_finite() && v > 0.0;
        if !valid(request.cell_side_mm)
            || !valid(request.usable_width_mm)
            || !valid(request.usable_height_mm)
            || !valid(request.cell_side)
        {
            return Ok(None);
        }

        // A cylinder or torus is sized as the plane, then moved down to a size that closes up
        // (GitHub issue #894).
        let glued = is_glued(&request.preset);
        let plane_preset = if glued { "rect" } else { request.preset.as_str() };
        let plane_params = if glued {
            ShapeParams::from([
                ("cols".to_string(), get(&request.params, "cols")),
                ("rows".to_string(), get(&request.params, "rows")),
            ])
        } else {
            request.params.clone()
        };
        let Some(planned) = self.plan(plane_preset, &plane_params)? else {
            return Ok(None);
        };
        let limit = self.reached_limit(plane_preset, &planned);
        let sized = if glued {
            let gluing = with(
                &request.params,
                &[
                    ("cols", get(&planned, "cols")),
                    ("rows", get(&planned, "rows")),
                ],
            );
            let Some(closed) = self.snap_to_close(&request.preset, &gluing)? else {
                return Ok(None);
            };
            match self.within_sheet(&request.preset, closed)? {
                Some(sized) => sized,
                None => return Ok(None),
            }
        } else {
            planned
        };
        let bounds = self.bounds(&request.preset, &sized)?;
        Ok(Some(PrintSizingResult {
            params: sized,
            width: bounds.width,
            height: bounds.height,
            limit,
        }))
    }

    /// The search cap a planned size sits on. An axis-aligned rectangle is sized by division and
    /// has none; a radial size under core's own maximum for the shape is not on the cap either.
    fn reached_limit(&self, preset: &str, planned: &ShapeParams) -> Option<u32> {
        match preset {
            "rect" if self.request.axis_aligned => None,
            "rect" | "parallelogram" => (get(planned, "cols") >= MAX_RECT_DIMENSION
                || get(planned, "rows") >= MAX_RECT_DIMENSION)
                .then_some(MAX_RECT_DIMENSION),
            "box" => ["width", "height", "depth"]
                .into_iter()
                .any(|name| get(planned, name) >= MAX_RADIUS)
                .then_some(MAX_RADIUS),
            _ => (get(planned, size_param(preset)) >= MAX_RADIUS).then_some(MAX_RADIUS),
        }
    }

    /// The strategy of the preset's family.
    fn plan(
        &mut self,
        preset: &str,
        params: &ShapeParams,
    ) -> Result<Option<ShapeParams>, FieldOpWireError> {
        let request = self.request;
        if preset == "rect" && request.axis_aligned {
            let cols = (request.usable_width_mm / request.cell_side_mm).floor();
            let rows = (request.usable_height_mm / request.cell_side_mm).floor();
            return Ok((cols >= 1.0 && rows >= 1.0).then(|| {
                with(
                    params,
                    &[("cols", cols.min(u32::MAX as f64) as u32), ("rows", rows.min(u32::MAX as f64) as u32)],
                )
            }));
        }
        if preset == "rect" || preset == "parallelogram" {
            return self.best_rect(preset, params);
        }
        self.best_radial(preset, params)
    }

    /// Display-space size of the shape in cell sides; infinite for a shape core refuses.
    fn bounds(&self, preset: &str, params: &ShapeParams) -> Result<Bounds, FieldOpWireError> {
        let list: Vec<(&str, u32)> = params.iter().map(|(n, &v)| (n.as_str(), v)).collect();
        match measure_extents(self.tessellation, preset, &list, self.request.directions) {
            Ok(extents) => Ok(Bounds {
                width: (extents[0][1] - extents[0][0]) / self.request.cell_side,
                height: (extents[1][1] - extents[1][0]) / self.request.cell_side,
            }),
            Err(FieldOpWireError::InvalidPreset { .. }) => Ok(Bounds {
                width: f64::INFINITY,
                height: f64::INFINITY,
            }),
            Err(error) => Err(error),
        }
    }

    fn fits(&self, bounds: Bounds) -> bool {
        let request = self.request;
        bounds.width * request.cell_side_mm <= request.usable_width_mm + FIT_EPSILON
            && bounds.height * request.cell_side_mm <= request.usable_height_mm + FIT_EPSILON
    }

    /// The most cells, then the fullest sheet, of a `cols × rows` shape.
    fn best_rect(
        &mut self,
        preset: &str,
        params: &ShapeParams,
    ) -> Result<Option<ShapeParams>, FieldOpWireError> {
        let request = self.request;
        let error: RefCell<Option<FieldOpWireError>> = RefCell::new(None);
        let measured: RefCell<HashMap<(u32, u32), Bounds>> = RefCell::new(HashMap::new());
        let bounds_at = |sizer: &Self, cols: u32, rows: u32| -> Bounds {
            if let Some(&bounds) = measured.borrow().get(&(cols, rows)) {
                return bounds;
            }
            let bounds = sizer
                .bounds(preset, &with(params, &[("cols", cols), ("rows", rows)]))
                .unwrap_or_else(|e| {
                    error.borrow_mut().get_or_insert(e);
                    Bounds {
                        width: f64::INFINITY,
                        height: f64::INFINITY,
                    }
                });
            measured.borrow_mut().insert((cols, rows), bounds);
            bounds
        };

        // Core refuses blocks below a lattice's minimum (3.12.12 needs two rows), and such a block
        // measures as infinite, so the search starts from the smallest block core accepts.
        let min_rows = first_accepted(|rows| bounds_at(self, MIN_PROBE_DIMENSION, rows));
        let min_cols = first_accepted(|cols| bounds_at(self, cols, min_rows));
        if min_rows == 0 || min_cols == 0 {
            return error.into_inner().map_or(Ok(None), Err);
        }

        // The bounds are close to affine in each dimension, so two measurements estimate where the
        // limit lies and the search only has to confirm it with a few calls.
        let base = bounds_at(self, min_cols, min_rows);
        let cols_hint = f64::from(min_cols)
            + estimate_limit(
                base.width,
                bounds_at(self, min_cols + 2, min_rows).width,
                request.usable_width_mm / request.cell_side_mm,
            );
        let rows_hint = f64::from(min_rows)
            + estimate_limit(
                base.height,
                bounds_at(self, min_cols, min_rows + 2).height,
                request.usable_height_mm / request.cell_side_mm,
            );
        let max_cols = largest_fitting(
            |cols| {
                let bounds = bounds_at(self, cols, min_rows);
                self.fits(bounds)
            },
            cols_hint,
            min_cols,
            MAX_RECT_DIMENSION,
        );
        let max_rows = largest_fitting(
            |rows| {
                let bounds = bounds_at(self, min_cols, rows);
                self.fits(bounds)
            },
            rows_hint,
            min_rows,
            MAX_RECT_DIMENSION,
        );
        if let Some(error) = error.borrow_mut().take() {
            return Err(error);
        }
        if max_cols == 0 || max_rows == 0 {
            return Ok(None);
        }

        // Bounds only grow with either dimension, so the tallest fitting field never gets taller as
        // the columns grow. Walking the columns down from the widest, each column's answer is at
        // least the previous one, and no column below `best_cell_count / max_rows` can win -- the
        // walk stops after the few columns near the widest instead of measuring every column.
        let mut best: Option<(u32, u32)> = None;
        let mut best_cell_count = 0u64;
        let mut best_fill = f64::NEG_INFINITY;
        let mut rows = max_rows;
        let mut cols = max_cols;
        while cols >= min_cols && u64::from(cols) * u64::from(max_rows) >= best_cell_count {
            rows = largest_fitting(
                |r| {
                    let bounds = bounds_at(self, cols, r);
                    self.fits(bounds)
                },
                f64::from(rows),
                min_rows,
                max_rows,
            );
            if rows != 0 {
                let bounds = bounds_at(self, cols, rows);
                let cell_count = u64::from(cols) * u64::from(rows);
                let fill = (bounds.width * request.cell_side_mm) / request.usable_width_mm
                    + (bounds.height * request.cell_side_mm) / request.usable_height_mm;
                // On an exact tie the narrower field wins, as when the columns were walked up.
                if cell_count > best_cell_count || (cell_count == best_cell_count && fill >= best_fill)
                {
                    best = Some((cols, rows));
                    best_cell_count = cell_count;
                    best_fill = fill;
                }
            }
            cols -= 1;
        }
        if let Some(error) = error.borrow_mut().take() {
            return Err(error);
        }
        Ok(best.map(|(cols, rows)| with(params, &[("cols", cols), ("rows", rows)])))
    }

    /// The largest fitting size of a one-parameter shape (the box grows by its width).
    fn best_radial(
        &mut self,
        preset: &str,
        params: &ShapeParams,
    ) -> Result<Option<ShapeParams>, FieldOpWireError> {
        let name = size_param(preset);
        let max_size = MAX_RADIUS.min(
            self.tessellation
                .preset_param_max(preset, name)
                .unwrap_or(u32::MAX),
        );
        let candidate = |size: u32| radial_candidate(preset, params, size);
        let mut best: Option<ShapeParams> = None;
        // Core refuses sizes below a shape's minimum (a trihexagonal triangle needs 3), and such a
        // size measures as infinite, so the search starts from the smallest size core accepts.
        let mut min_size = 0;
        for size in 1..=MIN_PROBE_DIMENSION.min(max_size) {
            if self.bounds(preset, &candidate(size))?.width.is_finite() {
                min_size = size;
                break;
            }
        }
        if min_size == 0 {
            return Ok(None);
        }
        let mut low = min_size;
        let mut probe = min_size;

        // Bounds grow monotonically with radius. Exponential probing avoids walking every radius
        // when the requested cell is large; the binary search below avoids the O(radius^3)
        // behavior that occurred for tiny cells when every candidate regenerated all radial cells.
        while probe <= max_size {
            let shape = candidate(probe);
            let bounds = self.bounds(preset, &shape)?;
            if !self.fits(bounds) {
                break;
            }
            best = Some(shape);
            low = probe + 1;
            probe *= 2;
        }
        if best.is_none() {
            return Ok(None);
        }

        let mut high = (probe - 1).min(max_size);
        while low <= high {
            let radius = low + (high - low) / 2;
            let shape = candidate(radius);
            let bounds = self.bounds(preset, &shape)?;
            if self.fits(bounds) {
                best = Some(shape);
                low = radius + 1;
            } else {
                high = radius - 1;
            }
        }
        Ok(best)
    }

    /// Whether the cylinder or torus closes up at its size (GitHub issue #894). Only core knows: it
    /// refuses a size where a cell would meet another through two faces or the sides do not line up.
    fn closes(&mut self, preset: &str, params: &ShapeParams) -> Result<bool, FieldOpWireError> {
        let (cols, rows) = (get(params, "cols"), get(params, "rows"));
        if cols < 1 || rows < 1 {
            return Ok(false);
        }
        let key = (preset.to_string(), cols, rows, get(params, "axis"));
        if let Some(&closes) = self.closes.get(&key) {
            return Ok(closes);
        }
        let list: Vec<(&str, u32)> = params.iter().map(|(n, &v)| (n.as_str(), v)).collect();
        let closes = match self.tessellation.build_preset_folds(preset, &list) {
            Ok(_) => true,
            Err(maze_core::space::FieldOpError::InvalidPreset(_)) => false,
            Err(error) => return Err(error.into()),
        };
        self.closes.insert(key, closes);
        Ok(closes)
    }

    /// `params` (a cylinder or torus) at the nearest smaller size that closes up; `None` when no
    /// size within reach closes up.
    fn snap_to_close(
        &mut self,
        preset: &str,
        params: &ShapeParams,
    ) -> Result<Option<ShapeParams>, FieldOpWireError> {
        if self.closes(preset, params)? {
            return Ok(Some(params.clone()));
        }
        let (cols, rows) = (get(params, "cols"), get(params, "rows"));
        for other in around_size(rows) {
            for value in around_size(cols) {
                let candidate = with(params, &[("cols", value), ("rows", other)]);
                if self.closes(preset, &candidate)? {
                    return Ok(Some(candidate));
                }
            }
        }
        Ok(None)
    }

    /// `sized` (a cylinder or torus) made smaller until it fits the sheet. The plane it was sized
    /// from is measured in cell pitches, a gluing that is made of lattice periods can be much
    /// bigger than that.
    fn within_sheet(
        &mut self,
        preset: &str,
        mut sized: ShapeParams,
    ) -> Result<Option<ShapeParams>, FieldOpWireError> {
        let request = self.request;
        for _ in 0..MAX_SHRINK_STEPS {
            let bounds = self.bounds(preset, &sized)?;
            if self.fits(bounds) {
                return Ok(Some(sized));
            }
            let too_wide = bounds.width * request.cell_side_mm > request.usable_width_mm;
            let too_high = bounds.height * request.cell_side_mm > request.usable_height_mm;
            let (cols, rows) = (get(&sized, "cols"), get(&sized, "rows"));
            // A size core refuses is cut in half, otherwise the sheet over the field decides how
            // much to cut.
            let smaller = |size: u32, over: bool, usable: f64, extent: f64| -> u32 {
                if !over {
                    return size;
                }
                let cut = if extent.is_finite() {
                    (f64::from(size) * usable / extent).floor()
                } else {
                    f64::from(size / 2).floor()
                };
                let cut = if cut.is_finite() { cut.max(0.0) as u32 } else { 0 };
                cut.min(size.saturating_sub(1)).max(1)
            };
            let next = with(
                &sized,
                &[
                    (
                        "cols",
                        smaller(cols, too_wide, request.usable_width_mm, bounds.width * request.cell_side_mm),
                    ),
                    (
                        "rows",
                        smaller(rows, too_high, request.usable_height_mm, bounds.height * request.cell_side_mm),
                    ),
                ],
            );
            let Some(next) = self.snap_to_close(preset, &next)? else {
                return Ok(None);
            };
            if get(&next, "cols") < 1 || get(&next, "rows") < 1 {
                return Ok(None);
            }
            sized = next;
        }
        Ok(None)
    }
}

/// The values at and below `size` within `1..=MAX_RECT_DIMENSION`, nearest first.
fn around_size(size: u32) -> impl Iterator<Item = u32> {
    (0..=SNAP_RANGE).filter_map(move |distance| {
        let candidate = size.checked_sub(distance)?;
        (candidate >= 1 && candidate <= MAX_RECT_DIMENSION).then_some(candidate)
    })
}

/// The param the radial search grows: the box is grown by its width, the others by one size.
fn size_param(preset: &str) -> &'static str {
    match preset {
        "box" => "width",
        "triangle" | "tetrahedron" | "octahedron" | "icosahedron" => "side",
        _ => "radius",
    }
}

fn radial_candidate(preset: &str, params: &ShapeParams, size: u32) -> ShapeParams {
    match preset {
        "box" => scaled_box(params, size),
        _ => with(params, &[(size_param(preset), size)]),
    }
}

/// The box keeping its proportions with `longest` cells along its longest side.
fn scaled_box(params: &ShapeParams, longest: u32) -> ShapeParams {
    let current = ["width", "height", "depth"].map(|name| get(params, name));
    let scale = f64::from(longest) / f64::from(current.into_iter().max().unwrap_or(1).max(1));
    let side = |value: u32| ((f64::from(value) * scale).round() as u32).max(1);
    with(
        params,
        &[
            ("width", side(current[0])),
            ("height", side(current[1])),
            ("depth", side(current[2])),
        ],
    )
}

/// How many dimensions past the smallest block a size growing about linearly reaches `limit`, from
/// its size there and two further (a staggered lattice repeats every 2). An estimate only:
/// `largest_fitting` verifies it.
fn estimate_limit(size_at_min: f64, size_two_further: f64, limit: f64) -> f64 {
    let slope = (size_two_further - size_at_min) / 2.0;
    let estimate = if slope > 0.0 {
        ((limit - size_at_min) / slope).floor()
    } else {
        0.0
    };
    if estimate.is_finite() { estimate } else { 0.0 }
}

/// Smallest `value` in `1..=MIN_PROBE_DIMENSION` whose block core accepts (finite bounds), 0 when
/// none does.
fn first_accepted(mut bounds_of: impl FnMut(u32) -> Bounds) -> u32 {
    (1..=MIN_PROBE_DIMENSION)
        .find(|&value| bounds_of(value).width.is_finite())
        .unwrap_or(0)
}

/// Largest `value` in `min..=max` with `fits_at(value)`, 0 when even `min` does not fit.
/// `fits_at` is monotone (true up to a limit); the search gallops from `hint` toward the limit and
/// bisects the bracket, so a good hint costs a handful of calls.
fn largest_fitting(mut fits_at: impl FnMut(u32) -> bool, hint: f64, min: u32, max: u32) -> u32 {
    let start = hint
        .round()
        .clamp(f64::from(min), f64::from(max)) as i64;
    let (min, max) = (i64::from(min), i64::from(max));
    let mut low: i64; // fits, or min - 1
    let mut high: i64; // does not fit, or max + 1
    if fits_at(start as u32) {
        low = start;
        high = max + 1;
        let mut step = 1;
        while low + step <= max {
            if fits_at((low + step) as u32) {
                low += step;
            } else {
                high = low + step;
                break;
            }
            step *= 2;
        }
    } else {
        high = start;
        low = min - 1;
        let mut step = 1;
        while high - step >= min {
            if fits_at((high - step) as u32) {
                low = high - step;
                break;
            }
            high -= step;
            step *= 2;
        }
    }
    while high - low > 1 {
        let mid = (low + high) / 2;
        if fits_at(mid as u32) {
            low = mid;
        } else {
            high = mid;
        }
    }
    if low < min { 0 } else { low as u32 }
}

#[cfg(test)]
#[path = "print_sizing_tests.rs"]
mod tests;
