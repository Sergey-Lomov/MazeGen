use super::segment::{distance_to_line_segment, line_crosses_ray};
use super::{GEOM_EPS, PathCommand, Point, Segment};

/// A cell's closed boundary: each face's segment chain, in `faces_of` order. Invariants (tested
/// per tessellation): closed, exact joints, no self-intersection, counter-clockwise, face order
/// equal to `faces_of`.
#[derive(Debug, Clone, PartialEq)]
pub struct BoundaryPath {
    faces: Vec<Vec<Segment>>,
}

impl BoundaryPath {
    pub fn new(faces: Vec<Vec<Segment>>) -> Self {
        BoundaryPath { faces }
    }

    /// Per-face segment chains, in `faces_of` order.
    pub fn faces(&self) -> &[Vec<Segment>] {
        &self.faces
    }

    pub fn segments(&self) -> impl Iterator<Item = &Segment> {
        self.faces.iter().flatten()
    }

    /// `MoveTo` the first segment's start, then one command per segment.
    pub fn path_commands(&self) -> Vec<PathCommand> {
        let mut commands = Vec::with_capacity(self.segments().count() + 1);
        if let Some(first) = self.segments().next() {
            commands.push(PathCommand::MoveTo(first.start()));
        }
        commands.extend(self.segments().map(Segment::path_command));
        commands
    }

    /// The closed polyline (first point not repeated at the end), each segment flattened within
    /// `tolerance`. Joints appear once.
    pub fn flatten(&self, tolerance: f64) -> Vec<Point> {
        let mut points = Vec::new();
        for segment in self.segments() {
            let flat = segment.flatten(tolerance);
            points.extend_from_slice(&flat[..flat.len() - 1]);
        }
        points
    }

    /// Signed area, positive for a counter-clockwise boundary. Exact for lines and arcs.
    pub fn signed_area(&self) -> f64 {
        self.segments().map(Segment::signed_area_contribution).sum()
    }

    /// Whether `point` lies inside or on the closed boundary (within `GEOM_EPS`).
    pub fn contains(&self, point: Point) -> bool {
        if self.segments().any(|s| s.distance_to(point) <= GEOM_EPS) {
            return true;
        }
        self.segments()
            .map(|s| s.ray_crossings(point))
            .sum::<usize>()
            % 2
            == 1
    }

    /// Axis-aligned bounds of the boundary (exact for lines and arcs).
    pub fn bounds(&self) -> (Point, Point) {
        let points: Vec<Point> = self.segments().flat_map(Segment::extreme_points).collect();
        bounds_of(&points)
    }
}

/// Arc-length midpoint of a segment chain — a face's contact point.
pub fn chain_midpoint(chain: &[Segment]) -> Point {
    let total: f64 = chain.iter().map(Segment::length).sum();
    let mut remaining = total / 2.0;
    for segment in chain {
        let length = segment.length();
        if remaining <= length {
            return segment.point(if length == 0.0 {
                0.0
            } else {
                remaining / length
            });
        }
        remaining -= length;
    }
    chain.last().map_or(Point::default(), Segment::end)
}

pub(super) fn bounds_of(points: &[Point]) -> (Point, Point) {
    let mut min = Point::new(f64::INFINITY, f64::INFINITY);
    let mut max = Point::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in points {
        min = Point::new(min.x.min(p.x), min.y.min(p.y));
        max = Point::new(max.x.max(p.x), max.y.max(p.y));
    }
    (min, max)
}

/// Whether `point` lies inside or on the closed polygon `polygon` (within `GEOM_EPS`).
pub(super) fn polygon_contains(polygon: &[Point], point: Point) -> bool {
    let edges = || {
        polygon
            .iter()
            .zip(polygon.iter().cycle().skip(1))
            .map(|(&a, &b)| (a, b))
    };
    if edges().any(|(a, b)| distance_to_line_segment(point, a, b) <= GEOM_EPS) {
        return true;
    }
    edges()
        .filter(|&(a, b)| line_crosses_ray(point, a, b))
        .count()
        % 2
        == 1
}
