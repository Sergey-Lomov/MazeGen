//! Field operations over `Tessellation` cell sets (GitHub issue #760) — see `Specs/space.md`'s
//! "Field operations".
//!
//! Translation and reflection are derived geometrically for every tessellation (the
//! `FieldOps` extension trait); preset field shapes are declared by each tessellation
//! (`Tessellation::presets` / `build_preset`) on top of the shared builders below. Everything is in
//! world units, with no display orientation.

use super::geometry::{GEOM_EPS, MAX_REGION_CANDIDATES, Point, TessellationGeometry};
use super::{CellScope, Tessellation};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fmt;

/// An operation a tessellation may offer on cell sets. `Tessellation::field_operations` lists the
/// supported ones so the UI can hide unavailable tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FieldOperation {
    Translate,
    Reflect,
}

/// Why a field operation was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldOpError {
    /// The tessellation does not offer the operation (or the preset).
    Unavailable,
    /// The vector or axis is not a symmetry of the tessellation.
    NotASymmetry,
    /// A cell of the input does not exist in the tessellation, or its image does not.
    OutsideTessellation,
    /// Unknown preset parameters, a missing or out-of-range value, or a preset too large to build.
    InvalidPreset(String),
}

impl fmt::Display for FieldOpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FieldOpError::Unavailable => write!(f, "operation is not available"),
            FieldOpError::NotASymmetry => write!(f, "not a symmetry of the tessellation"),
            FieldOpError::OutsideTessellation => {
                write!(f, "a cell is outside the tessellation")
            }
            FieldOpError::InvalidPreset(reason) => write!(f, "invalid preset: {reason}"),
        }
    }
}

impl std::error::Error for FieldOpError {}

/// One integer parameter of a preset field shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetParam {
    pub name: &'static str,
    pub min: u32,
}

/// A preset field shape a tessellation offers: its key and parameter schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetDescriptor {
    pub key: &'static str,
    pub params: &'static [PresetParam],
}

