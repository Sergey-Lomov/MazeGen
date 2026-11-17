use super::*;
use crate::comparison::Comparison;
use crate::ids::IdGenerator;
use crate::space::topology::{Fold, FoldEnd, FoldGroup, FoldGroupId, FoldId};
use crate::space::{
    Field, MultiLevelField, SquarePoint, SquareTessellation, TessellationFingerprint, Topology,
    cell_position, floor_aware_xy_distance, planar_distance, square_rect,
};
use std::sync::Arc;

fn fp() -> TessellationFingerprint {
    TessellationFingerprint::new("test")
}

fn p(x: i32, y: i32) -> SquarePoint {
    SquarePoint { x, y }
}

/// A `width` x 1 strip whose east face (0) of the last cell is glued to the west face (2) of the
/// first: a cylinder of circumference `width`.
fn ring_topology(width: i32) -> Topology<SquareTessellation> {
    let fold = Fold {
        a: FoldEnd {
            cell: p(width - 1, 0),
            face_idx: 0,
        },
        b: FoldEnd {
            cell: p(0, 0),
            face_idx: 2,
        },
        twist: false,
        group: FoldGroupId(0),
    };
    Topology::new(
        fp(),
        vec![fold],
        vec![FoldGroup {
            id: FoldGroupId(0),
            folds: vec![FoldId(0)],
        }],
    )
}

fn two_floors(width: i32, glue_floor: Option<usize>) -> MultiLevelField<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let tessellation = Arc::<SquareTessellation>::default();
    let mut floors: Vec<Field<SquareTessellation>> = (0..2)
        .map(|_| {
            Field::new(
                Arc::clone(&tessellation),
                square_rect(width as usize, 1),
                &mut ids,
            )
            .unwrap()
        })
        .collect();
    if let Some(index) = glue_floor {
        floors[index]
            .set_topology(ring_topology(width), &fp())
            .unwrap();
    }
    MultiLevelField::new(tessellation, floors)
}

fn at(field: &MultiLevelField<SquareTessellation>, x: i32) -> crate::space::ScaledPoint {
    cell_position(field.tessellation(), p(x, 0))
}

#[test]
fn a_field_without_folds_is_bit_identical_to_the_planar_distance() {
    let field = two_floors(6, None);
    let metrics = FloorMetrics::new(&field, DistancePolicy::Strict);
    for (a_level, b_level, height) in [(0, 0, false), (0, 1, false), (0, 1, true)] {
        let got = metrics
            .distance(a_level, at(&field, 0), b_level, at(&field, 5), height)
            .unwrap();
        let expected =
            floor_aware_xy_distance(a_level, at(&field, 0), b_level, at(&field, 5), height);
        assert!(got.exact);
        assert_eq!(got.lower_bound.to_bits(), expected.to_bits());
        assert_eq!(got.upper_bound.to_bits(), expected.to_bits());
    }
}

#[test]
fn a_seam_shortens_the_distance_on_its_own_floor_only() {
    let field = two_floors(6, Some(0));
    let metrics = FloorMetrics::new(&field, DistancePolicy::Strict);
    let (a, b) = (at(&field, 0), at(&field, 5));
    let glued = metrics.distance(0, a, 0, b, false).unwrap();
    assert!(glued.exact);
    assert!((glued.lower_bound - 1.0).abs() < 1e-9, "{glued:?}");
    let plain = metrics.distance(1, a, 1, b, false).unwrap();
    assert_eq!(plain.upper_bound, planar_distance(a, b));
}

#[test]
fn a_cross_floor_pair_takes_the_shorter_xy_distance_and_lifts_it_by_the_floor_gap() {
    let field = two_floors(6, Some(1));
    let metrics = FloorMetrics::new(&field, DistancePolicy::Strict);
    let (a, b) = (at(&field, 0), at(&field, 5));
    let flat = metrics.distance(0, a, 1, b, false).unwrap();
    assert!((flat.upper_bound - 1.0).abs() < 1e-9, "{flat:?}");
    let lifted = metrics.distance(0, a, 1, b, true).unwrap();
    assert!(
        (lifted.upper_bound - 2.0_f64.sqrt()).abs() < 1e-9,
        "{lifted:?}"
    );
}

#[test]
fn compare_decides_with_the_surface_distance() {
    let field = two_floors(6, Some(0));
    let metrics = FloorMetrics::new(&field, DistancePolicy::Strict);
    let (a, b) = (at(&field, 0), at(&field, 5));
    assert_eq!(
        metrics.compare(0, a, 0, b, false, Comparison::Lt, 2.0),
        Ok(WithinLimit::Yes)
    );
    assert_eq!(
        metrics.compare(0, a, 0, b, false, Comparison::Lt, 0.5),
        Ok(WithinLimit::No)
    );
}

#[test]
fn ranking_distance_is_planar_without_seams_and_surface_with_them() {
    let plain = two_floors(6, None);
    let glued = two_floors(6, Some(0));
    let (a, b) = (at(&plain, 0), at(&plain, 5));
    let first_plain = plain.levels_ordered().next().unwrap();
    let plain_metric = plain.field_of(first_plain).unwrap().surface_metric();
    assert_eq!(plain_metric.ranking_distance(a, b), planar_distance(a, b));
    let first = glued.levels_ordered().next().unwrap();
    let glued_metric = glued.field_of(first).unwrap().surface_metric();
    assert!((glued_metric.ranking_distance(a, b) - 1.0).abs() < 1e-9);
}

#[test]
fn floor_ranking_distance_follows_each_pairs_own_floor() {
    let field = two_floors(6, Some(1));
    let metrics = FloorMetrics::new(&field, DistancePolicy::Strict);
    let (a, b) = (at(&field, 0), at(&field, 5));
    assert_eq!(metrics.ranking_distance(0, a, 0, b), planar_distance(a, b));
    assert!((metrics.ranking_distance(1, a, 1, b) - 1.0).abs() < 1e-9);
    assert!((metrics.ranking_distance(0, a, 1, b) - 1.0).abs() < 1e-9);
}
