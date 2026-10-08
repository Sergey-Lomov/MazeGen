use super::{SquareFace, SquarePoint, SquareTessellation, Tessellation};

/// Square tessellation with one missing transition, used to exercise `Option<Point>` consumers.
pub(crate) struct GappedSquareTessellation;

impl Tessellation for GappedSquareTessellation {
    type Point = SquarePoint;
    type Face = SquareFace;

    fn step(point: SquarePoint, face: SquareFace) -> Option<SquarePoint> {
        if point == (SquarePoint { x: 0, y: 0 }) && face == SquareFace::E {
            None
        } else {
            SquareTessellation::step(point, face)
        }
    }

    fn is_valid_point(point: SquarePoint) -> bool {
        point.x != 99
    }

    fn faces() -> &'static [SquareFace] {
        SquareTessellation::faces()
    }

    fn face_between(from: SquarePoint, to: SquarePoint) -> Option<SquareFace> {
        SquareTessellation::face_between(from, to)
    }

    fn rotation_symmetries() -> &'static [&'static [usize]] {
        SquareTessellation::rotation_symmetries()
    }

    fn mirror_symmetries() -> &'static [&'static [usize]] {
        SquareTessellation::mirror_symmetries()
    }

    fn cartesian(point: SquarePoint) -> (f64, f64) {
        SquareTessellation::cartesian(point)
    }
}
