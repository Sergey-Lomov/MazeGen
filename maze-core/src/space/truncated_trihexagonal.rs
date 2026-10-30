//! The truncated trihexagonal tiling 4.6.12: regular dodecagons, hexagons and squares of the same
//! edge length. Around every vertex a square, a hexagon and a dodecagon meet.
//!
//! Dodecagon centers form a triangular lattice with spacing `3 + √3` (two dodecagon apothems of
//! `(2 + √3) / 2` plus one square), spanned by `A = (3 + √3)·(1, 0)` and `B = (3 + √3)·(cos 60°,
//! sin 60°)`. A dodecagon's face `f` has its outward normal at `30°·f`: even faces are shared with
//! squares (one square between every two lattice-neighbor dodecagons), odd faces with hexagons
//! (one hexagon at the center of every lattice triangle). The tiling has the full `p6m` symmetry.
//!
//! A cell id is a dodecagon `(q, r)` — the center `q·A + r·B` — plus a
//! [`TruncatedTrihexagonalKind`]: the dodecagon itself, one of three squares or one of two
//! hexagons, each named by the normal angle of the anchor dodecagon's face it sits across. The
//! squares across faces `6, 8, 10` and the hexagons across faces `5, 9` and `7, 11` are translates
//! of those (belonging to neighboring anchors). The three squares have different orientations
//! (turned by 60° against each other).

use super::exact_tiling::{Template, Tiling, Vertex, add, half, scale, sub, unit};
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

/// What a cell is: the dodecagon, one of the three square orientations or one of the two hexagons.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum TruncatedTrihexagonalKind {
    Dodecagon,
    /// The square across face 0 of the anchor dodecagon (normal at `0°`).
    Square0,
    /// The square across face 2 of the anchor dodecagon (normal at `60°`).
    Square60,
    /// The square across face 4 of the anchor dodecagon (normal at `120°`).
    Square120,
    /// The hexagon across face 1 of the anchor dodecagon (normal at `30°`).
    Hexagon30,
    /// The hexagon across face 3 of the anchor dodecagon (normal at `90°`).
    Hexagon90,
}

impl TruncatedTrihexagonalKind {
    /// Every kind, in wire order.
    pub const ALL: [TruncatedTrihexagonalKind; 6] = [
        Self::Dodecagon,
        Self::Square0,
        Self::Square60,
        Self::Square120,
        Self::Hexagon30,
        Self::Hexagon90,
    ];

    /// Position in the wire encoding.
    pub fn index(self) -> usize {
        // The discriminants follow `ALL`.
        self as usize
    }

    /// Number of sides of the cell.
    fn face_count(self) -> usize {
        match self {
            Self::Dodecagon => 12,
            Self::Square0 | Self::Square60 | Self::Square120 => 4,
            Self::Hexagon30 | Self::Hexagon90 => 6,
        }
    }

    /// Face of the anchor dodecagon the cell sits across; `None` for the dodecagon itself.
    fn anchor_face(self) -> Option<usize> {
        match self {
            Self::Dodecagon => None,
            Self::Square0 => Some(0),
            Self::Square60 => Some(2),
            Self::Square120 => Some(4),
            Self::Hexagon30 => Some(1),
            Self::Hexagon90 => Some(3),
        }
    }
}

impl_cell_kind!(TruncatedTrihexagonalKind);

/// A dodecagon `(q, r)` and the kind of cell anchored at it.
pub type TruncatedTrihexagonalPoint = AnchoredPoint<TruncatedTrihexagonalKind>;

impl TruncatedTrihexagonalPoint {
    pub const fn dodecagon(q: i32, r: i32) -> Self {
        Self::new(q, r, TruncatedTrihexagonalKind::Dodecagon)
    }

    pub fn is_dodecagon(self) -> bool {
        self.kind == TruncatedTrihexagonalKind::Dodecagon
    }

