use super::field_ops::{
    CIRCLE_PRESET, Inclusion, RECT_PRESET, TRIANGLE_PRESET, circle_cells, param, triangle_cells,
};
use super::{
    CellShape, FieldOpError, Point, PresetDescriptor, PresetParams, Segment, ShapeDescriptor,
    Tessellation, validate_preset,
};
use std::sync::LazyLock;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct SquarePoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum SquareFace {
    N,
    S,
    E,
    W,
}

impl SquareFace {
    /// The face on the other side of the same edge — also the face a straight pass leaves by.
    pub fn opposite(self) -> Self {
        match self {
            SquareFace::N => SquareFace::S,
            SquareFace::S => SquareFace::N,
            SquareFace::E => SquareFace::W,
            SquareFace::W => SquareFace::E,
        }
    }
}

static SQUARE_SHAPES: LazyLock<[ShapeDescriptor; 1]> =
    LazyLock::new(|| [ShapeDescriptor::regular_polygon(4)]);

/// `faces_of` is already the canonical counter-clockwise order `[E, N, W, S]`.
const SQUARE_LOCAL_TO_CANONICAL: [usize; 4] = [0, 1, 2, 3];

#[derive(Debug, Default, Clone, Copy)]
pub struct SquareTessellation;

impl Tessellation for SquareTessellation {
    type CellId = SquarePoint;
    type Face = SquareFace;

    fn is_valid_cell(&self, _cell: SquarePoint) -> bool {
        true
    }

    fn faces_of(&self, _cell: SquarePoint) -> &[SquareFace] {
        &[SquareFace::E, SquareFace::N, SquareFace::W, SquareFace::S]
    }

    fn neighbor(&self, cell: SquarePoint, face: SquareFace) -> Option<(SquarePoint, SquareFace)> {
        let (dx, dy) = match face {
            SquareFace::N => (0, 1),
            SquareFace::S => (0, -1),
            SquareFace::E => (1, 0),
            SquareFace::W => (-1, 0),
        };
        let neighbor = SquarePoint {
            x: cell.x.checked_add(dx)?,
            y: cell.y.checked_add(dy)?,
        };
        Some((neighbor, face.opposite()))
    }

    fn is_straight(&self, _cell: SquarePoint, in_face: SquareFace, out_face: SquareFace) -> bool {
        out_face == in_face.opposite()
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SQUARE_SHAPES
    }

    fn shape_of(&self, _cell: SquarePoint) -> Option<CellShape<'_>> {
        Some(CellShape::full(
            &SQUARE_SHAPES[0],
            &SQUARE_LOCAL_TO_CANONICAL,
        ))
    }

    /// Unit squares: cell `(x, y)` spans `[x, x + 1] × [y, y + 1]` (area 1).
    fn center(&self, cell: SquarePoint) -> Point {
        Point::new(cell.x as f64 + 0.5, cell.y as f64 + 0.5)
    }

    fn face_segments(&self, cell: SquarePoint, face: SquareFace) -> Vec<Segment> {
        let corner = |dx: i32, dy: i32| {
            Point::new(
                (cell.x as i64 + dx as i64) as f64,
                (cell.y as i64 + dy as i64) as f64,
            )
        };
        let (from, to) = match face {
            SquareFace::E => (corner(1, 0), corner(1, 1)),
            SquareFace::N => (corner(1, 1), corner(0, 1)),
            SquareFace::W => (corner(0, 1), corner(0, 0)),
            SquareFace::S => (corner(0, 0), corner(1, 0)),
        };
        vec![Segment::line(from, to)]
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<SquarePoint>> {
        let xs = cell_range(min.x.min(max.x) - 1.0, min.x.max(max.x));
        let ys = cell_range(min.y.min(max.y) - 1.0, min.y.max(max.y));
        grid_candidates(xs, ys, limit, |x, y| SquarePoint { x, y })
    }

    fn presets(&self) -> &[PresetDescriptor] {
        &SQUARE_PRESETS
    }

    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<SquarePoint>, FieldOpError> {
        validate_preset(&SQUARE_PRESETS, key, params)?;
        let origin = self.center(SquarePoint { x: 0, y: 0 });
        match key {
            "rect" => Ok(centered_square_rect(
                param(params, "cols") as usize,
                param(params, "rows") as usize,
            )),
            "circle" => circle_cells(self, origin, param(params, "radius"), Inclusion::Center),
            "triangle" => triangle_cells(self, origin, param(params, "side"), Inclusion::Center),
            _ => Err(FieldOpError::Unavailable),
        }
    }

    fn area(&self, _cell: SquarePoint) -> f64 {
        1.0
    }
}

/// Every `(x, y)` of the two ranges mapped by `cell`, or `None` when that would exceed `limit`.
pub(super) fn grid_candidates<C>(
    xs: std::ops::RangeInclusive<i32>,
    ys: std::ops::RangeInclusive<i32>,
    limit: usize,
    cell: impl Fn(i32, i32) -> C,
) -> Option<Vec<C>> {
    let span = |r: &std::ops::RangeInclusive<i32>| (*r.end() as i64 - *r.start() as i64 + 1).max(0);
    if span(&xs).saturating_mul(span(&ys)) > i64::try_from(limit).unwrap_or(i64::MAX) {
        return None;
    }
    Some(
        ys.flat_map(|y| xs.clone().map(move |x| (x, y)))
            .map(|(x, y)| cell(x, y))
            .collect(),
    )
}

/// Integer range `floor(lo)..=floor(hi)`, clamped to `i32`.
pub(super) fn cell_range(lo: f64, hi: f64) -> std::ops::RangeInclusive<i32> {
    let clamp = |v: f64| v.floor().clamp(i32::MIN as f64, i32::MAX as f64) as i32;
    clamp(lo)..=clamp(hi)
}

pub fn square_rect(width: usize, height: usize) -> Vec<SquarePoint> {
    (0..height)
        .flat_map(|y| {
            (0..width).map(move |x| SquarePoint {
                x: x as i32,
                y: y as i32,
            })
        })
        .collect()
}

/// Preset field shapes of the square grid, in UI order.
const SQUARE_PRESETS: [PresetDescriptor; 3] = [RECT_PRESET, CIRCLE_PRESET, TRIANGLE_PRESET];

/// `square_rect` shifted so the origin cell sits at `size / 2` (rounded down) of each axis.
fn centered_square_rect(width: usize, height: usize) -> Vec<SquarePoint> {
    let (ox, oy) = ((width / 2) as i32, (height / 2) as i32);
    let mut cells: Vec<SquarePoint> = square_rect(width, height)
        .into_iter()
        .map(|p| SquarePoint {
            x: p.x - ox,
            y: p.y - oy,
        })
        .collect();
    cells.sort();
    cells
}
