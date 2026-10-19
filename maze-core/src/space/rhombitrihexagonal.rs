//! The rhombitrihexagonal tiling 3.4.6.4: regular hexagons, squares and equilateral triangles of
//! the same edge length. Around every vertex a triangle, a square, a hexagon and a square meet in
//! that order.
//!
//! Hexagon centers form a triangular lattice with spacing `1 + √3` (the hexagons are joined by
//! squares), spanned by `A = (1 + √3)·(cos 30°, sin 30°)` and `B = (1 + √3)·(0, 1)`. A hexagon's
//! vertices lie at angles `60°·k` at distance 1 from its center, so its faces point at `30° + 60°·k`.
//! The tiling has the full `p6m` symmetry: 60° rotations and reflections about a hexagon center,
//! and the two lattice translations.
//!
//! A cell id is a hexagon `(q, r)` — the center `q·A + r·B` — plus a
//! [`RhombitrihexagonalKind`]: the hexagon itself, one of three squares, or one of two triangles.
//! `Square k` is the square across face `k` (`k = 0, 1, 2`, normals `30°`, `90°`, `150°`) of the
//! anchor hexagon; the squares across faces `3, 4, 5` are the squares `0, 1, 2` of the neighboring
//! hexagons. The squares therefore come in three orientations, 60° apart. `TriangleA` and
//! `TriangleB` are the triangles touching the anchor at its vertices `0` and `1`; the triangles at
//! vertices `2, 4` and `3, 5` are translates of these two.

use super::exact_tiling::{Template, Tiling, Vertex, add};
use super::field_ops::Inclusion;
use super::multi_shape::{
    AnchoredPoint, CellFace, PRESETS, SQRT_3, anchor_cells, expanded_box, impl_cell_kind,
    is_opposite_face, lattice_rect_cells, polygon_faces, preset_cells, regular_cell_shape,
    regular_polygon_area, regular_shapes,
};
use super::square::cell_range;
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    Tessellation,
};
use std::sync::LazyLock;

/// What a cell is: the hexagon, one of the three squares, or one of the two triangles.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum RhombitrihexagonalKind {
    Hexagon,
    /// The square across face 0 of the anchor hexagon (normal at `30°`).
    Square0,
    /// The square across face 1 of the anchor hexagon (normal at `90°`).
    Square1,
    /// The square across face 2 of the anchor hexagon (normal at `150°`).
    Square2,
    /// The triangle at vertex 0 of the anchor hexagon.
    TriangleA,
    /// The triangle at vertex 1 of the anchor hexagon.
    TriangleB,
}

impl RhombitrihexagonalKind {
    /// Every kind, in wire order.
    pub const ALL: [RhombitrihexagonalKind; 6] = [
        Self::Hexagon,
        Self::Square0,
        Self::Square1,
        Self::Square2,
        Self::TriangleA,
        Self::TriangleB,
    ];

    /// Position in the wire encoding.
    pub fn index(self) -> usize {
        // The discriminants follow `ALL`.
        self as usize
    }

    /// Number of sides of the cell: 6 for the hexagon, 4 for a square, 3 for a triangle.
    fn face_count(self) -> usize {
        match self {
            Self::Hexagon => 6,
            Self::Square0 | Self::Square1 | Self::Square2 => 4,
            Self::TriangleA | Self::TriangleB => 3,
        }
    }
}

impl_cell_kind!(RhombitrihexagonalKind);

/// A hexagon `(q, r)` and the kind of cell anchored at it.
pub type RhombitrihexagonalPoint = AnchoredPoint<RhombitrihexagonalKind>;

impl RhombitrihexagonalPoint {
    pub const fn hexagon(q: i32, r: i32) -> Self {
        Self::new(q, r, RhombitrihexagonalKind::Hexagon)
    }

    pub fn is_hexagon(self) -> bool {
        self.kind == RhombitrihexagonalKind::Hexagon
    }

    pub fn is_square(self) -> bool {
        matches!(
            self.kind,
            RhombitrihexagonalKind::Square0
                | RhombitrihexagonalKind::Square1
                | RhombitrihexagonalKind::Square2
        )
    }
}

/// A side of a cell: its position in `faces_of`, counter-clockwise from the cell's first vertex.
/// A hexagon has faces `0..6` (face `k` runs from hexagon vertex `k`, at angle `60°·k` around the
/// center, to vertex `k + 1`), a square `0..4` and a triangle `0..3`. A square's face `0` is the
/// one shared with its anchor hexagon; a triangle's face `0` is the one shared with the square
/// across the anchor's face `j - 1`, where `j` is the anchor vertex the triangle touches.
pub type RhombitrihexagonalFace = CellFace;

static SHAPES: LazyLock<[ShapeDescriptor; 3]> = LazyLock::new(|| regular_shapes([6, 4, 3]));

/// Unit vector `(cos 60°·k, sin 60°·k)`: hexagon vertex `k` relative to its center.
const HEXAGON_VERTICES: [Vertex; 6] = [
    [2, 0, 0, 0],
    [1, 0, 0, 1],
    [-1, 0, 0, 1],
    [-2, 0, 0, 0],
    [-1, 0, 0, -1],
    [1, 0, 0, -1],
];

/// Unit vector `(cos(30° + 60°·k), sin(30° + 60°·k))`: the outward normal of hexagon face `k`.
const NORMALS: [Vertex; 6] = [
    [0, 1, 1, 0],
    [0, 0, 2, 0],
    [0, -1, 1, 0],
    [0, -1, -1, 0],
    [0, 0, -2, 0],
    [0, 1, -1, 0],
];

