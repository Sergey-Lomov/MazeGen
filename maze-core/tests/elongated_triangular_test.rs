use maze_core::IdGenerator;
use maze_core::space::{
    CellScope, ElongatedTriangularKind, ElongatedTriangularPoint, ElongatedTriangularTessellation,
    Field, FieldOpError, FieldOperation, FieldOps, Point, Tessellation, TessellationGeometry,
    is_connected,
};
use std::sync::Arc;

const SQRT_3: f64 = 1.732_050_807_568_877_2;
const ROW: f64 = 1.0 + SQRT_3 / 2.0;

fn tiles(radius: i32) -> Vec<ElongatedTriangularPoint> {
    (-radius..=radius)
        .flat_map(|y| (-radius..=radius).map(move |x| (x, y)))
        .flat_map(|(x, y)| {
            ElongatedTriangularKind::ALL
                .into_iter()
                .map(move |kind| ElongatedTriangularPoint::new(x, y, kind))
        })
        .collect()
}

fn neighbors(
    t: &ElongatedTriangularTessellation,
    c: ElongatedTriangularPoint,
) -> Vec<ElongatedTriangularPoint> {
    t.faces_of(c)
        .iter()
        .map(|&f| t.neighbor(c, f).unwrap().0)
        .collect()
}

/// A square borders two squares and two triangles, a triangle two triangles and one square.
#[test]
fn neighbor_kinds_follow_the_3_3_3_4_4_pattern() {
    let t = ElongatedTriangularTessellation;
    for c in tiles(5) {
        let around = neighbors(&t, c);
        let mut unique = around.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), around.len(), "{c:?}");
        let squares = around.iter().filter(|n| n.is_square()).count();
        let triangles = around.len() - squares;
        if c.is_square() {
            assert_eq!((squares, triangles), (2, 2), "{c:?}");
        } else {
            assert_eq!((squares, triangles), (1, 2), "{c:?}");
        }
    }
}

#[test]
fn squares_stack_on_down_triangles_of_the_band_below() {
    let t = ElongatedTriangularTessellation;
    let around = neighbors(&t, ElongatedTriangularPoint::square(3, -2));
    assert_eq!(
        around,
        [
            ElongatedTriangularPoint::new(3, -3, ElongatedTriangularKind::TriangleDown),
            ElongatedTriangularPoint::square(4, -2),
            ElongatedTriangularPoint::new(3, -2, ElongatedTriangularKind::TriangleUp),
            ElongatedTriangularPoint::square(2, -2),
        ]
    );
}

#[test]
fn neighbor_is_reciprocal() {
    let t = ElongatedTriangularTessellation;
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
        assert_eq!(ElongatedTriangularPoint::from_xy(x, y), c);
    }
    assert_eq!(
        ElongatedTriangularPoint::from_xy(-1, 4),
        ElongatedTriangularPoint::new(-1, 4, ElongatedTriangularKind::TriangleDown)
    );
}

#[test]
fn wire_encoding_wraps_beyond_the_documented_range() {
    let inside = ElongatedTriangularPoint::square(i32::MAX / 3, 0);
    let (x, y) = inside.to_xy();
    assert_eq!(ElongatedTriangularPoint::from_xy(x, y), inside);
    let outside = ElongatedTriangularPoint::square(i32::MAX / 3 + 1, 0);
    let (x, y) = outside.to_xy();
    assert_ne!(ElongatedTriangularPoint::from_xy(x, y), outside);
}

#[test]
fn neighbor_is_none_at_coordinate_overflow() {
    let t = ElongatedTriangularTessellation;
    let missing = ElongatedTriangularKind::ALL
        .into_iter()
        .flat_map(|kind| {
            let c = ElongatedTriangularPoint::new(i32::MAX, i32::MAX, kind);
            t.faces_of(c)
                .iter()
                .map(|&f| t.neighbor(c, f))
                .collect::<Vec<_>>()
        })
        .filter(Option::is_none)
        .count();
    assert!(missing > 0);
}

