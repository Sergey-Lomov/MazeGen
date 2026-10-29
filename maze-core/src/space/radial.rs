//! The radial tessellation: one central cell surrounded by concentric rings of cells, where the
//! number of cells per ring grows with the distance from the center so that cells keep a similar
//! size.
//!
//! The center is a disc of radius 1; ring `r` (`r >= 1`) is the annulus between radii `r` and
//! `r + 1`, cut into `ring_count(r)` equal sectors. How the counts grow is the `RadialLayout`:
//! `Classic` keeps the count or doubles it once a cell is about twice as wide as the ring is thick,
//! so every sector boundary of a ring is also one of the next; `Smooth` follows the ring area
//! (`n · (2r + 1) / 3` cells, multiples of three) with a searched table in which neighboring rings
//! never share a boundary closer than a third of the narrower cell.
//! Where boundaries of neighboring rings differ, a cell borders several cells of the next ring
//! (`Outer(k)` faces, counter-clockwise) and of the previous ring (`Inner(m)` faces, clockwise as
//! the inner arc is traversed), each through the part of the arc both share. The faces of a ring
//! cell are `Outer(0..a)`, `Next`, `Inner(0..b)`, `Prev`; the center has `Outer(0..ring_count(1))`.
//! The outermost ring's outer arc is a single `Outer(0)` face without a neighbor.
//! The tessellation holds at most `max_cells` cells.

use super::field_ops::{CIRCLE_PRESET, Inclusion, circle_cells, param, validate_preset};
use super::{
    CellShape, FieldOpError, FieldOperation, GEOM_EPS, Point, PresetDescriptor, PresetParams,
    Segment, ShapeDescriptor, ShapeFamily, Tessellation, is_straight_geometric,
};
use std::f64::consts::{PI, TAU};

pub const MIN_FIRST_RING_CELLS: u32 = 6;
pub const MAX_FIRST_RING_CELLS: u32 = 24;
/// Range of `max_cells`, the cell count (the center included) at which the rings stop.
pub const MIN_CELL_LIMIT: u32 = 100;
pub const MAX_CELL_LIMIT: u32 = 10_000;
pub const DEFAULT_CELL_LIMIT: u32 = 3000;

/// Most outer / inner neighbors a ring cell can have; construction fails beyond that.
const MAX_OUTER: usize = 4;
const MAX_INNER: usize = 3;

/// Angular slack (radians) widening the sector range of a candidate query.
const ANGLE_SLACK: f64 = 1e-6;

/// A classic ring doubles its count when a cell of the previous count would be at least this many
/// times wider (at the ring's mid radius) than the ring is thick.
const CLASSIC_SPLIT_WIDTH: f64 = 1.5;
/// Smooth layout: allowed relative deviation of a ring's count from the area-proportional count.
const SMOOTH_WINDOW: f64 = 0.25;
/// Smooth layout: the narrowest shared arc between two rings, in units of the narrower cell,
/// is at least `1 / SMOOTH_MIN_SHARE`.
const SMOOTH_MIN_SHARE: u64 = 3;

/// Names of the ring shapes by outer and inner neighbor count.
const RING_SHAPE_NAMES: [[&str; MAX_INNER]; MAX_OUTER] = [
    ["ring_1_1", "ring_1_2", "ring_1_3"],
    ["ring_2_1", "ring_2_2", "ring_2_3"],
    ["ring_3_1", "ring_3_2", "ring_3_3"],
    ["ring_4_1", "ring_4_2", "ring_4_3"],
];

/// How the cell count grows from ring to ring.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum RadialLayout {
    /// Ring 1 holds `first_ring_cells`; later a ring keeps the count of the previous one or
    /// doubles it. Boundaries of neighboring rings always coincide.
    Classic,
    /// Counts follow the ring area for evenly sized cells; ring 1 holds `first_ring_cells`
    /// rounded to a multiple of three.
    Smooth,
}

impl RadialLayout {
    pub const ALL: [RadialLayout; 2] = [RadialLayout::Classic, RadialLayout::Smooth];

