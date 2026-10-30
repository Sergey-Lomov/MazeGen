//! The elongated triangular tiling 3.3.3.4.4: rows of unit squares alternate with rows of
//! equilateral triangles of the same edge length. Around every vertex three triangles and two
//! squares meet.
//!
//! The plane is cut into bands, band `y` being a row of squares with the row of triangles above it.
//! Band `y` starts at world height `y·(1 + √3/2)`, and every band is shifted half a square to the
//! right of the one below (`x` offset `y / 2`): the squares of band `y + 1` then stand exactly on the
//! down-pointing triangles of band `y`. The tiling has the wallpaper group `cmm`: translations by
//! `(1, 0)` and `(1/2, 1 + √3/2)`, mirrors and half turns, but no 60° rotation.
//!
//! A cell id is a column `x` and a band `y` plus an [`ElongatedTriangularKind`]: the square, the
//! triangle that stands on it ([`TriangleUp`](ElongatedTriangularKind::TriangleUp)) or the triangle
//! hanging between it and its right neighbor ([`TriangleDown`](ElongatedTriangularKind::TriangleDown)).

use super::exact_tiling::{Template, Tiling, Vertex};
use super::field_ops::{Inclusion, convex_cells, param};
use super::multi_shape::{
    AnchoredPoint, CellFace, PRESETS, SQRT_3, anchor_cells, expanded_box, impl_cell_kind,
    is_opposite_face, polygon_faces, preset_cells, regular_cell_shape, regular_polygon_area,
    regular_shapes,
};
use super::square::cell_range;
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    Tessellation,
};
use std::collections::HashSet;
use std::sync::LazyLock;

/// What a cell is: the square or one of the two triangle orientations.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum ElongatedTriangularKind {
    Square,
    /// The triangle standing on the top edge of the square of the same column; its apex points up.
    TriangleUp,
    /// The triangle between `TriangleUp` of its column and of the next one; its apex points down.
    TriangleDown,
}

impl ElongatedTriangularKind {
    /// Every kind, in wire order.
    pub const ALL: [ElongatedTriangularKind; 3] =
        [Self::Square, Self::TriangleUp, Self::TriangleDown];

    /// Position in the wire encoding.
    pub fn index(self) -> usize {
        // The discriminants follow `ALL`.
        self as usize
    }

    /// Number of sides of the cell.
    fn face_count(self) -> usize {
        match self {
            Self::Square => 4,
            Self::TriangleUp | Self::TriangleDown => 3,
        }
    }
}

impl_cell_kind!(ElongatedTriangularKind);

/// A column `q` and a band `r` and the kind of cell anchored at that square.
pub type ElongatedTriangularPoint = AnchoredPoint<ElongatedTriangularKind>;

impl ElongatedTriangularPoint {
    pub const fn square(q: i32, r: i32) -> Self {
        Self::new(q, r, ElongatedTriangularKind::Square)
    }

    pub fn is_square(self) -> bool {
        self.kind == ElongatedTriangularKind::Square
    }

    pub fn is_triangle(self) -> bool {
        !self.is_square()
    }
}

/// A side of a cell: its position in `faces_of`, counter-clockwise from the cell's first vertex.
/// A square has faces `0..4` (bottom, right, top, left), a triangle `0..3`: an up triangle starts
/// with its base, a down triangle with its right side.
pub type ElongatedTriangularFace = CellFace;

static SHAPES: LazyLock<[ShapeDescriptor; 2]> = LazyLock::new(|| regular_shapes([4, 3]));

/// One square step to the right.
const STEP_Q: Vertex = [4, 0, 0, 0];
/// One band up: half a square to the right, `1 + √3/2` up.
const STEP_R: Vertex = [2, 0, 4, 2];

/// Vertices of the cell kinds relative to their anchor square's bottom-left corner,
/// counter-clockwise, in kind order.
fn templates() -> Vec<Template> {
    vec![
        // Square: bottom-left, bottom-right, top-right, top-left.
        Template::new(&[[0, 0, 0, 0], [4, 0, 0, 0], [4, 0, 4, 0], [0, 0, 4, 0]]),
        // Up triangle: base on the square's top edge, apex half a square right, `√3/2` above.
        Template::new(&[[0, 0, 4, 0], [4, 0, 4, 0], [2, 0, 4, 2]]),
        // Down triangle: apex on the square's top-right corner, top edge one square wide.
        Template::new(&[[4, 0, 4, 0], [6, 0, 4, 2], [2, 0, 4, 2]]),
    ]
}

static TILING: LazyLock<Tiling> = LazyLock::new(|| Tiling::new(4, STEP_Q, STEP_R, templates()));

/// World height of one band: a row of squares and the row of triangles above it, `1 + √3/2`.
const ROW: f64 = 1.0 + SQRT_3 / 2.0;

/// Farthest a vertex of any cell anchored at a square lies from the square's bottom-left corner
/// (a down triangle's far corner, `1.5` right), with a margin so a cell touching the query box only
/// at a vertex is still a candidate.
const ANCHOR_REACH: f64 = 1.5 + 1e-6;

#[derive(Debug, Default, Clone, Copy)]
pub struct ElongatedTriangularTessellation;

