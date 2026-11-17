use super::*;
use crate::ids::IdGenerator;
use crate::space::topology::{Fold, FoldEnd, FoldGroup, FoldGroupId, FoldId, FoldSide};
use crate::space::{
    Field, RadialFace, RadialLayout, RadialParams, RadialPoint, RadialTessellation, SquarePoint,
    SquareTessellation, TessellationFingerprint, Topology, edge_position,
};
use std::f64::consts::PI;
use std::sync::Arc;

const E: usize = 0;
const W: usize = 2;

fn fp() -> TessellationFingerprint {
    TessellationFingerprint::new("test")
}

fn p(x: i32, y: i32) -> SquarePoint {
    SquarePoint { x, y }
}

fn fold<C>(a: (C, usize), b: (C, usize), twist: bool) -> Fold<C> {
    Fold {
        a: FoldEnd {
            cell: a.0,
            face_idx: a.1,
        },
        b: FoldEnd {
            cell: b.0,
            face_idx: b.1,
        },
        twist,
        group: FoldGroupId(0),
    }
}

fn topology<T: Tessellation>(folds: Vec<Fold<T::CellId>>) -> Topology<T> {
    let ids = (0..folds.len()).map(FoldId).collect();
    Topology::new(
        fp(),
        folds,
        vec![FoldGroup {
            id: FoldGroupId(0),
            folds: ids,
        }],
    )
}

fn field<T: Tessellation>(
    tessellation: T,
    cells: Vec<T::CellId>,
    folds: Vec<Fold<T::CellId>>,
) -> Field<T> {
    let mut field = Field::new(Arc::new(tessellation), cells, &mut IdGenerator::new()).unwrap();
    field.set_topology(topology(folds), &fp()).unwrap();
    field
}

/// A 4×2 square field whose east edge is glued to its west edge.
fn cylinder(twist: bool) -> Field<SquareTessellation> {
    let cells = (0..4).flat_map(|x| (0..2).map(move |y| p(x, y))).collect();
    let folds = (0..2)
        .map(|y| fold((p(3, y), E), (p(0, y), W), twist))
        .collect();
    field(SquareTessellation, cells, folds)
}

fn line(from: (f64, f64), to: (f64, f64)) -> Segment {
    Segment::line(Point::new(from.0, from.1), Point::new(to.0, to.1))
}

fn arc(center: (f64, f64), radius: f64, start: f64, sweep: f64) -> Segment {
    Segment::arc(Point::new(center.0, center.1), radius, start, sweep)
}

fn transform_of(class: FoldClass) -> RigidTransform {
    match class {
        FoldClass::Isometric { transform } => transform,
        FoldClass::TopologicalOnly => panic!("expected an isometric fold"),
    }
}

#[test]
fn straight_faces_of_equal_length_are_isometric_both_ways() {
    // Side a runs up along x = 4, side b runs down along x = 0 (both counter-clockwise).
    let a = [line((4.0, 0.0), (4.0, 1.0))];
    let b = [line((0.0, 1.0), (0.0, 0.0))];
    for twist in [false, true] {
        let transform = transform_of(classify_fold_faces(&a, &b, twist));
        assert_eq!(transform.reflects, twist);
        // The endpoint correspondence follows the twist.
        let (to_start, to_end) = if twist {
            (b[0].start(), b[0].end())
        } else {
            (b[0].end(), b[0].start())
        };
        assert!(transform.apply(to_start).distance(a[0].start()) < FOLD_ISOMETRY_EPS);
        assert!(transform.apply(to_end).distance(a[0].end()) < FOLD_ISOMETRY_EPS);
    }
}

#[test]
fn straight_faces_of_different_length_are_topological_only() {
    let a = [line((4.0, 0.0), (4.0, 1.0))];
    let b = [line((0.0, 2.0), (0.0, 0.0))];
    assert_eq!(
        classify_fold_faces(&a, &b, false),
        FoldClass::TopologicalOnly
    );
}