/// Named preset parameter values.
pub type PresetParams<'a> = &'a [(&'a str, u32)];

pub(super) const COLS: PresetParam = PresetParam {
    name: "cols",
    min: 1,
};
pub(super) const ROWS: PresetParam = PresetParam {
    name: "rows",
    min: 1,
};
pub(super) const RADIUS: PresetParam = PresetParam {
    name: "radius",
    min: 1,
};
pub(super) const SIDE: PresetParam = PresetParam {
    name: "side",
    min: 1,
};

pub(super) const RECT_PRESET: PresetDescriptor = PresetDescriptor {
    key: "rect",
    params: &[COLS, ROWS],
};
pub(super) const PARALLELOGRAM_PRESET: PresetDescriptor = PresetDescriptor {
    key: "parallelogram",
    params: &[COLS, ROWS],
};
pub(super) const CIRCLE_PRESET: PresetDescriptor = PresetDescriptor {
    key: "circle",
    params: &[RADIUS],
};
pub(super) const TRIANGLE_PRESET: PresetDescriptor = PresetDescriptor {
    key: "triangle",
    params: &[SIDE],
};
pub(super) const HEXAGON_PRESET: PresetDescriptor = PresetDescriptor {
    key: "hexagon",
    params: &[RADIUS],
};

/// Largest product of a preset's parameters accepted: bounds a rectangle's cell count and keeps
/// every coordinate far from `i32` overflow.
pub(super) const MAX_PRESET_SIZE: u64 = 1_000_000;

/// Switches a preset may leave out (they default to `0`) and that do not count toward its size.
const OPTIONAL_PARAMS: [&str; 1] = ["axis"];

/// Checks `params` against the schema of preset `key` among `presets`: the preset must exist and
/// every parameter must be present exactly once, known and at least its minimum, and the product
/// of the values must stay within `MAX_PRESET_SIZE`.
pub fn validate_preset(
    presets: &[PresetDescriptor],
    key: &str,
    params: PresetParams<'_>,
) -> Result<(), FieldOpError> {
    let descriptor = presets
        .iter()
        .find(|descriptor| descriptor.key == key)
        .ok_or(FieldOpError::Unavailable)?;
    for &(name, value) in params {
        let schema = descriptor
            .params
            .iter()
            .find(|schema| schema.name == name)
            .ok_or_else(|| FieldOpError::InvalidPreset(format!("unknown parameter \"{name}\"")))?;
        if value < schema.min {
            return Err(FieldOpError::InvalidPreset(format!(
                "\"{name}\" must be at least {}",
                schema.min
            )));
        }
    }
    let size: u64 = params
        .iter()
        .filter(|(name, _)| !OPTIONAL_PARAMS.contains(name))
        .map(|&(_, value)| u64::from(value))
        .product();
    if size > MAX_PRESET_SIZE {
        return Err(FieldOpError::InvalidPreset(
            "preset is too large".to_string(),
        ));
    }
    for schema in descriptor.params {
        let count = params
            .iter()
            .filter(|(name, _)| *name == schema.name)
            .count();
        let optional = OPTIONAL_PARAMS.contains(&schema.name);
        if count > 1 || (count == 0 && !optional) {
            return Err(FieldOpError::InvalidPreset(format!(
                "parameter \"{}\" must be given exactly once",
                schema.name
            )));
        }
    }
    Ok(())
}

/// The value of `name` in params already accepted by `validate_preset`.
pub(super) fn param(params: PresetParams<'_>, name: &str) -> u32 {
    params
        .iter()
        .find(|(n, _)| *n == name)
        .map(|&(_, value)| value)
        .expect("params validated against the preset schema")
}

/// The value of the optional switch `name` (`0` when left out) in params already accepted by
/// `validate_preset`.
pub(super) fn optional_param(params: PresetParams<'_>, name: &str) -> u32 {
    params
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(0, |&(_, value)| value)
}

/// Half-size (world units) of the window probed when deciding whether a map is a symmetry. It
/// spans many periods of every built-in lattice, so a map that matches cells across it matches
/// everywhere (the tilings are periodic).
const SYMMETRY_PROBE_RADIUS: f64 = 6.0;

/// Largest vertex distance accepted as "the same vertex" when comparing a mapped cell to its
/// target. Absorbs lattice floating-point noise only.
const SYMMETRY_VERTEX_TOLERANCE: f64 = 1e-6;

/// Field operations on cell sets, available on every `Tessellation` (blanket impl). Results are
/// sorted by `CellId`. An empty input yields an empty result.
pub trait FieldOps: Tessellation {
    /// Every cell moved by the world `vector`. `vector` must be a translation symmetry of the
    /// tessellation.
    fn translate_cells(
        &self,
        cells: &[Self::CellId],
        vector: Point,
    ) -> Result<Vec<Self::CellId>, FieldOpError> {
        require_operation(self, FieldOperation::Translate)?;
        let map = |point: Point| point + vector;
        let is_translation = match self.translation_basis() {
            Some(basis) => in_lattice(basis, vector),
            None => is_symmetry(self, &map, Point::default()),
        };
        if !is_translation {
            return Err(FieldOpError::NotASymmetry);
        }
        map_cells(self, cells, &map)
    }

    /// Every cell mirrored across the world line through `axis.0` and `axis.1`. The line must be a
    /// reflection symmetry of the tessellation.
    fn reflect_cells(
        &self,
        cells: &[Self::CellId],
        axis: (Point, Point),
    ) -> Result<Vec<Self::CellId>, FieldOpError> {
        require_operation(self, FieldOperation::Reflect)?;
        let (a, b) = axis;
        let direction = b - a;
        let length_squared = direction.dot(direction);
        if length_squared == 0.0 {
            return Err(FieldOpError::NotASymmetry);
        }
        let reflect = |point: Point| {
            let along = (point - a).dot(direction) / length_squared;
            let foot = a + direction * along;
            foot * 2.0 - point
        };
        // Probe near the axis, where a reflection's behavior is decided.
        let nearest = a + direction * ((-a.dot(direction)) / length_squared);
        if !is_symmetry(self, &reflect, nearest) {
            return Err(FieldOpError::NotASymmetry);
        }
        map_cells(self, cells, &reflect)
    }
}

fn require_operation<T: Tessellation + ?Sized>(
    tessellation: &T,
    operation: FieldOperation,
) -> Result<(), FieldOpError> {
    if tessellation.field_operations().contains(&operation) {
        Ok(())
    } else {
        Err(FieldOpError::Unavailable)
    }
}

impl<T: Tessellation + ?Sized> FieldOps for T {}

/// The characteristic points of `cell`'s boundary: every segment's start and midpoint (the
/// midpoints tell a convex arc from a concave one over the same chord).
fn cell_vertices<T: Tessellation + ?Sized>(tessellation: &T, cell: T::CellId) -> Vec<Point> {
    tessellation
        .boundary_path(cell)
        .segments()
        .flat_map(|segment| [segment.start(), segment.point(0.5)])
        .collect()
}

fn same_vertex_set(a: &[Point], b: &[Point]) -> bool {
    let near = |p: &Point, q: &Point| p.distance(*q) <= SYMMETRY_VERTEX_TOLERANCE;
    a.len() == b.len()
        && a.iter().all(|p| b.iter().any(|q| near(p, q)))
        && b.iter().all(|q| a.iter().any(|p| near(p, q)))
}

/// Largest distance from an integer accepted for a lattice coordinate; absorbs floating-point
/// noise of vectors computed from cell centers.
const LATTICE_COORDINATE_TOLERANCE: f64 = 1e-6;

/// Whether `vector` is an integer combination of the two `basis` vectors.
fn in_lattice(basis: [Point; 2], vector: Point) -> bool {
    let [a, b] = basis;
    let determinant = a.x * b.y - a.y * b.x;
    let along_a = (vector.x * b.y - vector.y * b.x) / determinant;
    let along_b = (a.x * vector.y - a.y * vector.x) / determinant;
    [along_a, along_b]
        .iter()
        .all(|c| (c - c.round()).abs() <= LATTICE_COORDINATE_TOLERANCE)
}

/// Checks the `Tessellation::translation_basis` contract of `tessellation`: a tessellation that
/// offers `Translate` must declare a basis, and the basis must accept exactly the translations the
/// slow symmetry probe accepts (tested on lattice vectors, fractions of them and other offsets).
/// Run for every registered tessellation, so a new one cannot skip or get its basis wrong.
pub fn check_translation_basis<T: Tessellation + ?Sized>(tessellation: &T) -> Result<(), String> {
    let t = tessellation;
    let Some(basis) = t.translation_basis() else {
        return if t.field_operations().contains(&FieldOperation::Translate) {
            Err("offers Translate but declares no translation_basis".to_string())
        } else {
            Ok(())
        };
    };
    let [a, b] = basis;
    let mut vectors = vec![Point::default()];
    for i in -2..=2 {
        for j in -2..=2 {
            let lattice = a * f64::from(i) + b * f64::from(j);
            vectors.push(lattice);
            vectors.push(lattice + a * 0.5);
            vectors.push(lattice + b * 0.5);
            vectors.push(lattice + (a + b) * 0.5);
            vectors.push(lattice + Point::new(0.3, 0.1));
        }
    }
    let window = Point::new(2.0, 2.0);
    let cells = t
        .candidate_cells(
            Point::default() - window,
            Point::default() + window,
            100_000,
        )
        .ok_or("no candidate cells near the origin")?;
    let valid: Vec<_> = cells.into_iter().filter(|&c| t.is_valid_cell(c)).collect();
    let first = *valid.first().ok_or("no valid cell near the origin")?;
    vectors.extend(valid.iter().map(|&c| t.center(c) - t.center(first)));
    for v in vectors {
        let map = |point: Point| point + v;
        let probed = is_symmetry(t, &map, Point::default());
        if in_lattice(basis, v) != probed {
            return Err(format!(
                "translation_basis disagrees with the symmetry probe for ({}, {}): probe says {probed}",
                v.x, v.y
            ));
        }
    }
    Ok(())
}

/// Whether the point map sends every cell of the probe window around `focus` onto a cell with the
/// same boundary.
fn is_symmetry<T: Tessellation + ?Sized>(
    tessellation: &T,
    map: &dyn Fn(Point) -> Point,
    focus: Point,
) -> bool {
    let radius = Point::new(SYMMETRY_PROBE_RADIUS, SYMMETRY_PROBE_RADIUS);
    let Some(window) =
        tessellation.candidate_cells(focus - radius, focus + radius, MAX_REGION_CANDIDATES)
    else {
        return false;
    };
    window
        .into_iter()
        .filter(|&cell| tessellation.is_valid_cell(cell))
        .all(|cell| {
            let Some(target) =
                tessellation.cell_at(map(tessellation.center(cell)), CellScope::Space)
            else {
                return false;
            };
            let mapped: Vec<Point> = cell_vertices(tessellation, cell)
                .into_iter()
                .map(map)
                .collect();
            same_vertex_set(&mapped, &cell_vertices(tessellation, target))
        })
}

fn map_cells<T: Tessellation + ?Sized>(
    tessellation: &T,
    cells: &[T::CellId],
    map: &dyn Fn(Point) -> Point,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let mut mapped = Vec::with_capacity(cells.len());
    for &cell in cells {
        if !tessellation.is_valid_cell(cell) {
            return Err(FieldOpError::OutsideTessellation);
        }
        let image = tessellation
            .cell_at(map(tessellation.center(cell)), CellScope::Space)
            .filter(|&image| tessellation.is_valid_cell(image))
            .ok_or(FieldOpError::OutsideTessellation)?;
        mapped.push(image);
    }
    mapped.sort();
    mapped.dedup();
    Ok(mapped)
}

/// Whether `cells` (sorted, without duplicates) form one connected set through tessellation
/// neighbors. The empty set is connected.
pub fn is_connected<T: Tessellation + ?Sized>(tessellation: &T, cells: &[T::CellId]) -> bool {
    let Some(&start) = cells.first() else {
        return true;
    };
    let mut seen: HashSet<T::CellId> = HashSet::from([start]);
    let mut stack = vec![start];
    while let Some(cell) = stack.pop() {
        for &face in tessellation.faces_of(cell) {
            if let Some((next, _)) = tessellation.neighbor(cell, face)
                && cells.binary_search(&next).is_ok()
                && seen.insert(next)
            {
                stack.push(next);
            }
        }
    }
    seen.len() == cells.len()
}

/// Tolerance of every preset boundary test, in world units: a cell whose center (or vertex) sits
/// exactly on the shape boundary is inside.
const PRESET_EPS: f64 = 1e-6;

/// Which part of a cell must lie inside a preset shape.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Inclusion {
    Center,
    WholeCell,
}

/// A measurement running under `with_extent_focus`.
#[derive(Clone, Copy)]
struct ExtentFocus {
    directions: [[f64; 2]; 2],
    /// False once a builder did something that depends on the whole shape.
    exact: bool,
}

thread_local! {
    /// The focus of the measurement running on this thread, if any.
    static EXTENT_FOCUS: Cell<Option<ExtentFocus>> = const { Cell::new(None) };
}

/// Called by a shape builder that works on the whole set of cells (it drops a piece cut off from
/// the rest): under `with_extent_focus` the cells are only a part, so the result is not exact.
pub(super) fn spoil_extent_focus() {
    EXTENT_FOCUS.with(|focus| {
        if let Some(active) = focus.get() {
            focus.set(Some(ExtentFocus { exact: false, ..active }));
        }
    });
}

/// Runs `measure` with the geometric shape builders (`circle`, `triangle`, `hexagon`, a lattice
/// `rect`) returning only the cells that can hold the extremes along `directions` (GitHub issue
/// #939): the cells in the strips at the four ends, not the whole shape. The cells returned are a
/// subset, so only a measurement of the extents may run inside. A shape on a tessellation without
/// a translation lattice is built in full. The flag returned is false when a builder needed the
/// whole shape after all; the result of `measure` is then not to be used.
pub fn with_extent_focus<R>(directions: [[f64; 2]; 2], measure: impl FnOnce() -> R) -> (R, bool) {
    struct Restore(Option<ExtentFocus>);
    impl Drop for Restore {
        fn drop(&mut self) {
            EXTENT_FOCUS.with(|focus| focus.set(self.0));
        }
    }
    let _restore = Restore(EXTENT_FOCUS.with(|focus| {
        focus.replace(Some(ExtentFocus {
            directions,
            exact: true,
        }))
    }));
    let result = measure();
    let exact = EXTENT_FOCUS.with(|focus| focus.get().is_some_and(|active| active.exact));
    (result, exact)
}

/// Tolerance the boundaries are flattened with to find how far a cell reaches from its center.
const REACH_TOLERANCE: f64 = 1e-6;
/// Margin on the measured reach: the focus must never cut off a cell a measurement needs.
const REACH_SAFETY: f64 = 1.5;
/// Side of a focus tile in cell reaches.
const TILE_REACHES: f64 = 6.0;
/// Largest number of tiles a focused build walks; a bigger box is built in full.
const MAX_FOCUS_TILES: f64 = 4_000_000.0;

/// The valid cells matching `inside` (a point test) within the box `min`–`max`, sorted.
fn cells_where<T: Tessellation + ?Sized>(
    tessellation: &T,
    min: Point,
    max: Point,
    inclusion: Inclusion,
    inside: impl Fn(Point) -> bool,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let accepts = |cell: T::CellId| {
        tessellation.is_valid_cell(cell)
            && match inclusion {
                Inclusion::Center => inside(tessellation.center(cell)),
                Inclusion::WholeCell => cell_vertices(tessellation, cell).into_iter().all(&inside),
            }
    };
    let focused = match EXTENT_FOCUS.with(Cell::get) {
        Some(focus) if tessellation.translation_basis().is_some() => {
            // The shape is measured as if built in full: one too large to be built is refused too,
            // else a size would be found that the field then cannot have. Candidates are counted
            // before any is allocated.
            if tessellation
                .candidate_cells(min, max, MAX_REGION_CANDIDATES)
                .is_none()
            {
                return Err(FieldOpError::InvalidPreset(
                    "preset is too large".to_string(),
                ));
            }
            focused_cells(tessellation, min, max, focus.directions, &accepts)?
        }
        _ => None,
    };
    let mut cells: Vec<T::CellId> = match focused {
        Some(cells) => cells,
        None => tessellation
            .candidate_cells(min, max, MAX_REGION_CANDIDATES)
            .ok_or_else(|| FieldOpError::InvalidPreset("preset is too large".to_string()))?
            .into_iter()
            .filter(|&cell| accepts(cell))
            .collect(),
    };
    cells.sort();
    cells.dedup();
    if cells.is_empty() {
        return Err(FieldOpError::InvalidPreset(
            "the shape contains no cells".to_string(),
        ));
    }
    Ok(cells)
}

/// The cells accepted in the box `min`–`max` that lie within reach of its extremes along each end
/// of `directions`, or `None` when the box cannot be walked in tiles.
///
/// The box is cut into tiles; for each end the tiles are visited from the one reaching furthest
/// along it, until the next tile lies more than three cell reaches behind the furthest accepted
/// cell. Every accepted cell a measurement of the extents can need is in a visited tile: it
/// is at most two reaches behind the furthest center, and a cell's center lies in its tile.
fn focused_cells<T: Tessellation + ?Sized>(
    tessellation: &T,
    min: Point,
    max: Point,
    directions: [[f64; 2]; 2],
    accepts: &dyn Fn(T::CellId) -> bool,
) -> Result<Option<Vec<T::CellId>>, FieldOpError> {
    let Some(reach) = cell_reach(tessellation, (min + max) * 0.5) else {
        return Ok(None);
    };
    let tile = TILE_REACHES * reach;
    let columns = ((max.x - min.x) / tile).ceil().max(1.0);
    let rows = ((max.y - min.y) / tile).ceil().max(1.0);
    if columns * rows > MAX_FOCUS_TILES {
        return Ok(None);
    }
    let (columns, rows) = (columns as usize, rows as usize);
    let tile_min = |column: usize, row: usize| {
        Point::new(min.x + column as f64 * tile, min.y + row as f64 * tile)
    };

    let mut visited: HashMap<(usize, usize), Vec<(T::CellId, Point)>> = HashMap::new();
    for end in [
        directions[0],
        directions[1],
        [-directions[0][0], -directions[0][1]],
        [-directions[1][0], -directions[1][1]],
    ] {
        let along = |point: Point| end[0] * point.x + end[1] * point.y;
        let margin = 3.0 * reach * end[0].hypot(end[1]);
        // A tile reaches furthest along `end` at one of its corners.
        let furthest = |column: usize, row: usize| {
            let low = tile_min(column, row);
            let high = low + Point::new(tile, tile);
            [low.x, high.x]
                .into_iter()
                .flat_map(|x| [low.y, high.y].map(move |y| along(Point::new(x, y))))
                .fold(f64::NEG_INFINITY, f64::max)
        };
        let mut order: Vec<(f64, usize, usize)> = (0..columns)
            .flat_map(|column| (0..rows).map(move |row| (column, row)))
            .map(|(column, row)| (furthest(column, row), column, row))
            .collect();
        order.sort_by(|a, b| b.0.total_cmp(&a.0));

        let mut best = f64::NEG_INFINITY;
        for (tile_furthest, column, row) in order {
            if best.is_finite() && tile_furthest < best - margin {
                break;
            }
            if !visited.contains_key(&(column, row)) {
                let low = tile_min(column, row);
                let high = Point::new((low.x + tile).min(max.x), (low.y + tile).min(max.y));
                let candidates = tessellation
                    .candidate_cells(low, high, MAX_REGION_CANDIDATES)
                    .ok_or_else(|| FieldOpError::InvalidPreset("preset is too large".to_string()))?;
                let accepted = candidates
                    .into_iter()
                    .filter(|&cell| accepts(cell))
                    .map(|cell| (cell, tessellation.center(cell)))
                    .collect();
                visited.insert((column, row), accepted);
            }
            for &(_, center) in &visited[&(column, row)] {
                best = best.max(along(center));
            }
        }
    }
    Ok(Some(
        visited
            .into_values()
            .flatten()
            .map(|(cell, _)| cell)
            .collect(),
    ))
}

/// How far the cells around `at` reach from their centers (with `REACH_SAFETY`), the largest of
/// every shape found within a few units; `None` for a tessellation with no cell there.
fn cell_reach<T: Tessellation + ?Sized>(tessellation: &T, at: Point) -> Option<f64> {
    let around = Point::new(6.0, 6.0);
    let mut shapes = HashSet::new();
    let mut reach: Option<f64> = None;
    for cell in tessellation.candidate_cells(at - around, at + around, MAX_REGION_CANDIDATES)? {
        if !tessellation.is_valid_cell(cell) {
            continue;
        }
        let first_of_shape = tessellation
            .shape_of(cell)
            .is_none_or(|shape| shapes.insert(shape.descriptor().key().to_owned()));
        if !first_of_shape {
            continue;
        }
        let center = tessellation.center(cell);
        let cell_reach = tessellation
            .boundary_path(cell)
            .flatten(REACH_TOLERANCE)
            .iter()
            .map(|point| point.distance(center))
            .fold(0.0, f64::max);
        reach = Some(reach.unwrap_or(0.0).max(cell_reach));
    }
    reach
        .filter(|&reach| reach > 0.0)
        .map(|reach| reach * REACH_SAFETY)
}

/// A disc of `radius` around `origin`.
pub(super) fn circle_cells<T: Tessellation + ?Sized>(
    tessellation: &T,
    origin: Point,
    radius: u32,
    inclusion: Inclusion,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let radius = radius as f64;
    let reach = Point::new(radius + 2.0, radius + 2.0);
    cells_where(
        tessellation,
        origin - reach,
        origin + reach,
        inclusion,
        |p| p.distance(origin) <= radius + PRESET_EPS,
    )
}

/// An equilateral triangle of `side`, apex up, centroid at `origin`.
pub(super) fn triangle_cells<T: Tessellation + ?Sized>(
    tessellation: &T,
    origin: Point,
    side: u32,
    inclusion: Inclusion,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let side = side as f64;
    let circumradius = side / 3f64.sqrt();
    let vertices = [
        origin + Point::polar(circumradius, std::f64::consts::FRAC_PI_2),
        origin
            + Point::polar(
                circumradius,
                std::f64::consts::FRAC_PI_2 + 2.0 * std::f64::consts::FRAC_PI_3,
            ),
        origin
            + Point::polar(
                circumradius,
                std::f64::consts::FRAC_PI_2 + 4.0 * std::f64::consts::FRAC_PI_3,
            ),
    ];
    convex_cells(tessellation, origin, &vertices, circumradius, inclusion)
}

/// A regular hexagon of circumradius `radius` (vertices on the x axis), centered at `origin`.
pub(super) fn hexagon_cells<T: Tessellation + ?Sized>(
    tessellation: &T,
    origin: Point,
    radius: u32,
    inclusion: Inclusion,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let radius = radius as f64;
    let vertices: Vec<Point> = (0..6)
        .map(|k| origin + Point::polar(radius, k as f64 * std::f64::consts::FRAC_PI_3))
        .collect();
    convex_cells(tessellation, origin, &vertices, radius, inclusion)
}

/// Cells inside the convex counter-clockwise polygon `vertices`, all within `reach` of `origin`.
pub(super) fn convex_cells<T: Tessellation + ?Sized>(
    tessellation: &T,
    origin: Point,
    vertices: &[Point],
    reach: f64,
    inclusion: Inclusion,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let margin = Point::new(reach + 2.0, reach + 2.0);
    // A cell is accepted only when its center lies inside the polygon, so the polygon's own box
    // bounds the search: no walk over the corners of a box drawn around a long, thin shape.
    let (mut low, mut high) = (origin - margin, origin + margin);
    let (mut low_vertex, mut high_vertex) = (vertices[0], vertices[0]);
    for vertex in vertices {
        low_vertex = Point::new(low_vertex.x.min(vertex.x), low_vertex.y.min(vertex.y));
        high_vertex = Point::new(high_vertex.x.max(vertex.x), high_vertex.y.max(vertex.y));
    }
    let slack = Point::new(PRESET_EPS + GEOM_EPS, PRESET_EPS + GEOM_EPS) * 1e3;
    low = Point::new(low.x.max(low_vertex.x - slack.x), low.y.max(low_vertex.y - slack.y));
    high = Point::new(high.x.min(high_vertex.x + slack.x), high.y.min(high_vertex.y + slack.y));
    cells_where(
        tessellation,
        low,
        high,
        inclusion,
        |p| {
            vertices
                .iter()
                .zip(vertices.iter().cycle().skip(1))
                .all(|(&a, &b)| {
                    let edge = b - a;
                    edge.cross(p - a) >= -(PRESET_EPS + GEOM_EPS) * edge.length()
                })
        },
    )
}
