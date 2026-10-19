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

use super::field_ops::{
    CIRCLE_PRESET, Inclusion, RECT_PRESET, TRIANGLE_PRESET, circle_cells, convex_cells, param,
    triangle_cells,
};
use super::square::cell_range;
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    Tessellation, validate_preset,
};
use std::collections::HashSet;
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
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct TruncatedHexagonalPoint {
    pub q: i32,
    pub r: i32,
    pub kind: TruncatedHexagonalKind,
}

impl TruncatedHexagonalPoint {
    pub const fn dodecagon(q: i32, r: i32) -> Self {
        Self {
            q,
            r,
            kind: TruncatedHexagonalKind::Dodecagon,
        }
    }

    pub const fn new(q: i32, r: i32, kind: TruncatedHexagonalKind) -> Self {
        Self { q, r, kind }
    }

    /// Wire encoding as an integer pair: `x = 3q + kind index`, `y = r`. Every pair decodes to a
    /// cell. Coordinates beyond `±i32::MAX / 3` in `q` do not fit the wire and wrap.
    pub fn to_xy(self) -> (i32, i32) {
        (
            self.q
                .wrapping_mul(3)
                .wrapping_add(self.kind.index() as i32),
            self.r,
        )
    }

    /// Inverse of [`to_xy`](Self::to_xy).
    pub fn from_xy(x: i32, y: i32) -> Self {
        Self {
            q: x.div_euclid(3),
            r: y,
            kind: TruncatedHexagonalKind::ALL[x.rem_euclid(3) as usize],
        }
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
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct TruncatedHexagonalFace(u8);

impl TruncatedHexagonalFace {
    pub const fn new(index: u8) -> Self {
        Self(index)
    }

    pub fn index(self) -> usize {
        self.0 as usize
    }
}

const fn face(index: u8) -> TruncatedHexagonalFace {
    TruncatedHexagonalFace(index)
}

const DODECAGON_FACES: [TruncatedHexagonalFace; 12] = [
    face(0),
    face(1),
    face(2),
    face(3),
    face(4),
    face(5),
    face(6),
    face(7),
    face(8),
    face(9),
    face(10),
    face(11),
];
const TRIANGLE_FACES: [TruncatedHexagonalFace; 3] = [face(0), face(1), face(2)];

/// `faces_of` is already the canonical counter-clockwise order for every template.
const DODECAGON_LOCAL_TO_CANONICAL: [usize; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const TRIANGLE_LOCAL_TO_CANONICAL: [usize; 3] = [0, 1, 2];

const DODECAGON_SHAPE: usize = 0;
const TRIANGLE_SHAPE: usize = 1;

static SHAPES: LazyLock<[ShapeDescriptor; 2]> = LazyLock::new(|| {
    [
        ShapeDescriptor::regular_polygon(12),
        ShapeDescriptor::regular_polygon(3),
    ]
});

/// A point of the plane `(x, y) = ((xr + xs·√3) / 4, (yr + ys·√3) / 4)` as the integers
/// `[xr, xs, yr, ys]`. Every vertex of the tiling has this form, so vertices compare exactly and a
/// vertex shared by several cells gets identical coordinates from each.
type Vertex = [i64; 4];

/// `2·cos(30°·m)` as `p + q·√3`, for `m = 0..12`.
const TWICE_COS: [(i64, i64); 12] = [
    (2, 0),
    (0, 1),
    (1, 0),
    (0, 0),
    (-1, 0),
    (0, -1),
    (-2, 0),
    (0, -1),
    (-1, 0),
    (0, 0),
    (1, 0),
    (0, 1),
];

/// Unit vector `(cos 30°·m, sin 30°·m)`; `m` is taken modulo 12.
fn unit(m: usize) -> Vertex {
    let (cp, cq) = TWICE_COS[m % 12];
    // sin(30°·m) = cos(30°·(m - 3)).
    let (sp, sq) = TWICE_COS[(m + 9) % 12];
    [2 * cp, 2 * cq, 2 * sp, 2 * sq]
}

/// `v · (k0 + k1·√3)`.
fn scale(v: Vertex, k0: i64, k1: i64) -> Vertex {
    let mul = |r: i64, s: i64| (k0 * r + 3 * k1 * s, k0 * s + k1 * r);
    let (xr, xs) = mul(v[0], v[1]);
    let (yr, ys) = mul(v[2], v[3]);
    [xr, xs, yr, ys]
}

fn half(v: Vertex) -> Vertex {
    debug_assert!(v.iter().all(|c| c % 2 == 0));
    v.map(|c| c / 2)
}

fn add(a: Vertex, b: Vertex) -> Vertex {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]
}

fn sub(a: Vertex, b: Vertex) -> Vertex {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]]
}

