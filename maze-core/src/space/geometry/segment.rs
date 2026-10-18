use super::{GEOM_EPS, Point};
use std::f64::consts::{FRAC_PI_2, PI, TAU};

/// One piece of a face's boundary — see `Specs/space.md`'s "Geometry". Every operation takes a
/// normalized `t ∈ [0, 1]`, linear in arc length. Consumers never inspect the kind: drawing uses
/// `path_command`, geometric operations use `flatten`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Segment {
    Line {
        from: Point,
        to: Point,
    },
    /// A circular arc from `from` to `to` around `center`, starting at `start_angle` and turning by
    /// `sweep` radians (positive counter-clockwise). The endpoints are stored explicitly so joints
    /// with neighboring segments stay exact; every other point comes from the angles.
    CircularArc {
        from: Point,
        to: Point,
        center: Point,
        radius: f64,
        start_angle: f64,
        sweep: f64,
    },
}

/// One drawing step of a boundary path. A new segment kind adds its own command together with
/// renderer support (e.g. `CubicTo` for Bézier segments).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathCommand {
    MoveTo(Point),
    LineTo(Point),
    ArcTo {
        center: Point,
        radius: f64,
        start_angle: f64,
        end_angle: f64,
        ccw: bool,
    },
}

impl Segment {
    pub fn line(from: Point, to: Point) -> Self {
        Segment::Line { from, to }
    }

    /// The arc around `center` from `start_angle` turning by `sweep`; endpoints computed once here.
    pub fn arc(center: Point, radius: f64, start_angle: f64, sweep: f64) -> Self {
        Segment::CircularArc {
            from: center + Point::polar(radius, start_angle),
            to: center + Point::polar(radius, start_angle + sweep),
            center,
            radius,
            start_angle,
            sweep,
        }
    }

    pub fn start(&self) -> Point {
        match *self {
            Segment::Line { from, .. } | Segment::CircularArc { from, .. } => from,
        }
    }

    pub fn end(&self) -> Point {
        match *self {
            Segment::Line { to, .. } | Segment::CircularArc { to, .. } => to,
        }
    }

    /// The point at arc-length fraction `t`; exactly `start()`/`end()` at `0`/`1`.
    pub fn point(&self, t: f64) -> Point {
        if t <= 0.0 {
            return self.start();
        }
        if t >= 1.0 {
            return self.end();
        }
        match *self {
            Segment::Line { from, to } => from + (to - from) * t,
            Segment::CircularArc {
                center,
                radius,
                start_angle,
                sweep,
                ..
            } => center + Point::polar(radius, start_angle + sweep * t),
        }
    }

    /// Unit tangent in the direction of travel at `t`.
    pub fn tangent(&self, t: f64) -> Point {
        match *self {
            Segment::Line { from, to } => (to - from).normalized(),
            Segment::CircularArc {
                start_angle, sweep, ..
            } => {
                let angle = start_angle + sweep * t.clamp(0.0, 1.0);
                let direction = Point::new(-angle.sin(), angle.cos());
                if sweep < 0.0 { -direction } else { direction }
            }
        }
    }

    pub fn length(&self) -> f64 {
        match *self {
            Segment::Line { from, to } => (to - from).length(),
            Segment::CircularArc { radius, sweep, .. } => radius * sweep.abs(),
        }
    }

    /// The same curve traversed the other way: `reversed().point(t) == point(1 - t)`.
    pub fn reversed(&self) -> Self {
        match *self {
            Segment::Line { from, to } => Segment::Line { from: to, to: from },
            Segment::CircularArc {
                from,
                to,
                center,
                radius,
                start_angle,
                sweep,
            } => Segment::CircularArc {
                from: to,
                to: from,
                center,
                radius,
                start_angle: start_angle + sweep,
                sweep: -sweep,
            },
        }
    }

    /// The two halves at `t`; both share the split point exactly.
    pub fn split(&self, t: f64) -> (Segment, Segment) {
        let t = t.clamp(0.0, 1.0);
        let mid = self.point(t);
        match *self {
            Segment::Line { from, to } => (
                Segment::Line { from, to: mid },
                Segment::Line { from: mid, to },
            ),
            Segment::CircularArc {
                from,
                to,
                center,
                radius,
                start_angle,
                sweep,
            } => (
                Segment::CircularArc {
                    from,
                    to: mid,
                    center,
                    radius,
                    start_angle,
                    sweep: sweep * t,
                },
                Segment::CircularArc {
                    from: mid,
                    to,
                    center,
                    radius,
                    start_angle: start_angle + sweep * t,
                    sweep: sweep * (1.0 - t),
                },
            ),
        }
    }