/// A square is passed straight through the opposite face; triangles never.
#[test]
fn straight_passes_are_opposite_faces_of_squares_only() {
    let t = ElongatedTriangularTessellation;
    for c in tiles(2) {
        let straight = t
            .faces_of(c)
            .iter()
            .flat_map(|&a| t.faces_of(c).iter().map(move |&b| (a, b)))
            .filter(|&(a, b)| t.is_straight(c, a, b))
            .count();
        assert_eq!(straight, if c.is_square() { 4 } else { 0 }, "{c:?}");
    }
}

#[test]
fn shapes_are_regular_4_and_3() {
    let t = ElongatedTriangularTessellation;
    let keys: Vec<_> = t.shape_descriptors().iter().map(|d| d.key()).collect();
    assert_eq!(keys, ["regular:4", "regular:3"]);
    for kind in ElongatedTriangularKind::ALL {
        let expected = match kind {
            ElongatedTriangularKind::Square => "regular:4",
            _ => "regular:3",
        };
        let c = ElongatedTriangularPoint::new(0, 0, kind);
        assert_eq!(t.shape_of(c).unwrap().descriptor().key(), expected);
    }
}

#[test]
fn cells_have_unit_sides_and_shared_edges_match() {
    let t = ElongatedTriangularTessellation;
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

/// Three triangles and two squares meet at every vertex.
#[test]
fn every_interior_vertex_is_3_3_3_4_4() {
    use std::collections::HashMap;
    let t = ElongatedTriangularTessellation;
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
        if sides.len() == 5 {
            sides.sort();
            assert_eq!(sides, &[3, 3, 3, 4, 4]);
            full += 1;
        }
    }
    assert!(full > 50);
}

#[test]
fn triangle_orientations_point_up_and_down() {
    let t = ElongatedTriangularTessellation;
    let square = t.center(ElongatedTriangularPoint::square(0, 0));
    let up = t.center(ElongatedTriangularPoint::new(
        0,
        0,
        ElongatedTriangularKind::TriangleUp,
    ));
    let down = t.center(ElongatedTriangularPoint::new(
        0,
        0,
        ElongatedTriangularKind::TriangleDown,
    ));
    // The up triangle stands right above the square, the down one is half a square to the right.
    assert!((up.x - square.x).abs() < 1e-12 && up.y > square.y);
    assert!((down.x - square.x - 0.5).abs() < 1e-12);
    // A centroid lies a third of the height from the base (up) or from the top edge (down).
    assert!((up.y - (1.0 + SQRT_3 / 6.0)).abs() < 1e-12);
    assert!((down.y - (1.0 + SQRT_3 / 3.0)).abs() < 1e-12);
}

#[test]
fn square_and_triangle_areas() {
    let t = ElongatedTriangularTessellation;
    assert!((t.area(ElongatedTriangularPoint::square(0, 0)) - 1.0).abs() < 1e-12);
    for kind in [
        ElongatedTriangularKind::TriangleUp,
        ElongatedTriangularKind::TriangleDown,
    ] {
        assert!((t.area(ElongatedTriangularPoint::new(1, -2, kind)) - SQRT_3 / 4.0).abs() < 1e-12);
    }
}

#[test]
fn bands_are_shifted_half_a_square_per_row() {
    let t = ElongatedTriangularTessellation;
    let at = |x, y| t.center(ElongatedTriangularPoint::square(x, y));
    let origin = at(0, 0);
    assert!((at(1, 0).x - origin.x - 1.0).abs() < 1e-12 && (at(1, 0).y - origin.y).abs() < 1e-12);
    assert!((at(0, 1).x - origin.x - 0.5).abs() < 1e-12);
    assert!((at(0, 1).y - origin.y - ROW).abs() < 1e-12);
    assert!((at(0, -2).x - origin.x + 1.0).abs() < 1e-12);
}