    /// The wire name of the layout.
    pub fn name(self) -> &'static str {
        match self {
            RadialLayout::Classic => "classic",
            RadialLayout::Smooth => "smooth",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|layout| layout.name() == name)
    }
}

/// The size and layout of the rings.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct RadialParams {
    /// Approximate cell count of ring 1.
    pub first_ring_cells: u32,
    pub layout: RadialLayout,
    /// The rings stop before the first one that would bring the cell count (the center
    /// included) above this limit.
    pub max_cells: u32,
}

/// `ring == 0, index == 0` is the center; otherwise `ring >= 1` and `index < ring_count(ring)`,
/// counted counter-clockwise from the positive x axis.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct RadialPoint {
    pub ring: i32,
    pub index: i32,
}

impl RadialPoint {
    pub const CENTER: RadialPoint = RadialPoint { ring: 0, index: 0 };
}

/// A face of a radial cell. `Outer(k)` is the `k`-th outer-ring neighbor counter-clockwise (for the
/// center, the `k`-th ring-1 cell); `Next` and `Prev` are the radial sides toward the next and the
/// previous cell of the ring; `Inner(m)` is the `m`-th inner-ring neighbor clockwise.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum RadialFace {
    Outer(u32),
    Next,
    Inner(u32),
    Prev,
}

/// A fraction of a turn `(numerator, denominator)`.
type Turn = (i64, i64);

#[derive(Debug, Clone)]
pub struct RadialTessellation {
    params: RadialParams,
    /// Cell count of ring `r` at index `r - 1`.
    ring_counts: Vec<u32>,
    center_faces: Vec<RadialFace>,
    /// Face lists of ring cells by `(outer - 1) * MAX_INNER + (inner - 1)`.
    ring_faces: Vec<Vec<RadialFace>>,
    /// `0..max face count`; the `faces_of(cell).len()` long prefix is the cell's
    /// `local_to_canonical` (`faces_of` is already the canonical order).
    identity: Vec<usize>,
    /// The center, then the ring shapes that occur.
    shapes: Vec<ShapeDescriptor>,
    /// Index into `shapes` by `(outer - 1) * MAX_INNER + (inner - 1)`.
    shape_slots: Vec<Option<usize>>,
}

impl RadialTessellation {
    /// Builds the tessellation, rejecting parameters outside their supported ranges.
    pub fn new(params: RadialParams) -> Result<Self, String> {
        check_range(
            "first_ring_cells",
            params.first_ring_cells,
            MIN_FIRST_RING_CELLS,
            MAX_FIRST_RING_CELLS,
        )?;
        check_range(
            "max_cells",
            params.max_cells,
            MIN_CELL_LIMIT,
            MAX_CELL_LIMIT,
        )?;
        let ring_counts = ring_counts(params);
        let mut this = Self {
            params,
            center_faces: (0..ring_counts[0]).map(RadialFace::Outer).collect(),
            shapes: vec![ShapeDescriptor::regular_polygon(ring_counts[0] as usize)],
            ring_counts,
            ring_faces: Vec::new(),
            identity: Vec::new(),
            shape_slots: vec![None; MAX_OUTER * MAX_INNER],
        };
        for outer in 1..=MAX_OUTER {
            for inner in 1..=MAX_INNER {
                this.ring_faces.push(
                    (0..outer as u32)
                        .map(RadialFace::Outer)
                        .chain([RadialFace::Next])
                        .chain((0..inner as u32).map(RadialFace::Inner))
                        .chain([RadialFace::Prev])
                        .collect(),
                );
            }
        }
        for ring in 1..=this.ring_total() as i32 {
            for index in 0..this.ring_counts[ring as usize - 1] as i32 {
                let (outer, inner) = this.neighbor_counts(RadialPoint { ring, index });
                if outer > MAX_OUTER || inner > MAX_INNER {
                    return Err(format!(
                        "ring {ring} cell {index} has {outer} outer and {inner} inner neighbors"
                    ));
                }
                let slot = (outer - 1) * MAX_INNER + inner - 1;
                if this.shape_slots[slot].is_none() {
                    this.shape_slots[slot] = Some(this.shapes.len());
                    this.shapes.push(ring_shape(outer, inner));
                }
            }
        }
        this.identity = (0..this.center_faces.len().max(MAX_OUTER + MAX_INNER + 2)).collect();
        Ok(this)
    }

