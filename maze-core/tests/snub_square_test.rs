use maze_core::IdGenerator;
use maze_core::space::{
    CellScope, Field, FieldOpError, FieldOperation, FieldOps, Point, SnubSquareKind,
    SnubSquarePoint, SnubSquareTessellation, Tessellation, TessellationGeometry, is_connected,
};
use std::collections::HashMap;
use std::sync::Arc;

const SQRT_3: f64 = 1.732_050_807_568_877_2;
/// Length of a lattice step, `(1 + √3) / √2`.
const PITCH: f64 = 1.931_851_652_578_136_6;

fn tiles(radius: i32) -> Vec<SnubSquarePoint> {
    (-radius..=radius)
        .flat_map(|r| (-radius..=radius).map(move |q| (q, r)))
        .flat_map(|(q, r)| {
            SnubSquareKind::ALL
                .into_iter()
                .map(move |kind| SnubSquarePoint::new(q, r, kind))
        })
        .collect()
}

fn neighbors(t: &SnubSquareTessellation, c: SnubSquarePoint) -> Vec<SnubSquarePoint> {
    t.faces_of(c)
        .iter()
        .map(|&f| t.neighbor(c, f).unwrap().0)
        .collect()
}

/// Squares border four triangles; triangles two squares and one triangle.
#[test]
fn neighbor_kinds_follow_the_3_3_4_3_4_pattern() {
    let t = SnubSquareTessellation;
    for c in tiles(5) {
        let around = neighbors(&t, c);
        let mut unique = around.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), around.len(), "{c:?}");
        let squares = around.iter().filter(|n| n.is_square()).count();
        let triangles = around.len() - squares;
        let expected = if c.is_square() { (0, 4) } else { (2, 1) };
        assert_eq!((squares, triangles), expected, "{c:?}");
    }
}

#[test]
fn neighbor_is_reciprocal() {
    let t = SnubSquareTessellation;
    for c in tiles(5) {
        for &f in t.faces_of(c) {
            let (c2, f2) = t.neighbor(c, f).unwrap();
            assert_eq!(t.neighbor(c2, f2), Some((c, f)), "{c:?} {f:?}");
        }
    }
}

#[test]
fn neighbor_is_none_at_coordinate_overflow() {
    let t = SnubSquareTessellation;
    let missing = SnubSquareKind::ALL
        .into_iter()
        .flat_map(|kind| {
            let c = SnubSquarePoint::new(i32::MAX, i32::MAX, kind);
            t.faces_of(c)
                .iter()
                .map(|&f| t.neighbor(c, f))
                .collect::<Vec<_>>()
        })
        .filter(Option::is_none)
        .count();
    assert!(missing > 0);
}

/// A square is passed straight through its opposite face only, whatever its orientation; a
/// triangle never.
#[test]
fn straight_passes_are_opposite_square_faces() {
    let t = SnubSquareTessellation;
    for c in tiles(2) {
        let faces = t.faces_of(c);
        for &a in faces {
            let straight: Vec<_> = faces.iter().filter(|&&b| t.is_straight(c, a, b)).collect();
            if c.is_triangle() {
                assert!(straight.is_empty(), "{c:?} {a:?}");
                continue;
            }
            assert_eq!(straight.len(), 1, "{c:?} {a:?}");
            let (s0, s1) = (
                t.edge_segments(c, a)[0],
                t.edge_segments(c, *straight[0])[0],
            );
            let (d0, d1) = (s0.end() - s0.start(), s1.end() - s1.start());
            assert!((d0.x * d1.y - d0.y * d1.x).abs() < 1e-9, "{c:?} {a:?}");
            assert!(d0.x * d1.x + d0.y * d1.y < 0.0, "{c:?} {a:?}");
        }
    }
}

#[test]
fn shapes_are_regular_4_and_3() {
    let t = SnubSquareTessellation;
    let keys: Vec<_> = t.shape_descriptors().iter().map(|d| d.key()).collect();
    assert_eq!(keys, ["regular:4", "regular:3"]);
    for kind in SnubSquareKind::ALL {
        let c = SnubSquarePoint::new(0, 0, kind);
        let expected = if c.is_square() {
            "regular:4"
        } else {
            "regular:3"
        };
        assert_eq!(t.shape_of(c).unwrap().descriptor().key(), expected);
    }
}

