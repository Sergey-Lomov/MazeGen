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

use super::field_ops::{
    CIRCLE_PRESET, Inclusion, RECT_PRESET, TRIANGLE_PRESET, circle_cells, convex_cells, param,
    triangle_cells,
};
use super::square::cell_range;
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    Tessellation, validate_preset,
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
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct RhombitrihexagonalPoint {
    pub q: i32,
    pub r: i32,
    pub kind: RhombitrihexagonalKind,
}

impl RhombitrihexagonalPoint {
    pub const fn hexagon(q: i32, r: i32) -> Self {
        Self {
            q,
            r,
            kind: RhombitrihexagonalKind::Hexagon,
        }
    }

    pub const fn new(q: i32, r: i32, kind: RhombitrihexagonalKind) -> Self {
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
            kind: RhombitrihexagonalKind::ALL[x.rem_euclid(6) as usize],
        }
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
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct RhombitrihexagonalFace(u8);

impl RhombitrihexagonalFace {
    pub const fn new(index: u8) -> Self {
        Self(index)
    }

    pub fn index(self) -> usize {
        self.0 as usize
    }
}

const fn face(index: u8) -> RhombitrihexagonalFace {
    RhombitrihexagonalFace(index)
}

const HEXAGON_FACES: [RhombitrihexagonalFace; 6] =
    [face(0), face(1), face(2), face(3), face(4), face(5)];
const SQUARE_FACES: [RhombitrihexagonalFace; 4] = [face(0), face(1), face(2), face(3)];
const TRIANGLE_FACES: [RhombitrihexagonalFace; 3] = [face(0), face(1), face(2)];

/// `faces_of` is already the canonical counter-clockwise order for every template.
const HEXAGON_LOCAL_TO_CANONICAL: [usize; 6] = [0, 1, 2, 3, 4, 5];
const SQUARE_LOCAL_TO_CANONICAL: [usize; 4] = [0, 1, 2, 3];
const TRIANGLE_LOCAL_TO_CANONICAL: [usize; 3] = [0, 1, 2];

const HEXAGON_SHAPE: usize = 0;
const SQUARE_SHAPE: usize = 1;
const TRIANGLE_SHAPE: usize = 2;

static SHAPES: LazyLock<[ShapeDescriptor; 3]> = LazyLock::new(|| {
    [
        ShapeDescriptor::regular_polygon(6),
        ShapeDescriptor::regular_polygon(4),
        ShapeDescriptor::regular_polygon(3),
    ]
});

/// A point of the plane `(x, y) = ((xr + xs·√3) / 2, (yr + ys·√3) / 2)` as the integers
/// `[xr, xs, yr, ys]`. Every vertex of the tiling has this form, so vertices compare exactly and a
/// vertex shared by several cells gets identical coordinates from each.
type Vertex = [i64; 4];

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

fn add(a: Vertex, b: Vertex) -> Vertex {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]
}

/// Center of the hexagon `(q, r)`.
fn anchor(q: i64, r: i64) -> Vertex {
    std::array::from_fn(|i| q * STEP_Q[i] + r * STEP_R[i])
}

/// Vertices of the cell kinds relative to their anchor hexagon center, counter-clockwise, in kind
/// order. A square across face `k` starts with that face's endpoints reversed; a triangle at
/// hexagon vertex `j` is `v_j, v_j + n_{j-1}, v_j + n_j`.
static TEMPLATES: LazyLock<[Template; 6]> = LazyLock::new(|| {
    let square = |k: usize| {
        let (a, b) = (HEXAGON_VERTICES[k], HEXAGON_VERTICES[(k + 1) % 6]);
        Template::new(&[b, a, add(a, NORMALS[k]), add(b, NORMALS[k])])
    };
    let triangle = |j: usize| {
        let v = HEXAGON_VERTICES[j];
        Template::new(&[v, add(v, NORMALS[(j + 5) % 6]), add(v, NORMALS[j])])
    };
    [
        Template::new(&HEXAGON_VERTICES),
        square(0),
        square(1),
        square(2),
        triangle(0),
        triangle(1),
    ]
});