#[test]
fn equal_length_is_not_enough() {
    // A line against two collinear halves: same length, different segmentation.
    let straight = [line((0.0, 0.0), (2.0, 0.0))];
    let halves = [line((0.0, 0.0), (1.0, 0.0)), line((1.0, 0.0), (2.0, 0.0))];
    assert_eq!(
        classify_fold_faces(&straight, &halves, true),
        FoldClass::TopologicalOnly
    );
    // A bent chain against a straight chain of the same total length.
    let bent = [line((0.0, 0.0), (1.0, 0.0)), line((1.0, 0.0), (1.0, 1.0))];
    let long = [line((0.0, 0.0), (0.0, 2.0))];
    assert_eq!(
        classify_fold_faces(&long, &bent, true),
        FoldClass::TopologicalOnly
    );
    // Arcs of equal length (π/2) but different radius, hence a different chord.
    let tight = [arc((0.0, 0.0), 1.0, 0.0, PI / 2.0)];
    let wide = [arc((0.0, 0.0), 2.0, 0.0, PI / 4.0)];
    assert!((tight[0].length() - wide[0].length()).abs() < 1e-12);
    assert_eq!(
        classify_fold_faces(&tight, &wide, false),
        FoldClass::TopologicalOnly
    );
}

#[test]
fn degenerate_or_mixed_chains_are_topological_only() {
    let straight = [line((0.0, 0.0), (1.0, 1.0))];
    // No segments on either side.
    assert_eq!(
        classify_fold_faces(&[], &straight, false),
        FoldClass::TopologicalOnly
    );
    assert_eq!(
        classify_fold_faces(&straight, &[], true),
        FoldClass::TopologicalOnly
    );
    // A closed chain has coincident ends, so no transform is determined by its endpoints.
    let closed = [line((0.0, 0.0), (1.0, 0.0)), line((1.0, 0.0), (0.0, 0.0))];
    assert_eq!(
        classify_fold_faces(&closed, &closed, false),
        FoldClass::TopologicalOnly
    );
    // A line against an arc with the same endpoints.
    let curved = [arc((0.0, 0.0), 1.0, 0.0, PI / 2.0)];
    let chord = [Segment::line(curved[0].start(), curved[0].end())];
    assert_eq!(
        classify_fold_faces(&chord, &[curved[0].reversed()], false),
        FoldClass::TopologicalOnly
    );
    assert_eq!(
        classify_fold_faces(&curved, &[chord[0].reversed()], false),
        FoldClass::TopologicalOnly
    );
}

#[test]
fn same_chord_and_radius_but_opposite_bulge_is_topological_only() {
    // Both run (1,0) -> (0,1); the first bulges away from the origin, the second toward it.
    let convex = [arc((0.0, 0.0), 1.0, 0.0, PI / 2.0)];
    let concave = arc((1.0, 1.0), 1.0, -PI / 2.0, -PI / 2.0);
    assert!(concave.start().distance(convex[0].start()) < 1e-12);
    assert!(concave.end().distance(convex[0].end()) < 1e-12);
    // Untwisted, side b is traversed backwards: pass its reverse so that it reads as `concave`.
    let b = [concave.reversed()];
    assert_eq!(
        classify_fold_faces(&convex, &b, false),
        FoldClass::TopologicalOnly
    );
}

#[test]
fn twist_selects_orientation_preserving_or_reflecting_fit() {
    // A chain and its mirror image across the x axis (travel direction kept): only a reflection
    // maps one onto the other with start meeting start; untwisted, the reversed chain has its
    // legs in the wrong order.
    let l = [line((0.0, 0.0), (2.0, 0.0)), line((2.0, 0.0), (2.0, 1.0))];
    let mirrored = [line((0.0, 0.0), (2.0, 0.0)), line((2.0, 0.0), (2.0, -1.0))];
    let transform = transform_of(classify_fold_faces(&l, &mirrored, true));
    assert!(transform.reflects);
    assert!(
        transform
            .apply(Point::new(2.0, -1.0))
            .distance(Point::new(2.0, 1.0))
            < FOLD_ISOMETRY_EPS
    );
    assert_eq!(
        classify_fold_faces(&l, &mirrored, false),
        FoldClass::TopologicalOnly
    );
}

