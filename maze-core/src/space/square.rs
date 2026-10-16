use super::Tessellation;

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

#[derive(Debug, Default, Clone, Copy)]
pub struct SquareTessellation;

impl Tessellation for SquareTessellation {
    type CellId = SquarePoint;
    type Face = SquareFace;

    fn is_valid_cell(&self, _cell: SquarePoint) -> bool {
        true
    }

    fn faces_of(&self, _cell: SquarePoint) -> &[SquareFace] {
        &[SquareFace::N, SquareFace::S, SquareFace::E, SquareFace::W]
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

    fn cartesian(&self, cell: SquarePoint) -> (f64, f64) {
        (cell.x as f64, cell.y as f64)
    }

    /// Faces in `[N, S, E, W]` order (indices 0-3). 90°-clockwise rotation cycles N->E->S->W->N.
    fn rotation_symmetries(&self) -> &[&[usize]] {
        &[
            &[0, 1, 2, 3], // identity
            &[2, 3, 1, 0], // 90°:  N->E, S->W, E->S, W->N
            &[1, 0, 3, 2], // 180°: N->S, S->N, E->W, W->E
            &[3, 2, 0, 1], // 270°: N->W, S->E, E->N, W->S
        ]
    }

    /// Two independent mirror axes: N-S (E<->W swap, N/S fixed) and E-W (N<->S swap, E/W fixed).
    fn mirror_symmetries(&self) -> &[&[usize]] {
        &[
            &[0, 1, 3, 2], // mirror across the N-S axis
            &[1, 0, 2, 3], // mirror across the E-W axis
        ]
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
