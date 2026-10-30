//! The truncated hexagonal tiling 3.12.12: regular dodecagons and equilateral triangles of the
//! same edge length. Around every vertex a triangle and two dodecagons meet.
//!
//! Dodecagon centers form a triangular lattice with spacing `2 + √3` (the apothem of a unit-edge
//! dodecagon is `(2 + √3) / 2`), spanned by `A = (2 + √3)·(1, 0)` and `B = (2 + √3)·(cos 60°,
//! sin 60°)`. A dodecagon's face `f` has its outward normal at `30°·f`: even faces are shared with
//! neighboring dodecagons, odd faces with triangles. The tiling has the full `p6m` symmetry.
//!
//! A cell id is a dodecagon `(q, r)` — the center `q·A + r·B` — plus a
//! [`TruncatedHexagonalKind`]: the dodecagon itself or one of two triangles. Triangles come in two
//! orientations. [`TriangleUp`](TruncatedHexagonalKind::TriangleUp) points its apex at `90°` and
//! sits across face `3` of the anchor dodecagon; [`TriangleDown`](TruncatedHexagonalKind::TriangleDown)
//! points its apex at `30°` and sits across face `1`. The triangles across faces `5, 9` and
//! `7, 11` are translates of these two (belonging to neighboring anchors).

use super::exact_tiling::{Template, Tiling, Vertex, half, scale, sub, unit};
use super::field_ops::Inclusion;
use super::multi_shape::{
    AnchoredPoint, CellFace, PRESETS, SQRT_3, anchor_cells, expanded_box, impl_cell_kind,
    is_opposite_face, lattice_rect_cells, polygon_faces, preset_cells, regular_cell_shape,
    regular_polygon_area, regular_shapes, retain_attached,
};
use super::square::cell_range;
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    Tessellation,
};
use std::sync::LazyLock;

/// What a cell is: the dodecagon or one of the two triangle orientations.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum TruncatedHexagonalKind {
    Dodecagon,
    /// The triangle across face 3 of the anchor dodecagon; its apex points at `90°`.
    TriangleUp,
    /// The triangle across face 1 of the anchor dodecagon; its apex points at `30°`.
    TriangleDown,
}

impl TruncatedHexagonalKind {
    /// Every kind, in wire order.
    pub const ALL: [TruncatedHexagonalKind; 3] =
        [Self::Dodecagon, Self::TriangleUp, Self::TriangleDown];

    /// Position in the wire encoding.
    pub fn index(self) -> usize {
        // The discriminants follow `ALL`.
        self as usize
    }

    /// Number of sides of the cell.
    fn face_count(self) -> usize {
        match self {
            Self::Dodecagon => 12,
            Self::TriangleUp | Self::TriangleDown => 3,
        }
    }
}

impl_cell_kind!(TruncatedHexagonalKind);

/// A dodecagon `(q, r)` and the kind of cell anchored at it.
pub type TruncatedHexagonalPoint = AnchoredPoint<TruncatedHexagonalKind>;

impl TruncatedHexagonalPoint {
    pub const fn dodecagon(q: i32, r: i32) -> Self {
        Self::new(q, r, TruncatedHexagonalKind::Dodecagon)
    }

    pub fn is_dodecagon(self) -> bool {
        self.kind == TruncatedHexagonalKind::Dodecagon
    }

    pub fn is_triangle(self) -> bool {
        !self.is_dodecagon()
    }
}

/// A side of a cell: its position in `faces_of`, counter-clockwise from the cell's first vertex.
/// A dodecagon has faces `0..12` (face `f` has its normal at `30°·f`), a triangle `0..3`; a
/// triangle's face `0` is the one shared with its anchor dodecagon.
pub type TruncatedHexagonalFace = CellFace;

static SHAPES: LazyLock<[ShapeDescriptor; 2]> = LazyLock::new(|| regular_shapes([12, 3]));

/// Lattice step `A` (dodecagon `q + 1`): `(2 + √3)·(1, 0)`.
const STEP_Q: Vertex = [8, 4, 0, 0];
/// Lattice step `B` (dodecagon `r + 1`): `(2 + √3)·(cos 60°, sin 60°)`.
const STEP_R: Vertex = [4, 2, 6, 4];

/// Start vertex of dodecagon face `f` relative to the center: `apothem·n_f - t_f / 2`, with
/// `n_f` the outward normal and `t_f` the counter-clockwise tangent (`90°` ahead of `n_f`).
fn dodecagon_vertex(f: usize) -> Vertex {
    sub(half(scale(unit(f), 2, 1)), half(unit(f + 3)))
}

/// Vertices of the cell kinds relative to their anchor dodecagon center, counter-clockwise, in
/// kind order. A triangle across face `f` starts with that face's endpoints reversed, then the
/// apex `(1 + √3)·n_f` away from the center.
fn templates() -> Vec<Template> {
    let dodecagon: Vec<Vertex> = (0..12).map(dodecagon_vertex).collect();
    let triangle = |f: usize| {
        let (a, b) = (dodecagon_vertex(f), dodecagon_vertex(f + 1));
        Template::new(&[b, a, scale(unit(f), 1, 1)])
    };
    vec![Template::new(&dodecagon), triangle(3), triangle(1)]
}

