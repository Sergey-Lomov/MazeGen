use maze_core::IdGenerator;
use maze_core::space::{
    CellScope, Field, FieldOpError, FieldOperation, FieldOps, Point, RhombitrihexagonalKind,
    RhombitrihexagonalPoint, RhombitrihexagonalTessellation, Tessellation, TessellationGeometry,
};
use std::sync::Arc;

const SQRT_3: f64 = 1.732_050_807_568_877_2;

fn tiles(radius: i32) -> Vec<RhombitrihexagonalPoint> {
    (-radius..=radius)
        .flat_map(|r| (-radius..=radius).map(move |q| (q, r)))
        .flat_map(|(q, r)| {
            RhombitrihexagonalKind::ALL
                .into_iter()
                .map(move |kind| RhombitrihexagonalPoint::new(q, r, kind))
        })
        .collect()
}

fn neighbors(
    t: &RhombitrihexagonalTessellation,
    c: RhombitrihexagonalPoint,
) -> Vec<RhombitrihexagonalPoint> {
    t.faces_of(c)
        .iter()
        .map(|&f| t.neighbor(c, f).unwrap().0)
        .collect()
}

/// Hexagons border six squares, squares two hexagons and two triangles, triangles three squares.
#[test]
fn neighbor_kinds_follow_the_3_4_6_4_pattern() {
    let t = RhombitrihexagonalTessellation;
    for c in tiles(5) {
        let around = neighbors(&t, c);
        let mut unique = around.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), around.len(), "{c:?}");
        let count =
            |pred: fn(&RhombitrihexagonalPoint) -> bool| around.iter().filter(|n| pred(n)).count();
        let hexagons = count(|n| n.is_hexagon());
        let squares = count(|n| n.is_square());
        let triangles = around.len() - hexagons - squares;
        match c.kind {
            RhombitrihexagonalKind::Hexagon => {
                assert_eq!((hexagons, squares, triangles), (0, 6, 0))
            }
            RhombitrihexagonalKind::Square0
            | RhombitrihexagonalKind::Square1
            | RhombitrihexagonalKind::Square2 => {
                assert_eq!((hexagons, squares, triangles), (2, 0, 2), "{c:?}");
                // Face 0 is the one shared with the anchor hexagon.
                assert_eq!(
                    around[0],
                    RhombitrihexagonalPoint::hexagon(c.q, c.r),
                    "{c:?}"
                );
            }
            _ => assert_eq!((hexagons, squares, triangles), (0, 3, 0), "{c:?}"),
        }
    }
}

#[test]
fn hexagon_faces_lead_to_the_three_square_orientations() {
    let t = RhombitrihexagonalTessellation;
    let hexagon = RhombitrihexagonalPoint::hexagon(3, -2);
    let around = neighbors(&t, hexagon);
    assert_eq!(
        around,
        [
            RhombitrihexagonalPoint::new(3, -2, RhombitrihexagonalKind::Square0),
            RhombitrihexagonalPoint::new(3, -2, RhombitrihexagonalKind::Square1),
            RhombitrihexagonalPoint::new(3, -2, RhombitrihexagonalKind::Square2),
            RhombitrihexagonalPoint::new(2, -2, RhombitrihexagonalKind::Square0),
            RhombitrihexagonalPoint::new(3, -3, RhombitrihexagonalKind::Square1),
            RhombitrihexagonalPoint::new(4, -3, RhombitrihexagonalKind::Square2),
        ]
    );
}

#[test]
fn neighbor_is_reciprocal() {
    let t = RhombitrihexagonalTessellation;
    for c in tiles(5) {
        for &f in t.faces_of(c) {
            let (c2, f2) = t.neighbor(c, f).unwrap();
            assert_eq!(t.neighbor(c2, f2), Some((c, f)), "{c:?} {f:?}");
        }
    }
}

#[test]
fn wire_encoding_round_trips_including_negative_coordinates() {
    for c in tiles(5) {
        let (x, y) = c.to_xy();
        assert_eq!(RhombitrihexagonalPoint::from_xy(x, y), c);
    }
    assert_eq!(
        RhombitrihexagonalPoint::from_xy(-1, 4),
        RhombitrihexagonalPoint::new(-1, 4, RhombitrihexagonalKind::TriangleB)
    );
}

#[test]
fn wire_encoding_wraps_beyond_the_documented_range() {
    let inside = RhombitrihexagonalPoint::hexagon(i32::MAX / 6, 0);
    let (x, y) = inside.to_xy();
    assert_eq!(RhombitrihexagonalPoint::from_xy(x, y), inside);
    let outside = RhombitrihexagonalPoint::hexagon(i32::MAX / 6 + 1, 0);
    let (x, y) = outside.to_xy();
    assert_ne!(RhombitrihexagonalPoint::from_xy(x, y), outside);
}

