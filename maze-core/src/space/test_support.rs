use super::{SquareFace, SquarePoint, SquareTessellation, Tessellation};

/// Square tessellation with one missing transition, used to exercise `Option<Point>` consumers.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct GappedSquareTessellation;

impl Tessellation for GappedSquareTessellation {
    type Point = SquarePoint;
    type Face = SquareFace;

    fn step(&self, point: SquarePoint, face: SquareFace) -> Option<SquarePoint> {
        if point == (SquarePoint { x: 0, y: 0 }) && face == SquareFace::E {
            None
        } else {
            SquareTessellation.step(point, face)
        }
    }

    fn is_valid_point(&self, point: SquarePoint) -> bool {
        point.x != 99
    }

    fn faces(&self) -> &[SquareFace] {
        SquareTessellation.faces()
    }

    fn face_between(&self, from: SquarePoint, to: SquarePoint) -> Option<SquareFace> {
        SquareTessellation.face_between(from, to)
    }

    fn rotation_symmetries(&self) -> &[&[usize]] {
        SquareTessellation.rotation_symmetries()
    }

    fn mirror_symmetries(&self) -> &[&[usize]] {
        SquareTessellation.mirror_symmetries()
    }

    fn cartesian(&self, point: SquarePoint) -> (f64, f64) {
        SquareTessellation.cartesian(point)
    }
}

/// Square tessellation carrying instance data (a projection scale), used to exercise code that
/// must treat two instances of a non-zero-sized tessellation as distinct.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ScaledSquareTessellation {
    pub scale: f64,
}

impl Tessellation for ScaledSquareTessellation {
    type Point = SquarePoint;
    type Face = SquareFace;

    fn step(&self, point: SquarePoint, face: SquareFace) -> Option<SquarePoint> {
        SquareTessellation.step(point, face)
    }

    fn is_valid_point(&self, point: SquarePoint) -> bool {
        SquareTessellation.is_valid_point(point)
    }

    fn faces(&self) -> &[SquareFace] {
        SquareTessellation.faces()
    }

    fn face_between(&self, from: SquarePoint, to: SquarePoint) -> Option<SquareFace> {
        SquareTessellation.face_between(from, to)
    }

    fn rotation_symmetries(&self) -> &[&[usize]] {
        SquareTessellation.rotation_symmetries()
    }

    fn mirror_symmetries(&self) -> &[&[usize]] {
        SquareTessellation.mirror_symmetries()
    }

    fn cartesian(&self, point: SquarePoint) -> (f64, f64) {
        let (x, y) = SquareTessellation.cartesian(point);
        (x * self.scale, y * self.scale)
    }
}
