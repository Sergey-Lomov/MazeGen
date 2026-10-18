//! Field operations over `Tessellation` cell sets (GitHub issue #760) — see `Specs/space.md`'s
//! "Field operations".
//!
//! Translation and reflection are derived geometrically for every tessellation (the
//! `FieldOps` extension trait); preset field shapes are declared by each tessellation
//! (`Tessellation::presets` / `build_preset`) on top of the shared builders below. Everything is in
//! world units, with no display orientation.

use super::geometry::{GEOM_EPS, MAX_REGION_CANDIDATES, Point, TessellationGeometry};
use super::{CellScope, Tessellation};
use std::collections::HashSet;
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
    let size: u64 = params.iter().map(|&(_, value)| u64::from(value)).product();
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
        if count != 1 {
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
        if !is_symmetry(self, &map, Point::default()) {
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

/// The sorted vertices (segment starts) of `cell`'s boundary.
fn cell_vertices<T: Tessellation + ?Sized>(tessellation: &T, cell: T::CellId) -> Vec<Point> {
    tessellation
        .boundary_path(cell)
        .segments()
        .map(|segment| segment.start())
        .collect()
}

fn same_vertex_set(a: &[Point], b: &[Point]) -> bool {
    let near = |p: &Point, q: &Point| p.distance(*q) <= SYMMETRY_VERTEX_TOLERANCE;
    a.len() == b.len()
        && a.iter().all(|p| b.iter().any(|q| near(p, q)))
        && b.iter().all(|q| a.iter().any(|p| near(p, q)))
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

/// The valid cells matching `inside` (a point test) within the box `min`–`max`, sorted.
fn cells_where<T: Tessellation + ?Sized>(
    tessellation: &T,
    min: Point,
    max: Point,
    inclusion: Inclusion,
    inside: impl Fn(Point) -> bool,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let mut cells: Vec<T::CellId> = tessellation
        .candidate_cells(min, max, MAX_REGION_CANDIDATES)
        .ok_or_else(|| FieldOpError::InvalidPreset("preset is too large".to_string()))?
        .into_iter()
        .filter(|&cell| tessellation.is_valid_cell(cell))
        .filter(|&cell| match inclusion {
            Inclusion::Center => inside(tessellation.center(cell)),
            Inclusion::WholeCell => cell_vertices(tessellation, cell).into_iter().all(&inside),
        })
        .collect();
    cells.sort();
    cells.dedup();
    if cells.is_empty() {
        return Err(FieldOpError::InvalidPreset(
            "the shape contains no cells".to_string(),
        ));
    }
    Ok(cells)
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
fn convex_cells<T: Tessellation + ?Sized>(
    tessellation: &T,
    origin: Point,
    vertices: &[Point],
    reach: f64,
    inclusion: Inclusion,
) -> Result<Vec<T::CellId>, FieldOpError> {
    let margin = Point::new(reach + 2.0, reach + 2.0);
    cells_where(
        tessellation,
        origin - margin,
        origin + margin,
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