/// Lattice step `A` (hexagon `q + 1`): `(1 + √3)·(cos 30°, sin 30°)`.
const STEP_Q: Vertex = [3, 1, 1, 1];
/// Lattice step `B` (hexagon `r + 1`): `(1 + √3)·(0, 1)`.
const STEP_R: Vertex = [0, 0, 2, 2];

/// Vertices of the cell kinds relative to their anchor hexagon center, counter-clockwise, in kind
/// order. A square across face `k` starts with that face's endpoints reversed; a triangle at
/// hexagon vertex `j` is `v_j, v_j + n_{j-1}, v_j + n_j`.
fn templates() -> Vec<Template> {
    let square = |k: usize| {
        let (a, b) = (HEXAGON_VERTICES[k], HEXAGON_VERTICES[(k + 1) % 6]);
        Template::new(&[b, a, add(a, NORMALS[k]), add(b, NORMALS[k])])
    };
    let triangle = |j: usize| {
        let v = HEXAGON_VERTICES[j];
        Template::new(&[v, add(v, NORMALS[(j + 5) % 6]), add(v, NORMALS[j])])
    };
    vec![
        Template::new(&HEXAGON_VERTICES),
        square(0),
        square(1),
        square(2),
        triangle(0),
        triangle(1),
    ]
}

static TILING: LazyLock<Tiling> = LazyLock::new(|| Tiling::new(2, STEP_Q, STEP_R, templates()));

/// Farthest a vertex of any cell anchored at a hexagon lies from that hexagon's center
/// (`√(2 + √3) ≈ 1.93`), with a margin so a cell touching the query box only at a vertex is still
/// a candidate.
const ANCHOR_REACH: f64 = 2.0 + 1e-6;

#[derive(Debug, Default, Clone, Copy)]
pub struct RhombitrihexagonalTessellation;

impl Tessellation for RhombitrihexagonalTessellation {
    type CellId = RhombitrihexagonalPoint;
    type Face = RhombitrihexagonalFace;

    fn is_valid_cell(&self, _cell: RhombitrihexagonalPoint) -> bool {
        true
    }

    fn faces_of(&self, cell: RhombitrihexagonalPoint) -> &[RhombitrihexagonalFace] {
        polygon_faces(cell.kind.face_count())
    }

    fn neighbor(
        &self,
        cell: RhombitrihexagonalPoint,
        face: RhombitrihexagonalFace,
    ) -> Option<(RhombitrihexagonalPoint, RhombitrihexagonalFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        let link = TILING.link(cell.kind.index(), face.index());
        Some((
            RhombitrihexagonalPoint::new(
                cell.q.checked_add(link.dq)?,
                cell.r.checked_add(link.dr)?,
                RhombitrihexagonalKind::ALL[link.kind],
            ),
            RhombitrihexagonalFace::new(link.face),
        ))
    }

    /// A hexagon is passed straight through its opposite face, a square through its opposite
    /// face; a triangle has no opposite face and every pass through it turns by 60°.
    fn is_straight(
        &self,
        cell: RhombitrihexagonalPoint,
        in_face: RhombitrihexagonalFace,
        out_face: RhombitrihexagonalFace,
    ) -> bool {
        let count = cell.kind.face_count();
        count != 3 && is_opposite_face(count, in_face.index(), out_face.index())
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: RhombitrihexagonalPoint) -> Option<CellShape<'_>> {
        Some(regular_cell_shape(&*SHAPES, cell.kind.face_count()))
    }

    /// Centroid of the cell's polygon.
    fn center(&self, cell: RhombitrihexagonalPoint) -> Point {
        TILING.center(cell.q, cell.r, cell.kind.index())
    }

    fn face_segments(
        &self,
        cell: RhombitrihexagonalPoint,
        face: RhombitrihexagonalFace,
    ) -> Vec<Segment> {
        TILING.face_segments(cell.q, cell.r, cell.kind.index(), face.index())
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<RhombitrihexagonalPoint>> {
        let (lo, hi) = expanded_box(min, max, ANCHOR_REACH);
        // A hexagon center `(q, r)` sits at `x = q·(3 + √3)/2`, `y = q·(1 + √3)/2 + r·(1 + √3)`:
        // `x` fixes `q` alone, then `y` bounds `r`.
        anchor_cells(
            cell_range(lo.x / STEP_X, hi.x / STEP_X),
            |q| {
                let shift = q as f64 * PITCH / 2.0;
                cell_range((lo.y - shift) / PITCH, (hi.y - shift) / PITCH)
            },
            RhombitrihexagonalKind::ALL.len(),
            limit,
            |q, r, kind| RhombitrihexagonalPoint::new(q, r, RhombitrihexagonalKind::ALL[kind]),
        )
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<RhombitrihexagonalPoint>, FieldOpError> {
        let origin = self.center(RhombitrihexagonalPoint::hexagon(0, 0));
        // `cols × rows` hexagon pitches, centered on the origin hexagon.
        let mut cells = preset_cells(self, key, params, origin, Inclusion::WholeCell, || {
            lattice_rect_cells(self, params, origin, Point::new(PITCH, PITCH))
        })?;
        cells.sort();
        Ok(cells)
    }

    fn area(&self, cell: RhombitrihexagonalPoint) -> f64 {
        regular_polygon_area(cell.kind.face_count())
    }
}

/// Center distance of neighboring hexagons, `1 + √3`.
const PITCH: f64 = 1.0 + SQRT_3;

/// World `x` distance of hexagon `q` and `q + 1`, `(3 + √3) / 2`.
const STEP_X: f64 = (3.0 + SQRT_3) / 2.0;
