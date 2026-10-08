use super::Tessellation;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct SquarePoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Copy, Clone, PartialEq)]
pub enum SquareFace {
    N,
    S,
    E,
    W,
}

pub struct SquareTessellation;

impl Tessellation for SquareTessellation {
    type Point = SquarePoint;
    type Face = SquareFace;

    fn step(point: SquarePoint, face: SquareFace) -> Option<SquarePoint> {
        Some(match face {
            SquareFace::N => SquarePoint {
                x: point.x,
                y: point.y + 1,
            },
            SquareFace::S => SquarePoint {
                x: point.x,
                y: point.y - 1,
            },
            SquareFace::E => SquarePoint {
                x: point.x + 1,
                y: point.y,
            },
            SquareFace::W => SquarePoint {
                x: point.x - 1,
                y: point.y,
            },
        })
    }

    fn is_valid_point(_point: SquarePoint) -> bool {
        true
    }

    fn faces() -> &'static [SquareFace] {
        &[SquareFace::N, SquareFace::S, SquareFace::E, SquareFace::W]
    }

    fn face_between(from: SquarePoint, to: SquarePoint) -> Option<SquareFace> {
        match (to.x - from.x, to.y - from.y) {
            (0, 1) => Some(SquareFace::N),
            (0, -1) => Some(SquareFace::S),
            (1, 0) => Some(SquareFace::E),
            (-1, 0) => Some(SquareFace::W),
            _ => None,
        }
    }

    fn cartesian(point: SquarePoint) -> (f64, f64) {
        (point.x as f64, point.y as f64)
    }

    /// Faces in `[N, S, E, W]` order (indices 0-3). 90°-clockwise rotation cycles N->E->S->W->N.
    fn rotation_symmetries() -> &'static [&'static [usize]] {
        &[
            &[0, 1, 2, 3], // identity
            &[2, 3, 1, 0], // 90°:  N->E, S->W, E->S, W->N
            &[1, 0, 3, 2], // 180°: N->S, S->N, E->W, W->E
            &[3, 2, 0, 1], // 270°: N->W, S->E, E->N, W->S
        ]
    }

    /// Two independent mirror axes: N-S (E<->W swap, N/S fixed) and E-W (N<->S swap, E/W fixed).
    fn mirror_symmetries() -> &'static [&'static [usize]] {
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