/// Up to six vertices of a cell kind, counter-clockwise.
#[derive(Debug, Copy, Clone)]
struct Template {
    vertices: [Vertex; 6],
    len: usize,
}

impl Template {
    fn new(vertices: &[Vertex]) -> Self {
        let mut out = [[0; 4]; 6];
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
    buffer: [Vertex; 6],
    len: usize,
}

impl Vertices {
    fn as_slice(&self) -> &[Vertex] {
        &self.buffer[..self.len]
    }
}

/// Farthest a vertex of any cell anchored at a hexagon lies from that hexagon's center
/// (`√(2 + √3) ≈ 1.93`), with a margin so a cell touching the query box only at a vertex is still
/// a candidate.
const ANCHOR_REACH: f64 = 2.0 + 1e-6;

/// Vertices of `cell` counter-clockwise.
fn vertices(cell: RhombitrihexagonalPoint) -> Vertices {
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
    kind: RhombitrihexagonalKind,
    face: u8,
}

/// Neighbor table per kind and face, found once by matching reversed edges among the cells
/// anchored near the origin hexagon. The tiling is translation invariant, so it holds everywhere.
static LINKS: LazyLock<[Vec<Link>; 6]> = LazyLock::new(|| {
    RhombitrihexagonalKind::ALL.map(|kind| {
        let own = vertices(RhombitrihexagonalPoint::new(0, 0, kind));
        let own = own.as_slice();
        (0..own.len())
            .map(|k| {
                let (start, end) = (own[k], own[(k + 1) % own.len()]);
                for dq in -2..=2 {
                    for dr in -2..=2 {
                        for other in RhombitrihexagonalKind::ALL {
                            let theirs = vertices(RhombitrihexagonalPoint::new(dq, dr, other));
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
pub struct RhombitrihexagonalTessellation;

impl Tessellation for RhombitrihexagonalTessellation {
    type CellId = RhombitrihexagonalPoint;
    type Face = RhombitrihexagonalFace;

    fn is_valid_cell(&self, _cell: RhombitrihexagonalPoint) -> bool {
        true
    }

    fn faces_of(&self, cell: RhombitrihexagonalPoint) -> &[RhombitrihexagonalFace] {
        match cell.kind {
            RhombitrihexagonalKind::Hexagon => &HEXAGON_FACES,
            RhombitrihexagonalKind::Square0
            | RhombitrihexagonalKind::Square1
            | RhombitrihexagonalKind::Square2 => &SQUARE_FACES,
            RhombitrihexagonalKind::TriangleA | RhombitrihexagonalKind::TriangleB => {
                &TRIANGLE_FACES
            }
        }
    }

    fn neighbor(
        &self,
        cell: RhombitrihexagonalPoint,
        face: RhombitrihexagonalFace,
    ) -> Option<(RhombitrihexagonalPoint, RhombitrihexagonalFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        let link = LINKS[cell.kind.index()][face.index()];
        Some((
            RhombitrihexagonalPoint::new(
                cell.q.checked_add(link.dq)?,
                cell.r.checked_add(link.dr)?,
                link.kind,
            ),
            RhombitrihexagonalFace(link.face),
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
        match self.faces_of(cell).len() {
            6 => out_face.index() == (in_face.index() + 3) % 6,
            4 => out_face.index() == (in_face.index() + 2) % 4,
            _ => false,
        }
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: RhombitrihexagonalPoint) -> Option<CellShape<'_>> {
        Some(if cell.is_hexagon() {
            CellShape::full(&SHAPES[HEXAGON_SHAPE], &HEXAGON_LOCAL_TO_CANONICAL)
        } else if cell.is_square() {
            CellShape::full(&SHAPES[SQUARE_SHAPE], &SQUARE_LOCAL_TO_CANONICAL)
        } else {
            CellShape::full(&SHAPES[TRIANGLE_SHAPE], &TRIANGLE_LOCAL_TO_CANONICAL)
        })
    }

    /// Centroid of the cell's polygon.
    fn center(&self, cell: RhombitrihexagonalPoint) -> Point {
        let vs = vertices(cell);
        let vs = vs.as_slice();
        let sum = vs.iter().fold([0i64; 4], |acc, &v| add(acc, v));
        let n = (2 * vs.len()) as f64;
        Point::new(
            (sum[0] as f64 + sum[1] as f64 * SQRT_3) / n,
            (sum[2] as f64 + sum[3] as f64 * SQRT_3) / n,
        )
    }

    fn face_segments(
        &self,
        cell: RhombitrihexagonalPoint,
        face: RhombitrihexagonalFace,
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
    ) -> Option<Vec<RhombitrihexagonalPoint>> {
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
        // A hexagon center `(q, r)` sits at `x = q·(3 + √3)/2`, `y = q·(1 + √3)/2 + r·(1 + √3)`:
        // `x` fixes `q` alone, then `y` bounds `r`.
        let qs = cell_range(lo.x / STEP_X, hi.x / STEP_X);
        let rs = |q: i32| {
            let shift = q as f64 * PITCH / 2.0;
            cell_range((lo.y - shift) / PITCH, (hi.y - shift) / PITCH)
        };
        let count: i64 = qs
            .clone()
            .map(|q| {
                let rs = rs(q);
                6 * (*rs.end() as i64 - *rs.start() as i64 + 1).max(0)
            })
            .sum();
        if count > i64::try_from(limit).unwrap_or(i64::MAX) {
            return None;
        }
        Some(
            qs.flat_map(|q| {
                rs(q).flat_map(move |r| {
                    RhombitrihexagonalKind::ALL.map(|kind| RhombitrihexagonalPoint::new(q, r, kind))
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
    ) -> Result<Vec<RhombitrihexagonalPoint>, FieldOpError> {
        validate_preset(&PRESETS, key, params)?;
        let origin = self.center(RhombitrihexagonalPoint::hexagon(0, 0));
        let mut cells = match key {
            "rect" => {
                // `cols × rows` hexagon pitches, centered on the origin hexagon.
                let half = Point::new(
                    param(params, "cols") as f64 * PITCH / 2.0,
                    param(params, "rows") as f64 * PITCH / 2.0,
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
            "triangle" => {
                triangle_cells(self, origin, param(params, "side"), Inclusion::WholeCell)?
            }
            _ => return Err(FieldOpError::Unavailable),
        };
        cells.sort();
        Ok(cells)
    }

    fn area(&self, cell: RhombitrihexagonalPoint) -> f64 {
        // Side length 1: a hexagon is `3·√3 / 2`, a square `1`, a triangle `√3 / 4`.
        if cell.is_hexagon() {
            3.0 * SQRT_3 / 2.0
        } else if cell.is_square() {
            1.0
        } else {
            SQRT_3 / 4.0
        }
    }
}

const SQRT_3: f64 = 1.732_050_807_568_877_2;

/// Center distance of neighboring hexagons, `1 + √3`.
const PITCH: f64 = 1.0 + SQRT_3;

/// World `x` distance of hexagon `q` and `q + 1`, `(3 + √3) / 2`.
const STEP_X: f64 = (3.0 + SQRT_3) / 2.0;

/// World position of a vertex, computed from the integers only, so a vertex shared by several
/// cells gets identical coordinates from each of them.
fn point(v: Vertex) -> Point {
    Point::new(
        (v[0] as f64 + v[1] as f64 * SQRT_3) / 2.0,
        (v[2] as f64 + v[3] as f64 * SQRT_3) / 2.0,
    )
}

/// Preset field shapes of the rhombitrihexagonal tiling, in UI order.
const PRESETS: [PresetDescriptor; 3] = [RECT_PRESET, CIRCLE_PRESET, TRIANGLE_PRESET];
