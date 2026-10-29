//! The snub square tiling 3.3.4.3.4: regular squares and equilateral triangles of the same edge
//! length. Around every vertex three triangles and two squares meet, in the order triangle,
//! triangle, square, triangle, square.
//!
//! The squares come in two orientations, turned by 30° against each other; the triangles in four.
//! The translation lattice is square, spanned by `A = a·(cos(-15°), sin(-15°)) = ((2 + √3) / 2,
//! -1/2)` and `B = a·(cos 75°, sin 75°) = (1/2, (2 + √3) / 2)` with `a = (1 + √3) / √2`. Every
//! lattice cell holds two squares and four triangles (area `2 + √3`); the tiling is invariant
//! under 90° rotations about a square center.
//!
//! **Handedness.** The tiling is chiral. This module fixes one form (y up): the lattice vector `A`
//! points 15° clockwise from the x axis. Its mirror image is not offered, and since the tiling has
//! no mirror symmetry, no reflection maps a field onto itself.
//!
//! A cell id is an anchor `(q, r)` — the corner `q·A + r·B`, the first vertex of the axis-aligned
//! square — plus a [`SnubSquareKind`]: that square, the tilted square, or one of four triangles.
//! The cells of a kind anchored at neighboring points are translates of each other.

use super::exact_tiling::{Template, Tiling, Vertex, add, unit};
use super::field_ops::Inclusion;
use super::multi_shape::{
    AnchoredPoint, CellFace, PRESETS, SQRT_3, anchor_cells, expanded_box, impl_cell_kind,
    is_opposite_face, lattice_rect_cells, polygon_faces, preset_cells, regular_cell_shape,
    regular_polygon_area, regular_shapes, retain_attached,
};
use super::square::cell_range;
use super::{
    CellShape, FieldOpError, FieldOperation, Point, PresetDescriptor, PresetParams, Segment,
    ShapeDescriptor, Tessellation,
};
use std::sync::LazyLock;

/// What a cell is: one of the two squares or one of the four triangles.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum SnubSquareKind {
    /// The square with sides along the axes, its first vertex at the anchor.
    Square,
    /// The square turned by 30° against [`Square`](Self::Square), below and to the right of it.
    TiltedSquare,
    /// The triangle on the bottom side of the axis-aligned square, its apex pointing down.
    TriangleDown,
    /// The triangle on the right side of the axis-aligned square, its apex pointing right.
    TriangleRight,
    /// The triangle on the top side of the axis-aligned square, its apex pointing up.
    TriangleUp,
    /// The triangle on the left side of the axis-aligned square, its apex pointing left.
    TriangleLeft,
}

impl SnubSquareKind {
    /// Every kind, in wire order.
    pub const ALL: [SnubSquareKind; 6] = [
        Self::Square,
        Self::TiltedSquare,
        Self::TriangleDown,
        Self::TriangleRight,
        Self::TriangleUp,
        Self::TriangleLeft,
    ];

    /// Position in the wire encoding.
    pub fn index(self) -> usize {
        // The discriminants follow `ALL`.
        self as usize
    }

    /// Number of sides of the cell.
    fn face_count(self) -> usize {
        match self {
            Self::Square | Self::TiltedSquare => 4,
            _ => 3,
        }
    }
}

impl_cell_kind!(SnubSquareKind);

/// An anchor `(q, r)` and the kind of cell anchored there.
pub type SnubSquarePoint = AnchoredPoint<SnubSquareKind>;

impl SnubSquarePoint {
    pub fn is_square(self) -> bool {
        self.kind.face_count() == 4
    }

    pub fn is_triangle(self) -> bool {
        !self.is_square()
    }
}

/// A side of a cell: its position in `faces_of`, counter-clockwise from the cell's first vertex
/// (a square `0..4`, a triangle `0..3`). The first vertex differs per kind, so canonical face `0`
/// points in a different absolute direction for each kind of one shape.
pub type SnubSquareFace = CellFace;

static SHAPES: LazyLock<[ShapeDescriptor; 2]> = LazyLock::new(|| regular_shapes([4, 3]));

/// Lattice step `A` (anchor `q + 1`): `((2 + √3) / 2, -1/2)`.
const STEP_Q: Vertex = [4, 2, -2, 0];
/// Lattice step `B` (anchor `r + 1`): `(1/2, (2 + √3) / 2)`.
const STEP_R: Vertex = [2, 0, 4, 2];

/// Vertices of the kinds relative to the anchor, counter-clockwise, in kind order. With the
/// axis-aligned square `0, p1, p2, p3`: the tilted square hangs from the bottom-right corner `p1`,
/// and each triangle sits on a side of the axis-aligned square.
fn templates() -> Vec<Template> {
    let origin: Vertex = [0; 4];
    let p1 = unit(0);
    let p3 = unit(3);
    let p2 = add(p1, p3);
    let down = unit(10);
    let tilted_end = unit(11);
    [
        vec![origin, p1, p2, p3],
        vec![p1, down, add(down, tilted_end), add(p1, tilted_end)],
        vec![origin, down, p1],
        vec![p1, add(p1, unit(1)), p2],
        vec![p2, add(p3, unit(2)), p3],
        vec![p3, add(p3, unit(7)), origin],
    ]
    .iter()
    .map(|vs| Template::new(vs))
    .collect()
}

static TILING: LazyLock<Tiling> = LazyLock::new(|| Tiling::new(4, STEP_Q, STEP_R, templates()));

/// Farthest a vertex of any cell anchored at a point lies from it (below `1.94`), with a margin so a
/// cell touching the query box only at a vertex is still a candidate.
const ANCHOR_REACH: f64 = 2.0 + 1e-6;

#[derive(Debug, Default, Clone, Copy)]
pub struct SnubSquareTessellation;

