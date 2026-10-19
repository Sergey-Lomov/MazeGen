//! The snub hexagonal (snub trihexagonal) tiling 3.3.3.3.6: regular hexagons and equilateral
//! triangles of the same edge length, four triangles and one hexagon around every vertex.
//!
//! The vertices are the points of the unit triangular lattice `a + b·ω` (`ω = e^{iπ/3}`, written
//! `(a, b)`) without the sublattice `L = { (a, b) : a ≡ 2b (mod 7) }`. Every removed point leaves a
//! hexagon (its six lattice neighbors); the lattice triangles that touch no removed point are the
//! triangle cells. Hexagon centers are the points of `L`, spanned by `(2, 1)` and `(-1, 3)`, so the
//! tiling is invariant under those two translations (center distance `√7`) and under 60° rotations
//! about a hexagon center.
//!
//! **Handedness.** The tiling is chiral. This module fixes the counter-clockwise form (y up): the
//! lattice vector `(2, 1)` points `atan(√3 / 5) ≈ 19.1°` counter-clockwise from the hexagon's
//! vertex axis. Its mirror image (`a ≡ 4b (mod 7)`) is not offered, and since the tiling has no
//! mirror symmetry, no reflection maps a field onto itself.
//!
//! A cell id is a hexagon `(q, r)` — the center `q·(2, 1) + r·(-1, 3)` — plus a
//! [`SnubHexagonalKind`]: the hexagon itself, one of the six triangles sharing an edge with it, or
//! one of two triangles that border only triangles. A triangle's anchor is the hexagon whose
//! translation of the kind's template yields it.

use super::field_ops::Inclusion;
use super::multi_shape::{
    AnchoredPoint, CellFace, PRESETS, SQRT_3, anchor_cells, expanded_box, impl_cell_kind,
    is_opposite_face, lattice_rect_cells, polygon_faces, preset_cells, regular_cell_shape,
    regular_polygon_area, regular_shapes,
};
use super::square::cell_range;
use super::{
    CellShape, FieldOpError, FieldOperation, Point, PresetDescriptor, PresetParams, Segment,
    ShapeDescriptor, Tessellation,
};
use std::sync::LazyLock;

/// What a cell is: a hexagon, a triangle across one of the hexagon's faces, or a triangle that
/// borders no hexagon.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum SnubHexagonalKind {
    Hexagon,
    /// The triangle across face `k` of the anchor hexagon (`Edge0` ... `Edge5`).
    Edge0,
    Edge1,
    Edge2,
    Edge3,
    Edge4,
    Edge5,
    /// The two triangles with no hexagon neighbor.
    Inner0,
    Inner1,
}

impl SnubHexagonalKind {
    /// Every kind, in wire order.
    pub const ALL: [SnubHexagonalKind; 9] = [
        Self::Hexagon,
        Self::Edge0,
        Self::Edge1,
        Self::Edge2,
        Self::Edge3,
        Self::Edge4,
        Self::Edge5,
        Self::Inner0,
        Self::Inner1,
    ];

    /// Position in the wire encoding (`0` hexagon, `1..=6` edge triangles, `7` and `8` inner).
    pub fn index(self) -> usize {
        // The discriminants follow `ALL`.
        self as usize
    }
}

impl_cell_kind!(SnubHexagonalKind);

/// A hexagon `(q, r)` and the kind of cell anchored at it.
pub type SnubHexagonalPoint = AnchoredPoint<SnubHexagonalKind>;

impl SnubHexagonalPoint {
    pub const fn hexagon(q: i32, r: i32) -> Self {
        Self::new(q, r, SnubHexagonalKind::Hexagon)
    }

    pub fn is_hexagon(self) -> bool {
        self.kind == SnubHexagonalKind::Hexagon
    }
}

/// A side of a cell: its position in `faces_of`, counter-clockwise from the cell's first vertex.
/// A hexagon has faces `0..6` (face `k` runs from hexagon vertex `k`, at angle `60°·k` around the
/// center, to vertex `k + 1`), a triangle `0..3`; an edge triangle's face `0` is the one shared
/// with its anchor hexagon.
pub type SnubHexagonalFace = CellFace;

static SHAPES: LazyLock<[ShapeDescriptor; 2]> = LazyLock::new(|| regular_shapes([6, 3]));

/// A point `a + b·ω` of the unit triangular lattice.
type Lattice = (i64, i64);

/// The six unit lattice directions `ω^0 ... ω^5`, counter-clockwise.
const DIRECTIONS: [Lattice; 6] = [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)];