    pub fn params(&self) -> RadialParams {
        self.params
    }

    /// Number of rings around the center; cells of the last ring have no outer neighbors.
    pub fn ring_total(&self) -> u32 {
        self.ring_counts.len() as u32
    }

    /// Cells of ring `ring` (`ring >= 1`), `None` beyond the last ring.
    pub fn ring_count(&self, ring: i32) -> Option<u32> {
        let slot = usize::try_from(ring.checked_sub(1)?).ok()?;
        self.ring_counts.get(slot).copied()
    }

    fn count(&self, ring: i32) -> i64 {
        i64::from(self.ring_count(ring).expect("ring within the table"))
    }

    /// `(first, len)`: the cells of ring `other` whose sectors overlap sector `index` of a ring
    /// of `count` sectors (`other_count` is the sector count of `other`).
    fn overlap(index: i64, count: i64, other_count: i64) -> (i64, i64) {
        let first = index * other_count / count;
        let last = ((index + 1) * other_count + count - 1) / count - 1;
        (first, last - first + 1)
    }

    /// Outer-ring cells of a ring cell: `(first, len)`; `None` for the last ring.
    fn outer_span(&self, cell: RadialPoint) -> Option<(i64, i64)> {
        self.ring_count(cell.ring + 1)?;
        Some(Self::overlap(
            i64::from(cell.index),
            self.count(cell.ring),
            self.count(cell.ring + 1),
        ))
    }

    /// Inner-ring cells of a ring cell of ring >= 2: `(first, len)`.
    fn inner_span(&self, cell: RadialPoint) -> (i64, i64) {
        Self::overlap(
            i64::from(cell.index),
            self.count(cell.ring),
            self.count(cell.ring - 1),
        )
    }

    /// `(outer, inner)` face counts of a ring cell.
    fn neighbor_counts(&self, cell: RadialPoint) -> (usize, usize) {
        let outer = self.outer_span(cell).map_or(1, |(_, len)| len as usize);
        let inner = if cell.ring == 1 {
            1
        } else {
            self.inner_span(cell).1 as usize
        };
        (outer, inner)
    }

    /// The arc of radius `radius` over `lo..hi` turns, counter-clockwise.
    fn forward_arc(radius: i32, lo: Turn, hi: Turn) -> Segment {
        let (start, end) = (turn_angle(lo), turn_angle(hi));
        Segment::CircularArc {
            from: Self::vertex(radius, lo),
            to: Self::vertex(radius, hi),
            center: Point::default(),
            radius: radius as f64,
            start_angle: start,
            sweep: end - start,
        }
    }

    /// Point of ring-boundary radius `radius` at `turn`. The fraction is reduced first, so a vertex
    /// shared by cells of rings with different counts gets bit-identical coordinates from each.
    fn vertex(radius: i32, (numerator, denominator): Turn) -> Point {
        let numerator = numerator.rem_euclid(denominator);
        if numerator == 0 {
            return Point::new(radius as f64, 0.0);
        }
        Point::polar(radius as f64, turn_angle((numerator, denominator)))
    }

    /// The arc shared by sector `(idx, count)` of ring `ring` and sector `(other, other_count)` of
    /// the neighboring ring, counter-clockwise.
    fn shared_arc(radius: i32, a: Turn, b: Turn) -> Segment {
        let lo = if less(a, b) { b } else { a };
        let hi_a = (a.0 + 1, a.1);
        let hi_b = (b.0 + 1, b.1);
        let hi = if less(hi_a, hi_b) { hi_a } else { hi_b };
        Self::forward_arc(radius, lo, hi)
    }
}

/// The cell counts of the rings around the center, up to `max_cells` cells in all.
fn ring_counts(params: RadialParams) -> Vec<u32> {
    let mut counts = match params.layout {
        RadialLayout::Classic => classic_counts(params.first_ring_cells, params.max_cells),
        RadialLayout::Smooth => smooth_counts(params.first_ring_cells, params.max_cells),
    };
    let mut total = 1u32;
    counts.retain(|&count| {
        total += count;
        total <= params.max_cells
    });
    counts
}