const CELL_TYPES: [super::CellType; 2] = [
    super::CellType::new("triangle"),
    super::CellType::new("square"),
];
/// Side count of each of `CELL_TYPES`, in the same order.
const FACE_COUNTS: [usize; 2] = [3, 4];

impl Tessellation for SnubSquareTessellation {
    type CellId = SnubSquarePoint;
    type Face = SnubSquareFace;

    fn is_valid_cell(&self, _cell: SnubSquarePoint) -> bool {
        true
    }

    fn faces_of(&self, cell: SnubSquarePoint) -> &[SnubSquareFace] {
        polygon_faces(cell.kind.face_count())
    }

    fn neighbor(
        &self,
        cell: SnubSquarePoint,
        face: SnubSquareFace,
    ) -> Option<(SnubSquarePoint, SnubSquareFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        let link = TILING.link(cell.kind.index(), face.index());
        Some((
            SnubSquarePoint::new(
                cell.q.checked_add(link.dq)?,
                cell.r.checked_add(link.dr)?,
                SnubSquareKind::ALL[link.kind],
            ),
            SnubSquareFace::new(link.face),
        ))
    }

    /// A square is passed straight through its opposite face, whatever its orientation (faces are
    /// counter-clockwise). A triangle has no opposite face; every pass through it turns by 60°.
    fn is_straight(
        &self,
        cell: SnubSquarePoint,
        in_face: SnubSquareFace,
        out_face: SnubSquareFace,
    ) -> bool {
        cell.is_square() && is_opposite_face(4, in_face.index(), out_face.index())
    }

    /// The tiling is chiral and has no mirror symmetry, so only translation is offered.
    fn field_operations(&self) -> &[FieldOperation] {
        &[FieldOperation::Translate]
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: SnubSquarePoint) -> Option<CellShape<'_>> {
        Some(regular_cell_shape(&*SHAPES, cell.kind.face_count()))
    }

    fn cell_types(&self) -> &[super::CellType] {
        &CELL_TYPES
    }

    /// By polygon: the type follows the cell's side count.
    fn cell_type_of(&self, cell: Self::CellId) -> super::CellTypeId {
        super::multi_shape::cell_type_by_face_count(&FACE_COUNTS, self.faces_of(cell).len())
    }

    /// Centroid of the cell's polygon.
    fn translation_basis(&self) -> Option<[Point; 2]> {
        Some([
            Point::new(-1.866025403784438, 0.5),
            Point::new(0.5, 1.866025403784439),
        ])
    }

    fn center(&self, cell: SnubSquarePoint) -> Point {
        TILING.center(cell.q, cell.r, cell.kind.index())
    }

    fn face_segments(&self, cell: SnubSquarePoint, face: SnubSquareFace) -> Vec<Segment> {
        TILING.face_segments(cell.q, cell.r, cell.kind.index(), face.index())
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<SnubSquarePoint>> {
        let (lo, hi) = expanded_box(min, max, ANCHOR_REACH);
        // With `S = STEP_X` and `H = STEP_HALF` an anchor `(q, r)` sits at `x = S·q + H·r`,
        // `y = -H·q + S·r`. The lattice is orthogonal with squared step `S² + H²`, so a corner maps
        // back to `q = (S·x - H·y) / (S² + H²)`; for a fixed `q` the box then bounds `r` through
        // `x` (÷ H) and through `y` (÷ S).
        let corners = [(lo.x, lo.y), (lo.x, hi.y), (hi.x, lo.y), (hi.x, hi.y)];
        let q_of = |(x, y): (f64, f64)| (STEP_X * x - STEP_HALF * y) / STEP_SQUARED;
        let (q_min, q_max) = corners
            .iter()
            .map(|&c| q_of(c))
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| {
                (lo.min(q), hi.max(q))
            });
        anchor_cells(
            cell_range(q_min, q_max),
            |q| {
                let q = q as f64;
                let by_x = (
                    (lo.x - STEP_X * q) / STEP_HALF,
                    (hi.x - STEP_X * q) / STEP_HALF,
                );
                let by_y = (
                    (lo.y + STEP_HALF * q) / STEP_X,
                    (hi.y + STEP_HALF * q) / STEP_X,
                );
                cell_range(by_x.0.max(by_y.0), by_x.1.min(by_y.1))
            },
            SnubSquareKind::ALL.len(),
            limit,
            |q, r, kind| SnubSquarePoint::new(q, r, SnubSquareKind::ALL[kind]),
        )
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<SnubSquarePoint>, FieldOpError> {
        let origin = self.center(SnubSquarePoint::new(0, 0, SnubSquareKind::Square));
        // `cols × rows` lattice pitches, centered on the origin square.
        let mut cells = preset_cells(self, key, params, origin, Inclusion::Center, || {
            lattice_rect_cells(self, params, origin, Point::new(PITCH, PITCH))
        })?;
        retain_attached(self, &mut cells, |c| c.is_square())?;
        cells.sort();
        Ok(cells)
    }

    fn area(&self, cell: SnubSquarePoint) -> f64 {
        regular_polygon_area(cell.kind.face_count())
    }
}

/// `x` of lattice step `A` and `y` of step `B`, `(2 + √3) / 2`.
const STEP_X: f64 = (2.0 + SQRT_3) / 2.0;

/// `y` of lattice step `B` and `-y` of step `A`.
const STEP_HALF: f64 = 0.5;

/// Squared length of a lattice step, `2 + √3`.
const STEP_SQUARED: f64 = STEP_X * STEP_X + STEP_HALF * STEP_HALF;

/// Length of a lattice step, `(1 + √3) / √2`.
const PITCH: f64 = 1.931_851_652_578_136_6;