#[test]
fn cell_at_finds_cells_in_every_quadrant() {
    let t = ElongatedTriangularTessellation;
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
    let t = ElongatedTriangularTessellation;
    let (min, max) = (Point::new(-5.0, -5.0), Point::new(5.0, 5.0));
    let cells = t.candidate_cells(min, max, 10_000).unwrap();
    for c in tiles(12) {
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
fn presets_are_nonempty_and_rect_scales_with_its_size() {
    let t = ElongatedTriangularTessellation;
    let small = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    let large = t.build_preset("rect", &[("cols", 6), ("rows", 6)]).unwrap();
    assert!(large.len() > 3 * small.len());
    assert!(small.iter().any(|c| c.is_square()));
    assert!(small.iter().any(|c| c.is_triangle()));
}

/// Thin and tall rectangles keep their size: a staggered band must not empty out the strip, or
/// the print sizing search (which relies on the extent growing with each dimension) degenerates.
#[test]
fn rect_keeps_its_square_count_for_thin_rectangles() {
    let t = ElongatedTriangularTessellation;
    for (cols, rows) in [(1, 1), (1, 9), (2, 9), (3, 7), (9, 1), (8, 8)] {
        let cells = t
            .build_preset("rect", &[("cols", cols), ("rows", rows)])
            .unwrap();
        let squares = cells.iter().filter(|c| c.is_square()).count();
        assert_eq!(squares, (cols * rows) as usize, "{cols}x{rows}");
    }
}

#[test]
fn translation_by_lattice_vectors_and_reflection_work() {
    let t = ElongatedTriangularTessellation;
    let cells = [
        ElongatedTriangularPoint::square(0, 0),
        ElongatedTriangularPoint::new(0, 0, ElongatedTriangularKind::TriangleDown),
    ];
    assert_eq!(
        t.translate_cells(&cells, Point::new(1.0, 0.0)).unwrap(),
        [
            ElongatedTriangularPoint::square(1, 0),
            ElongatedTriangularPoint::new(1, 0, ElongatedTriangularKind::TriangleDown)
        ]
    );
    // One band up and half a square right keeps the column.
    assert_eq!(
        t.translate_cells(&cells, Point::new(0.5, ROW)).unwrap(),
        [
            ElongatedTriangularPoint::square(0, 1),
            ElongatedTriangularPoint::new(0, 1, ElongatedTriangularKind::TriangleDown)
        ]
    );
    assert_eq!(
        t.translate_cells(&cells, Point::new(0.5, 0.0)),
        Err(FieldOpError::NotASymmetry)
    );
    assert_eq!(
        t.field_operations(),
        [FieldOperation::Translate, FieldOperation::Reflect]
    );
    // The vertical axis through the origin square's center maps the down triangle to the one
    // on its left.
    let axis = (Point::new(0.5, 0.0), Point::new(0.5, 1.0));
    let mirrored = t.reflect_cells(&cells[1..], axis).unwrap();
    assert_eq!(
        mirrored,
        [ElongatedTriangularPoint::new(
            -1,
            0,
            ElongatedTriangularKind::TriangleDown
        )]
    );
}

#[test]
fn field_connectivity_matches_adjacency() {
    let t = Arc::new(ElongatedTriangularTessellation);
    let mut ids = IdGenerator::new();
    let cells = t.build_preset("rect", &[("cols", 8), ("rows", 8)]).unwrap();
    let field = Field::new(t, cells, &mut ids).unwrap();
    let center = field.nodes_at(ElongatedTriangularPoint::square(0, 0))[0];
    assert_eq!(field.neighbors(center).len(), 4);
}

/// Every preset stays one connected component for a wide range of sizes, not only small ones.
#[test]
fn presets_are_connected_for_every_size() {
    let t = ElongatedTriangularTessellation;
    for size in 1..=24u32 {
        for (key, params) in [
            ("rect", vec![("cols", size), ("rows", size)]),
            ("circle", vec![("radius", size)]),
            ("triangle", vec![("side", size)]),
        ] {
            let Ok(cells) = t.build_preset(key, &params) else {
                continue;
            };
            assert!(is_connected(&t, &cells), "{key} {size} is disconnected");
        }
    }
}