fn classic_counts(first: u32, max_cells: u32) -> Vec<u32> {
    let mut counts = vec![first];
    let mut total = first;
    while total <= max_cells {
        let previous = *counts.last().expect("ring 1 exists");
        let ring = counts.len() as f64 + 1.0;
        let width = TAU * (ring + 0.5) / f64::from(previous);
        let count = if width >= CLASSIC_SPLIT_WIDTH {
            2 * previous
        } else {
            previous
        };
        counts.push(count);
        total += count;
    }
    counts
}

/// Per ring the area-proportional count `first · (2r + 1) / 3` is the ideal; the table minimizes
/// the squared relative deviation from it over multiples of three within `SMOOTH_WINDOW`, with
/// non-decreasing counts and a share of at least `1 / SMOOTH_MIN_SHARE` of the narrower cell on
/// every shared arc.
fn smooth_counts(first: u32, max_cells: u32) -> Vec<u32> {
    let ideal = |ring: u32| f64::from(first) * f64::from(2 * ring + 1) / 3.0;
    let mut rings = 0u32;
    let mut area = 0.0;
    while area + ideal(rings + 1) <= f64::from(max_cells) {
        rings += 1;
        area += ideal(rings);
    }
    // layers[r]: (count, cost up to this ring, index of the best previous entry).
    let mut layers: Vec<Vec<(u32, f64, usize)>> = Vec::new();
    for ring in 1..=rings {
        let x = ideal(ring);
        let low = ((x * (1.0 - SMOOTH_WINDOW)) as u32).div_ceil(3).max(2) * 3;
        let high = (x * (1.0 + SMOOTH_WINDOW)).ceil() as u32 / 3 * 3;
        let mut layer = Vec::new();
        for count in (low..=high.max(low)).step_by(3) {
            let cost = ((f64::from(count) - x) / x).powi(2);
            match layers.last() {
                None => layer.push((count, cost, 0)),
                Some(previous) => {
                    let best = previous
                        .iter()
                        .enumerate()
                        .filter(|(_, (before, _, _))| {
                            *before <= count && shares_enough(*before, count)
                        })
                        .min_by(|a, b| a.1.1.total_cmp(&b.1.1));
                    if let Some((index, (_, before_cost, _))) = best {
                        layer.push((count, before_cost + cost, index));
                    }
                }
            }
        }
        if layer.is_empty() {
            break;
        }
        layers.push(layer);
    }
    let Some(last) = layers.last() else {
        return vec![first.div_ceil(3).max(2) * 3];
    };
    let mut index = last
        .iter()
        .enumerate()
        .min_by(|a, b| a.1.1.total_cmp(&b.1.1))
        .map(|(index, _)| index)
        .expect("layer is not empty");
    let mut counts = Vec::with_capacity(layers.len());
    for layer in layers.iter().rev() {
        counts.push(layer[index].0);
        index = layer[index].2;
    }
    counts.reverse();
    counts
}

/// Whether the shared arcs between rings of `a` and `b` sectors are all at least
/// `1 / SMOOTH_MIN_SHARE` of the narrower cell (equal counts share whole cells).
///
/// In lowest terms `a / g` and `b / g` are coprime, so one block of the circle is cut at multiples
/// of `b` and of `a` with a narrowest gap of exactly one unit, while the narrower cell is
/// `min(a, b) / g` units wide: the condition reduces to that width being at most `SMOOTH_MIN_SHARE`.
fn shares_enough(a: u32, b: u32) -> bool {
    let divisor = gcd(u64::from(a), u64::from(b));
    u64::from(a.min(b)) / divisor <= SMOOTH_MIN_SHARE
}

/// `a < b` for fractions with positive denominators.
fn less(a: Turn, b: Turn) -> bool {
    a.0 * b.1 < b.0 * a.1
}

