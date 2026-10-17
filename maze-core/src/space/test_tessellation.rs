//! A finite, hand-laid dev tessellation that exercises everything the `Tessellation` contract
//! allows and the built-in tessellations never use (GitHub issue #765). Compiled only for tests
//! and under the `test-tessellation` feature.
//!
//! ```text
//!   y=2.43        T1    T2          T1, T2: equilateral triangles (side 0.5) on E's split side
//!   y=2        D | E  | F          E = square with its north side split into two faces
//!   y=1        A | B  | G ) H      G, H share a circular arc; F has no shape template
//!   y=0     x=0   1    2  3  4
//! ```
//!
//! Cells (id: shape, faces counter-clockwise from east): `A0`, `B1`, `D2` squares (`regular:4`);
//! `E3` a square with five faces `[E, N-right, N-left, W, S]` (`test:split_square`), geometrically
//! identical to `D2`; `F4` a square without a template; `G5`, `H6` quads sharing a circular arc
//! (`regular:4`); `T7`, `T8` triangles (`regular:3`). Areas differ (squares 1, triangles ≈ 0.108,
//! `G5`/`H6` bounded by the arc), so `cell_scale` varies. No field operations or presets.

use super::{
    CellShape, Point, Segment, ShapeDescriptor, ShapeFamily, Tessellation, is_straight_geometric,
};
use std::sync::LazyLock;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct TestCell(pub u8);

/// A face as its position in `faces_of(cell)`.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct TestFace(pub u8);

const SQUARE_SHAPE: usize = 0;
const TRIANGLE_SHAPE: usize = 1;
const SPLIT_SQUARE_SHAPE: usize = 2;

static SHAPES: LazyLock<[ShapeDescriptor; 3]> = LazyLock::new(|| {
    [
        ShapeDescriptor::regular_polygon(4),
        ShapeDescriptor::regular_polygon(3),
        ShapeDescriptor::new(ShapeFamily::Registered {
            kind: "test",
            name: "split_square",
            face_count: 5,
            // Mirror across the vertical axis: E <-> W, the two north halves swap, S stays.
            generators: vec![vec![3, 2, 1, 0, 4]],
        }),
    ]
});

struct FaceDef {
    segments: Vec<Segment>,
    neighbor: Option<(u8, u8)>,
}

struct CellDef {
    center: Point,
    faces: Vec<FaceDef>,
    face_ids: Vec<TestFace>,
    shape: Option<(usize, Vec<usize>)>,
}

static LAYOUT: LazyLock<Vec<CellDef>> = LazyLock::new(build_layout);

/// The test tessellation instance; the layout is static.
#[derive(Debug, Default, Clone, Copy)]
pub struct TestTessellation;

impl TestTessellation {
    /// Every valid cell, in id order.
    pub fn all_cells() -> Vec<TestCell> {
        (0..LAYOUT.len() as u8).map(TestCell).collect()
    }

    fn def(&self, cell: TestCell) -> &CellDef {
        &LAYOUT[cell.0 as usize]
    }
}

impl Tessellation for TestTessellation {
    type CellId = TestCell;
    type Face = TestFace;

    fn is_valid_cell(&self, cell: TestCell) -> bool {
        (cell.0 as usize) < LAYOUT.len()
    }

    fn faces_of(&self, cell: TestCell) -> &[TestFace] {
        &self.def(cell).face_ids
    }

    fn neighbor(&self, cell: TestCell, face: TestFace) -> Option<(TestCell, TestFace)> {
        self.def(cell).faces[face.0 as usize]
            .neighbor
            .map(|(c, f)| (TestCell(c), TestFace(f)))
    }

    fn is_straight(&self, cell: TestCell, in_face: TestFace, out_face: TestFace) -> bool {
        is_straight_geometric(self, cell, in_face, out_face)
    }

    fn shape_descriptors(&self) -> &[ShapeDescriptor] {
        &*SHAPES
    }

    fn shape_of(&self, cell: TestCell) -> Option<CellShape<'_>> {
        let (index, local_to_canonical) = self.def(cell).shape.as_ref()?;
        Some(CellShape::full(&SHAPES[*index], local_to_canonical))
    }

    fn center(&self, cell: TestCell) -> Point {
        self.def(cell).center
    }

    fn face_segments(&self, cell: TestCell, face: TestFace) -> Vec<Segment> {
        self.def(cell).faces[face.0 as usize].segments.clone()
    }

    fn candidate_cells(&self, _min: Point, _max: Point, limit: usize) -> Option<Vec<TestCell>> {
        (LAYOUT.len() <= limit).then(Self::all_cells)
    }

    fn field_operations(&self) -> &[super::FieldOperation] {
        &[]
    }
}

