//! The truncated square tiling 4.8.8: regular octagons and squares turned by 45°.
//!
//! Cells are integer points `(x, y)` on a lattice of half the octagon pitch: an octagon sits where
//! both coordinates are even, a square where both are odd; a point of mixed parity is not a tile.
//! Every octagon has 8 neighbors (4 octagons through the axis-aligned faces, 4 squares through the
//! diagonal faces); every square has 4 neighbors, all octagons.

use super::field_ops::{
    CIRCLE_PRESET, Inclusion, RECT_PRESET, TRIANGLE_PRESET, circle_cells, param, triangle_cells,
};
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    Tessellation, validate_preset,
};
use std::sync::LazyLock;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct SquareOctagonPoint {
    pub x: i32,
    pub y: i32,
}

impl SquareOctagonPoint {
    pub fn is_octagon(self) -> bool {
        self.x.rem_euclid(2) == 0 && self.y.rem_euclid(2) == 0
    }

    pub fn is_square(self) -> bool {
        self.x.rem_euclid(2) == 1 && self.y.rem_euclid(2) == 1
    }

    /// The cell one `face` step away, or `None` when `self` is not a tile, the result would not be
    /// one (a square has no cardinal faces) or a coordinate overflows `i32`.
    pub fn step(self, face: SquareOctagonFace) -> Option<Self> {
        let (dx, dy) = face.offset();
        let reach = match (self.is_octagon(), self.is_square(), face.is_diagonal()) {
            (true, _, true) | (_, true, true) => 1,
            (true, _, false) => 2,
            _ => return None,
        };
        Some(Self {
            x: self.x.checked_add(dx * reach)?,
            y: self.y.checked_add(dy * reach)?,
        })
    }
}

/// A side of a cell, named by the direction it faces. An octagon has all eight; a square only the
/// four diagonal ones.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum SquareOctagonFace {
    E,
    NE,
    N,
    NW,
    W,
    SW,
    S,
    SE,
}

impl SquareOctagonFace {
    const ALL: [Self; 8] = [
        Self::E,
        Self::NE,
        Self::N,
        Self::NW,
        Self::W,
        Self::SW,
        Self::S,
        Self::SE,
    ];

    pub fn is_diagonal(self) -> bool {
        matches!(self, Self::NE | Self::NW | Self::SW | Self::SE)
    }

    /// The face on the other side of the same edge — also the face a straight pass leaves by.
    pub fn opposite(self) -> Self {
        Self::ALL[(self.index() + 4) % 8]
    }

    /// Position in the canonical counter-clockwise order of an octagon's faces, from `E`.
    fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|&face| face == self)
            .expect("ALL lists every face")
    }

    fn offset(self) -> (i32, i32) {
        match self {
            Self::E => (1, 0),
            Self::NE => (1, 1),
            Self::N => (0, 1),
            Self::NW => (-1, 1),
            Self::W => (-1, 0),
            Self::SW => (-1, -1),
            Self::S => (0, -1),
            Self::SE => (1, -1),
        }
    }
}

use SquareOctagonFace::{E, N, NE, NW, S, SE, SW, W};

const OCTAGON_FACES: [SquareOctagonFace; 8] = [E, NE, N, NW, W, SW, S, SE];
const SQUARE_FACES: [SquareOctagonFace; 4] = [NE, NW, SW, SE];

/// `faces_of` is already the canonical counter-clockwise order for both templates.
const OCTAGON_LOCAL_TO_CANONICAL: [usize; 8] = [0, 1, 2, 3, 4, 5, 6, 7];
const SQUARE_LOCAL_TO_CANONICAL: [usize; 4] = [0, 1, 2, 3];

const OCTAGON_SHAPE: usize = 0;
const SQUARE_SHAPE: usize = 1;

static SHAPES: LazyLock<[ShapeDescriptor; 2]> = LazyLock::new(|| {
    [
        ShapeDescriptor::regular_polygon(8),
        ShapeDescriptor::regular_polygon(4),
    ]
});