/// Vertices of the triangle kinds relative to their anchor hexagon center, counter-clockwise, in
/// kind order `Edge0 ... Edge5, Inner0, Inner1`. Edge triangle `k` lies across hexagon face `k`
/// and starts with that face's endpoints reversed; the inner triangles are the nearest ones of
/// their translation classes.
const TRIANGLE_TEMPLATES: [[Lattice; 3]; 8] = [
    [(0, 1), (1, 0), (1, 1)],
    [(-1, 1), (0, 1), (-1, 2)],
    [(-1, 0), (-1, 1), (-2, 1)],
    [(0, -1), (-1, 0), (-1, -1)],
    [(1, -1), (0, -1), (1, -2)],
    [(1, 0), (1, -1), (2, -1)],
    [(1, -2), (2, -2), (1, -1)],
    [(0, -2), (0, -1), (-1, -1)],
];

/// Farthest a vertex of any cell anchored at a hexagon lies from that hexagon's center (exactly 2),
/// with a margin so a cell touching the query box only at a vertex is still a candidate.
const ANCHOR_REACH: f64 = 2.0 + 1e-6;

fn in_sublattice((a, b): Lattice) -> bool {
    (a - 2 * b).rem_euclid(7) == 0
}

/// Lattice position of the hexagon center `(q, r)`.
fn anchor_lattice(q: i32, r: i32) -> Lattice {
    (2 * q as i64 - r as i64, q as i64 + 3 * r as i64)
}

/// The hexagon `(q, r)` centered on sublattice point `(a, b)`, or `None` when `q` or `r` leave
/// `i32`.
fn hexagon_at((a, b): Lattice) -> Option<SnubHexagonalPoint> {
    debug_assert!(in_sublattice((a, b)));
    Some(SnubHexagonalPoint::hexagon(
        i32::try_from((3 * a + b).div_euclid(7)).ok()?,
        i32::try_from((2 * b - a).div_euclid(7)).ok()?,
    ))
}

/// Vertices of `cell` counter-clockwise, and how many are used (6 or 3).
fn vertices(cell: SnubHexagonalPoint) -> ([Lattice; 6], usize) {
    let (ca, cb) = anchor_lattice(cell.q, cell.r);
    let mut out = [(0, 0); 6];
    if cell.is_hexagon() {
        for (slot, (da, db)) in out.iter_mut().zip(DIRECTIONS) {
            *slot = (ca + da, cb + db);
        }
        (out, 6)
    } else {
        let template = &TRIANGLE_TEMPLATES[cell.kind.index() - 1];
        for (slot, &(da, db)) in out.iter_mut().zip(template) {
            *slot = (ca + da, cb + db);
        }
        (out, 3)
    }
}

