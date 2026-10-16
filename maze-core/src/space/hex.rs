use super::square::cell_range;
use super::{CellShape, Point, Segment, ShapeDescriptor, Tessellation};
use std::sync::LazyLock;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct HexPoint {
    pub q: i32,
    pub r: i32,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum HexFace {
    E,
    NE,
    NW,
    W,
    SW,
    SE,
}

impl HexFace {
    /// The face on the other side of the same edge — also the face a straight pass leaves by.
    pub fn opposite(self) -> Self {
        match self {
            HexFace::E => HexFace::W,
            HexFace::NE => HexFace::SW,
            HexFace::NW => HexFace::SE,
            HexFace::W => HexFace::E,
            HexFace::SW => HexFace::NE,
            HexFace::SE => HexFace::NW,
        }
    }
}

static HEX_SHAPES: LazyLock<[ShapeDescriptor; 1]> =
    LazyLock::new(|| [ShapeDescriptor::regular_polygon(6)]);

/// Local `[E, NE, NW, W, SW, SE]` is already counter-clockwise.
const HEX_LOCAL_TO_CANONICAL: [usize; 6] = [0, 1, 2, 3, 4, 5];

#[derive(Debug, Default, Clone, Copy)]
pub struct HexTessellation;

impl Tessellation for HexTessellation {
    type CellId = HexPoint;
    type Face = HexFace;

    fn is_valid_cell(&self, _cell: HexPoint) -> bool {
        true
    }

    fn faces_of(&self, _cell: HexPoint) -> &[HexFace] {
        &[
            HexFace::E,
            HexFace::NE,
            HexFace::NW,
            HexFace::W,
            HexFace::SW,
            HexFace::SE,
        ]
    }

    fn neighbor(&self, cell: HexPoint, face: HexFace) -> Option<(HexPoint, HexFace)> {
        let (dq, dr) = match face {
            HexFace::E => (1, 0),
            HexFace::NE => (1, -1),
            HexFace::NW => (0, -1),
            HexFace::W => (-1, 0),
            HexFace::SW => (-1, 1),
            HexFace::SE => (0, 1),
        };
        let neighbor = HexPoint {
            q: cell.q.checked_add(dq)?,
            r: cell.r.checked_add(dr)?,
        };
        Some((neighbor, face.opposite()))
    }

    fn is_straight(&self, _cell: HexPoint, in_face: HexFace, out_face: HexFace) -> bool {
        out_face == in_face.opposite()
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*HEX_SHAPES
    }

    fn shape_of(&self, _cell: HexPoint) -> Option<CellShape<'_>> {
        Some(CellShape::full(&HEX_SHAPES[0], &HEX_LOCAL_TO_CANONICAL))
    }

    /// Flat-top hexagon of area 1. Lattice coordinates (`hex_lattice`): center `(3q, -(2r + q))`.
    fn center(&self, cell: HexPoint) -> Point {
        hex_lattice(3 * cell.q as i64, -(2 * cell.r as i64 + cell.q as i64))
    }

    /// Face `k` of `[E, NE, NW, W, SW, SE]` runs from the vertex at `60k - 60` degrees to the one
    /// at `60k` degrees.
    fn face_segments(&self, cell: HexPoint, face: HexFace) -> Vec<Segment> {
        const VERTEX: [(i64, i64); 6] = [(2, 0), (1, 1), (-1, 1), (-2, 0), (-1, -1), (1, -1)];
        let k = match face {
            HexFace::E => 0,
            HexFace::NE => 1,
            HexFace::NW => 2,
            HexFace::W => 3,
            HexFace::SW => 4,
            HexFace::SE => 5,
        };
        let (ci, cj) = (3 * cell.q as i64, -(2 * cell.r as i64 + cell.q as i64));
        let vertex = |index: usize| {
            let (di, dj) = VERTEX[index % 6];
            hex_lattice(ci + di, cj + dj)
        };
        vec![Segment::line(vertex(k + 5), vertex(k))]
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<HexPoint>> {
        let (x_unit, y_unit) = hex_units();
        let (lo, hi) = (
            Point::new(min.x.min(max.x), min.y.min(max.y)),
            Point::new(min.x.max(max.x), min.y.max(max.y)),
        );
        let qs = cell_range(lo.x / (3.0 * x_unit) - 1.0, hi.x / (3.0 * x_unit) + 1.0);
        // Center lattice j = -(2r + q), so r = (-j - q) / 2.
        let rs = move |q: i32| {
            let r_of = |y: f64| (-(y / y_unit) - q as f64) / 2.0;
            cell_range(r_of(hi.y) - 1.0, r_of(lo.y) + 1.0)
        };
        let count: i64 = qs
            .clone()
            .map(|q| {
                let r = rs(q);
                (*r.end() as i64 - *r.start() as i64 + 1).max(0)
            })
            .sum();
        if count > i64::try_from(limit).unwrap_or(i64::MAX) {
            return None;
        }
        Some(
            qs.flat_map(|q| rs(q).map(move |r| HexPoint { q, r }))
                .collect(),
        )
    }

    fn area(&self, _cell: HexPoint) -> f64 {
        1.0
    }
}

/// World units of the hex lattice: side `s` with `3·sqrt(3)/2·s² = 1`; `x = s/2 · i`,
/// `y = s·sqrt(3)/2 · j`. Every vertex sits on integer `(i, j)`, so a vertex shared by several
/// cells gets identical coordinates from each of them.
fn hex_units() -> (f64, f64) {
    let side = (2.0 / (3.0 * 3f64.sqrt())).sqrt();
    (side / 2.0, side * 3f64.sqrt() / 2.0)
}

fn hex_lattice(i: i64, j: i64) -> Point {
    let (x_unit, y_unit) = hex_units();
    Point::new(x_unit * i as f64, y_unit * j as f64)
}

pub fn hex_parallelogram(cols: usize, rows: usize) -> Vec<HexPoint> {
    (0..rows)
        .flat_map(|r| {
            (0..cols).map(move |q| HexPoint {
                q: q as i32,
                r: r as i32,
            })
        })
        .collect()
}

pub fn hex_hexagon(radius: usize) -> Vec<HexPoint> {
    let n = radius as i32;
    (-n..=n)
        .flat_map(move |q| ((-n).max(-q - n)..=n.min(-q + n)).map(move |r| HexPoint { q, r }))
        .collect()
}