    pub fn is_square(self) -> bool {
        matches!(
            self.kind,
            TruncatedTrihexagonalKind::Square0
                | TruncatedTrihexagonalKind::Square60
                | TruncatedTrihexagonalKind::Square120
        )
    }

    pub fn is_hexagon(self) -> bool {
        matches!(
            self.kind,
            TruncatedTrihexagonalKind::Hexagon30 | TruncatedTrihexagonalKind::Hexagon90
        )
    }
}

/// A side of a cell: its position in `faces_of`, counter-clockwise from the cell's first vertex.
/// A dodecagon has faces `0..12` (face `f` has its normal at `30°·f`), a hexagon `0..6`, a square
/// `0..4`; the face `0` of a square or hexagon is the one shared with its anchor dodecagon.
pub type TruncatedTrihexagonalFace = CellFace;

static SHAPES: LazyLock<[ShapeDescriptor; 3]> = LazyLock::new(|| regular_shapes([12, 4, 6]));

/// Lattice step `A` (dodecagon `q + 1`): `(3 + √3)·(1, 0)`.
const STEP_Q: Vertex = [12, 4, 0, 0];
/// Lattice step `B` (dodecagon `r + 1`): `(3 + √3)·(cos 60°, sin 60°)`.
const STEP_R: Vertex = [6, 2, 6, 6];

/// Start vertex of dodecagon face `f` relative to the center: `apothem·n_f - t_f / 2`, with
/// `n_f` the outward normal and `t_f` the counter-clockwise tangent (`90°` ahead of `n_f`).
fn dodecagon_vertex(f: usize) -> Vertex {
    sub(half(scale(unit(f), 2, 1)), half(unit(f + 3)))
}

/// Vertices of the cell kinds relative to their anchor dodecagon center, counter-clockwise, in
/// kind order. A square or hexagon across face `f` starts with that face's endpoints reversed,
/// then continues away from the dodecagon: the square by two unit steps along the outward normal
/// `n_f`, the hexagon by turning left by 60° at every vertex.
fn templates() -> Vec<Template> {
    TruncatedTrihexagonalKind::ALL
        .map(|kind| {
            let Some(f) = kind.anchor_face() else {
                let dodecagon: Vec<Vertex> = (0..12).map(dodecagon_vertex).collect();
                return Template::new(&dodecagon);
            };
            let (a, b) = (dodecagon_vertex(f), dodecagon_vertex(f + 1));
            let mut vs = vec![b, a];
            if f % 2 == 0 {
                vs.push(add(a, unit(f)));
                vs.push(add(b, unit(f)));
            } else {
                // The edge `b -> a` runs at `30°·(f + 9)`; every next edge turns by `60°`.
                for k in 0..4 {
                    let last = vs[vs.len() - 1];
                    vs.push(add(last, unit(f + 11 + 2 * k)));
                }
                debug_assert_eq!(add(vs[5], unit(f + 19)), vs[0]);
            }
            Template::new(&vs)
        })
        .into()
}

static TILING: LazyLock<Tiling> = LazyLock::new(|| Tiling::new(4, STEP_Q, STEP_R, templates()));

/// Farthest a vertex of any cell anchored at a dodecagon lies from that dodecagon's center (the far
/// vertex of a hexagon, `2 + √3 ≈ 3.73`), with a margin so a cell touching the query box only at a
/// vertex is still a candidate.
const ANCHOR_REACH: f64 = 2.0 + SQRT_3 + 1e-6;

#[derive(Debug, Default, Clone, Copy)]
pub struct TruncatedTrihexagonalTessellation;

const CELL_TYPES: [super::CellType; 3] = [
    super::CellType::new("square"),
    super::CellType::new("hexagon"),
    super::CellType::new("dodecagon"),
];
/// Side count of each of `CELL_TYPES`, in the same order.
const FACE_COUNTS: [usize; 3] = [4, 6, 12];

impl Tessellation for TruncatedTrihexagonalTessellation {
    type CellId = TruncatedTrihexagonalPoint;
    type Face = TruncatedTrihexagonalFace;

