//! The trihexagonal (kagome) tiling 3.6.3.6: regular hexagons and equilateral triangles of the same
//! edge length, alternating around every vertex.
//!
//! Hexagons sit on a triangular lattice with axial coordinates `(q, r)` (center-to-center distance
//! 2, so neighbors touch at a vertex). Each lattice triangle holds one kagome triangle: its medial
//! triangle. A cell id is that lattice anchor plus a [`TrihexagonalKind`]; the anchor of a triangle
//! is the lower-left hexagon of the lattice triangle it sits in. Every hexagon has six triangle
//! neighbors, every triangle three hexagon neighbors.

use super::field_ops::{Inclusion, param};
use super::multi_shape::{
    AnchoredPoint, PRESETS, SQRT_3, anchor_cells, expanded_box, impl_cell_kind, preset_cells,
    regular_cell_shape, regular_polygon_area, regular_shapes,
};
use super::square::cell_range;
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    Tessellation,
};
use std::collections::HashSet;
use std::sync::LazyLock;

/// What a cell is: a hexagon, or a triangle pointing up or down.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum TrihexagonalKind {
    Hexagon,
    /// Apex up; sits between hexagons `(q+1, r)`, `(q, r+1)` and `(q+1, r+1)`.
    Up,
    /// Apex down; sits between hexagons `(q, r)`, `(q+1, r)` and `(q, r+1)`.
    Down,
}

impl TrihexagonalKind {
    /// Every kind, in wire order.
    pub const ALL: [TrihexagonalKind; 3] = [Self::Hexagon, Self::Up, Self::Down];

    /// Position in the wire encoding (hexagon 0, up 1, down 2).
    pub fn index(self) -> usize {
        // The discriminants follow `ALL`.
        self as usize
    }
}

impl_cell_kind!(TrihexagonalKind);

/// A hexagon `(q, r)` and the kind of cell anchored at it.
pub type TrihexagonalPoint = AnchoredPoint<TrihexagonalKind>;

impl TrihexagonalPoint {
    pub const fn hexagon(q: i32, r: i32) -> Self {
        Self::new(q, r, TrihexagonalKind::Hexagon)
    }

    pub const fn up(q: i32, r: i32) -> Self {
        Self::new(q, r, TrihexagonalKind::Up)
    }

    pub const fn down(q: i32, r: i32) -> Self {
        Self::new(q, r, TrihexagonalKind::Down)
    }

    pub fn is_hexagon(self) -> bool {
        self.kind == TrihexagonalKind::Hexagon
    }

    /// The cell one `face` step away, or `None` when `face` is not a side of `self` or a
    /// coordinate overflows `i32`.
    pub fn step(self, face: TrihexagonalFace) -> Option<Self> {
        use TrihexagonalFace::{N, NE, NW, S, SE, SW};
        let (dq, dr, kind) = match (self.kind, face) {
            (TrihexagonalKind::Hexagon, NE) => (0, 0, TrihexagonalKind::Down),
            (TrihexagonalKind::Hexagon, N) => (-1, 0, TrihexagonalKind::Up),
            (TrihexagonalKind::Hexagon, NW) => (-1, 0, TrihexagonalKind::Down),
            (TrihexagonalKind::Hexagon, SW) => (-1, -1, TrihexagonalKind::Up),
            (TrihexagonalKind::Hexagon, S) => (0, -1, TrihexagonalKind::Down),
            (TrihexagonalKind::Hexagon, SE) => (0, -1, TrihexagonalKind::Up),
            (TrihexagonalKind::Down, N) => (0, 1, TrihexagonalKind::Hexagon),
            (TrihexagonalKind::Down, SW) => (0, 0, TrihexagonalKind::Hexagon),
            (TrihexagonalKind::Down, SE) => (1, 0, TrihexagonalKind::Hexagon),
            (TrihexagonalKind::Up, NE) => (1, 1, TrihexagonalKind::Hexagon),
            (TrihexagonalKind::Up, NW) => (0, 1, TrihexagonalKind::Hexagon),
            (TrihexagonalKind::Up, S) => (1, 0, TrihexagonalKind::Hexagon),
            _ => return None,
        };
        Some(Self::new(
            self.q.checked_add(dq)?,
            self.r.checked_add(dr)?,
            kind,
        ))
    }
}

/// A side of a cell, named by the direction it faces. A hexagon has all six; an up triangle `NE`,
/// `NW`, `S`; a down triangle `N`, `SW`, `SE`.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum TrihexagonalFace {
    NE,
    N,
    NW,
    SW,
    S,
    SE,
}