static TILING: LazyLock<Tiling> = LazyLock::new(|| Tiling::new(4, STEP_Q, STEP_R, templates()));

/// Farthest a vertex of any cell anchored at a dodecagon lies from that dodecagon's center (a
/// triangle apex, `1 + √3 ≈ 2.73`), with a margin so a cell touching the query box only at a vertex
/// is still a candidate.
const ANCHOR_REACH: f64 = 1.0 + SQRT_3 + 1e-6;

#[derive(Debug, Default, Clone, Copy)]
pub struct TruncatedHexagonalTessellation;

const CELL_TYPES: [super::CellType; 2] = [
    super::CellType::new("triangle"),
    super::CellType::new("dodecagon"),
];
/// Side count of each of `CELL_TYPES`, in the same order.
const FACE_COUNTS: [usize; 2] = [3, 12];

impl Tessellation for TruncatedHexagonalTessellation {
    type CellId = TruncatedHexagonalPoint;
    type Face = TruncatedHexagonalFace;

    fn is_valid_cell(&self, _cell: TruncatedHexagonalPoint) -> bool {
        true
    }

    fn faces_of(&self, cell: TruncatedHexagonalPoint) -> &[TruncatedHexagonalFace] {
        polygon_faces(cell.kind.face_count())
    }

    fn neighbor(
        &self,
        cell: TruncatedHexagonalPoint,
        face: TruncatedHexagonalFace,
    ) -> Option<(TruncatedHexagonalPoint, TruncatedHexagonalFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        let link = TILING.link(cell.kind.index(), face.index());
        Some((
            TruncatedHexagonalPoint::new(
                cell.q.checked_add(link.dq)?,
                cell.r.checked_add(link.dr)?,
                TruncatedHexagonalKind::ALL[link.kind],
            ),
            TruncatedHexagonalFace::new(link.face),
        ))
    }

    /// A dodecagon is passed straight through its opposite face; a triangle has no opposite face
    /// and every pass through it turns by 60°.
    fn is_straight(
        &self,
        cell: TruncatedHexagonalPoint,
        in_face: TruncatedHexagonalFace,
        out_face: TruncatedHexagonalFace,
    ) -> bool {
        let count = cell.kind.face_count();
        count == 12 && is_opposite_face(count, in_face.index(), out_face.index())
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: TruncatedHexagonalPoint) -> Option<CellShape<'_>> {
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
            Point::new(-3.732050807568877, 0.0),
            Point::new(1.866025403784439, 3.232050807568877),
        ])
    }

    fn center(&self, cell: TruncatedHexagonalPoint) -> Point {
        TILING.center(cell.q, cell.r, cell.kind.index())
    }

    fn face_segments(
        &self,
        cell: TruncatedHexagonalPoint,
        face: TruncatedHexagonalFace,
    ) -> Vec<Segment> {
        TILING.face_segments(cell.q, cell.r, cell.kind.index(), face.index())
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<TruncatedHexagonalPoint>> {
        let (lo, hi) = expanded_box(min, max, ANCHOR_REACH);
        // A dodecagon center `(q, r)` sits at `y = r·ROW`, `x = (q + r / 2)·PITCH`: `y` fixes `r`
        // alone, then `x` bounds `q`.
        anchor_cells(
            cell_range(lo.y / ROW, hi.y / ROW),
            |r| {
                let shift = r as f64 / 2.0;
                cell_range(lo.x / PITCH - shift, hi.x / PITCH - shift)
            },
            TruncatedHexagonalKind::ALL.len(),
            limit,
            |r, q, kind| TruncatedHexagonalPoint::new(q, r, TruncatedHexagonalKind::ALL[kind]),
        )
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<TruncatedHexagonalPoint>, FieldOpError> {
        let origin = self.center(TruncatedHexagonalPoint::dodecagon(0, 0));
        // `cols × rows` dodecagon pitches, centered on the origin dodecagon.
        let mut cells = preset_cells(self, key, params, origin, Inclusion::Center, || {
            lattice_rect_cells(self, params, origin, Point::new(PITCH, ROW))
        })?;
        retain_attached(self, &mut cells, |c| c.is_dodecagon())?;
        cells.sort();
        Ok(cells)
    }

    fn area(&self, cell: TruncatedHexagonalPoint) -> f64 {
        regular_polygon_area(cell.kind.face_count())
    }
}

/// Center distance of neighboring dodecagons, `2 + √3`.
const PITCH: f64 = 2.0 + SQRT_3;

/// World `y` distance of dodecagon rows `r` and `r + 1`, `(2 + √3)·√3 / 2`.
const ROW: f64 = PITCH * SQRT_3 / 2.0;