fn p(x: f64, y: f64) -> Point {
    Point::new(x, y)
}

fn line(a: (f64, f64), b: (f64, f64)) -> Vec<Segment> {
    vec![Segment::line(p(a.0, a.1), p(b.0, b.1))]
}

fn face(segments: Vec<Segment>, neighbor: Option<(u8, u8)>) -> FaceDef {
    FaceDef { segments, neighbor }
}

fn cell(center: Point, faces: Vec<FaceDef>, shape: Option<(usize, Vec<usize>)>) -> CellDef {
    let face_ids = (0..faces.len() as u8).map(TestFace).collect();
    CellDef {
        center,
        faces,
        face_ids,
        shape,
    }
}

/// The arc between `G5` and `H6`: centered at `(2, 0.5)`, from `(3, 0)` to `(3, 1)`, bulging east
/// into `H6`. Endpoints are exact so the joints with the straight faces are bit-identical.
fn shared_arc() -> Segment {
    Segment::CircularArc {
        from: p(3.0, 0.0),
        to: p(3.0, 1.0),
        center: p(2.0, 0.5),
        radius: 1.25_f64.sqrt(),
        start_angle: (-0.5_f64).atan2(1.0),
        sweep: 2.0 * 0.5_f64.atan(),
    }
}

fn build_layout() -> Vec<CellDef> {
    let identity4 = || vec![0, 1, 2, 3];
    let triangle_height = 0.25 * 3.0_f64.sqrt();
    let apex = |x: f64| (x, 2.0 + triangle_height);
    let triangle_center = |x: f64| p(x, 2.0 + triangle_height / 3.0);
    vec![
        // A0
        cell(
            p(0.5, 0.5),
            vec![
                face(line((1.0, 0.0), (1.0, 1.0)), Some((1, 2))),
                face(line((1.0, 1.0), (0.0, 1.0)), Some((2, 3))),
                face(line((0.0, 1.0), (0.0, 0.0)), None),
                face(line((0.0, 0.0), (1.0, 0.0)), None),
            ],
            Some((SQUARE_SHAPE, identity4())),
        ),
        // B1
        cell(
            p(1.5, 0.5),
            vec![
                face(line((2.0, 0.0), (2.0, 1.0)), Some((5, 2))),
                face(line((2.0, 1.0), (1.0, 1.0)), Some((3, 4))),
                face(line((1.0, 1.0), (1.0, 0.0)), Some((0, 0))),
                face(line((1.0, 0.0), (2.0, 0.0)), None),
            ],
            Some((SQUARE_SHAPE, identity4())),
        ),
        // D2
        cell(
            p(0.5, 1.5),
            vec![
                face(line((1.0, 1.0), (1.0, 2.0)), Some((3, 3))),
                face(line((1.0, 2.0), (0.0, 2.0)), None),
                face(line((0.0, 2.0), (0.0, 1.0)), None),
                face(line((0.0, 1.0), (1.0, 1.0)), Some((0, 1))),
            ],
            Some((SQUARE_SHAPE, identity4())),
        ),
        // E3: north side split at x = 1.5 into two faces with different neighbors.
        cell(
            p(1.5, 1.5),
            vec![
                face(line((2.0, 1.0), (2.0, 2.0)), Some((4, 2))),
                face(line((2.0, 2.0), (1.5, 2.0)), Some((8, 0))),
                face(line((1.5, 2.0), (1.0, 2.0)), Some((7, 0))),
                face(line((1.0, 2.0), (1.0, 1.0)), Some((2, 0))),
                face(line((1.0, 1.0), (2.0, 1.0)), Some((1, 1))),
            ],
            Some((SPLIT_SQUARE_SHAPE, vec![0, 1, 2, 3, 4])),
        ),
        // F4: no shape template.
        cell(
            p(2.5, 1.5),
            vec![
                face(line((3.0, 1.0), (3.0, 2.0)), None),
                face(line((3.0, 2.0), (2.0, 2.0)), None),
                face(line((2.0, 2.0), (2.0, 1.0)), Some((3, 0))),
                face(line((2.0, 1.0), (3.0, 1.0)), Some((5, 1))),
            ],
            None,
        ),
        // G5: east face is the shared arc.
        cell(
            p(2.5, 0.5),
            vec![
                face(vec![shared_arc()], Some((6, 2))),
                face(line((3.0, 1.0), (2.0, 1.0)), Some((4, 3))),
                face(line((2.0, 1.0), (2.0, 0.0)), Some((1, 0))),
                face(line((2.0, 0.0), (3.0, 0.0)), None),
            ],
            Some((SQUARE_SHAPE, identity4())),
        ),
        // H6: west face is the same arc, traversed the other way.
        cell(
            p(3.5, 0.5),
            vec![
                face(line((4.0, 0.0), (4.0, 1.0)), None),
                face(line((4.0, 1.0), (3.0, 1.0)), None),
                face(vec![shared_arc().reversed()], Some((5, 0))),
                face(line((3.0, 0.0), (4.0, 0.0)), None),
            ],
            Some((SQUARE_SHAPE, identity4())),
        ),
        // T7, T8: base on E3's north side, counter-clockwise from the base.
        cell(
            triangle_center(1.25),
            vec![
                face(line((1.0, 2.0), (1.5, 2.0)), Some((3, 2))),
                face(line((1.5, 2.0), apex(1.25)), None),
                face(line(apex(1.25), (1.0, 2.0)), None),
            ],
            Some((TRIANGLE_SHAPE, vec![0, 1, 2])),
        ),
        cell(
            triangle_center(1.75),
            vec![
                face(line((1.5, 2.0), (2.0, 2.0)), Some((3, 1))),
                face(line((2.0, 2.0), apex(1.75)), None),
                face(line(apex(1.75), (1.5, 2.0)), None),
            ],
            Some((TRIANGLE_SHAPE, vec![0, 1, 2])),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::IdGenerator;
    use crate::space::{CellScope, Field, FieldOperation, TessellationGeometry};
    use std::collections::HashSet;
    use std::sync::Arc;

    fn faces(cell: TestCell) -> Vec<(TestFace, Option<(TestCell, TestFace)>)> {
        TestTessellation
            .faces_of(cell)
            .iter()
            .map(|&f| (f, TestTessellation.neighbor(cell, f)))
            .collect()
    }

    #[test]
    fn neighbors_are_reciprocal_valid_and_distinct_per_cell() {
        for cell in TestTessellation::all_cells() {
            let mut seen = HashSet::new();
            for (face, neighbor) in faces(cell) {
                let Some((other, other_face)) = neighbor else {
                    continue;
                };
                assert!(TestTessellation.is_valid_cell(other));
                assert!(TestTessellation.faces_of(other).contains(&other_face));
                assert_eq!(
                    TestTessellation.neighbor(other, other_face),
                    Some((cell, face)),
                    "{cell:?} {face:?}"
                );
                assert!(seen.insert(other), "two faces of {cell:?} toward {other:?}");
            }
        }
    }

    #[test]
    fn paired_faces_are_identical_segments_polylines_and_contact_points() {
        let t = TestTessellation;
        for cell in TestTessellation::all_cells() {
            for (face, neighbor) in faces(cell) {
                let Some((other, other_face)) = neighbor else {
                    continue;
                };
                let mine = t.edge_segments(cell, face);
                let theirs: Vec<Segment> = t
                    .edge_segments(other, other_face)
                    .iter()
                    .rev()
                    .map(Segment::reversed)
                    .collect();
                assert_eq!(mine, theirs, "{cell:?} {face:?}");
                assert_eq!(
                    t.contact_point(cell, face),
                    t.contact_point(other, other_face)
                );
                // The raw per-side segments agree too, not only the owner-derived ones.
                let raw: Vec<Segment> = t
                    .face_segments(other, other_face)
                    .iter()
                    .rev()
                    .map(Segment::reversed)
                    .collect();
                assert_eq!(t.face_segments(cell, face), raw, "{cell:?} {face:?}");
            }
        }
    }

    #[test]
    fn boundaries_are_closed_counter_clockwise_and_contain_the_center() {
        let t = TestTessellation;
        for cell in TestTessellation::all_cells() {
            let path = t.boundary_path(cell);
            assert_eq!(path.faces().len(), t.faces_of(cell).len());
            let segments: Vec<Segment> = path.segments().copied().collect();
            for (i, segment) in segments.iter().enumerate() {
                assert_eq!(segment.end(), segments[(i + 1) % segments.len()].start());
            }
            assert!(path.signed_area() > 0.0, "{cell:?}");
            assert!((t.area(cell) - path.signed_area()).abs() < 1e-9);
            assert!(path.contains(t.center(cell)), "{cell:?}");
        }
    }

    #[test]
    fn cell_scale_varies() {
        let t = TestTessellation;
        let scale = |id: u8| t.cell_scale(TestCell(id));
        assert!((scale(0) - 1.0).abs() < 1e-12);
        assert!((scale(7) - (3.0_f64.sqrt() / 16.0).sqrt()).abs() < 1e-12);
        assert!(scale(5) > scale(0), "G is a square plus an arc bulge");
        assert!(scale(6) < scale(0), "H is a square minus the arc bulge");
    }

    #[test]
    fn straight_table_matches_the_geometric_definition() {
        let t = TestTessellation;
        for cell in TestTessellation::all_cells() {
            for &a in t.faces_of(cell) {
                for &b in t.faces_of(cell) {
                    assert_eq!(
                        t.is_straight(cell, a, b),
                        is_straight_geometric(&t, cell, a, b)
                    );
                }
            }
        }
        // The arc contact point is collinear with the centers of both arc cells.
        assert!(t.is_straight(TestCell(5), TestFace(2), TestFace(0)));
        assert!(t.is_straight(TestCell(6), TestFace(2), TestFace(0)));
    }

    #[test]
    fn shapes_bind_every_templated_cell_and_skip_the_rest() {
        let t = TestTessellation;
        for cell in TestTessellation::all_cells() {
            let Some(shape) = t.shape_of(cell) else {
                assert_eq!(cell, TestCell(4), "only F has no template");
                continue;
            };
            assert!(t.shape_descriptors().contains(shape.descriptor()));
            assert_eq!(shape.descriptor().face_count(), t.faces_of(cell).len());
        }
        // D and E are congruent squares with different templates and face counts.
        let (d, e) = (TestCell(2), TestCell(3));
        assert_eq!(t.boundary_path(d).signed_area(), 1.0);
        assert_eq!(t.boundary_path(e).signed_area(), 1.0);
        assert_ne!(
            t.shape_of(d).unwrap().descriptor(),
            t.shape_of(e).unwrap().descriptor()
        );
        assert_eq!(t.faces_of(d).len(), 4);
        assert_eq!(t.faces_of(e).len(), 5);
    }

    #[test]
    fn split_side_faces_reach_different_cells() {
        let t = TestTessellation;
        let toward: Vec<TestCell> = [1, 2]
            .iter()
            .map(|&i| t.neighbor(TestCell(3), TestFace(i)).unwrap().0)
            .collect();
        assert_eq!(toward, vec![TestCell(8), TestCell(7)]);
    }

    #[test]
    fn arc_edge_is_shared_by_both_cells_and_hit_tested_from_both_sides() {
        let t = TestTessellation;
        let (g, h) = (TestCell(5), TestCell(6));
        assert!(matches!(
            t.edge_segments(g, TestFace(0))[0],
            Segment::CircularArc { .. }
        ));
        let bulge_tip = p(2.0 + 1.25_f64.sqrt(), 0.5);
        assert!(t.contact_point(g, TestFace(0)).distance(bulge_tip) < 1e-12);
        let at = |x: f64, y: f64| t.cell_at(p(x, y), CellScope::Space);
        assert_eq!(at(3.05, 0.5), Some(g), "inside the bulge, east of x = 3");
        assert_eq!(at(3.2, 0.5), Some(h));
        assert_eq!(at(bulge_tip.x, 0.5), Some(g), "on the arc: minimal id wins");
        assert_eq!(at(3.0, 0.0), Some(g), "arc endpoint");
        assert_eq!(at(9.0, 9.0), None);
    }

    #[test]
    fn declares_no_field_operations_or_presets() {
        assert!(TestTessellation.field_operations().is_empty());
        assert!(
            !TestTessellation
                .field_operations()
                .contains(&FieldOperation::Translate)
        );
        assert!(TestTessellation.presets().is_empty());
    }

    #[test]
    fn field_neighbors_follow_faces() {
        let mut ids = IdGenerator::new();
        let field = Field::new(
            Arc::new(TestTessellation),
            TestTessellation::all_cells(),
            &mut ids,
        )
        .unwrap();
        let node = field.nodes_at(TestCell(3))[0];
        let cells: HashSet<TestCell> = field
            .neighbors(node)
            .into_iter()
            .map(|n| field.cell_of(n).unwrap())
            .collect();
        let expected: HashSet<TestCell> = [4, 8, 7, 2, 1].into_iter().map(TestCell).collect();
        assert_eq!(cells, expected);
    }
}