#[test]
fn neighbor_is_none_at_coordinate_overflow() {
    let t = RhombitrihexagonalTessellation;
    let missing = RhombitrihexagonalKind::ALL
        .into_iter()
        .flat_map(|kind| {
            let c = RhombitrihexagonalPoint::new(i32::MAX, 0, kind);
            t.faces_of(c)
                .iter()
                .map(|&f| t.neighbor(c, f))
                .collect::<Vec<_>>()
        })
        .filter(Option::is_none)
        .count();
    assert!(missing > 0);
}

/// Hexagons and squares are passed straight through the opposite face; triangles never.
#[test]
fn straight_passes_are_opposite_faces_of_hexagons_and_squares() {
    let t = RhombitrihexagonalTessellation;
    for c in tiles(2) {
        let straight = t
            .faces_of(c)
            .iter()
            .flat_map(|&a| t.faces_of(c).iter().map(move |&b| (a, b)))
            .filter(|&(a, b)| t.is_straight(c, a, b))
            .count();
        let expected = match t.faces_of(c).len() {
            6 => 6,
            4 => 4,
            _ => 0,
        };
        assert_eq!(straight, expected, "{c:?}");
    }
}

#[test]
fn shapes_are_regular_6_4_and_3() {
    let t = RhombitrihexagonalTessellation;
    let keys: Vec<_> = t.shape_descriptors().iter().map(|d| d.key()).collect();
    assert_eq!(keys, ["regular:6", "regular:4", "regular:3"]);
    let key = |c| t.shape_of(c).unwrap().descriptor().key().to_owned();
    for kind in RhombitrihexagonalKind::ALL {
        let expected = match kind {
            RhombitrihexagonalKind::Hexagon => "regular:6",
            RhombitrihexagonalKind::Square0
            | RhombitrihexagonalKind::Square1
            | RhombitrihexagonalKind::Square2 => "regular:4",
            _ => "regular:3",
        };
        assert_eq!(key(RhombitrihexagonalPoint::new(0, 0, kind)), expected);
    }
}

#[test]
fn cells_have_unit_sides_and_shared_edges_match() {
    let t = RhombitrihexagonalTessellation;
    for c in tiles(3) {
        let path = t.boundary_path(c);
        assert!((path.signed_area() - t.area(c)).abs() < 1e-9, "{c:?}");
        for &f in t.faces_of(c) {
            let segments = t.edge_segments(c, f);
            let length: f64 = segments.iter().map(|s| s.length()).sum();
            assert!((length - 1.0).abs() < 1e-9, "{c:?} {f:?}");
            let (c2, f2) = t.neighbor(c, f).unwrap();
            let theirs: Vec<_> = t
                .edge_segments(c2, f2)
                .iter()
                .rev()
                .map(|s| s.reversed())
                .collect();
            assert_eq!(segments, theirs, "{c:?} {f:?}");
        }
    }
}

/// A triangle, a square, a hexagon and a square meet at every vertex: the corners at each vertex
/// read `3.4.6.4`, in that cyclic order.
#[test]
fn every_interior_vertex_is_3_4_6_4() {
    use std::collections::HashMap;
    let t = RhombitrihexagonalTessellation;
    let mut corners: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for c in tiles(3) {
        for &f in t.faces_of(c) {
            let start = t.edge_segments(c, f)[0].start();
            let key = (
                (start.x * 8.0).round() as i64,
                (start.y * 8.0).round() as i64,
            );
            corners.entry(key).or_default().push(t.faces_of(c).len());
        }
    }
    let mut full = 0;
    for sides in corners.values_mut() {
        if sides.len() == 4 {
            sides.sort();
            assert_eq!(sides, &[3, 4, 4, 6]);
            full += 1;
        }
    }
    assert!(full > 100);
}

#[test]
fn hexagon_square_and_triangle_areas() {
    let t = RhombitrihexagonalTessellation;
    assert!((t.area(RhombitrihexagonalPoint::hexagon(0, 0)) - 1.5 * SQRT_3).abs() < 1e-12);
    for kind in [
        RhombitrihexagonalKind::Square0,
        RhombitrihexagonalKind::Square1,
        RhombitrihexagonalKind::Square2,
    ] {
        assert!((t.area(RhombitrihexagonalPoint::new(1, -2, kind)) - 1.0).abs() < 1e-12);
    }
    for kind in [
        RhombitrihexagonalKind::TriangleA,
        RhombitrihexagonalKind::TriangleB,
    ] {
        assert!((t.area(RhombitrihexagonalPoint::new(1, -2, kind)) - SQRT_3 / 4.0).abs() < 1e-12);
    }
}

