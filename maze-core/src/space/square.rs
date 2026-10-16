use super::{CellShape, ShapeDescriptor, Tessellation};
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

    fn cartesian(&self, cell: SquarePoint) -> (f64, f64) {
        (cell.x as f64, cell.y as f64)
    }
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
