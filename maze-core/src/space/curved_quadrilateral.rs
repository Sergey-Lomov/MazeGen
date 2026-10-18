//! The curved quadrilateral tessellation: the square grid with every edge replaced by a quarter
//! circle, so each tile has two opposite convex sides and two opposite concave sides.
//!
//! Cell `(x, y)` has the square's corners `(x, y)`, `(x + 1, y)`, `(x + 1, y + 1)`, `(x, y + 1)`.
//! In a cell of even parity `(x + y)` the east and west sides bulge outward (convex) and the north
//! and south sides bulge inward (concave); in a cell of odd parity it is the other way round. Both
//! sides of a shared edge agree: the neighbor of a convex side has a concave side there. A convex
//! side is the quarter of the circle around the cell's own center through its four corners (radius
//! `√2 / 2`); the same arc is the concave side of the neighbor, so a shared edge is one circle arc
//! and every tile has area exactly 1 (the bulges and the dents cancel).

use super::field_ops::{
    CIRCLE_PRESET, Inclusion, RECT_PRESET, TRIANGLE_PRESET, circle_cells, param, triangle_cells,
};
use super::square::{cell_range, grid_candidates};
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    ShapeFamily, Tessellation, validate_preset,
};
use std::f64::consts::{FRAC_1_SQRT_2, FRAC_PI_2};
use std::sync::LazyLock;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct CurvedQuadrilateralPoint {
    pub x: i32,
    pub y: i32,
}

impl CurvedQuadrilateralPoint {
    /// Whether the east and west sides are convex (`x + y` even); the north and south sides then
    /// are concave, and the other way round for an odd cell.
    fn east_west_convex(self) -> bool {
        (self.x as i64 + self.y as i64) & 1 == 0
    }
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum CurvedQuadrilateralFace {
    E,
    N,
    W,
    S,
}

impl CurvedQuadrilateralFace {
    const ALL: [CurvedQuadrilateralFace; 4] = [Self::E, Self::N, Self::W, Self::S];

    /// The face on the other side of the same edge — also the face a straight pass leaves by.
    pub fn opposite(self) -> Self {
        match self {
            Self::N => Self::S,
            Self::S => Self::N,
            Self::E => Self::W,
            Self::W => Self::E,
        }
    }

    /// Unit step from a cell to the neighbor across this face.
    fn step(self) -> (i32, i32) {
        match self {
            Self::E => (1, 0),
            Self::N => (0, 1),
            Self::W => (-1, 0),
            Self::S => (0, -1),
        }
    }

    fn is_horizontal_step(self) -> bool {
        matches!(self, Self::E | Self::W)
    }
}

/// The tile's symmetries: the mirrors across its two axes (their product is the half turn). A
/// quarter turn is not one — it would swap the convex and the concave pair.
static SHAPES: LazyLock<[ShapeDescriptor; 1]> = LazyLock::new(|| {
    [ShapeDescriptor::new(ShapeFamily::Registered {
        kind: "curved_quadrilateral",
        name: "curved_quadrilateral",
        face_count: 4,
        generators: vec![vec![2, 1, 0, 3], vec![0, 3, 2, 1]],
    })]
});

/// `faces_of` is already the canonical counter-clockwise order `[E, N, W, S]`.
const LOCAL_TO_CANONICAL: [usize; 4] = [0, 1, 2, 3];

/// Radius of every edge arc: the circumradius of the unit square.
const RADIUS: f64 = FRAC_1_SQRT_2;

/// How far a convex side reaches beyond its square, `√2 / 2 - 1 / 2`.
const BULGE: f64 = RADIUS - 0.5;

#[derive(Debug, Default, Clone, Copy)]
pub struct CurvedQuadrilateralTessellation;

impl Tessellation for CurvedQuadrilateralTessellation {
    type CellId = CurvedQuadrilateralPoint;
    type Face = CurvedQuadrilateralFace;

    fn is_valid_cell(&self, _cell: CurvedQuadrilateralPoint) -> bool {
        true
    }

    fn faces_of(&self, _cell: CurvedQuadrilateralPoint) -> &[CurvedQuadrilateralFace] {
        &CurvedQuadrilateralFace::ALL
    }

    fn neighbor(
        &self,
        cell: CurvedQuadrilateralPoint,
        face: CurvedQuadrilateralFace,
    ) -> Option<(CurvedQuadrilateralPoint, CurvedQuadrilateralFace)> {
        let (dx, dy) = face.step();
        let neighbor = CurvedQuadrilateralPoint {
            x: cell.x.checked_add(dx)?,
            y: cell.y.checked_add(dy)?,
        };
        Some((neighbor, face.opposite()))
    }