    fn is_valid_cell(&self, _cell: TruncatedTrihexagonalPoint) -> bool {
        true
    }

    fn faces_of(&self, cell: TruncatedTrihexagonalPoint) -> &[TruncatedTrihexagonalFace] {
        polygon_faces(cell.kind.face_count())
    }

    fn neighbor(
        &self,
        cell: TruncatedTrihexagonalPoint,
        face: TruncatedTrihexagonalFace,
    ) -> Option<(TruncatedTrihexagonalPoint, TruncatedTrihexagonalFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        let link = TILING.link(cell.kind.index(), face.index());
        Some((
            TruncatedTrihexagonalPoint::new(
                cell.q.checked_add(link.dq)?,
                cell.r.checked_add(link.dr)?,
                TruncatedTrihexagonalKind::ALL[link.kind],
            ),
            TruncatedTrihexagonalFace::new(link.face),
        ))
    }

    /// A dodecagon, a hexagon and a square are passed straight through their opposite face. The
    /// faces are counter-clockwise, so the opposite one is half a turn ahead whatever the
    /// orientation of the cell.
    fn is_straight(
        &self,
        cell: TruncatedTrihexagonalPoint,
        in_face: TruncatedTrihexagonalFace,
        out_face: TruncatedTrihexagonalFace,
    ) -> bool {
        let count = cell.kind.face_count();
        is_opposite_face(count, in_face.index(), out_face.index())
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: TruncatedTrihexagonalPoint) -> Option<CellShape<'_>> {
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
            Point::new(-2.366025403784438, -4.098076211353316),
            Point::new(2.366025403784439, -4.098076211353316),
        ])
    }

    fn center(&self, cell: TruncatedTrihexagonalPoint) -> Point {
        TILING.center(cell.q, cell.r, cell.kind.index())
    }

    fn face_segments(
        &self,
        cell: TruncatedTrihexagonalPoint,
        face: TruncatedTrihexagonalFace,
    ) -> Vec<Segment> {
        TILING.face_segments(cell.q, cell.r, cell.kind.index(), face.index())
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<TruncatedTrihexagonalPoint>> {
        let (lo, hi) = expanded_box(min, max, ANCHOR_REACH);
        // A dodecagon center `(q, r)` sits at `y = r·ROW`, `x = (q + r / 2)·PITCH`: `y` fixes `r`
        // alone, then `x` bounds `q`.
        anchor_cells(
            cell_range(lo.y / ROW, hi.y / ROW),
            |r| {
                let shift = r as f64 / 2.0;
                cell_range(lo.x / PITCH - shift, hi.x / PITCH - shift)
            },
            TruncatedTrihexagonalKind::ALL.len(),
            limit,
            |r, q, kind| {
                TruncatedTrihexagonalPoint::new(q, r, TruncatedTrihexagonalKind::ALL[kind])
            },
        )
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<TruncatedTrihexagonalPoint>, FieldOpError> {
        let origin = self.center(TruncatedTrihexagonalPoint::dodecagon(0, 0));
        // `cols × rows` dodecagon pitches, centered on the origin dodecagon.
        let mut cells = preset_cells(self, key, params, origin, Inclusion::Center, || {
            lattice_rect_cells(self, params, origin, Point::new(PITCH, ROW))
        })?;
        retain_attached(self, &mut cells, |c| c.is_dodecagon())?;
        cells.sort();
        Ok(cells)
    }

    fn area(&self, cell: TruncatedTrihexagonalPoint) -> f64 {
        regular_polygon_area(cell.kind.face_count())
    }
}

/// Center distance of neighboring dodecagons, `3 + √3`.
const PITCH: f64 = 3.0 + SQRT_3;

/// World `y` distance of dodecagon rows `r` and `r + 1`, `(3 + √3)·√3 / 2`.
const ROW: f64 = PITCH * SQRT_3 / 2.0;
