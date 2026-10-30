//! The offset-row square (brick, running-bond) tiling: unit squares in rows, every odd row shifted
//! by half a cell. Each cell has six neighbors: two in its own row and two in each adjacent row,
//! the latter sharing half an edge each.
//!
//! Cell `(x, y)` is row `y`, column `x`; the cell spans `[x + s, x + s + 1] × [y, y + 1]` with
//! shift `s = 1/2` on odd rows and `0` on even ones.

use super::field_ops::{
    CIRCLE_PRESET, Inclusion, MAX_PRESET_SIZE, RECT_PRESET, TRIANGLE_PRESET, circle_cells, param,
};
use super::square::{cell_range, grid_candidates};
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    ShapeFamily, Tessellation, validate_preset,
};
use std::sync::LazyLock;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct BrickPoint {
    pub x: i32,
    pub y: i32,
}

impl BrickPoint {
    fn is_odd_row(self) -> bool {
        self.y.rem_euclid(2) == 1
    }

    /// The cell one `face` step away, or `None` when a coordinate overflows `i32`.
    pub fn step(self, face: BrickFace) -> Option<Self> {
        let (dx, dy) = face.offset(self.is_odd_row());
        Some(Self {
            x: self.x.checked_add(dx)?,
            y: self.y.checked_add(dy)?,
        })
    }
}

/// A side of a brick, named by the direction it faces. The top and bottom edges are each shared
/// with two cells of the adjacent row, so they are split into a half per cell (`NE`/`NW`,
/// `SW`/`SE`).
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum BrickFace {
    E,
    NE,
    NW,
    W,
    SW,
    SE,
}

impl BrickFace {
    const ALL: [Self; 6] = [Self::E, Self::NE, Self::NW, Self::W, Self::SW, Self::SE];

    /// The face on the other side of the same edge — also the face a straight pass leaves by.
    pub fn opposite(self) -> Self {
        Self::ALL[(self.index() + 3) % 6]
    }

    /// Position in the canonical counter-clockwise order of a brick's faces, from `E`.
    fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|&face| face == self)
            .expect("ALL lists every face")
    }

    /// Column and row offset of the neighbor across this face, from a cell of an odd or even row.
    fn offset(self, odd_row: bool) -> (i32, i32) {
        let shift = i32::from(odd_row);
        match self {
            Self::E => (1, 0),
            Self::W => (-1, 0),
            Self::NE => (shift, 1),
            Self::NW => (shift - 1, 1),
            Self::SE => (shift, -1),
            Self::SW => (shift - 1, -1),
        }
    }
}

/// `BrickFace::ALL` is already the canonical counter-clockwise order.
const LOCAL_TO_CANONICAL: [usize; 6] = [0, 1, 2, 3, 4, 5];

/// The brick's symmetries: the mirrors across its vertical and horizontal axes (their product is
/// the half turn).
static SHAPES: LazyLock<[ShapeDescriptor; 1]> = LazyLock::new(|| {
    [ShapeDescriptor::new(ShapeFamily::Registered {
        kind: "brick",
        name: "brick",
        face_count: 6,
        generators: vec![vec![3, 2, 1, 0, 5, 4], vec![0, 5, 4, 3, 2, 1]],
    })]
});

#[derive(Debug, Default, Clone, Copy)]
pub struct BrickTessellation;

impl Tessellation for BrickTessellation {
    type CellId = BrickPoint;
    type Face = BrickFace;

    fn is_valid_cell(&self, _cell: BrickPoint) -> bool {
        true
    }

    fn faces_of(&self, _cell: BrickPoint) -> &[BrickFace] {
        &BrickFace::ALL
    }

    fn neighbor(&self, cell: BrickPoint, face: BrickFace) -> Option<(BrickPoint, BrickFace)> {
        Some((cell.step(face)?, face.opposite()))
    }

