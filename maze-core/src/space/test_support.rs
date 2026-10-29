use super::{
    CellShape, Point, Segment, ShapeDescriptor, SquareFace, SquarePoint, SquareTessellation,
    Tessellation,
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

    fn center(&self, cell: SquarePoint) -> Point {
        SquareTessellation.center(cell)
    }

    fn face_segments(&self, cell: SquarePoint, face: SquareFace) -> Vec<Segment> {
        SquareTessellation.face_segments(cell, face)
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<SquarePoint>> {
        SquareTessellation.candidate_cells(min, max, limit)
    }
}

/// Square tessellation carrying instance data (a geometry scale), used to exercise code that must
/// treat two instances of a non-zero-sized tessellation as distinct, and a `cell_scale` other
/// than 1 (its `area` comes from the boundary: `scale²`).
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

    fn center(&self, cell: SquarePoint) -> Point {
        SquareTessellation.center(cell) * self.scale
    }

    fn face_segments(&self, cell: SquarePoint, face: SquareFace) -> Vec<Segment> {
        SquareTessellation
            .face_segments(cell, face)
            .iter()
            .map(|segment| Segment::line(segment.start() * self.scale, segment.end() * self.scale))
            .collect()
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<SquarePoint>> {
        SquareTessellation.candidate_cells(
            min * (1.0 / self.scale),
            max * (1.0 / self.scale),
            limit,
        )
    }
}

/// Square tessellation whose declared `translation_basis` is set by the test, used to check the
/// basis contract (`check_translation_basis`) and that `translate_cells` honors a declared basis.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BasisSquareTessellation {
    pub basis: Option<[Point; 2]>,
}

impl Tessellation for BasisSquareTessellation {
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

    fn center(&self, cell: SquarePoint) -> Point {
        SquareTessellation.center(cell)
    }

    fn face_segments(&self, cell: SquarePoint, face: SquareFace) -> Vec<Segment> {
        SquareTessellation.face_segments(cell, face)
    }

    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<SquarePoint>> {
        SquareTessellation.candidate_cells(min, max, limit)
    }

    fn translation_basis(&self) -> Option<[Point; 2]> {
        self.basis
    }
}

/// Radial tessellations of several sizes in both layouts, each with every cell of its first
/// rings: the center and rings whose neighbors overlap one to three cells of the adjacent rings.
pub(crate) fn radial_cases() -> Vec<(super::RadialTessellation, Vec<super::RadialPoint>)> {
    [6, 9, 13, 24]
        .into_iter()
        .flat_map(|first_ring_cells| {
            super::RadialLayout::ALL.map(|layout| (first_ring_cells, layout))
        })
        .map(|(first_ring_cells, layout)| {
            let tessellation = super::RadialTessellation::new(super::RadialParams {
                first_ring_cells,
                layout,
                max_cells: super::DEFAULT_CELL_LIMIT,
            })
            .unwrap();
            let cells = std::iter::once(super::RadialPoint::CENTER)
                .chain((1..=5).flat_map(|ring| {
                    (0..tessellation.ring_count(ring).unwrap() as i32)
                        .map(move |index| super::RadialPoint { ring, index })
                }))
                .collect();
            (tessellation, cells)
        })
        .collect()
}

/// Voronoi tessellations at several jitters and seeds, each with the cells within lattice
/// distance 3 of the origin.
pub(crate) fn voronoi_cases() -> Vec<(super::VoronoiTessellation, Vec<super::VoronoiPoint>)> {
    [(0.0, 0), (0.15, 1), (0.4, 7)]
        .into_iter()
        .map(|(jitter, seed)| {
            let tessellation = super::VoronoiTessellation::new(super::VoronoiParams {
                jitter,
                seed,
                max_cells: super::voronoi::DEFAULT_CELL_LIMIT,
            })
            .unwrap();
            let cells = (-3..=3)
                .flat_map(|q| (-3..=3).map(move |r| super::VoronoiPoint { q, r }))
                .filter(|cell| (cell.q + cell.r).abs() <= 3)
                .collect();
            (tessellation, cells)
        })
        .collect()
}