#[test]
fn arcs_match_by_travel_direction_and_twist() {
    // Side a: a counter-clockwise arc (an outer face). Side b: a clockwise arc of the same radius
    // and span (an inner face). Gluing them is the ordinary match, so both twists fit (an arc is
    // symmetric under swapping its ends), the untwisted one without a reflection.
    let a = [arc((0.0, 0.0), 2.0, 0.0, PI / 4.0)];
    let b = [arc((0.0, 0.0), 2.0, PI + PI / 4.0, -PI / 4.0)];
    let untwisted = transform_of(classify_fold_faces(&a, &b, false));
    assert!(!untwisted.reflects);
    let twisted = transform_of(classify_fold_faces(&a, &b, true));
    assert!(twisted.reflects);
    for t in [0.0, 0.3, 0.5, 1.0] {
        assert!(untwisted.apply(b[0].point(1.0 - t)).distance(a[0].point(t)) < FOLD_ISOMETRY_EPS);
        assert!(twisted.apply(b[0].point(t)).distance(a[0].point(t)) < FOLD_ISOMETRY_EPS);
    }
    // Two outer faces of equal radius and span curve the same way around their cells, so the
    // glued cells could not sit on opposite sides: no rigid fit under either twist.
    let outer = [arc((0.0, 0.0), 2.0, PI, PI / 4.0)];
    assert_eq!(
        classify_fold_faces(&a, &outer, false),
        FoldClass::TopologicalOnly
    );
    assert_eq!(
        classify_fold_faces(&a, &outer, true),
        FoldClass::TopologicalOnly
    );
}

#[test]
fn inverse_undoes_the_transform() {
    let a = [arc((0.0, 0.0), 2.0, 0.0, PI / 4.0)];
    let b = [arc((0.0, 0.0), 2.0, PI + PI / 4.0, -PI / 4.0)];
    for twist in [false, true] {
        let transform = transform_of(classify_fold_faces(&a, &b, twist));
        let inverse = transform.inverse();
        for q in [Point::new(0.3, -1.7), Point::new(-4.0, 2.5)] {
            assert!(inverse.apply(transform.apply(q)).distance(q) < 1e-12);
            assert!(transform.apply(inverse.apply(q)).distance(q) < 1e-12);
        }
    }
}

#[test]
fn transform_matrix_matches_apply() {
    let a = [line((4.0, 0.0), (4.0, 1.0))];
    let b = [line((0.0, 1.0), (0.0, 0.0))];
    for twist in [false, true] {
        let transform = transform_of(classify_fold_faces(&a, &b, twist));
        let [m_a, m_b, m_c, m_d, m_e, m_f] = transform.matrix();
        let q = Point::new(0.3, -1.7);
        let by_matrix = Point::new(m_a * q.x + m_c * q.y + m_e, m_b * q.x + m_d * q.y + m_f);
        assert!(by_matrix.distance(transform.apply(q)) < 1e-12);
    }
}

#[test]
fn field_classifies_square_cylinder_folds_as_isometric() {
    for twist in [false, true] {
        let field = cylinder(twist);
        for id in 0..2 {
            let transform = transform_of(field.fold_class(FoldId(id)).unwrap());
            assert_eq!(transform.reflects, twist);
        }
        assert!(field.fold_class(FoldId(2)).is_none());
    }
}

#[test]
fn field_classifies_radial_arcs_by_curvature_and_radius() {
    let tessellation = RadialTessellation::new(RadialParams {
        first_ring_cells: 6,
        layout: RadialLayout::Classic,
        max_cells: 200,
    })
    .unwrap();
    let face_idx = |cell: RadialPoint, face: RadialFace| {
        tessellation
            .faces_of(cell)
            .iter()
            .position(|&f| f == face)
            .unwrap()
    };
    // Ring 1 spans 60° per cell and ring 2 30°: the outer arcs of ring 1 and the inner arcs of
    // ring 2 are congruent arcs of the first circle. The field holds two non-adjacent cells, so
    // the base neighbors of the glued faces lie outside it.
    let ring1 = RadialPoint { ring: 1, index: 0 };
    let ring2 = RadialPoint { ring: 2, index: 6 };
    let class = |twist: bool, a: (RadialPoint, RadialFace), b: (RadialPoint, RadialFace)| {
        let f = field(
            tessellation.clone(),
            vec![ring1, ring2],
            vec![fold(
                (a.0, face_idx(a.0, a.1)),
                (b.0, face_idx(b.0, b.1)),
                twist,
            )],
        );
        assert!(f.fold_activity()[0].is_active());
        f.fold_class(FoldId(0)).unwrap()
    };
    let outer1 = (ring1, RadialFace::Outer(0));
    let inner2 = (ring2, RadialFace::Inner(0));
    let outer2 = (ring2, RadialFace::Outer(0));

    // Outer arc against inner arc of the same radius and span: isometric either way.
    assert!(!transform_of(class(false, outer1, inner2)).reflects);
    assert!(transform_of(class(true, outer1, inner2)).reflects);
    // Both outer: radii differ.
    assert_eq!(class(false, outer1, outer2), FoldClass::TopologicalOnly);
    assert_eq!(class(true, outer1, outer2), FoldClass::TopologicalOnly);
}