const CELL_TYPES: [super::CellType; 2] = [
    super::CellType::new("triangle"),
    super::CellType::new("square"),
];
/// Side count of each of `CELL_TYPES`, in the same order.
const FACE_COUNTS: [usize; 2] = [3, 4];

impl Tessellation for ElongatedTriangularTessellation {
    type CellId = ElongatedTriangularPoint;
    type Face = ElongatedTriangularFace;

    fn is_valid_cell(&self, _cell: ElongatedTriangularPoint) -> bool {
        true
    }

    fn faces_of(&self, cell: ElongatedTriangularPoint) -> &[ElongatedTriangularFace] {
        polygon_faces(cell.kind.face_count())
    }

    fn neighbor(
        &self,
        cell: ElongatedTriangularPoint,
        face: ElongatedTriangularFace,
    ) -> Option<(ElongatedTriangularPoint, ElongatedTriangularFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        let link = TILING.link(cell.kind.index(), face.index());
        Some((
            ElongatedTriangularPoint::new(
                cell.q.checked_add(link.dq)?,
                cell.r.checked_add(link.dr)?,
                ElongatedTriangularKind::ALL[link.kind],
            ),
            ElongatedTriangularFace::new(link.face),
        ))
    }

    /// A square is passed straight through its opposite face; a triangle has no opposite face and
    /// every pass through it turns by 60°.
    fn is_straight(
        &self,
        cell: ElongatedTriangularPoint,
        in_face: ElongatedTriangularFace,
        out_face: ElongatedTriangularFace,
    ) -> bool {
        cell.is_square() && is_opposite_face(4, in_face.index(), out_face.index())
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: ElongatedTriangularPoint) -> Option<CellShape<'_>> {
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
        Some([Point::new(-1.0, 0.0), Point::new(-0.5, -1.866025403784438)])
    }

    fn center(&self, cell: ElongatedTriangularPoint) -> Point {
        TILING.center(cell.q, cell.r, cell.kind.index())
    }

    fn face_segments(
        &self,
        cell: ElongatedTriangularPoint,
        face: ElongatedTriangularFace,
    ) -> Vec<Segment> {
        TILING.face_segments(cell.q, cell.r, cell.kind.index(), face.index())
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<ElongatedTriangularPoint>> {
        let (lo, hi) = expanded_box(min, max, ANCHOR_REACH);
        // A band spans `r·ROW` to `(r + 1)·ROW`: the height fixes the bands, then each band's
        // columns start `r / 2` to the right of the origin column.
        anchor_cells(
            cell_range(lo.y / ROW - 1.0, hi.y / ROW),
            |r| {
                let shift = r as f64 / 2.0;
                cell_range(lo.x - shift - 1.5, hi.x - shift)
            },
            ElongatedTriangularKind::ALL.len(),
            limit,
            |r, q, kind| ElongatedTriangularPoint::new(q, r, ElongatedTriangularKind::ALL[kind]),
        )
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<ElongatedTriangularPoint>, FieldOpError> {
        let origin = self.center(ElongatedTriangularPoint::square(0, 0));
        let mut cells = preset_cells(self, key, params, origin, Inclusion::Center, || {
            // `cols` squares wide, `rows` bands high, around the origin square. Square centers
            // sit on a lattice of spacing 1 (shifted by half a square from band to band) and
            // `ROW`, so the rectangle is moved a quarter of a spacing off the origin: no center
            // lies on an edge and every band keeps exactly `cols` squares.
            let half = Point::new(
                param(params, "cols") as f64 / 2.0,
                param(params, "rows") as f64 * ROW / 2.0,
            );
            let shift = Point::new(0.25, 0.25 * ROW);
            let middle = origin + shift;
            let corners = [
                middle + Point::new(-half.x, -half.y),
                middle + Point::new(half.x, -half.y),
                middle + half,
                middle + Point::new(-half.x, half.y),
            ];
            convex_cells(
                self,
                origin,
                &corners,
                half.x.hypot(half.y) + shift.x.hypot(shift.y),
                Inclusion::Center,
            )
        })?;
        // A cell picked by its center can be cut off from the rest at the rim of the shape (a lone
        // triangle between excluded squares), so only the largest piece stays.
        cells = largest_component(self, cells);
        if cells.is_empty() {
            return Err(FieldOpError::InvalidPreset(
                "the shape contains no cells".to_string(),
            ));
        }
        cells.sort();
        Ok(cells)
    }

    fn area(&self, cell: ElongatedTriangularPoint) -> f64 {
        regular_polygon_area(cell.kind.face_count())
    }
}

/// The largest connected group of `cells` through shared faces (the first one on a tie).
fn largest_component(
    tessellation: &ElongatedTriangularTessellation,
    cells: Vec<ElongatedTriangularPoint>,
) -> Vec<ElongatedTriangularPoint> {
    let members: HashSet<_> = cells.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut best: Vec<ElongatedTriangularPoint> = Vec::new();
    for &start in &cells {
        if !seen.insert(start) {
            continue;
        }
        let mut component = vec![start];
        let mut next = 0;
        while let Some(&cell) = component.get(next) {
            next += 1;
            for &face in tessellation.faces_of(cell) {
                if let Some((other, _)) = tessellation.neighbor(cell, face)
                    && members.contains(&other)
                    && seen.insert(other)
                {
                    component.push(other);
                }
            }
        }
        if component.len() > best.len() {
            best = component;
        }
    }
    best
}