/// Lattice step `A` (dodecagon `q + 1`): `(2 + √3)·(1, 0)`.
const STEP_Q: Vertex = [8, 4, 0, 0];
/// Lattice step `B` (dodecagon `r + 1`): `(2 + √3)·(cos 60°, sin 60°)`.
const STEP_R: Vertex = [4, 2, 6, 4];

/// Center of the dodecagon `(q, r)`.
fn anchor(q: i64, r: i64) -> Vertex {
    std::array::from_fn(|i| q * STEP_Q[i] + r * STEP_R[i])
}

/// Start vertex of dodecagon face `f` relative to the center: `apothem·n_f - t_f / 2`, with
/// `n_f` the outward normal and `t_f` the counter-clockwise tangent (`90°` ahead of `n_f`).
fn dodecagon_vertex(f: usize) -> Vertex {
    sub(half(scale(unit(f), 2, 1)), half(unit(f + 3)))
}

/// Vertices of the cell kinds relative to their anchor dodecagon center, counter-clockwise, in
/// kind order. A triangle across face `f` starts with that face's endpoints reversed, then the
/// apex `(1 + √3)·n_f` away from the center.
static TEMPLATES: LazyLock<[Template; 3]> = LazyLock::new(|| {
    let dodecagon: Vec<Vertex> = (0..12).map(dodecagon_vertex).collect();
    let triangle = |f: usize| {
        let (a, b) = (dodecagon_vertex(f), dodecagon_vertex(f + 1));
        Template::new(&[b, a, scale(unit(f), 1, 1)])
    };
    [Template::new(&dodecagon), triangle(3), triangle(1)]
});

/// Up to twelve vertices of a cell kind, counter-clockwise.
#[derive(Debug, Copy, Clone)]
struct Template {
    vertices: [Vertex; 12],
    len: usize,
}

impl Template {
    fn new(vertices: &[Vertex]) -> Self {
        let mut out = [[0; 4]; 12];
        out[..vertices.len()].copy_from_slice(vertices);
        Self {
            vertices: out,
            len: vertices.len(),
        }
    }
}

/// Vertices of a cell, counter-clockwise, in a fixed-size buffer.
#[derive(Debug, Copy, Clone)]
struct Vertices {
    buffer: [Vertex; 12],
    len: usize,
}

impl Vertices {
    fn as_slice(&self) -> &[Vertex] {
        &self.buffer[..self.len]
    }
}

/// Farthest a vertex of any cell anchored at a dodecagon lies from that dodecagon's center (a
/// triangle apex, `1 + √3 ≈ 2.73`), with a margin so a cell touching the query box only at a vertex
/// is still a candidate.
const ANCHOR_REACH: f64 = 1.0 + SQRT_3 + 1e-6;

/// Vertices of `cell` counter-clockwise.
fn vertices(cell: TruncatedHexagonalPoint) -> Vertices {
    let origin = anchor(cell.q as i64, cell.r as i64);
    let template = &TEMPLATES[cell.kind.index()];
    Vertices {
        buffer: template.vertices.map(|v| add(v, origin)),
        len: template.len,
    }
}

/// Where the neighbor across a face sits: its anchor relative to the cell's anchor, its kind and
/// the face of it that is shared.
#[derive(Debug, Copy, Clone)]
struct Link {
    dq: i32,
    dr: i32,
    kind: TruncatedHexagonalKind,
    face: u8,
}