#[test]
fn folded_face_is_unpaired() {
    let field = cylinder(false);
    let tessellation = field.tessellation();
    let west = tessellation.faces_of(p(0, 0))[W];
    // The base owner of (0,0)'s west face is its smaller neighbor (-1,0); the fold unpairs it.
    assert_eq!(tessellation.edge_owner(p(0, 0), west).0, p(-1, 0));
    assert_eq!(field.edge_owner(p(0, 0), west), (p(0, 0), west));
    assert_eq!(
        field.edge_segments(p(0, 0), west),
        tessellation.face_segments(p(0, 0), west)
    );
    assert_eq!(
        field.contact_point(p(0, 0), west),
        chain_midpoint(&tessellation.face_segments(p(0, 0), west))
    );
    let folded = field.folded_face(p(0, 0), west).unwrap();
    assert_eq!(folded.side, FoldSide::B);
    assert_eq!(folded.partner.cell, p(3, 0));
    assert!(!folded.twist);
    // An ordinary face is still paired.
    let north = tessellation.faces_of(p(0, 0))[1];
    assert!(field.folded_face(p(0, 0), north).is_none());
    assert_eq!(
        field.edge_owner(p(0, 0), north),
        tessellation.edge_owner(p(0, 0), north)
    );
}

#[test]
fn without_folds_geometry_is_unchanged() {
    let cells: Vec<_> = (0..3).flat_map(|x| (0..3).map(move |y| p(x, y))).collect();
    let field = Field::new(
        Arc::new(SquareTessellation),
        cells.clone(),
        &mut IdGenerator::new(),
    )
    .unwrap();
    let tessellation = field.tessellation();
    for cell in cells {
        for &face in tessellation.faces_of(cell) {
            assert_eq!(
                field.edge_owner(cell, face),
                tessellation.edge_owner(cell, face)
            );
            assert_eq!(
                field.edge_segments(cell, face),
                tessellation.edge_segments(cell, face)
            );
            assert_eq!(
                field.contact_point(cell, face),
                tessellation.contact_point(cell, face)
            );
        }
    }
}

#[test]
fn inactive_fold_does_not_unpair_a_face() {
    // The fold's second end (7,0) is not a field cell, so the fold is inactive.
    let field = field(
        SquareTessellation,
        vec![p(0, 0), p(3, 0)],
        vec![fold((p(3, 0), E), (p(7, 0), W), false)],
    );
    let east = field.tessellation().faces_of(p(3, 0))[E];
    assert!(!field.fold_activity()[0].is_active());
    assert!(field.folded_face(p(3, 0), east).is_none());
    assert!(field.fold_class(FoldId(0)).is_none());
}

#[test]
fn edge_position_across_a_fold_is_the_folded_faces_contact_point() {
    let field = cylinder(false);
    let across = edge_position(&field, p(3, 1), p(0, 1));
    assert!(across.point.distance(Point::new(4.0, 1.5)) < GEOM_EPS);
    let back = edge_position(&field, p(0, 1), p(3, 1));
    assert!(back.point.distance(Point::new(0.0, 1.5)) < GEOM_EPS);
    let tessellation = field.tessellation();
    let midpoint = (tessellation.center(p(3, 1)) + tessellation.center(p(0, 1))) * 0.5;
    assert!(across.point.distance(midpoint) > 1.0);
    // An ordinary neighbor is unaffected.
    let ordinary = edge_position(&field, p(1, 1), p(2, 1));
    assert!(ordinary.point.distance(Point::new(2.0, 1.5)) < GEOM_EPS);
}
