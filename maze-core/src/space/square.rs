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

    fn step(point: SquarePoint, face: SquareFace) -> SquarePoint {
        match face {
            SquareFace::N => SquarePoint { x: point.x, y: point.y + 1 },
            SquareFace::S => SquarePoint { x: point.x, y: point.y - 1 },
            SquareFace::E => SquarePoint { x: point.x + 1, y: point.y },
            SquareFace::W => SquarePoint { x: point.x - 1, y: point.y },
        }
    }

    fn faces() -> &'static [SquareFace] {
        &[SquareFace::N, SquareFace::S, SquareFace::E, SquareFace::W]
    }

    fn face_between(from: SquarePoint, to: SquarePoint) -> Option<SquareFace> {
        match (to.x - from.x, to.y - from.y) {
            (0, 1)  => Some(SquareFace::N),
            (0, -1) => Some(SquareFace::S),
            (1, 0)  => Some(SquareFace::E),
            (-1, 0) => Some(SquareFace::W),
            _       => None,
        }
    }

}

pub fn square_rect(width: usize, height: usize) -> Vec<SquarePoint> {
    (0..height)
        .flat_map(|y| (0..width).map(move |x| SquarePoint { x: x as i32, y: y as i32 }))
        .collect()
}
