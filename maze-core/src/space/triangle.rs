use super::field_ops::{
    CIRCLE_PRESET, HEXAGON_PRESET, Inclusion, RECT_PRESET, TRIANGLE_PRESET, circle_cells, param,
};
use super::square::{cell_range, grid_candidates};
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    Tessellation, validate_preset,
};
use std::sync::LazyLock;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct TriPoint {
    pub col: i32,
    pub row: i32,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum TriFace {
    Left,
    Right,
    Base,
}

impl TriFace {
    /// The face on the other side of the same edge: a `Left` side touches the neighbor's `Right`
    /// side and vice versa, a `Base` touches the neighbor's `Base`.
    pub fn opposite(self) -> Self {
        match self {
            TriFace::Left => TriFace::Right,
            TriFace::Right => TriFace::Left,
            TriFace::Base => TriFace::Base,
        }
    }
}

static TRI_SHAPES: LazyLock<[ShapeDescriptor; 1]> =
    LazyLock::new(|| [ShapeDescriptor::regular_polygon(3)]);

/// `pointing_up` cells (`Base` neighbor at `row - 1`, above in `cartesian`): canonical
/// counter-clockwise order.
const TRI_BASE_ABOVE_FACES: [TriFace; 3] = [TriFace::Base, TriFace::Left, TriFace::Right];

/// Other cells (`Base` neighbor at `row + 1`, below in `cartesian`): canonical counter-clockwise
/// order.
const TRI_BASE_BELOW_FACES: [TriFace; 3] = [TriFace::Base, TriFace::Right, TriFace::Left];

/// `faces_of` is the canonical counter-clockwise order on both orientations.
const TRI_LOCAL_TO_CANONICAL: [usize; 3] = [0, 1, 2];

fn pointing_up(cell: TriPoint) -> bool {
    (cell.col + cell.row).rem_euclid(2) == 0
}

#[derive(Debug, Default, Clone, Copy)]
pub struct TriTessellation;

impl Tessellation for TriTessellation {
    type CellId = TriPoint;
    type Face = TriFace;

    fn is_valid_cell(&self, _cell: TriPoint) -> bool {
        true
    }

    /// Counter-clockwise from `Base`; `Left`/`Right` swap circular positions between the two
    /// orientations.
    fn faces_of(&self, cell: TriPoint) -> &[TriFace] {
        if pointing_up(cell) {
            &TRI_BASE_ABOVE_FACES
        } else {
            &TRI_BASE_BELOW_FACES
        }
    }

    fn neighbor(&self, cell: TriPoint, face: TriFace) -> Option<(TriPoint, TriFace)> {
        let pointing_up = pointing_up(cell);
        let (dcol, drow) = match face {
            TriFace::Left => (-1, 0),
            TriFace::Right => (1, 0),
            TriFace::Base if pointing_up => (0, -1),
            TriFace::Base => (0, 1),
        };
        let neighbor = TriPoint {
            col: cell.col.checked_add(dcol)?,
            row: cell.row.checked_add(drow)?,
        };
        Some((neighbor, face.opposite()))
    }

    /// Geometric semantics: every pass through a triangle turns by 60°, so none is straight.
    fn is_straight(&self, _cell: TriPoint, _in_face: TriFace, _out_face: TriFace) -> bool {
        false
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*TRI_SHAPES
    }

    /// Full dihedral group (3 rotations + 3 reflections).
    fn shape_of(&self, _cell: TriPoint) -> Option<CellShape<'_>> {
        Some(CellShape::full(&TRI_SHAPES[0], &TRI_LOCAL_TO_CANONICAL))
    }

    /// Centroid of the cell's triangle (area 1).
    fn center(&self, cell: TriPoint) -> Point {
        let [a, b, c] = tri_vertices(cell);
        Point::new((a.x + b.x + c.x) / 3.0, (a.y + b.y + c.y) / 3.0)
    }

    /// `pointing_up` cells (base on top): `Base` top-right to top-left, `Left` down to the apex,
    /// `Right` back up. Other cells (base at the bottom): `Base` bottom-left to bottom-right,
    /// `Right` up to the apex, `Left` back down.
    fn face_segments(&self, cell: TriPoint, face: TriFace) -> Vec<Segment> {
        let [first, second, third] = tri_vertices(cell);
        let (from, to) = match face {
            TriFace::Base => (first, second),
            TriFace::Left if pointing_up(cell) => (second, third),
            TriFace::Right if pointing_up(cell) => (third, first),
            TriFace::Right => (second, third),
            TriFace::Left => (third, first),
        };
        vec![Segment::line(from, to)]
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<TriPoint>> {
        let (x_unit, y_unit) = tri_units();
        let (lo, hi) = (
            Point::new(min.x.min(max.x), min.y.min(max.y)),
            Point::new(min.x.max(max.x), min.y.max(max.y)),
        );
        // Center lattice x = 2col + 1; rows span y in [-(row + 1), -row] (lattice units).
        let cols = cell_range((lo.x / x_unit - 3.0) / 2.0, (hi.x / x_unit + 1.0) / 2.0);
        let rows = cell_range(-(hi.y / y_unit) - 1.0, -(lo.y / y_unit) + 1.0);
        grid_candidates(cols, rows, limit, |col, row| TriPoint { col, row })
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &TRI_PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<TriPoint>, FieldOpError> {
        validate_preset(&TRI_PRESETS, key, params)?;
        let mut cells = match key {
            "rect" => centered_tri_rect(param(params, "cols") as i32, param(params, "rows") as i32),
            "triangle" => centered_on_lattice(tri_triangle(param(params, "side") as usize)),
            "hexagon" => centered_on_lattice(tri_hexagon(param(params, "radius") as usize)),
            "circle" => {
                let origin = self.center(TriPoint { col: 0, row: 0 });
                circle_cells(self, origin, param(params, "radius"), Inclusion::WholeCell)?
            }
            _ => return Err(FieldOpError::Unavailable),
        };
        cells.sort();
        Ok(cells)
    }

    fn area(&self, _cell: TriPoint) -> f64 {
        1.0
    }
}

/// World units of the triangle lattice: side `s` with `sqrt(3)/4·s² = 1`; `x = s/4 · i`,
/// `y = s·sqrt(3)/2 · j`. Every vertex sits on integer `(i, j)`, so shared vertices are identical.
fn tri_units() -> (f64, f64) {
    let side = 2.0 / 3f64.sqrt().sqrt();
    (side / 4.0, side * 3f64.sqrt() / 2.0)
}

/// The cell's vertices in counter-clockwise order starting at `Base`'s start (see
/// `face_segments`).
fn tri_vertices(cell: TriPoint) -> [Point; 3] {
    let (x_unit, y_unit) = tri_units();
    let at = |i: i64, j: i64| Point::new(x_unit * i as f64, y_unit * j as f64);
    let (i, top, bottom) = (
        2 * cell.col as i64 + 1,
        -(cell.row as i64),
        -(cell.row as i64) - 1,
    );
    if pointing_up(cell) {
        [at(i + 2, top), at(i - 2, top), at(i, bottom)]
    } else {
        [at(i - 2, bottom), at(i + 2, bottom), at(i, top)]
    }
}

pub fn tri_rect(cols: usize, rows: usize) -> Vec<TriPoint> {
    (0..rows)
        .flat_map(|row| {
            (0..cols).map(move |col| TriPoint {
                col: col as i32,
                row: row as i32,
            })
        })
        .collect()
}

pub fn tri_triangle(side: usize) -> Vec<TriPoint> {
    // Equilateral triangle: apex at row 0 (1 tile), base at row N-1 (2N-1 tiles).
    // indent = N - 1 - row + (N % 2) ensures the apex tile is pointing-down so it has
    // a Base neighbour in row 1 (pointing-down.Base = row+1). Without the parity shift,
    // an odd N produces a pointing-up apex with no downward neighbour, disconnecting the field.
    let n = side as i32;
    let shift = n % 2;
    (0..side)
        .flat_map(move |row| {
            let indent = n - 1 - row as i32 + shift;
            (indent..=indent + 2 * row as i32).map(move |col| TriPoint {
                col,
                row: row as i32,
            })
        })
        .collect()
}

pub fn tri_hexagon(radius: usize) -> Vec<TriPoint> {
    // Equilateral hexagonal boundary: all 6 sides have R triangle-edges.
    // Rows: 0..2R (total 2R rows). Top row starts with pointing-down → smooth top boundary.
    // Bottom row ends with pointing-up → smooth bottom boundary.
    // odd_base = R-1 if R even, R if R odd (top row indent is odd = pointing-down first).
    // Row r: k = min(r, 2R-1-r), indent = odd_base - k, width = 2*(k+R) + 1.
    let r = radius as i32;
    let odd_base = if r % 2 == 0 { r - 1 } else { r };
    (0..2 * r)
        .flat_map(move |row| {
            let k = row.min(2 * r - 1 - row);
            let indent = odd_base - k;
            let width = 2 * (k + r) + 1;
            (indent..indent + width).map(move |col| TriPoint { col, row })
        })
        .collect()
}

/// Preset field shapes of the triangle grid, in UI order.
const TRI_PRESETS: [PresetDescriptor; 4] =
    [RECT_PRESET, TRIANGLE_PRESET, HEXAGON_PRESET, CIRCLE_PRESET];

/// Each configured column is a pair of adjacent opposite-orientation triangles, so a rectangle
/// holds `2 · cols` triangles per row.
fn centered_tri_rect(cols: i32, rows: i32) -> Vec<TriPoint> {
    let origin_row = rows / 2;
    (0..rows)
        .flat_map(|row| {
            (0..2 * cols).map(move |col| TriPoint {
                col: col - cols,
                row: row - origin_row,
            })
        })
        .collect()
}

/// Shifts a lattice-aligned shape so its middle cell sits near the origin. The shift keeps
/// `col + row` parity (which decides a triangle's orientation), so the shape's boundary stays
/// smooth.
fn centered_on_lattice(cells: Vec<TriPoint>) -> Vec<TriPoint> {
    let bounds = |f: fn(&TriPoint) -> i32| {
        (
            cells.iter().map(f).min().unwrap_or(0),
            cells.iter().map(f).max().unwrap_or(0),
        )
    };
    let ((min_col, max_col), (min_row, max_row)) = (bounds(|p| p.col), bounds(|p| p.row));
    let ox = (min_col + max_col + 1).div_euclid(2);
    let mut oy = (min_row + max_row + 1).div_euclid(2);
    if (ox + oy).rem_euclid(2) != 0 {
        oy = (oy - 1).max(0);
    }
    cells
        .into_iter()
        .map(|p| TriPoint {
            col: p.col - ox,
            row: p.row - oy,
        })
        .collect()
}