impl TrihexagonalFace {
    /// The face on the other side of the same edge: neighbors always meet across opposite
    /// directions.
    pub fn opposite(self) -> Self {
        match self {
            Self::NE => Self::SW,
            Self::N => Self::S,
            Self::NW => Self::SE,
            Self::SW => Self::NE,
            Self::S => Self::N,
            Self::SE => Self::NW,
        }
    }
}

use TrihexagonalFace::{N, NE, NW, S, SE, SW};

/// Counter-clockwise; face `k` runs from hexagon vertex `k` to `k + 1`.
const HEXAGON_FACES: [TrihexagonalFace; 6] = [NE, N, NW, SW, S, SE];
const UP_FACES: [TrihexagonalFace; 3] = [NE, NW, S];
const DOWN_FACES: [TrihexagonalFace; 3] = [N, SW, SE];

static SHAPES: LazyLock<[ShapeDescriptor; 2]> = LazyLock::new(|| regular_shapes([6, 3]));

#[derive(Debug, Default, Clone, Copy)]
pub struct TrihexagonalTessellation;

const CELL_TYPES: [super::CellType; 2] = [
    super::CellType::new("triangle"),
    super::CellType::new("hexagon"),
];
/// Side count of each of `CELL_TYPES`, in the same order.
const FACE_COUNTS: [usize; 2] = [3, 6];

impl Tessellation for TrihexagonalTessellation {
    type CellId = TrihexagonalPoint;
    type Face = TrihexagonalFace;

    fn is_valid_cell(&self, _cell: TrihexagonalPoint) -> bool {
        true
    }

    fn faces_of(&self, cell: TrihexagonalPoint) -> &[TrihexagonalFace] {
        match cell.kind {
            TrihexagonalKind::Hexagon => &HEXAGON_FACES,
            TrihexagonalKind::Up => &UP_FACES,
            TrihexagonalKind::Down => &DOWN_FACES,
        }
    }

    fn neighbor(
        &self,
        cell: TrihexagonalPoint,
        face: TrihexagonalFace,
    ) -> Option<(TrihexagonalPoint, TrihexagonalFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        Some((cell.step(face)?, face.opposite()))
    }