/// Neighbor table per kind and face, found once by matching reversed edges among the cells
/// anchored near the origin dodecagon. The tiling is translation invariant, so it holds everywhere.
static LINKS: LazyLock<[Vec<Link>; 3]> = LazyLock::new(|| {
    TruncatedHexagonalKind::ALL.map(|kind| {
        let own = vertices(TruncatedHexagonalPoint::new(0, 0, kind));
        let own = own.as_slice();
        (0..own.len())
            .map(|k| {
                let (start, end) = (own[k], own[(k + 1) % own.len()]);
                for dq in -2..=2 {
                    for dr in -2..=2 {
                        for other in TruncatedHexagonalKind::ALL {
                            let theirs = vertices(TruncatedHexagonalPoint::new(dq, dr, other));
                            let theirs = theirs.as_slice();
                            let m = theirs.len();
                            if let Some(j) =
                                (0..m).find(|&j| theirs[j] == end && theirs[(j + 1) % m] == start)
                            {
                                return Link {
                                    dq,
                                    dr,
                                    kind: other,
                                    face: j as u8,
                                };
                            }
                        }
                    }
                }
                unreachable!("every cell edge is shared with a cell anchored within two steps")
            })
            .collect()
    })
});

#[derive(Debug, Default, Clone, Copy)]
pub struct TruncatedHexagonalTessellation;

impl Tessellation for TruncatedHexagonalTessellation {
    type CellId = TruncatedHexagonalPoint;
    type Face = TruncatedHexagonalFace;

    fn is_valid_cell(&self, _cell: TruncatedHexagonalPoint) -> bool {
        true
    }

    fn faces_of(&self, cell: TruncatedHexagonalPoint) -> &[TruncatedHexagonalFace] {
        match cell.kind {
            TruncatedHexagonalKind::Dodecagon => &DODECAGON_FACES,
            TruncatedHexagonalKind::TriangleUp | TruncatedHexagonalKind::TriangleDown => {
                &TRIANGLE_FACES
            }
        }
    }

