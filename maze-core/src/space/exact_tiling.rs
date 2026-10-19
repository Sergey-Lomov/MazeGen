//! Machinery shared by the multi-shape tessellations whose cells are convex polygons with vertices
//! in `ℤ[√3]`: [`rhombitrihexagonal`](super::rhombitrihexagonal),
//! [`truncated_hexagonal`](super::truncated_hexagonal) and
//! [`truncated_trihexagonal`](super::truncated_trihexagonal).
//!
//! A cell id is an anchor `(q, r)` on a lattice plus a kind. Each tessellation supplies the vertex
//! denominator, the two lattice steps and one vertex [`Template`] per kind; the [`Tiling`] built
//! from them answers vertex, center, face segment and neighbor queries.

use super::multi_shape::SQRT_3;
use super::{Point, Segment};

/// A point of the plane `(x, y) = ((xr + xs·√3) / d, (yr + ys·√3) / d)` as the integers
/// `[xr, xs, yr, ys]`, `d` being the tiling's denominator. Every vertex of the tiling has this form,
/// so vertices compare exactly and a vertex shared by several cells gets identical coordinates
/// from each.
pub(super) type Vertex = [i64; 4];

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

/// Unit vector `(cos 30°·m, sin 30°·m)` at denominator 4; `m` is taken modulo 12.
pub(super) fn unit(m: usize) -> Vertex {
    let (cp, cq) = TWICE_COS[m % 12];
    // sin(30°·m) = cos(30°·(m - 3)).
    let (sp, sq) = TWICE_COS[(m + 9) % 12];
    [2 * cp, 2 * cq, 2 * sp, 2 * sq]
}

/// `v · (k0 + k1·√3)`.
pub(super) fn scale(v: Vertex, k0: i64, k1: i64) -> Vertex {
    let mul = |r: i64, s: i64| (k0 * r + 3 * k1 * s, k0 * s + k1 * r);
    let (xr, xs) = mul(v[0], v[1]);
    let (yr, ys) = mul(v[2], v[3]);
    [xr, xs, yr, ys]
}

pub(super) fn half(v: Vertex) -> Vertex {
    debug_assert!(v.iter().all(|c| c % 2 == 0));
    v.map(|c| c / 2)
}

pub(super) fn add(a: Vertex, b: Vertex) -> Vertex {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]
}

pub(super) fn sub(a: Vertex, b: Vertex) -> Vertex {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]]
}

/// Most vertices any supported cell has.
const MAX_VERTICES: usize = 12;

/// Up to twelve vertices of a cell kind relative to its anchor, counter-clockwise.
#[derive(Debug, Copy, Clone)]
pub(super) struct Template {
    vertices: [Vertex; MAX_VERTICES],
    len: usize,
}

impl Template {
    pub(super) fn new(vertices: &[Vertex]) -> Self {
        let mut out = [[0; 4]; MAX_VERTICES];
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
    buffer: [Vertex; MAX_VERTICES],
    len: usize,
}

impl Vertices {
    fn as_slice(&self) -> &[Vertex] {
        &self.buffer[..self.len]
    }
}

/// Where the neighbor across a face sits: its anchor relative to the cell's anchor, its kind index
/// and the face of it that is shared.
#[derive(Debug, Copy, Clone)]
pub(super) struct Link {
    pub dq: i32,
    pub dr: i32,
    pub kind: usize,
    pub face: u8,
}

/// How many anchor steps around the origin are searched for the neighbor across an edge.
const LINK_SEARCH: i32 = 2;

/// The cell geometry of one tessellation: lattice, kind templates and the neighbor table.
pub(super) struct Tiling {
    denominator: i64,
    step_q: Vertex,
    step_r: Vertex,
    templates: Vec<Template>,
    links: Vec<Vec<Link>>,
}

impl Tiling {
    /// A tiling whose anchor `(q, r)` sits at `q·step_q + r·step_r` and whose kinds have the given
    /// templates (in kind order). The neighbor table is found by matching reversed edges among the
    /// cells anchored near the origin; the tiling is translation invariant, so it holds everywhere.
    pub(super) fn new(
        denominator: i64,
        step_q: Vertex,
        step_r: Vertex,
        templates: Vec<Template>,
    ) -> Self {
        let mut tiling = Self {
            denominator,
            step_q,
            step_r,
            templates,
            links: Vec::new(),
        };
        tiling.links = (0..tiling.templates.len())
            .map(|kind| tiling.find_links(kind))
            .collect();
        tiling
    }

    fn find_links(&self, kind: usize) -> Vec<Link> {
        let own = self.vertices(0, 0, kind);
        let own = own.as_slice();
        (0..own.len())
            .map(|k| {
                let (start, end) = (own[k], own[(k + 1) % own.len()]);
                for dq in -LINK_SEARCH..=LINK_SEARCH {
                    for dr in -LINK_SEARCH..=LINK_SEARCH {
                        for other in 0..self.templates.len() {
                            let theirs = self.vertices(dq, dr, other);
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
    }

    fn anchor(&self, q: i32, r: i32) -> Vertex {
        std::array::from_fn(|i| q as i64 * self.step_q[i] + r as i64 * self.step_r[i])
    }

    /// Vertex `i` of a cell counter-clockwise.
    fn vertex(&self, q: i32, r: i32, kind: usize, i: usize) -> Vertex {
        add(self.templates[kind].vertices[i], self.anchor(q, r))
    }

    /// Vertices of a cell counter-clockwise.
    fn vertices(&self, q: i32, r: i32, kind: usize) -> Vertices {
        let origin = self.anchor(q, r);
        let template = &self.templates[kind];
        let mut buffer = [[0; 4]; MAX_VERTICES];
        for (slot, &v) in buffer.iter_mut().zip(&template.vertices[..template.len]) {
            *slot = add(v, origin);
        }
        Vertices {
            buffer,
            len: template.len,
        }
    }

    /// The neighbor across `face` of a cell of `kind`.
    pub(super) fn link(&self, kind: usize, face: usize) -> Link {
        self.links[kind][face]
    }

    /// World position of a vertex, computed from the integers only.
    fn point(&self, v: Vertex) -> Point {
        let d = self.denominator as f64;
        Point::new(
            (v[0] as f64 + v[1] as f64 * SQRT_3) / d,
            (v[2] as f64 + v[3] as f64 * SQRT_3) / d,
        )
    }

    /// Centroid of the cell's polygon.
    pub(super) fn center(&self, q: i32, r: i32, kind: usize) -> Point {
        let vs = self.vertices(q, r, kind);
        let vs = vs.as_slice();
        let sum = vs.iter().fold([0i64; 4], |acc, &v| add(acc, v));
        let n = (self.denominator * vs.len() as i64) as f64;
        Point::new(
            (sum[0] as f64 + sum[1] as f64 * SQRT_3) / n,
            (sum[2] as f64 + sum[3] as f64 * SQRT_3) / n,
        )
    }

    /// The straight side of the cell between its vertices `face` and `face + 1`.
    pub(super) fn face_segments(&self, q: i32, r: i32, kind: usize, face: usize) -> Vec<Segment> {
        let next = (face + 1) % self.templates[kind].len;
        vec![Segment::line(
            self.point(self.vertex(q, r, kind, face)),
            self.point(self.vertex(q, r, kind, next)),
        )]
    }
}
