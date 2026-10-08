use maze_core::IdGenerator;
use maze_core::space::{
    CairoFace, CairoPoint, CairoTessellation, CairoTileKind, Field, Tessellation,
};

fn node(field: &Field<CairoTessellation>, point: CairoPoint) -> u64 {
    field.nodes_at(point)[0]
}

fn broad_points() -> Vec<CairoPoint> {
    (-32..=32)
        .flat_map(|y| (-32..=32).map(move |x| CairoPoint::new(x, y)))
        .filter(|&point| CairoTessellation::is_valid_point(point))
        .collect()
}

#[test]
fn negative_coordinates_use_the_same_four_orientation_classes() {
    assert_eq!(CairoPoint::new(-3, 2).kind(), Some(CairoTileKind::L));
    assert_eq!(CairoPoint::new(-1, 2).kind(), Some(CairoTileKind::R));
    assert_eq!(CairoPoint::new(-6, -5).kind(), Some(CairoTileKind::U));
    assert_eq!(CairoPoint::new(-6, -7).kind(), Some(CairoTileKind::D));
    assert!(!CairoTessellation::is_valid_point(CairoPoint::new(0, 0)));
}

#[test]
fn invalid_points_are_not_neighbors_and_rect_is_deterministic() {
    let point = CairoPoint::new(-1, 2);
    let destination = CairoPoint::new(-2, -1);
    assert!(CairoTessellation::is_valid_point(destination));
    assert!(CairoTessellation::face_between(point, destination).is_some());
    assert_eq!(
        CairoTessellation::face_between(point, CairoPoint::new(-2, 0)),
        None
    );
    assert_eq!(
        CairoTessellation::face_neighbors(CairoPoint::new(0, 0)),
        None
    );

    let rect = CairoTessellation::rect(3, 2);
    assert_eq!(rect, CairoTessellation::rect(3, 2));
    assert_eq!(rect.len(), 12);
    assert!(
        rect.iter()
            .all(|&point| CairoTessellation::is_valid_point(point))
    );
}

#[test]
fn cartesian_projection_preserves_integer_coordinates() {
    assert_eq!(
        CairoTessellation::cartesian(CairoPoint::new(-6, -5)),
        (-6.0, -5.0)
    );
}

#[test]
fn every_valid_point_has_five_deterministic_direct_neighbors() {
    for point in broad_points() {
        let first = CairoTessellation::face_neighbors(point).unwrap();
        let second = CairoTessellation::face_neighbors(point).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), CairoTessellation::faces().len());

        let mut destinations: Vec<_> = first.iter().map(|(_, destination)| *destination).collect();
        destinations.sort_by_key(|point| (point.x, point.y));
        destinations.dedup();
        assert_eq!(destinations.len(), 5);

        for (face, destination) in first {
            assert!(CairoTessellation::is_valid_point(destination));
            assert_eq!(CairoTessellation::step(point, face), Some(destination));
            assert_eq!(
                CairoTessellation::face_between(point, destination),
                Some(face)
            );
            assert!(CairoTessellation::face_between(destination, point).is_some());
        }
    }
}

#[test]
fn step_returns_none_for_unused_coordinate_pairs() {
    assert_eq!(
        CairoTessellation::step(CairoPoint::new(0, 0), CairoFace::Twin),
        None
    );
}

#[test]
fn coordinate_overflow_returns_none_instead_of_panicking() {
    let point = CairoPoint::new(i32::MAX, 2);
    assert!(CairoTessellation::is_valid_point(point));
    assert_eq!(CairoTessellation::step(point, CairoFace::NorthEast), None);
    assert_eq!(CairoTessellation::face_neighbors(point), None);
    assert_eq!(
        CairoTessellation::face_between(point, CairoPoint::new(i32::MIN, 2)),
        None
    );
}

#[test]
fn field_constructors_reject_invalid_cairo_points() {
    let invalid = CairoPoint::new(0, 0);
    let mut ids = IdGenerator::new();

    let result = Field::<CairoTessellation>::new([invalid], &mut ids);
    assert!(matches!(result, Err("field contains an invalid point")));

    let result = Field::<CairoTessellation>::from_id_points([(1, invalid)]);
    assert!(matches!(result, Err("field contains an invalid point")));
}

#[test]
fn field_neighbors_are_symmetric_and_ordered_by_faces() {
    let mut ids = IdGenerator::new();
    let field = Field::<CairoTessellation>::new(broad_points(), &mut ids).unwrap();
    let point = CairoPoint::new(-1, 2);
    let point_node = node(&field, point);
    let neighbors = field.neighbors(point_node);
    assert_eq!(neighbors.len(), 5);

    let expected: Vec<_> = CairoTessellation::face_neighbors(point)
        .unwrap()
        .into_iter()
        .map(|(_, destination)| node(&field, destination))
        .collect();
    assert_eq!(neighbors, expected);

    for neighbor in neighbors {
        assert!(field.neighbors(neighbor).contains(&point_node));
    }
}

#[test]
fn explicit_symmetry_tables_have_the_expected_shape() {
    assert_eq!(
        CairoTessellation::rotation_symmetries(),
        &[&[0, 1, 2, 3, 4][..]]
    );
    assert_eq!(
        CairoTessellation::mirror_symmetries(),
        &[&[0, 4, 3, 2, 1][..]]
    );

    let mut faces = CairoTessellation::faces().to_vec();
    faces.sort_by_key(|face| match face {
        CairoFace::Twin => 0,
        CairoFace::NorthWest => 1,
        CairoFace::NorthEast => 2,
        CairoFace::SouthEast => 3,
        CairoFace::SouthWest => 4,
    });
    assert_eq!(faces, CairoTessellation::faces());
}

#[test]
fn local_dual_graph_has_three_and_four_valent_vertex_cycles() {
    let mut ids = IdGenerator::new();
    let field = Field::<CairoTessellation>::new(broad_points(), &mut ids).unwrap();
    let center = node(&field, CairoPoint::new(-1, 2));
    let neighbors = field.neighbors(center);

    let mut triangles = 0;
    let mut quadrilaterals = 0;
    for &first in &neighbors {
        for &last in &neighbors {
            if first >= last {
                continue;
            }
            if field.neighbors(first).contains(&last) {
                triangles += 1;
            }
            for middle in field.neighbors(first) {
                if middle == center || middle == last {
                    continue;
                }
                if field.neighbors(middle).contains(&last) {
                    quadrilaterals += 1;
                }
            }
        }
    }

    assert_eq!(triangles, 3, "three 120-degree vertices have valency 3");
    assert_eq!(
        quadrilaterals, 4,
        "two 90-degree vertices produce two orientations each"
    );
}