#[test]
fn hexagon_centers_form_the_triangular_lattice() {
    let t = RhombitrihexagonalTessellation;
    let at = |q, r| t.center(RhombitrihexagonalPoint::hexagon(q, r));
    let first = at(1, 0);
    assert!((first.distance(Point::new(0.0, 0.0)) - (1.0 + SQRT_3)).abs() < 1e-12);
    assert!((first.y.atan2(first.x) - 30f64.to_radians()).abs() < 1e-12);
    assert!((at(0, 1).distance(Point::new(0.0, 0.0)) - (1.0 + SQRT_3)).abs() < 1e-12);
    assert!((at(0, 1).x).abs() < 1e-12);
}

#[test]
fn cell_at_finds_cells_in_every_quadrant() {
    let t = RhombitrihexagonalTessellation;
    for c in tiles(4) {
        assert_eq!(t.cell_at(t.center(c), CellScope::Space), Some(c), "{c:?}");
    }
    assert!(
        t.cell_at(Point::new(-100.0, 100.0), CellScope::Space)
            .is_some()
    );
}

#[test]
fn candidate_cells_cover_the_box_and_respect_the_limit() {
    let t = RhombitrihexagonalTessellation;
    let (min, max) = (Point::new(-3.0, -3.0), Point::new(3.0, 3.0));
    let cells = t.candidate_cells(min, max, 10_000).unwrap();
    for c in tiles(8) {
        let touches = t.boundary_path(c).faces().iter().flatten().any(|s| {
            let v = s.start();
            v.x >= min.x && v.x <= max.x && v.y >= min.y && v.y <= max.y
        });
        if touches {
            assert!(cells.contains(&c), "{c:?}");
        }
    }
    assert_eq!(t.candidate_cells(min, max, cells.len() - 1), None);
    assert!(t.candidate_cells(min, max, cells.len()).is_some());
}

#[test]
fn anchor_reach_bounds_every_cell_vertex() {
    let t = RhombitrihexagonalTessellation;
    let origin = t.center(RhombitrihexagonalPoint::hexagon(0, 0));
    for kind in RhombitrihexagonalKind::ALL {
        let cell = RhombitrihexagonalPoint::new(0, 0, kind);
        for s in t.boundary_path(cell).faces().iter().flatten() {
            assert!(s.start().distance(origin) <= 2.0 + 1e-9, "{kind:?}");
        }
    }
}

#[test]
fn presets_are_nonempty_and_rect_scales_with_its_size() {
    let t = RhombitrihexagonalTessellation;
    let small = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    let large = t.build_preset("rect", &[("cols", 6), ("rows", 6)]).unwrap();
    assert!(large.len() > 3 * small.len());
    assert!(small.iter().any(|c| c.is_hexagon()));
    assert!(small.iter().any(|c| c.is_square()));
    assert!(small.iter().any(|c| !c.is_hexagon() && !c.is_square()));
}

#[test]
fn translation_by_a_lattice_vector_and_reflection_work() {
    let t = RhombitrihexagonalTessellation;
    let cells = [
        RhombitrihexagonalPoint::hexagon(0, 0),
        RhombitrihexagonalPoint::new(0, 0, RhombitrihexagonalKind::Square2),
    ];
    let moved = t.translate_cells(
        &cells,
        Point::new((3.0 + SQRT_3) / 2.0, (1.0 + SQRT_3) / 2.0),
    );
    assert_eq!(
        moved.unwrap(),
        [
            RhombitrihexagonalPoint::hexagon(1, 0),
            RhombitrihexagonalPoint::new(1, 0, RhombitrihexagonalKind::Square2)
        ]
    );
    assert_eq!(
        t.translate_cells(&cells, Point::new(1.0, 0.0)),
        Err(FieldOpError::NotASymmetry)
    );
    assert_eq!(
        t.field_operations(),
        [FieldOperation::Translate, FieldOperation::Reflect]
    );
    // The vertical axis through the origin hexagon maps Square0 (30°) onto Square2 (150°).
    let axis = (Point::new(0.0, 0.0), Point::new(0.0, 1.0));
    assert_eq!(
        t.reflect_cells(&cells[1..], axis).unwrap(),
        [RhombitrihexagonalPoint::new(
            0,
            0,
            RhombitrihexagonalKind::Square0
        )]
    );
}

#[test]
fn field_connectivity_matches_adjacency() {
    let t = Arc::new(RhombitrihexagonalTessellation);
    let mut ids = IdGenerator::new();
    let cells = t.build_preset("rect", &[("cols", 4), ("rows", 4)]).unwrap();
    let field = Field::new(t, cells, &mut ids).unwrap();
    let center = field.nodes_at(RhombitrihexagonalPoint::hexagon(0, 0))[0];
    assert_eq!(field.neighbors(center).len(), 6);
}
