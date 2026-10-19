use maze_core::IdGenerator;
use maze_core::space::{
    CellScope, Field, FieldOpError, FieldOperation, FieldOps, Point, Tessellation,
    TessellationGeometry, TruncatedHexagonalKind, TruncatedHexagonalPoint,
    TruncatedHexagonalTessellation, is_connected,
};
use std::sync::Arc;

const SQRT_3: f64 = 1.732_050_807_568_877_2;
const PITCH: f64 = 2.0 + SQRT_3;

fn tiles(radius: i32) -> Vec<TruncatedHexagonalPoint> {
    (-radius..=radius)
        .flat_map(|r| (-radius..=radius).map(move |q| (q, r)))
        .flat_map(|(q, r)| {
            TruncatedHexagonalKind::ALL
                .into_iter()
                .map(move |kind| TruncatedHexagonalPoint::new(q, r, kind))
        })
        .collect()
}

fn neighbors(
    t: &TruncatedHexagonalTessellation,
    c: TruncatedHexagonalPoint,
) -> Vec<TruncatedHexagonalPoint> {
    t.faces_of(c)
        .iter()
        .map(|&f| t.neighbor(c, f).unwrap().0)
        .collect()
}

/// Dodecagons border six dodecagons and six triangles, triangles three dodecagons.
#[test]
fn neighbor_kinds_follow_the_3_12_12_pattern() {
    let t = TruncatedHexagonalTessellation;
    for c in tiles(5) {
        let around = neighbors(&t, c);
        let mut unique = around.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), around.len(), "{c:?}");
        let dodecagons = around.iter().filter(|n| n.is_dodecagon()).count();
        let triangles = around.len() - dodecagons;
        if c.is_dodecagon() {
            assert_eq!((dodecagons, triangles), (6, 6), "{c:?}");
            // Even faces lead to dodecagons, odd faces to triangles.
            for (f, n) in around.iter().enumerate() {
                assert_eq!(n.is_dodecagon(), f % 2 == 0, "{c:?} face {f}");
            }
        } else {
            assert_eq!((dodecagons, triangles), (3, 0), "{c:?}");
            // Face 0 is the one shared with the anchor dodecagon.
            assert_eq!(
                around[0],
                TruncatedHexagonalPoint::dodecagon(c.q, c.r),
                "{c:?}"
            );
        }
    }
}

#[test]
fn anchor_triangles_sit_across_faces_3_and_1() {
    let t = TruncatedHexagonalTessellation;
    let around = neighbors(&t, TruncatedHexagonalPoint::dodecagon(3, -2));
    assert_eq!(
        around[3],
        TruncatedHexagonalPoint::new(3, -2, TruncatedHexagonalKind::TriangleUp)
    );
    assert_eq!(
        around[1],
        TruncatedHexagonalPoint::new(3, -2, TruncatedHexagonalKind::TriangleDown)
    );
}

#[test]
fn neighbor_is_reciprocal() {
    let t = TruncatedHexagonalTessellation;
    for c in tiles(5) {
        for &f in t.faces_of(c) {
            let (c2, f2) = t.neighbor(c, f).unwrap();
            assert_eq!(t.neighbor(c2, f2), Some((c, f)), "{c:?} {f:?}");
        }
    }
}

#[test]
fn neighbor_is_none_at_coordinate_overflow() {
    let t = TruncatedHexagonalTessellation;
    let missing = TruncatedHexagonalKind::ALL
        .into_iter()
        .flat_map(|kind| {
            let c = TruncatedHexagonalPoint::new(i32::MAX, 0, kind);
            t.faces_of(c)
                .iter()
                .map(|&f| t.neighbor(c, f))
                .collect::<Vec<_>>()
        })
        .filter(Option::is_none)
        .count();
    assert!(missing > 0);
}

/// A dodecagon is passed straight through the opposite face; triangles never.
#[test]
fn straight_passes_are_opposite_faces_of_dodecagons_only() {
    let t = TruncatedHexagonalTessellation;
    for c in tiles(2) {
        let straight = t
            .faces_of(c)
            .iter()
            .flat_map(|&a| t.faces_of(c).iter().map(move |&b| (a, b)))
            .filter(|&(a, b)| t.is_straight(c, a, b))
            .count();
        assert_eq!(straight, if c.is_dodecagon() { 12 } else { 0 }, "{c:?}");
    }
}

#[test]
fn shapes_are_regular_12_and_3() {
    let t = TruncatedHexagonalTessellation;
    let keys: Vec<_> = t.shape_descriptors().iter().map(|d| d.key()).collect();
    assert_eq!(keys, ["regular:12", "regular:3"]);
    for kind in TruncatedHexagonalKind::ALL {
        let expected = match kind {
            TruncatedHexagonalKind::Dodecagon => "regular:12",
            _ => "regular:3",
        };
        let c = TruncatedHexagonalPoint::new(0, 0, kind);
        assert_eq!(t.shape_of(c).unwrap().descriptor().key(), expected);
    }
}