#[test]
fn cells_have_unit_sides_and_shared_edges_match() {
    let t = SnubSquareTessellation;
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

/// Three triangles and two squares meet at every interior vertex, in the order 3.3.4.3.4.
#[test]
fn every_interior_vertex_is_3_3_4_3_4() {
    let t = SnubSquareTessellation;
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
fn cell_areas_fill_the_lattice_cell() {
    let t = SnubSquareTessellation;
    let total: f64 = SnubSquareKind::ALL
        .into_iter()
        .map(|kind| t.area(SnubSquarePoint::new(0, 0, kind)))
        .sum();
    assert!((total - (2.0 + SQRT_3)).abs() < 1e-12);
    assert!((total - PITCH * PITCH).abs() < 1e-9);
}

#[test]
fn anchors_form_a_square_lattice_turned_by_15_degrees() {
    let t = SnubSquareTessellation;
    let at = |q, r| t.center(SnubSquarePoint::new(q, r, SnubSquareKind::Square));
    let origin = at(0, 0);
    assert!((at(1, 0).distance(origin) - PITCH).abs() < 1e-12);
    assert!((at(0, 1).distance(origin) - PITCH).abs() < 1e-12);
    let a = at(1, 0) - origin;
    assert!((a.y.atan2(a.x) + 15f64.to_radians()).abs() < 1e-12);
    let b = at(0, 1) - origin;
    assert!((b.y.atan2(b.x) - 75f64.to_radians()).abs() < 1e-12);
}

#[test]
fn cell_at_finds_cells_in_every_quadrant() {
    let t = SnubSquareTessellation;
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
    let t = SnubSquareTessellation;
    let (min, max) = (Point::new(-5.0, -3.0), Point::new(4.0, 5.0));
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
    let t = SnubSquareTessellation;
    let origin = Point::new(0.0, 0.0);
    for kind in SnubSquareKind::ALL {
        let cell = SnubSquarePoint::new(0, 0, kind);
        for s in t.boundary_path(cell).faces().iter().flatten() {
            assert!(s.start().distance(origin) <= 2.0, "{kind:?}");
        }
    }
}

#[test]
fn presets_are_nonempty_and_rect_scales_with_its_size() {
    let t = SnubSquareTessellation;
    let small = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    let large = t.build_preset("rect", &[("cols", 6), ("rows", 6)]).unwrap();
    assert!(large.len() > 3 * small.len());
    assert!(small.iter().any(|c| c.is_square()));
    assert!(small.iter().any(|c| c.is_triangle()));
}

#[test]
fn only_translation_by_a_lattice_vector_is_offered() {
    let t = SnubSquareTessellation;
    let cells = [
        SnubSquarePoint::new(0, 0, SnubSquareKind::Square),
        SnubSquarePoint::new(0, 0, SnubSquareKind::TriangleUp),
    ];
    let step_a = Point::new(
        PITCH * 15f64.to_radians().cos(),
        -PITCH * 15f64.to_radians().sin(),
    );
    let moved = t.translate_cells(&cells, step_a).unwrap();
    assert_eq!(
        moved,
        [
            SnubSquarePoint::new(1, 0, SnubSquareKind::Square),
            SnubSquarePoint::new(1, 0, SnubSquareKind::TriangleUp)
        ]
    );
    assert_eq!(
        t.translate_cells(&cells, Point::new(1.0, 0.0)),
        Err(FieldOpError::NotASymmetry)
    );
    assert_eq!(t.field_operations(), [FieldOperation::Translate]);
}

#[test]
fn field_connectivity_matches_adjacency() {
    let t = Arc::new(SnubSquareTessellation);
    let mut ids = IdGenerator::new();
    let cells = t.build_preset("rect", &[("cols", 4), ("rows", 4)]).unwrap();
    let field = Field::new(t, cells, &mut ids).unwrap();
    let square = field.nodes_at(SnubSquarePoint::new(0, 0, SnubSquareKind::Square))[0];
    assert_eq!(field.neighbors(square).len(), 4);
}

/// Every preset stays one connected component for a wide range of sizes, not only small ones.
#[test]
fn presets_are_connected_for_every_size() {
    let t = SnubSquareTessellation;
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