#[derive(Debug, Default, Clone, Copy)]
pub struct SquareOctagonTessellation;

impl Tessellation for SquareOctagonTessellation {
    type CellId = SquareOctagonPoint;
    type Face = SquareOctagonFace;

    fn is_valid_cell(&self, cell: SquareOctagonPoint) -> bool {
        cell.is_octagon() || cell.is_square()
    }

    fn faces_of(&self, cell: SquareOctagonPoint) -> &[SquareOctagonFace] {
        debug_assert!(self.is_valid_cell(cell));
        if cell.is_octagon() {
            &OCTAGON_FACES
        } else {
            &SQUARE_FACES
        }
    }

    fn neighbor(
        &self,
        cell: SquareOctagonPoint,
        face: SquareOctagonFace,
    ) -> Option<(SquareOctagonPoint, SquareOctagonFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        Some((cell.step(face)?, face.opposite()))
    }

    fn is_straight(
        &self,
        cell: SquareOctagonPoint,
        in_face: SquareOctagonFace,
        out_face: SquareOctagonFace,
    ) -> bool {
        debug_assert!(self.faces_of(cell).contains(&in_face));
        debug_assert!(self.faces_of(cell).contains(&out_face));
        out_face == in_face.opposite()
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: SquareOctagonPoint) -> Option<CellShape<'_>> {
        debug_assert!(self.is_valid_cell(cell));
        Some(if cell.is_octagon() {
            CellShape::full(&SHAPES[OCTAGON_SHAPE], &OCTAGON_LOCAL_TO_CANONICAL)
        } else {
            CellShape::full(&SHAPES[SQUARE_SHAPE], &SQUARE_LOCAL_TO_CANONICAL)
        })
    }

    fn center(&self, cell: SquareOctagonPoint) -> Point {
        Point::new(
            lattice(cell.x as i64, cell.x as i64),
            lattice(cell.y as i64, cell.y as i64),
        )
    }

    fn face_segments(&self, cell: SquareOctagonPoint, face: SquareOctagonFace) -> Vec<Segment> {
        let (from, to) = if cell.is_octagon() {
            let k = face.index();
            (octagon_vertex(cell, k), octagon_vertex(cell, (k + 1) % 8))
        } else {
            // Face `NE, NW, SW, SE` runs between the diamond vertices `E, N, W, S`.
            let k = face.index() / 2;
            (square_vertex(cell, k), square_vertex(cell, (k + 1) % 4))
        };
        vec![Segment::line(from, to)]
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<SquareOctagonPoint>> {
        let half_pitch = (1.0 + std::f64::consts::SQRT_2) / 2.0;
        // A cell's boundary lies within one half pitch of its center.
        let range = |lo: f64, hi: f64| {
            let (lo, hi) = (lo.min(hi), lo.max(hi));
            super::square::cell_range(lo / half_pitch - 1.0, hi / half_pitch + 1.0)
        };
        let xs = range(min.x, max.x);
        let ys = range(min.y, max.y);
        let (even_x, odd_x) = parity_counts(&xs);
        let (even_y, odd_y) = parity_counts(&ys);
        let count = even_x * even_y + odd_x * odd_y;
        if count > i64::try_from(limit).unwrap_or(i64::MAX) {
            return None;
        }
        Some(
            ys.flat_map(|y| xs.clone().map(move |x| SquareOctagonPoint { x, y }))
                .filter(|&cell| self.is_valid_cell(cell))
                .collect(),
        )
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<SquareOctagonPoint>, FieldOpError> {
        validate_preset(&PRESETS, key, params)?;
        let origin = self.center(SquareOctagonPoint { x: 0, y: 0 });
        match key {
            "rect" => Ok(centered_rect(
                param(params, "cols") as i32,
                param(params, "rows") as i32,
            )),
            "circle" => circle_cells(self, origin, param(params, "radius"), Inclusion::Center),
            "triangle" => triangle_cells(self, origin, param(params, "side"), Inclusion::Center),
            _ => Err(FieldOpError::Unavailable),
        }
    }

    fn area(&self, cell: SquareOctagonPoint) -> f64 {
        // Side length 1: an octagon is `2 (1 + √2)`, a square 1.
        if cell.is_octagon() {
            2.0 * (1.0 + std::f64::consts::SQRT_2)
        } else {
            1.0
        }
    }
}

/// `(m + n·√2) / 2`. With side length 1 every vertex coordinate has this form with integer `m`
/// and `n`, so a vertex shared by several cells gets identical coordinates from each of them.
fn lattice(m: i64, n: i64) -> f64 {
    (m as f64 + n as f64 * std::f64::consts::SQRT_2) / 2.0
}

fn vertex(cell: SquareOctagonPoint, dx: (i64, i64), dy: (i64, i64)) -> Point {
    Point::new(
        lattice(cell.x as i64 + dx.0, cell.x as i64 + dx.1),
        lattice(cell.y as i64 + dy.0, cell.y as i64 + dy.1),
    )
}

/// Vertex `k` of an octagon, counter-clockwise from the start of its `E` face. Offsets from the
/// center are `±1/2` (`(±1, 0)` in `lattice` units) and `±P/2` with pitch `P = 1 + √2`
/// (`(±1, ±1)`).
fn octagon_vertex(cell: SquareOctagonPoint, k: usize) -> Point {
    const FAR: (i64, i64) = (1, 1);
    const NEAR: (i64, i64) = (1, 0);
    const NEG_FAR: (i64, i64) = (-1, -1);
    const NEG_NEAR: (i64, i64) = (-1, 0);
    const OFFSETS: [((i64, i64), (i64, i64)); 8] = [
        (FAR, NEG_NEAR),
        (FAR, NEAR),
        (NEAR, FAR),
        (NEG_NEAR, FAR),
        (NEG_FAR, NEAR),
        (NEG_FAR, NEG_NEAR),
        (NEG_NEAR, NEG_FAR),
        (NEAR, NEG_FAR),
    ];
    let (dx, dy) = OFFSETS[k];
    vertex(cell, dx, dy)
}

/// Vertex `k` of a square, counter-clockwise from the east one; half the diagonal is `√2 / 2`
/// (`(0, ±1)` in `lattice` units).
fn square_vertex(cell: SquareOctagonPoint, k: usize) -> Point {
    const OFFSETS: [((i64, i64), (i64, i64)); 4] = [
        ((0, 1), (0, 0)),
        ((0, 0), (0, 1)),
        ((0, -1), (0, 0)),
        ((0, 0), (0, -1)),
    ];
    let (dx, dy) = OFFSETS[k];
    vertex(cell, dx, dy)
}

/// Counts of even and odd integers in `range`.
fn parity_counts(range: &std::ops::RangeInclusive<i32>) -> (i64, i64) {
    let (lo, hi) = (*range.start() as i64, *range.end() as i64);
    if hi < lo {
        return (0, 0);
    }
    let evens = hi.div_euclid(2) - (lo - 1).div_euclid(2);
    (evens, hi - lo + 1 - evens)
}

/// Preset field shapes of the 4.8.8 tiling, in UI order.
const PRESETS: [PresetDescriptor; 3] = [RECT_PRESET, CIRCLE_PRESET, TRIANGLE_PRESET];

/// `cols × rows` octagons with the squares between them (the origin octagon at `size / 2`,
/// rounded down, of each axis).
fn centered_rect(cols: i32, rows: i32) -> Vec<SquareOctagonPoint> {
    let (ox, oy) = (cols / 2, rows / 2);
    let mut cells: Vec<SquareOctagonPoint> = (0..rows)
        .flat_map(|row| (0..cols).map(move |col| (col, row)))
        .flat_map(|(col, row)| {
            let (x, y) = (2 * (col - ox), 2 * (row - oy));
            let octagon = SquareOctagonPoint { x, y };
            let square = (col + 1 < cols && row + 1 < rows)
                .then_some(SquareOctagonPoint { x: x + 1, y: y + 1 });
            std::iter::once(octagon).chain(square)
        })
        .collect();
    cells.sort();
    cells
}