    /// Polyline approximation: endpoints exactly `point(0)`/`point(1)`, max distance to the true
    /// curve at most `tolerance` (world units, floored at `GEOM_EPS`), deterministic. A line
    /// yields its two endpoints.
    pub fn flatten(&self, tolerance: f64) -> Vec<Point> {
        match *self {
            Segment::Line { from, to } => vec![from, to],
            Segment::CircularArc {
                from,
                to,
                center,
                radius,
                sweep,
                ..
            } => {
                let pieces = arc_pieces(radius, sweep, tolerance);
                // Interior points are spherical interpolations between the endpoint vectors. The
                // two weights are built from the integer indices alone and added, so an arc and
                // its `reversed()` flatten to bit-identical point lists (one the reverse of the
                // other), which paired faces rely on.
                let (u, v) = (from - center, to - center);
                let angle = sweep.abs();
                let weight = |i: usize| (angle * (i as f64 / pieces as f64)).sin() / angle.sin();
                let mut points = Vec::with_capacity(pieces + 1);
                points.push(from);
                for i in 1..pieces {
                    points.push(center + (u * weight(pieces - i) + v * weight(i)));
                }
                points.push(to);
                points
            }
        }
    }

    /// The command drawing this segment from its start (the caller has already moved there).
    pub fn path_command(&self) -> PathCommand {
        match *self {
            Segment::Line { to, .. } => PathCommand::LineTo(to),
            Segment::CircularArc {
                center,
                radius,
                start_angle,
                sweep,
                ..
            } => PathCommand::ArcTo {
                center,
                radius,
                start_angle,
                end_angle: start_angle + sweep,
                ccw: sweep > 0.0,
            },
        }
    }

    /// Distance from `p` to the closest point of the segment.
    pub fn distance_to(&self, p: Point) -> f64 {
        match *self {
            Segment::Line { from, to } => distance_to_line_segment(p, from, to),
            Segment::CircularArc {
                from,
                to,
                center,
                radius,
                start_angle,
                sweep,
            } => {
                let offset = p - center;
                if offset.length() > 0.0 && angle_in_sweep(offset.angle(), start_angle, sweep) {
                    (offset.length() - radius).abs()
                } else {
                    (p - from).length().min((p - to).length())
                }
            }
        }
    }

    /// Signed area between the segment and the origin (shoelace contribution), so a closed chain's
    /// contributions sum to its signed area — positive counter-clockwise.
    pub fn signed_area_contribution(&self) -> f64 {
        let (a, b) = (self.start(), self.end());
        let chord = a.cross(b) / 2.0;
        match *self {
            Segment::Line { .. } => chord,
            Segment::CircularArc { radius, sweep, .. } => {
                // The circular segment between chord and arc, on the arc's turning side.
                chord + radius * radius / 2.0 * (sweep - sweep.sin())
            }
        }
    }

    /// Number of crossings of the ray from `p` toward +x with this segment, half-open in `y` so a
    /// closed chain counts each crossing exactly once (even-odd rule).
    pub fn ray_crossings(&self, p: Point) -> usize {
        match *self {
            Segment::Line { from, to } => usize::from(line_crosses_ray(p, from, to)),
            Segment::CircularArc {
                center,
                radius,
                start_angle,
                sweep,
                ..
            } => {
                // Cut the arc at its y-extrema: each piece is monotone in y, so it obeys the same
                // half-open rule as a line and crosses the ray's line at most once, on the side
                // of the center its cosine sign gives.
                let mut cuts = vec![0.0, 1.0];
                cuts.extend(extremum_fractions(start_angle, sweep, FRAC_PI_2));
                cuts.sort_by(f64::total_cmp);
                cuts.windows(2)
                    .filter(|w| {
                        let (a, b) = (self.point(w[0]), self.point(w[1]));
                        if (a.y > p.y) == (b.y > p.y) {
                            return false;
                        }
                        let mid_angle = start_angle + sweep * (w[0] + w[1]) / 2.0;
                        let dy = p.y - center.y;
                        let half_chord = (radius * radius - dy * dy).max(0.0).sqrt();
                        center.x + mid_angle.cos().signum() * half_chord > p.x
                    })
                    .count()
            }
        }
    }
}

impl Segment {
    /// Points bounding the segment: its endpoints plus, for an arc, its axis extrema.
    pub fn extreme_points(&self) -> Vec<Point> {
        let mut points = vec![self.start(), self.end()];
        if let Segment::CircularArc {
            start_angle, sweep, ..
        } = *self
        {
            for phase in [0.0, FRAC_PI_2] {
                points.extend(
                    extremum_fractions(start_angle, sweep, phase)
                        .into_iter()
                        .map(|t| self.point(t)),
                );
            }
        }
        points
    }

    /// Whether this segment and the line segment `a`–`b` share a point (within `GEOM_EPS`).
    pub fn touches_line(&self, a: Point, b: Point) -> bool {
        match *self {
            Segment::Line { from, to } => segments_touch(from, to, a, b),
            Segment::CircularArc {
                from, to, center, ..
            } => {
                !self.line_hits(a, b).is_empty()
                    || distance_to_line_segment(from, a, b) <= GEOM_EPS
                    || distance_to_line_segment(to, a, b) <= GEOM_EPS
                    || self.distance_to(a) <= GEOM_EPS
                    || self.distance_to(b) <= GEOM_EPS
                    || self.distance_to(closest_on_line_segment(center, a, b)) <= GEOM_EPS
            }
        }
    }

