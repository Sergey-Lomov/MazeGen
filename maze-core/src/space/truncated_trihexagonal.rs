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

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct TruncatedTrihexagonalPoint {
    pub q: i32,
    pub r: i32,
    pub kind: TruncatedTrihexagonalKind,
}

impl TruncatedTrihexagonalPoint {
    pub const fn dodecagon(q: i32, r: i32) -> Self {
        Self {
            q,
            r,
            kind: TruncatedTrihexagonalKind::Dodecagon,
        }
    }

    pub const fn new(q: i32, r: i32, kind: TruncatedTrihexagonalKind) -> Self {
        Self { q, r, kind }
    }

    /// Wire encoding as an integer pair: `x = 6q + kind index`, `y = r`. Every pair decodes to a
    /// cell. Coordinates beyond `±i32::MAX / 6` in `q` do not fit the wire and wrap.
    pub fn to_xy(self) -> (i32, i32) {
        (
            self.q
                .wrapping_mul(6)
                .wrapping_add(self.kind.index() as i32),
            self.r,
        )
    }

    /// Inverse of [`to_xy`](Self::to_xy).
    pub fn from_xy(x: i32, y: i32) -> Self {
        Self {
            q: x.div_euclid(6),
            r: y,
            kind: TruncatedTrihexagonalKind::ALL[x.rem_euclid(6) as usize],
        }
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
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct TruncatedTrihexagonalFace(u8);

impl TruncatedTrihexagonalFace {
    pub const fn new(index: u8) -> Self {
        Self(index)
    }

    pub fn index(self) -> usize {
        self.0 as usize
    }
}

const fn face(index: u8) -> TruncatedTrihexagonalFace {
    TruncatedTrihexagonalFace(index)
}

const DODECAGON_FACES: [TruncatedTrihexagonalFace; 12] = [
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
const HEXAGON_FACES: [TruncatedTrihexagonalFace; 6] =
    [face(0), face(1), face(2), face(3), face(4), face(5)];
const SQUARE_FACES: [TruncatedTrihexagonalFace; 4] = [face(0), face(1), face(2), face(3)];

/// `faces_of` is already the canonical counter-clockwise order for every template.
const DODECAGON_LOCAL_TO_CANONICAL: [usize; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const HEXAGON_LOCAL_TO_CANONICAL: [usize; 6] = [0, 1, 2, 3, 4, 5];
const SQUARE_LOCAL_TO_CANONICAL: [usize; 4] = [0, 1, 2, 3];

const DODECAGON_SHAPE: usize = 0;
const SQUARE_SHAPE: usize = 1;
const HEXAGON_SHAPE: usize = 2;

static SHAPES: LazyLock<[ShapeDescriptor; 3]> = LazyLock::new(|| {
    [
        ShapeDescriptor::regular_polygon(12),
        ShapeDescriptor::regular_polygon(4),
        ShapeDescriptor::regular_polygon(6),
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

/// Lattice step `A` (dodecagon `q + 1`): `(3 + √3)·(1, 0)`.
const STEP_Q: Vertex = [12, 4, 0, 0];
/// Lattice step `B` (dodecagon `r + 1`): `(3 + √3)·(cos 60°, sin 60°)`.
const STEP_R: Vertex = [6, 2, 6, 6];

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
/// kind order. A square or hexagon across face `f` starts with that face's endpoints reversed,
/// then continues away from the dodecagon: the square by two unit steps along the outward normal
/// `n_f`, the hexagon by turning left by 60° at every vertex.
static TEMPLATES: LazyLock<[Template; 6]> = LazyLock::new(|| {
    TruncatedTrihexagonalKind::ALL.map(|kind| {
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

/// Farthest a vertex of any cell anchored at a dodecagon lies from that dodecagon's center (the far
/// vertex of a hexagon, `2 + √3 ≈ 3.73`), with a margin so a cell touching the query box only at a
/// vertex is still a candidate.
const ANCHOR_REACH: f64 = 2.0 + SQRT_3 + 1e-6;

/// Vertices of `cell` counter-clockwise.
fn vertices(cell: TruncatedTrihexagonalPoint) -> Vertices {
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
    kind: TruncatedTrihexagonalKind,
    face: u8,
}

/// Neighbor table per kind and face, found once by matching reversed edges among the cells
/// anchored near the origin dodecagon. The tiling is translation invariant, so it holds everywhere.
static LINKS: LazyLock<[Vec<Link>; 6]> = LazyLock::new(|| {
    TruncatedTrihexagonalKind::ALL.map(|kind| {
        let own = vertices(TruncatedTrihexagonalPoint::new(0, 0, kind));
        let own = own.as_slice();
        (0..own.len())
            .map(|k| {
                let (start, end) = (own[k], own[(k + 1) % own.len()]);
                for dq in -2..=2 {
                    for dr in -2..=2 {
                        for other in TruncatedTrihexagonalKind::ALL {
                            let theirs = vertices(TruncatedTrihexagonalPoint::new(dq, dr, other));
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
pub struct TruncatedTrihexagonalTessellation;

impl Tessellation for TruncatedTrihexagonalTessellation {
    type CellId = TruncatedTrihexagonalPoint;
    type Face = TruncatedTrihexagonalFace;

    fn is_valid_cell(&self, _cell: TruncatedTrihexagonalPoint) -> bool {
        true
    }

    fn faces_of(&self, cell: TruncatedTrihexagonalPoint) -> &[TruncatedTrihexagonalFace] {
        if cell.is_dodecagon() {
            &DODECAGON_FACES
        } else if cell.is_square() {
            &SQUARE_FACES
        } else {
            &HEXAGON_FACES
        }
    }

    fn neighbor(
        &self,
        cell: TruncatedTrihexagonalPoint,
        face: TruncatedTrihexagonalFace,
    ) -> Option<(TruncatedTrihexagonalPoint, TruncatedTrihexagonalFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        let link = LINKS[cell.kind.index()][face.index()];
        Some((
            TruncatedTrihexagonalPoint::new(
                cell.q.checked_add(link.dq)?,
                cell.r.checked_add(link.dr)?,
                link.kind,
            ),
            TruncatedTrihexagonalFace(link.face),
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
        let count = self.faces_of(cell).len();
        out_face.index() == (in_face.index() + count / 2) % count
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: TruncatedTrihexagonalPoint) -> Option<CellShape<'_>> {
        Some(if cell.is_dodecagon() {
            CellShape::full(&SHAPES[DODECAGON_SHAPE], &DODECAGON_LOCAL_TO_CANONICAL)
        } else if cell.is_square() {
            CellShape::full(&SHAPES[SQUARE_SHAPE], &SQUARE_LOCAL_TO_CANONICAL)
        } else {
            CellShape::full(&SHAPES[HEXAGON_SHAPE], &HEXAGON_LOCAL_TO_CANONICAL)
        })
    }

    /// Centroid of the cell's polygon.
    fn center(&self, cell: TruncatedTrihexagonalPoint) -> Point {
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
        cell: TruncatedTrihexagonalPoint,
        face: TruncatedTrihexagonalFace,
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
    ) -> Option<Vec<TruncatedTrihexagonalPoint>> {
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
            .map(|r| 6 * (*qs(r).end() as i64 - *qs(r).start() as i64 + 1).max(0))
            .sum();
        if count > i64::try_from(limit).unwrap_or(i64::MAX) {
            return None;
        }
        Some(
            rs.flat_map(|r| {
                qs(r).flat_map(move |q| {
                    TruncatedTrihexagonalKind::ALL
                        .map(|kind| TruncatedTrihexagonalPoint::new(q, r, kind))
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
    ) -> Result<Vec<TruncatedTrihexagonalPoint>, FieldOpError> {
        validate_preset(&PRESETS, key, params)?;
        let origin = self.center(TruncatedTrihexagonalPoint::dodecagon(0, 0));
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
        // Squares and hexagons are kept only beside a kept dodecagon: one cut off from every
        // dodecagon of the shape would not be reachable from the rest of the field.
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

    fn area(&self, cell: TruncatedTrihexagonalPoint) -> f64 {
        // Side length 1: a dodecagon is `3·(2 + √3)`, a hexagon `3·√3 / 2`, a square `1`.
        if cell.is_dodecagon() {
            3.0 * (2.0 + SQRT_3)
        } else if cell.is_square() {
            1.0
        } else {
            3.0 * SQRT_3 / 2.0
        }
    }
}

const SQRT_3: f64 = 1.732_050_807_568_877_2;

/// Center distance of neighboring dodecagons, `3 + √3`.
const PITCH: f64 = 3.0 + SQRT_3;

/// World `y` distance of dodecagon rows `r` and `r + 1`, `(3 + √3)·√3 / 2`.
const ROW: f64 = PITCH * SQRT_3 / 2.0;

/// World position of a vertex, computed from the integers only, so a vertex shared by several
/// cells gets identical coordinates from each of them.
fn point(v: Vertex) -> Point {
    Point::new(
        (v[0] as f64 + v[1] as f64 * SQRT_3) / 4.0,
        (v[2] as f64 + v[3] as f64 * SQRT_3) / 4.0,
    )
}

/// Preset field shapes of the truncated trihexagonal tiling, in UI order.
const PRESETS: [PresetDescriptor; 3] = [RECT_PRESET, CIRCLE_PRESET, TRIANGLE_PRESET];