    fn neighbor(
        &self,
        cell: TruncatedHexagonalPoint,
        face: TruncatedHexagonalFace,
    ) -> Option<(TruncatedHexagonalPoint, TruncatedHexagonalFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        let link = LINKS[cell.kind.index()][face.index()];
        Some((
            TruncatedHexagonalPoint::new(
                cell.q.checked_add(link.dq)?,
                cell.r.checked_add(link.dr)?,
                link.kind,
            ),
            TruncatedHexagonalFace(link.face),
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
        match cell.kind {
            TruncatedHexagonalKind::Dodecagon => out_face.index() == (in_face.index() + 6) % 12,
            TruncatedHexagonalKind::TriangleUp | TruncatedHexagonalKind::TriangleDown => false,
        }
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: TruncatedHexagonalPoint) -> Option<CellShape<'_>> {
        Some(if cell.is_dodecagon() {
            CellShape::full(&SHAPES[DODECAGON_SHAPE], &DODECAGON_LOCAL_TO_CANONICAL)
        } else {
            CellShape::full(&SHAPES[TRIANGLE_SHAPE], &TRIANGLE_LOCAL_TO_CANONICAL)
        })
    }

    /// Centroid of the cell's polygon.
    fn center(&self, cell: TruncatedHexagonalPoint) -> Point {
        let vs = vertices(cell);
        let vs = vs.as_slice();
        let sum = vs.iter().fold([0i64; 4], |acc, &v| add(acc, v));
        let n = (4 * vs.len()) as f64;
        Point::new(
            (sum[0] as f64 + sum[1] as f64 * SQRT_3) / n,
            (sum[2] as f64 + sum[3] as f64 * SQRT_3) / n,
        )
    }

    fn face_segments(
        &self,
        cell: TruncatedHexagonalPoint,
        face: TruncatedHexagonalFace,
    ) -> Vec<Segment> {
        let vs = vertices(cell);
        let vs = vs.as_slice();
        let k = face.index();
        vec![Segment::line(point(vs[k]), point(vs[(k + 1) % vs.len()]))]
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<TruncatedHexagonalPoint>> {
        let (lo, hi) = (
            Point::new(
                min.x.min(max.x) - ANCHOR_REACH,
                min.y.min(max.y) - ANCHOR_REACH,
            ),
            Point::new(
                min.x.max(max.x) + ANCHOR_REACH,
                min.y.max(max.y) + ANCHOR_REACH,
            ),
        );
        // A dodecagon center `(q, r)` sits at `y = r·ROW`, `x = (q + r / 2)·PITCH`: `y` fixes `r`
        // alone, then `x` bounds `q`.
        let rs = cell_range(lo.y / ROW, hi.y / ROW);
        let qs = |r: i32| {
            let shift = r as f64 / 2.0;
            cell_range(lo.x / PITCH - shift, hi.x / PITCH - shift)
        };
        let count: i64 = rs
            .clone()
            .map(|r| 3 * (*qs(r).end() as i64 - *qs(r).start() as i64 + 1).max(0))
            .sum();
        if count > i64::try_from(limit).unwrap_or(i64::MAX) {
            return None;
        }
        Some(
            rs.flat_map(|r| {
                qs(r).flat_map(move |q| {
                    TruncatedHexagonalKind::ALL.map(|kind| TruncatedHexagonalPoint::new(q, r, kind))
                })
            })
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
    ) -> Result<Vec<TruncatedHexagonalPoint>, FieldOpError> {
        validate_preset(&PRESETS, key, params)?;
        let origin = self.center(TruncatedHexagonalPoint::dodecagon(0, 0));
        let mut cells = match key {
            "rect" => {
                // `cols × rows` dodecagon pitches, centered on the origin dodecagon.
                let half = Point::new(
                    param(params, "cols") as f64 * PITCH / 2.0,
                    param(params, "rows") as f64 * ROW / 2.0,
                );
                let corners = [
                    origin + Point::new(-half.x, -half.y),
                    origin + Point::new(half.x, -half.y),
                    origin + half,
                    origin + Point::new(-half.x, half.y),
                ];
                convex_cells(
                    self,
                    origin,
                    &corners,
                    half.x.hypot(half.y),
                    Inclusion::WholeCell,
                )?
            }
            "circle" => circle_cells(self, origin, param(params, "radius"), Inclusion::Center)?,
            "triangle" => triangle_cells(self, origin, param(params, "side"), Inclusion::Center)?,
            _ => return Err(FieldOpError::Unavailable),
        };
        // A triangle borders only dodecagons, so one whose dodecagons are all outside the shape
        // would be cut off from the rest of the field.
        let kept: HashSet<_> = cells.iter().copied().filter(|c| c.is_dodecagon()).collect();
        cells.retain(|&c| {
            c.is_dodecagon()
                || self
                    .faces_of(c)
                    .iter()
                    .any(|&f| self.neighbor(c, f).is_some_and(|(n, _)| kept.contains(&n)))
        });
        if cells.is_empty() {
            return Err(FieldOpError::InvalidPreset(
                "the shape contains no cells".to_string(),
            ));
        }
        cells.sort();
        Ok(cells)
    }

    fn area(&self, cell: TruncatedHexagonalPoint) -> f64 {
        // Side length 1: a dodecagon is `3·(2 + √3)`, a triangle `√3 / 4`.
        if cell.is_dodecagon() {
            3.0 * (2.0 + SQRT_3)
        } else {
            SQRT_3 / 4.0
        }
    }
}

const SQRT_3: f64 = 1.732_050_807_568_877_2;

/// Center distance of neighboring dodecagons, `2 + √3`.
const PITCH: f64 = 2.0 + SQRT_3;

/// World `y` distance of dodecagon rows `r` and `r + 1`, `(2 + √3)·√3 / 2`.
const ROW: f64 = PITCH * SQRT_3 / 2.0;

/// World position of a vertex, computed from the integers only, so a vertex shared by several
/// cells gets identical coordinates from each of them.
fn point(v: Vertex) -> Point {
    Point::new(
        (v[0] as f64 + v[1] as f64 * SQRT_3) / 4.0,
        (v[2] as f64 + v[3] as f64 * SQRT_3) / 4.0,
    )
}

/// Preset field shapes of the truncated hexagonal tiling, in UI order.
const PRESETS: [PresetDescriptor; 3] = [RECT_PRESET, CIRCLE_PRESET, TRIANGLE_PRESET];