    /// A hexagon is passed straight through its opposite face; a triangle has no opposite face and
    /// every pass through it turns by 60°.
    fn is_straight(
        &self,
        cell: TrihexagonalPoint,
        in_face: TrihexagonalFace,
        out_face: TrihexagonalFace,
    ) -> bool {
        cell.is_hexagon() && out_face == in_face.opposite()
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: TrihexagonalPoint) -> Option<CellShape<'_>> {
        Some(regular_cell_shape(&*SHAPES, self.faces_of(cell).len()))
    }

    fn cell_types(&self) -> &[super::CellType] {
        &CELL_TYPES
    }

    /// By polygon: the type follows the cell's side count.
    fn cell_type_of(&self, cell: Self::CellId) -> super::CellTypeId {
        super::multi_shape::cell_type_by_face_count(&FACE_COUNTS, self.faces_of(cell).len())
    }

    /// Centroid of the cell's polygon.
    fn center(&self, cell: TrihexagonalPoint) -> Point {
        let offsets = vertex_offsets(cell.kind);
        let (i, j) = offsets
            .iter()
            .fold((0, 0), |(i, j), &(vi, vj)| (i + vi, j + vj));
        let n = offsets.len() as f64;
        let (ci, cj) = lattice_center(cell);
        let (x_unit, y_unit) = units();
        Point::new(
            x_unit * (ci as f64 + i as f64 / n),
            y_unit * (cj as f64 + j as f64 / n),
        )
    }

    fn face_segments(&self, cell: TrihexagonalPoint, face: TrihexagonalFace) -> Vec<Segment> {
        let offsets = vertex_offsets(cell.kind);
        let k = self
            .faces_of(cell)
            .iter()
            .position(|&f| f == face)
            .expect("face belongs to the cell");
        vec![Segment::line(
            vertex(cell, k),
            vertex(cell, (k + 1) % offsets.len()),
        )]
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<TrihexagonalPoint>> {
        let (lo, hi) = expanded_box(min, max, 0.0);
        let row_height = SQRT_3;
        // A cell's lattice anchor is the hexagon `(q, r)` at `x = 2q + r`, `y = r·√3`; the cell
        // spans at most `[-1, 3]` in x and `[-√3/2, √3]` in y around it.
        let rs = cell_range(lo.y / row_height - 1.0, hi.y / row_height + 0.5);
        anchor_cells(
            rs,
            |r| cell_range((lo.x - 3.0 - r as f64) / 2.0, (hi.x + 1.0 - r as f64) / 2.0),
            TrihexagonalKind::ALL.len(),
            limit,
            |r, q, kind| TrihexagonalPoint::new(q, r, TrihexagonalKind::ALL[kind]),
        )
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<TrihexagonalPoint>, FieldOpError> {
        let origin = self.center(TrihexagonalPoint::hexagon(0, 0));
        let mut cells = preset_cells(self, key, params, origin, Inclusion::WholeCell, || {
            Ok(centered_rect(
                param(params, "cols") as i32,
                param(params, "rows") as i32,
            ))
        })?;
        cells.sort();
        Ok(cells)
    }

    fn area(&self, cell: TrihexagonalPoint) -> f64 {
        regular_polygon_area(self.faces_of(cell).len())
    }
}

/// World units of the vertex lattice for side length 1: `x = i / 2`, `y = j·√3 / 2`. Every vertex
/// sits on integer `(i, j)`, so a vertex shared by several cells gets identical coordinates from
/// each of them.
fn units() -> (f64, f64) {
    (0.5, SQRT_3 / 2.0)
}

/// Lattice coordinates of the hexagon center `(q, r)`, which anchors every cell at that `(q, r)`.
fn lattice_center(cell: TrihexagonalPoint) -> (i64, i64) {
    (4 * cell.q as i64 + 2 * cell.r as i64, 2 * cell.r as i64)
}

/// Offsets from the anchor hexagon center to the cell's vertices, counter-clockwise (face `k` runs
/// from vertex `k` to `k + 1`). A lattice triangle's vertices are the midpoints between its
/// hexagon centers.
fn vertex_offsets(kind: TrihexagonalKind) -> &'static [(i64, i64)] {
    match kind {
        // Vertices at 0°, 60°, ..., 300°.
        TrihexagonalKind::Hexagon => &[(2, 0), (1, 1), (-1, 1), (-2, 0), (-1, -1), (1, -1)],
        // Lower-right, top, lower-left.
        TrihexagonalKind::Up => &[(5, 1), (4, 2), (3, 1)],
        // Upper-right, upper-left, bottom.
        TrihexagonalKind::Down => &[(3, 1), (1, 1), (2, 0)],
    }
}

fn vertex(cell: TrihexagonalPoint, k: usize) -> Point {
    let (ci, cj) = lattice_center(cell);
    let (di, dj) = vertex_offsets(cell.kind)[k];
    let (x_unit, y_unit) = units();
    Point::new(x_unit * (ci + di) as f64, y_unit * (cj + dj) as f64)
}

/// `cols × rows` hexagons in screen-aligned rows (every row shifted by half a hexagon pitch
/// relative to its neighbor) plus every triangle whose three hexagons are all in the set. The
/// origin hexagon sits at `size / 2`, rounded down, of each axis.
fn centered_rect(cols: i32, rows: i32) -> Vec<TrihexagonalPoint> {
    let (ox, oy) = (cols / 2, rows / 2);
    let hexagons: Vec<TrihexagonalPoint> = (0..rows)
        .flat_map(|row| {
            let r = row - oy;
            (0..cols).map(move |col| TrihexagonalPoint::hexagon(col - ox - r.div_euclid(2), r))
        })
        .collect();
    let members: HashSet<TrihexagonalPoint> = hexagons.iter().copied().collect();
    let has = |q: i32, r: i32| members.contains(&TrihexagonalPoint::hexagon(q, r));
    let triangles = hexagons.iter().flat_map(|&h| {
        let (q, r) = (h.q, h.r);
        // `h` is the anchor of a down triangle and the upper-left hexagon of an up triangle.
        let down = (has(q + 1, r) && has(q, r + 1)).then_some(TrihexagonalPoint::down(q, r));
        let up = (has(q + 1, r - 1) && has(q + 1, r)).then_some(TrihexagonalPoint::up(q, r - 1));
        down.into_iter().chain(up)
    });
    let mut cells: Vec<TrihexagonalPoint> = hexagons.iter().copied().chain(triangles).collect();
    cells.sort();
    cells.dedup();
    cells
}