/// The angle of a fraction of a turn, reduced first so equal fractions give equal angles.
fn turn_angle((numerator, denominator): Turn) -> f64 {
    let divisor = gcd(numerator.unsigned_abs(), denominator as u64).max(1) as i64;
    TAU * (numerator / divisor) as f64 / (denominator / divisor) as f64
}

fn check_range(name: &str, value: u32, min: u32, max: u32) -> Result<(), String> {
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(format!(
            "{name} must be between {min} and {max}, got {value}"
        ))
    }
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// A ring cell with `outer` outer and `inner` inner neighbors: faces `Outer(0..outer)`, `Next`,
/// `Inner(0..inner)`, `Prev` in canonical order. Its only symmetry besides the identity is the
/// mirror across the radial axis.
fn ring_shape(outer: usize, inner: usize) -> ShapeDescriptor {
    let count = outer + inner + 2;
    let mirror = (0..count)
        .map(|i| match i {
            i if i < outer => outer - 1 - i,
            i if i == outer => count - 1,
            i if i < outer + 1 + inner => 2 * outer + inner + 1 - i,
            _ => outer,
        })
        .collect();
    ShapeDescriptor::new(ShapeFamily::Registered {
        kind: "radial",
        name: RING_SHAPE_NAMES[outer - 1][inner - 1],
        face_count: count,
        generators: vec![mirror],
    })
}

impl Tessellation for RadialTessellation {
    type CellId = RadialPoint;
    type Face = RadialFace;

    fn is_valid_cell(&self, cell: RadialPoint) -> bool {
        if cell.ring == 0 {
            return cell.index == 0;
        }
        self.ring_count(cell.ring)
            .is_some_and(|count| (0..count as i64).contains(&i64::from(cell.index)))
    }

    fn faces_of(&self, cell: RadialPoint) -> &[RadialFace] {
        debug_assert!(self.is_valid_cell(cell), "invalid cell {cell:?}");
        if cell.ring == 0 {
            return &self.center_faces;
        }
        let (outer, inner) = self.neighbor_counts(cell);
        &self.ring_faces[(outer - 1) * MAX_INNER + inner - 1]
    }

    fn neighbor(&self, cell: RadialPoint, face: RadialFace) -> Option<(RadialPoint, RadialFace)> {
        debug_assert!(self.faces_of(cell).contains(&face), "{face:?} of {cell:?}");
        let point = |ring: i32, index: i64| RadialPoint {
            ring,
            index: index as i32,
        };
        if cell.ring == 0 {
            let RadialFace::Outer(k) = face else {
                return None;
            };
            return Some((point(1, i64::from(k)), RadialFace::Inner(0)));
        }
        let count = self.count(cell.ring);
        let index = i64::from(cell.index);
        match face {
            RadialFace::Next => Some((point(cell.ring, (index + 1) % count), RadialFace::Prev)),
            RadialFace::Prev => Some((
                point(cell.ring, (index + count - 1) % count),
                RadialFace::Next,
            )),
            RadialFace::Outer(k) => {
                let (first, _) = self.outer_span(cell)?;
                let target = point(cell.ring + 1, first + i64::from(k));
                let (inner_first, inner_len) = self.inner_span(target);
                let m = inner_first + inner_len - 1 - index;
                Some((target, RadialFace::Inner(m as u32)))
            }
            RadialFace::Inner(m) if cell.ring == 1 => {
                debug_assert_eq!(m, 0);
                Some((RadialPoint::CENTER, RadialFace::Outer(cell.index as u32)))
            }
            RadialFace::Inner(m) => {
                let (first, len) = self.inner_span(cell);
                let target = point(cell.ring - 1, first + len - 1 - i64::from(m));
                let (outer_first, _) = self.outer_span(target).expect("inner ring has an outer");
                Some((target, RadialFace::Outer((index - outer_first) as u32)))
            }
        }
    }

    /// The geometric definition (`is_straight_geometric`) over the contact points and the center.
    fn is_straight(&self, cell: RadialPoint, in_face: RadialFace, out_face: RadialFace) -> bool {
        debug_assert!(self.faces_of(cell).contains(&in_face));
        debug_assert!(self.faces_of(cell).contains(&out_face));
        is_straight_geometric(self, cell, in_face, out_face)
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &self.shapes
    }