/// The cell on the left of the directed unit lattice edge `from -> to`, or `None` when its anchor
/// leaves `i32`.
fn cell_left_of(from: Lattice, to: Lattice) -> Option<SnubHexagonalPoint> {
    let step = (to.0 - from.0, to.1 - from.1);
    let m = DIRECTIONS
        .iter()
        .position(|&d| d == step)
        .expect("a cell edge is a unit lattice step");
    let (da, db) = DIRECTIONS[(m + 1) % 6];
    let third = (from.0 + da, from.1 + db);
    let corners = [from, to, third];
    if let Some(&removed) = corners.iter().find(|&&p| in_sublattice(p)) {
        return hexagon_at(removed);
    }
    let lowest = |points: &[Lattice]| {
        *points
            .iter()
            .min_by_key(|&&(a, b)| (b, a))
            .expect("a triangle has vertices")
    };
    let base = lowest(&corners);
    for (slot, template) in TRIANGLE_TEMPLATES.iter().enumerate() {
        let origin = lowest(template);
        let shift = (base.0 - origin.0, base.1 - origin.1);
        if !in_sublattice(shift) {
            continue;
        }
        let matches = template
            .iter()
            .all(|&(a, b)| corners.contains(&(a + shift.0, b + shift.1)));
        if matches {
            let anchor = hexagon_at(shift)?;
            return Some(SnubHexagonalPoint::new(
                anchor.q,
                anchor.r,
                SnubHexagonalKind::ALL[slot + 1],
            ));
        }
    }
    unreachable!("every lattice triangle off the sublattice is a translate of a template")
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SnubHexagonalTessellation;

impl Tessellation for SnubHexagonalTessellation {
    type CellId = SnubHexagonalPoint;
    type Face = SnubHexagonalFace;

    fn is_valid_cell(&self, _cell: SnubHexagonalPoint) -> bool {
        true
    }

    fn faces_of(&self, cell: SnubHexagonalPoint) -> &[SnubHexagonalFace] {
        polygon_faces(if cell.is_hexagon() { 6 } else { 3 })
    }

    fn neighbor(
        &self,
        cell: SnubHexagonalPoint,
        face: SnubHexagonalFace,
    ) -> Option<(SnubHexagonalPoint, SnubHexagonalFace)> {
        debug_assert!(self.faces_of(cell).contains(&face));
        let (own, n) = vertices(cell);
        let k = face.index();
        let (start, end) = (own[k], own[(k + 1) % n]);
        let other = cell_left_of(end, start)?;
        let (theirs, m) = vertices(other);
        let j = (0..m)
            .find(|&j| theirs[j] == end && theirs[(j + 1) % m] == start)
            .expect("the neighbor owns the same edge in reverse");
        Some((other, SnubHexagonalFace::new(j as u8)))
    }

    /// A hexagon is passed straight through its opposite face; a triangle has no opposite face and
    /// every pass through it turns by 60°.
    fn is_straight(
        &self,
        cell: SnubHexagonalPoint,
        in_face: SnubHexagonalFace,
        out_face: SnubHexagonalFace,
    ) -> bool {
        cell.is_hexagon() && is_opposite_face(6, in_face.index(), out_face.index())
    }

    /// The tiling is chiral and has no mirror symmetry, so only translation is offered.
    fn field_operations(&self) -> &[FieldOperation] {
        &[FieldOperation::Translate]
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: SnubHexagonalPoint) -> Option<CellShape<'_>> {
        Some(regular_cell_shape(&*SHAPES, self.faces_of(cell).len()))
    }

    /// Centroid of the cell's polygon.
    fn center(&self, cell: SnubHexagonalPoint) -> Point {
        let (vs, n) = vertices(cell);
        let (x2, y) = vs[..n]
            .iter()
            .fold((0, 0), |(x2, y), &(a, b)| (x2 + 2 * a + b, y + b));
        Point::new(
            x2 as f64 / (2 * n) as f64,
            y as f64 * (SQRT_3 / 2.0) / n as f64,
        )
    }

    fn face_segments(&self, cell: SnubHexagonalPoint, face: SnubHexagonalFace) -> Vec<Segment> {
        let (vs, n) = vertices(cell);
        let k = face.index();
        vec![Segment::line(point(vs[k]), point(vs[(k + 1) % n]))]
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<SnubHexagonalPoint>> {
        let (lo, hi) = expanded_box(min, max, ANCHOR_REACH);
        // A hexagon center `(q, r)` sits at `x = 5q/2 + r/2`, `y = (q + 3r)·√3/2`. For a fixed `r`
        // the box bounds `q` twice, through `x` and through `y`.
        let half_height = SQRT_3 / 2.0;
        let lattice_b = |y: f64| y / half_height;
        let r_of = |x: f64, y: f64| (2.5 * lattice_b(y) - x) / 7.0;
        let corners = [(lo.x, lo.y), (lo.x, hi.y), (hi.x, lo.y), (hi.x, hi.y)];
        let (r_min, r_max) = corners
            .iter()
            .map(|&(x, y)| r_of(x, y))
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), r| {
                (lo.min(r), hi.max(r))
            });
        let rs = cell_range(r_min, r_max);
        let qs = |r: i32| {
            let r = r as f64;
            let by_x = ((lo.x - 0.5 * r) / 2.5, (hi.x - 0.5 * r) / 2.5);
            let by_y = (lattice_b(lo.y) - 3.0 * r, lattice_b(hi.y) - 3.0 * r);
            cell_range(by_x.0.max(by_y.0), by_x.1.min(by_y.1))
        };
        anchor_cells(rs, qs, SnubHexagonalKind::ALL.len(), limit, |r, q, kind| {
            SnubHexagonalPoint::new(q, r, SnubHexagonalKind::ALL[kind])
        })
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<SnubHexagonalPoint>, FieldOpError> {
        let origin = self.center(SnubHexagonalPoint::hexagon(0, 0));
        // `cols × rows` hexagon pitches, centered on the origin hexagon.
        let mut cells = preset_cells(self, key, params, origin, Inclusion::WholeCell, || {
            lattice_rect_cells(self, params, origin, Point::new(PITCH, PITCH))
        })?;
        cells.sort();
        Ok(cells)
    }

    fn area(&self, cell: SnubHexagonalPoint) -> f64 {
        regular_polygon_area(self.faces_of(cell).len())
    }
}

/// Center distance of neighboring hexagons, `√7`.
const PITCH: f64 = 2.645_751_311_064_590_7;

/// World position of a lattice point: `x = a + b/2`, `y = b·√3/2`, computed from the integers only,
/// so a vertex shared by several cells gets identical coordinates from each of them.
fn point((a, b): Lattice) -> Point {
    Point::new((2 * a + b) as f64 * 0.5, b as f64 * (SQRT_3 / 2.0))
}