    /// Whether this segment crosses the line segment `a`–`b` transversally at a point interior to
    /// both (touching at an endpoint or tangentially does not count).
    pub fn crosses_line(&self, a: Point, b: Point) -> bool {
        match *self {
            Segment::Line { from, to } => segments_cross(from, to, a, b),
            Segment::CircularArc { from, to, .. } => self.line_hits(a, b).into_iter().any(|q| {
                [from, to, a, b]
                    .iter()
                    .all(|&end| end.distance(q) > GEOM_EPS)
            }),
        }
    }

    /// Transversal intersections of an arc with the line segment `a`–`b` (none for a line, and
    /// none for a tangent line).
    fn line_hits(&self, a: Point, b: Point) -> Vec<Point> {
        let Segment::CircularArc {
            center,
            radius,
            start_angle,
            sweep,
            ..
        } = *self
        else {
            return Vec::new();
        };
        let d = b - a;
        let f = a - center;
        let (qa, qb, qc) = (d.dot(d), 2.0 * f.dot(d), f.dot(f) - radius * radius);
        let discriminant = qb * qb - 4.0 * qa * qc;
        if qa == 0.0 || discriminant <= 0.0 {
            return Vec::new();
        }
        let root = discriminant.sqrt();
        [(-qb - root) / (2.0 * qa), (-qb + root) / (2.0 * qa)]
            .into_iter()
            .filter(|&t| (0.0..=1.0).contains(&t))
            .map(|t| a + d * t)
            .filter(|&q| angle_in_sweep((q - center).angle(), start_angle, sweep))
            .collect()
    }
}

/// Pieces an arc of `radius`/`sweep` is cut into so each chord's sagitta stays within `tolerance`.
/// The tolerance is floored at `GEOM_EPS` — a finer one is below the geometry's own precision and
/// would only multiply the piece count without bound.
fn arc_pieces(radius: f64, sweep: f64, tolerance: f64) -> usize {
    let tolerance = tolerance.max(GEOM_EPS);
    if radius <= tolerance {
        return 1;
    }
    let max_step = 2.0 * (1.0 - tolerance / radius).acos();
    ((sweep.abs() / max_step).ceil() as usize).max(1)
}

/// Fractions `t ∈ (0, 1)` where an arc from `start` turning by `sweep` reaches an angle
/// `phase + kπ` — `phase = π/2` gives its y-extrema, `phase = 0` its x-extrema.
fn extremum_fractions(start: f64, sweep: f64, phase: f64) -> Vec<f64> {
    if sweep == 0.0 {
        return Vec::new();
    }
    let (lo, hi) = if sweep > 0.0 {
        (start, start + sweep)
    } else {
        (start + sweep, start)
    };
    let first = ((lo - phase) / PI).floor() as i64;
    let last = ((hi - phase) / PI).ceil() as i64;
    (first..=last)
        .map(|k| (phase + k as f64 * PI - start) / sweep)
        .filter(|&t| t > 0.0 && t < 1.0)
        .collect()
}

fn angle_in_sweep(angle: f64, start: f64, sweep: f64) -> bool {
    let offset = if sweep >= 0.0 {
        (angle - start).rem_euclid(TAU)
    } else {
        (start - angle).rem_euclid(TAU)
    };
    offset <= sweep.abs()
}

pub(crate) fn distance_to_line_segment(p: Point, a: Point, b: Point) -> f64 {
    (p - closest_on_line_segment(p, a, b)).length()
}

fn closest_on_line_segment(p: Point, a: Point, b: Point) -> Point {
    let ab = b - a;
    let len2 = ab.dot(ab);
    if len2 == 0.0 {
        return a;
    }
    a + ab * ((p - a).dot(ab) / len2).clamp(0.0, 1.0)
}

/// Whether line segments `a1`–`a2` and `b1`–`b2` share a point (within `GEOM_EPS`).
pub(crate) fn segments_touch(a1: Point, a2: Point, b1: Point, b2: Point) -> bool {
    segments_cross(a1, a2, b1, b2)
        || distance_to_line_segment(a1, b1, b2) <= GEOM_EPS
        || distance_to_line_segment(a2, b1, b2) <= GEOM_EPS
        || distance_to_line_segment(b1, a1, a2) <= GEOM_EPS
        || distance_to_line_segment(b2, a1, a2) <= GEOM_EPS
}

/// Whether two line segments cross at a single interior point of both (no endpoint involved).
pub(crate) fn segments_cross(a1: Point, a2: Point, b1: Point, b2: Point) -> bool {
    let side = |p: Point, q1: Point, q2: Point| (q2 - q1).cross(p - q1);
    let (d1, d2) = (side(a1, b1, b2), side(a2, b1, b2));
    let (d3, d4) = (side(b1, a1, a2), side(b2, a1, a2));
    d1 * d2 < 0.0 && d3 * d4 < 0.0
}

/// Whether the ray from `p` toward +x crosses `a`–`b`, counting an endpoint only when it is the
/// segment's lower end (half-open), so vertices shared by two edges count once.
pub(crate) fn line_crosses_ray(p: Point, a: Point, b: Point) -> bool {
    if (a.y > p.y) == (b.y > p.y) {
        return false;
    }
    let x = a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x);
    x > p.x
}