#[test]
fn cells_have_unit_sides_and_shared_edges_match() {
    let t = TruncatedHexagonalTessellation;
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

/// A triangle and two dodecagons meet at every vertex.
#[test]
fn every_interior_vertex_is_3_12_12() {
    use std::collections::HashMap;
    let t = TruncatedHexagonalTessellation;
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
        if sides.len() == 3 {
            sides.sort();
            assert_eq!(sides, &[3, 12, 12]);
            full += 1;
        }
    }
    assert!(full > 100);
}

#[test]
fn triangle_orientations_point_up_and_down() {
    let t = TruncatedHexagonalTessellation;
    for (kind, apex_deg) in [
        (TruncatedHexagonalKind::TriangleUp, 90.0f64),
        (TruncatedHexagonalKind::TriangleDown, 30.0),
    ] {
        let c = TruncatedHexagonalPoint::new(0, 0, kind);
        let anchor = t.center(TruncatedHexagonalPoint::dodecagon(0, 0));
        let d = t.center(c) - anchor;
        assert!(
            (d.y.atan2(d.x) - apex_deg.to_radians()).abs() < 1e-9,
            "{kind:?}"
        );
    }
}

#[test]
fn dodecagon_and_triangle_areas() {
    let t = TruncatedHexagonalTessellation;
    assert!(
        (t.area(TruncatedHexagonalPoint::dodecagon(0, 0)) - 3.0 * (2.0 + SQRT_3)).abs() < 1e-12
    );
    for kind in [
        TruncatedHexagonalKind::TriangleUp,
        TruncatedHexagonalKind::TriangleDown,
    ] {
        assert!((t.area(TruncatedHexagonalPoint::new(1, -2, kind)) - SQRT_3 / 4.0).abs() < 1e-12);
    }
}

#[test]
fn dodecagon_centers_form_the_triangular_lattice() {
    let t = TruncatedHexagonalTessellation;
    let at = |q, r| t.center(TruncatedHexagonalPoint::dodecagon(q, r));
    let origin = Point::new(0.0, 0.0);
    assert!((at(1, 0).distance(origin) - PITCH).abs() < 1e-12);
    assert!((at(1, 0).y).abs() < 1e-12);
    assert!((at(0, 1).distance(origin) - PITCH).abs() < 1e-12);
    assert!((at(0, 1).y.atan2(at(0, 1).x) - 60f64.to_radians()).abs() < 1e-12);
}

#[test]
fn cell_at_finds_cells_in_every_quadrant() {
    let t = TruncatedHexagonalTessellation;
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
    let t = TruncatedHexagonalTessellation;
    let (min, max) = (Point::new(-5.0, -5.0), Point::new(5.0, 5.0));
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
    let t = TruncatedHexagonalTessellation;
    let origin = t.center(TruncatedHexagonalPoint::dodecagon(0, 0));
    for kind in TruncatedHexagonalKind::ALL {
        let cell = TruncatedHexagonalPoint::new(0, 0, kind);
        for s in t.boundary_path(cell).faces().iter().flatten() {
            assert!(
                s.start().distance(origin) <= 1.0 + SQRT_3 + 1e-9,
                "{kind:?}"
            );
        }
    }
}

#[test]
fn presets_are_nonempty_and_rect_scales_with_its_size() {
    let t = TruncatedHexagonalTessellation;
    let small = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    let large = t.build_preset("rect", &[("cols", 6), ("rows", 6)]).unwrap();
    assert!(large.len() > 3 * small.len());
    assert!(small.iter().any(|c| c.is_dodecagon()));
    assert!(small.iter().any(|c| c.is_triangle()));
}

#[test]
fn translation_by_a_lattice_vector_and_reflection_work() {
    let t = TruncatedHexagonalTessellation;
    let cells = [
        TruncatedHexagonalPoint::dodecagon(0, 0),
        TruncatedHexagonalPoint::new(0, 0, TruncatedHexagonalKind::TriangleDown),
    ];
    let moved = t.translate_cells(&cells, Point::new(PITCH, 0.0));
    assert_eq!(
        moved.unwrap(),
        [
            TruncatedHexagonalPoint::dodecagon(1, 0),
            TruncatedHexagonalPoint::new(1, 0, TruncatedHexagonalKind::TriangleDown)
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
    // The vertical axis through the origin dodecagon mirrors the triangle across face 1 (apex
    // at 30°) onto the triangle with its apex at 150°.
    let axis = (Point::new(0.0, 0.0), Point::new(0.0, 1.0));
    let mirrored = t.reflect_cells(&cells[1..], axis).unwrap();
    let before = t.center(cells[1]);
    let after = t.center(mirrored[0]);
    assert!((after.x + before.x).abs() < 1e-9 && (after.y - before.y).abs() < 1e-9);
}

#[test]
fn field_connectivity_matches_adjacency() {
    let t = Arc::new(TruncatedHexagonalTessellation);
    let mut ids = IdGenerator::new();
    let cells = t.build_preset("rect", &[("cols", 4), ("rows", 4)]).unwrap();
    let field = Field::new(t, cells, &mut ids).unwrap();
    let center = field.nodes_at(TruncatedHexagonalPoint::dodecagon(0, 0))[0];
    assert_eq!(field.neighbors(center).len(), 12);
}

/// Every preset stays one connected component for a wide range of sizes, not only small ones.
#[test]
fn presets_are_connected_for_every_size() {
    let t = TruncatedHexagonalTessellation;
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
