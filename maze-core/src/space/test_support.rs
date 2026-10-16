use super::{
    CellShape, ShapeDescriptor, SquareFace, SquarePoint, SquareTessellation, Tessellation,
};

/// Square tessellation with one missing edge (between `(0, 0)` and `(1, 0)`, in both directions),
/// used to exercise consumers of a `None` neighbor.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct GappedSquareTessellation;

impl Tessellation for GappedSquareTessellation {
    type CellId = SquarePoint;
    type Face = SquareFace;

    fn is_valid_cell(&self, cell: SquarePoint) -> bool {
        cell.x != 99
    }

    fn faces_of(&self, cell: SquarePoint) -> &[SquareFace] {
        SquareTessellation.faces_of(cell)
    }

    fn neighbor(&self, cell: SquarePoint, face: SquareFace) -> Option<(SquarePoint, SquareFace)> {
        let gap = (SquarePoint { x: 0, y: 0 }, SquareFace::E);
        let back = SquareTessellation.neighbor(gap.0, gap.1)?;
        if (cell, face) == gap || (cell, face) == back {
            None
        } else {
            SquareTessellation.neighbor(cell, face)
        }
    }

    fn is_straight(&self, cell: SquarePoint, in_face: SquareFace, out_face: SquareFace) -> bool {
        SquareTessellation.is_straight(cell, in_face, out_face)
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        SquareTessellation.shape_descriptors()
    }

    fn shape_of(&self, cell: SquarePoint) -> Option<CellShape<'_>> {
        SquareTessellation.shape_of(cell)
    }

    fn rotation_symmetries(&self) -> &[&[usize]] {
        SquareTessellation.rotation_symmetries()
    }

    fn mirror_symmetries(&self) -> &[&[usize]] {
        SquareTessellation.mirror_symmetries()
    }

    fn cartesian(&self, cell: SquarePoint) -> (f64, f64) {
        SquareTessellation.cartesian(cell)
    }
}

/// Square tessellation carrying instance data (a projection scale), used to exercise code that
/// must treat two instances of a non-zero-sized tessellation as distinct.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ScaledSquareTessellation {
    pub scale: f64,
}

impl Tessellation for ScaledSquareTessellation {
    type CellId = SquarePoint;
    type Face = SquareFace;

    fn is_valid_cell(&self, cell: SquarePoint) -> bool {
        SquareTessellation.is_valid_cell(cell)
    }

    fn faces_of(&self, cell: SquarePoint) -> &[SquareFace] {
        SquareTessellation.faces_of(cell)
    }

    fn neighbor(&self, cell: SquarePoint, face: SquareFace) -> Option<(SquarePoint, SquareFace)> {
        SquareTessellation.neighbor(cell, face)
    }

    fn is_straight(&self, cell: SquarePoint, in_face: SquareFace, out_face: SquareFace) -> bool {
        SquareTessellation.is_straight(cell, in_face, out_face)
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        SquareTessellation.shape_descriptors()
    }

    fn shape_of(&self, cell: SquarePoint) -> Option<CellShape<'_>> {
        SquareTessellation.shape_of(cell)
    }

    fn rotation_symmetries(&self) -> &[&[usize]] {
        SquareTessellation.rotation_symmetries()
    }

    fn mirror_symmetries(&self) -> &[&[usize]] {
        SquareTessellation.mirror_symmetries()
    }

    fn cartesian(&self, cell: SquarePoint) -> (f64, f64) {
        let (x, y) = SquareTessellation.cartesian(cell);
        (x * self.scale, y * self.scale)
    }
}