    fn is_straight(&self, _cell: BrickPoint, in_face: BrickFace, out_face: BrickFace) -> bool {
        out_face == in_face.opposite()
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, _cell: BrickPoint) -> Option<CellShape<'_>> {
        Some(CellShape::full(&SHAPES[0], &LOCAL_TO_CANONICAL))
    }

    fn translation_basis(&self) -> Option<[Point; 2]> {
        Some([Point::new(-1.0, 0.0), Point::new(-0.5, -1.0)])
    }

    fn center(&self, cell: BrickPoint) -> Point {
        corner(cell, 1, 1)
    }

    fn face_segments(&self, cell: BrickPoint, face: BrickFace) -> Vec<Segment> {
        // Vertices counter-clockwise from the east face's start; every coordinate is a multiple
        // of 1/2 and so exact, which keeps a vertex shared by several cells bit-identical.
        let vertex = |k: usize| match k % 6 {
            0 => corner(cell, 2, 0),
            1 => corner(cell, 2, 2),
            2 => corner(cell, 1, 2),
            3 => corner(cell, 0, 2),
            4 => corner(cell, 0, 0),
            _ => corner(cell, 1, 0),
        };
        let k = face.index();
        vec![Segment::line(vertex(k), vertex(k + 1))]
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<BrickPoint>> {
        // A cell reaches at most one unit left of its column and half a unit right of it.
        let xs = cell_range(min.x.min(max.x) - 1.5, min.x.max(max.x));
        let ys = cell_range(min.y.min(max.y) - 1.0, min.y.max(max.y));
        grid_candidates(xs, ys, limit, |x, y| BrickPoint { x, y })
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<BrickPoint>, FieldOpError> {
        validate_preset(&PRESETS, key, params)?;
        let origin = self.center(BrickPoint { x: 0, y: 0 });
        match key {
            "rect" => Ok(centered_rect(
                param(params, "cols") as i32,
                param(params, "rows") as i32,
            )),
            "circle" => circle_cells(self, origin, param(params, "radius"), Inclusion::Center),
            "triangle" => pyramid(param(params, "side")),
            _ => Err(FieldOpError::Unavailable),
        }
    }

    fn area(&self, _cell: BrickPoint) -> f64 {
        1.0
    }
}

/// The point at `(dx, dy)` half units from the cell's lower-left corner (`dx, dy` in `0..=2`).
fn corner(cell: BrickPoint, dx: i64, dy: i64) -> Point {
    let half_units_x = 2 * cell.x as i64 + i64::from(cell.is_odd_row()) + dx;
    let half_units_y = 2 * cell.y as i64 + dy;
    Point::new(half_units_x as f64 / 2.0, half_units_y as f64 / 2.0)
}

/// Preset field shapes of the brick tiling, in UI order.
///
/// `triangle` is a pyramid rather than an equilateral triangle: a half-cell row shift makes the
/// sides rise at `atan(2)` (about 63.4°), which an equilateral triangle's 60° cannot follow without
/// a ragged edge. `side` is the number of bricks in the bottom row.
const PRESETS: [PresetDescriptor; 3] = [RECT_PRESET, CIRCLE_PRESET, TRIANGLE_PRESET];

/// `cols × rows` cells with the origin cell at `size / 2` (rounded down) of each axis.
fn centered_rect(cols: i32, rows: i32) -> Vec<BrickPoint> {
    let (ox, oy) = (cols / 2, rows / 2);
    let mut cells: Vec<BrickPoint> = (0..rows)
        .flat_map(|row| {
            (0..cols).map(move |col| BrickPoint {
                x: col - ox,
                y: row - oy,
            })
        })
        .collect();
    cells.sort();
    cells
}

/// A pyramid of `side` rows, `side` bricks in the bottom one and one fewer in each row above, so
/// every brick rests on two below it. Centered horizontally, with the origin row a third of the
/// way up.
fn pyramid(side: u32) -> Result<Vec<BrickPoint>, FieldOpError> {
    let side = i64::from(side);
    if side * (side + 1) / 2 > MAX_PRESET_SIZE as i64 {
        return Err(FieldOpError::InvalidPreset(
            "preset is too large".to_string(),
        ));
    }
    let side = side as i32;
    let parity = |y: i32| y.rem_euclid(2);
    let base_y = -(side / 3);
    let mut cells: Vec<BrickPoint> = (0..side)
        .flat_map(|row| {
            let y = base_y + row;
            // Row `row` starts half a cell further right than the one below it; the parity terms
            // turn that into the column of its first brick.
            let first = (parity(base_y) + row - parity(y)) / 2 - side / 2;
            (0..side - row).map(move |i| BrickPoint { x: first + i, y })
        })
        .collect();
    cells.sort();
    Ok(cells)
}