    fn shape_of(&self, cell: RadialPoint) -> Option<CellShape<'_>> {
        let faces = self.faces_of(cell);
        let descriptor = if cell.ring == 0 {
            &self.shapes[0]
        } else {
            let (outer, inner) = self.neighbor_counts(cell);
            &self.shapes[self.shape_slots[(outer - 1) * MAX_INNER + inner - 1]?]
        };
        Some(CellShape::full(descriptor, &self.identity[..faces.len()]))
    }

    /// The center is the origin; a ring cell's center is the middle of its radial span on its
    /// bisector.
    fn center(&self, cell: RadialPoint) -> Point {
        if cell.ring == 0 {
            return Point::default();
        }
        let count = f64::from(self.ring_count(cell.ring).expect("valid cell"));
        Point::polar(
            f64::from(cell.ring) + 0.5,
            TAU * (f64::from(cell.index) + 0.5) / count,
        )
    }

    fn face_segments(&self, cell: RadialPoint, face: RadialFace) -> Vec<Segment> {
        debug_assert!(self.faces_of(cell).contains(&face), "{face:?} of {cell:?}");
        if cell.ring == 0 {
            let RadialFace::Outer(k) = face else {
                return Vec::new();
            };
            let count = self.count(1);
            return vec![Self::forward_arc(
                1,
                (i64::from(k), count),
                (i64::from(k) + 1, count),
            )];
        }
        let ring = cell.ring;
        let count = self.count(ring);
        let index = i64::from(cell.index);
        let own = (index, count);
        match face {
            RadialFace::Outer(k) => match self.outer_span(cell) {
                Some((first, _)) => vec![Self::shared_arc(
                    ring + 1,
                    own,
                    (first + i64::from(k), self.count(ring + 1)),
                )],
                None => vec![Self::shared_arc(ring + 1, own, own)],
            },
            RadialFace::Next => vec![Segment::line(
                Self::vertex(ring + 1, (index + 1, count)),
                Self::vertex(ring, (index + 1, count)),
            )],
            RadialFace::Inner(m) => {
                let arc = if ring == 1 {
                    Self::shared_arc(1, own, own)
                } else {
                    let (first, len) = self.inner_span(cell);
                    let other = (first + len - 1 - i64::from(m), self.count(ring - 1));
                    Self::shared_arc(ring, own, other)
                };
                vec![arc.reversed()]
            }
            RadialFace::Prev => vec![Segment::line(
                Self::vertex(ring, (index, count)),
                Self::vertex(ring + 1, (index, count)),
            )],
        }
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<RadialPoint>> {
        let (lo, hi) = (
            Point::new(min.x.min(max.x), min.y.min(max.y)),
            Point::new(min.x.max(max.x), min.y.max(max.y)),
        );
        let nearest = Point::new(0.0_f64.clamp(lo.x, hi.x), 0.0_f64.clamp(lo.y, hi.y));
        let (dmin, dmax) = (
            nearest.length(),
            [lo, hi, Point::new(lo.x, hi.y), Point::new(hi.x, lo.y)]
                .into_iter()
                .map(Point::length)
                .fold(0.0, f64::max),
        );
        let covers_origin = dmin <= GEOM_EPS;
        let center = Point::new((lo.x + hi.x) / 2.0, (lo.y + hi.y) / 2.0);
        // The box seen from the origin spans less than a half turn when it does not cover it.
        let deltas: Vec<f64> = [lo, hi, Point::new(lo.x, hi.y), Point::new(hi.x, lo.y)]
            .into_iter()
            .map(|corner| center.cross(corner).atan2(center.dot(corner)))
            .collect();
        let (turn_lo, turn_hi) = (
            center.angle() + deltas.iter().copied().fold(f64::INFINITY, f64::min) - ANGLE_SLACK,
            center.angle() + deltas.iter().copied().fold(f64::NEG_INFINITY, f64::max) + ANGLE_SLACK,
        );
        let first_ring = ((dmin - GEOM_EPS).ceil() - 1.0).max(1.0);
        let last_ring = (dmax + GEOM_EPS).floor().min(f64::from(self.ring_total()));
        let rings = (first_ring <= last_ring).then_some(first_ring as i32..=last_ring as i32);
        // Sector range `(first, len)` of ring `ring` meeting the box's angular span.
        let span = |ring: i32| -> (i64, i64) {
            let count = i64::from(self.ring_count(ring).expect("ring within the table"));
            if covers_origin || turn_hi - turn_lo >= TAU {
                return (0, count);
            }
            let first = (turn_lo / TAU * count as f64).floor() as i64;
            let last = (turn_hi / TAU * count as f64).floor() as i64;
            (first, (last - first + 1).min(count))
        };
        let include_center = dmin <= 1.0 + GEOM_EPS;
        let mut total = usize::from(include_center);
        for ring in rings.clone().into_iter().flatten() {
            total = total.saturating_add(span(ring).1 as usize);
            if total > limit {
                return None;
            }
        }
        let mut cells = Vec::with_capacity(total);
        if include_center {
            cells.push(RadialPoint::CENTER);
        }
        for ring in rings.into_iter().flatten() {
            let count = i64::from(self.ring_count(ring).expect("ring within the table"));
            let (first, len) = span(ring);
            cells.extend((first..first + len).map(|i| RadialPoint {
                ring,
                index: i.rem_euclid(count) as i32,
            }));
        }
        Some(cells)
    }

    /// Reflections across axes through the origin only; no translation is a symmetry.
    fn field_operations(&self) -> &[FieldOperation] {
        &[FieldOperation::Reflect]
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn preset_param_max(&self, key: &str, name: &str) -> Option<u32> {
        (key == "circle" && name == "radius").then(|| self.ring_total() + 1)
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<RadialPoint>, FieldOpError> {
        validate_preset(&PRESETS, key, params)?;
        match key {
            "circle" => {
                let radius = param(params, "radius");
                let limit = self.preset_param_max(key, "radius").unwrap_or(u32::MAX);
                let max_cells = self.params.max_cells;
                if radius > limit {
                    return Err(FieldOpError::InvalidPreset(format!(
                        "radius must be at most {limit}: the tessellation ends at {max_cells} cells"
                    )));
                }
                circle_cells(self, Point::default(), radius, Inclusion::WholeCell)
            }
            _ => Err(FieldOpError::Unavailable),
        }
    }

    /// The center is a disc of radius 1; ring `r` is `1 / count` of the annulus `[r, r + 1]`.
    fn area(&self, cell: RadialPoint) -> f64 {
        if cell.ring == 0 {
            return PI;
        }
        let count = f64::from(self.ring_count(cell.ring).expect("valid cell"));
        PI * (2.0 * f64::from(cell.ring) + 1.0) / count
    }
}

/// Preset field shapes of the radial tessellation, in UI order: the whole cells within `radius`
/// world units of the center — the center and `radius - 1` rings.
const PRESETS: [PresetDescriptor; 1] = [CIRCLE_PRESET];

#[cfg(test)]
mod tests {
    use super::*;

    /// The definition: cut one block of the circle at multiples of both counts and compare the
    /// narrowest gap with the narrower cell.
    fn shares_enough_by_cuts(a: u32, b: u32) -> bool {
        if a == b {
            return true;
        }
        let divisor = gcd(u64::from(a), u64::from(b));
        let (a, b) = (u64::from(a) / divisor, u64::from(b) / divisor);
        let mut cuts: Vec<u64> = (0..=a)
            .map(|i| i * b)
            .chain((0..=b).map(|j| j * a))
            .collect();
        cuts.sort_unstable();
        let narrowest = cuts
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .filter(|&gap| gap > 0)
            .min()
            .unwrap();
        SMOOTH_MIN_SHARE * narrowest >= a.min(b)
    }

    #[test]
    fn shares_enough_matches_the_cut_definition() {
        for a in 3..=120 {
            for b in 3..=120 {
                assert_eq!(shares_enough(a, b), shares_enough_by_cuts(a, b), "{a} {b}");
            }
        }
    }
}