    fn is_straight(
        &self,
        _cell: CurvedQuadrilateralPoint,
        in_face: CurvedQuadrilateralFace,
        out_face: CurvedQuadrilateralFace,
    ) -> bool {
        out_face == in_face.opposite()
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, _cell: CurvedQuadrilateralPoint) -> Option<CellShape<'_>> {
        Some(CellShape::full(&SHAPES[0], &LOCAL_TO_CANONICAL))
    }

    /// The center of the underlying unit square; the tile is symmetric about it.
    fn center(&self, cell: CurvedQuadrilateralPoint) -> Point {
        Point::new(cell.x as f64 + 0.5, cell.y as f64 + 0.5)
    }

    fn face_segments(
        &self,
        cell: CurvedQuadrilateralPoint,
        face: CurvedQuadrilateralFace,
    ) -> Vec<Segment> {
        let corner = |dx: i32, dy: i32| {
            Point::new(
                (cell.x as i64 + dx as i64) as f64,
                (cell.y as i64 + dy as i64) as f64,
            )
        };
        let (from, to) = match face {
            CurvedQuadrilateralFace::E => (corner(1, 0), corner(1, 1)),
            CurvedQuadrilateralFace::N => (corner(1, 1), corner(0, 1)),
            CurvedQuadrilateralFace::W => (corner(0, 1), corner(0, 0)),
            CurvedQuadrilateralFace::S => (corner(0, 0), corner(1, 0)),
        };
        let convex = face.is_horizontal_step() == cell.east_west_convex();
        // A convex side is an arc around the cell's own center, a concave one the same arc around
        // the center of the cell across; both are traversed so the cell stays on the left of a
        // convex side's circle and on the right of a concave one's.
        let own = self.center(cell);
        let (dx, dy) = face.step();
        let (center, sweep) = if convex {
            (own, FRAC_PI_2)
        } else {
            (own + Point::new(dx as f64, dy as f64), -FRAC_PI_2)
        };
        let start_angle = (from.y - center.y).atan2(from.x - center.x);
        vec![Segment::CircularArc {
            from,
            to,
            center,
            radius: RADIUS,
            start_angle,
            sweep,
        }]
    }

    fn candidate_cells(
        &self,
        min: Point,
        max: Point,
        limit: usize,
    ) -> Option<Vec<CurvedQuadrilateralPoint>> {
        // A tile reaches `BULGE` beyond its square on two opposite sides.
        let reach = BULGE + 1.0;
        let xs = cell_range(min.x.min(max.x) - reach, min.x.max(max.x) + BULGE);
        let ys = cell_range(min.y.min(max.y) - reach, min.y.max(max.y) + BULGE);
        grid_candidates(xs, ys, limit, |x, y| CurvedQuadrilateralPoint { x, y })
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<CurvedQuadrilateralPoint>, FieldOpError> {
        validate_preset(&PRESETS, key, params)?;
        let origin = self.center(CurvedQuadrilateralPoint { x: 0, y: 0 });
        match key {
            "rect" => Ok(centered_rect(
                param(params, "cols") as usize,
                param(params, "rows") as usize,
            )),
            "circle" => circle_cells(self, origin, param(params, "radius"), Inclusion::Center),
            "triangle" => triangle_cells(self, origin, param(params, "side"), Inclusion::Center),
            _ => Err(FieldOpError::Unavailable),
        }
    }

    /// The bulges of the two convex sides and the dents of the two concave ones cancel.
    fn area(&self, _cell: CurvedQuadrilateralPoint) -> f64 {
        1.0
    }
}

/// Preset field shapes of the curved quadrilateral tessellation, in UI order.
const PRESETS: [PresetDescriptor; 3] = [RECT_PRESET, CIRCLE_PRESET, TRIANGLE_PRESET];

/// A `width × height` block of cells with the origin cell at `size / 2` (rounded down) of each
/// axis, sorted by id.
fn centered_rect(width: usize, height: usize) -> Vec<CurvedQuadrilateralPoint> {
    let (ox, oy) = ((width / 2) as i32, (height / 2) as i32);
    let mut cells: Vec<CurvedQuadrilateralPoint> = (0..height as i32)
        .flat_map(|y| (0..width as i32).map(move |x| (x, y)))
        .map(|(x, y)| CurvedQuadrilateralPoint {
            x: x - ox,
            y: y - oy,
        })
        .collect();
    cells.sort();
    cells
}
