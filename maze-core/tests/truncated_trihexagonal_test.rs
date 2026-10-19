use maze_core::IdGenerator;
use maze_core::space::{
    CellScope, Field, FieldOpError, FieldOperation, FieldOps, Point, Tessellation,
    TessellationGeometry, TruncatedTrihexagonalKind, TruncatedTrihexagonalPoint,
    TruncatedTrihexagonalTessellation, is_connected,
};
use std::sync::Arc;

const SQRT_3: f64 = 1.732_050_807_568_877_2;
const PITCH: f64 = 3.0 + SQRT_3;

fn tiles(radius: i32) -> Vec<TruncatedTrihexagonalPoint> {
    (-radius..=radius)
        .flat_map(|r| (-radius..=radius).map(move |q| (q, r)))
        .flat_map(|(q, r)| {
            TruncatedTrihexagonalKind::ALL
                .into_iter()
                .map(move |kind| TruncatedTrihexagonalPoint::new(q, r, kind))
        })
        .collect()
}

fn neighbors(
    t: &TruncatedTrihexagonalTessellation,
    c: TruncatedTrihexagonalPoint,
) -> Vec<TruncatedTrihexagonalPoint> {
    t.faces_of(c)
        .iter()
        .map(|&f| t.neighbor(c, f).unwrap().0)
        .collect()
}

/// Dodecagons border six squares and six hexagons, hexagons three squares and three dodecagons,
/// squares two hexagons and two dodecagons, the kinds alternating around every cell.
#[test]
fn neighbor_kinds_follow_the_4_6_12_pattern() {
    let t = TruncatedTrihexagonalTessellation;
    for c in tiles(5) {
        let around = neighbors(&t, c);
        let mut unique = around.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), around.len(), "{c:?}");
        let count = |pred: fn(&TruncatedTrihexagonalPoint) -> bool| {
            around.iter().filter(|n| pred(n)).count()
        };
        let (dodecagons, squares, hexagons) = (
            count(|n| n.is_dodecagon()),
            count(|n| n.is_square()),
            count(|n| n.is_hexagon()),
        );
        if c.is_dodecagon() {
            assert_eq!((dodecagons, squares, hexagons), (0, 6, 6), "{c:?}");
            // Even faces lead to squares, odd faces to hexagons.
            for (f, n) in around.iter().enumerate() {
                assert_eq!(n.is_square(), f % 2 == 0, "{c:?} face {f}");
            }
        } else {
            let expected = if c.is_square() { (2, 0, 2) } else { (3, 3, 0) };
            assert_eq!((dodecagons, squares, hexagons), expected, "{c:?}");
            // Face 0 is the one shared with the anchor dodecagon.
            assert_eq!(
                around[0],
                TruncatedTrihexagonalPoint::dodecagon(c.q, c.r),
                "{c:?}"
            );
            // The two kinds alternate.
            for (f, n) in around.iter().enumerate() {
                assert_eq!(n.is_dodecagon(), f % 2 == 0, "{c:?} face {f}");
            }
        }
    }
}

#[test]
fn anchor_cells_sit_across_their_named_faces() {
    let t = TruncatedTrihexagonalTessellation;
    let around = neighbors(&t, TruncatedTrihexagonalPoint::dodecagon(3, -2));
    for (face, kind) in [
        (0, TruncatedTrihexagonalKind::Square0),
        (2, TruncatedTrihexagonalKind::Square60),
        (4, TruncatedTrihexagonalKind::Square120),
        (1, TruncatedTrihexagonalKind::Hexagon30),
        (3, TruncatedTrihexagonalKind::Hexagon90),
    ] {
        assert_eq!(around[face], TruncatedTrihexagonalPoint::new(3, -2, kind));
    }
}

#[test]
fn neighbor_is_reciprocal() {
    let t = TruncatedTrihexagonalTessellation;
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
        assert_eq!(TruncatedTrihexagonalPoint::from_xy(x, y), c);
    }
    assert_eq!(
        TruncatedTrihexagonalPoint::from_xy(-1, 4),
        TruncatedTrihexagonalPoint::new(-1, 4, TruncatedTrihexagonalKind::Hexagon90)
    );
}

#[test]
fn wire_encoding_wraps_beyond_the_documented_range() {
    let inside = TruncatedTrihexagonalPoint::dodecagon(i32::MAX / 6, 0);
    let (x, y) = inside.to_xy();
    assert_eq!(TruncatedTrihexagonalPoint::from_xy(x, y), inside);
    let outside = TruncatedTrihexagonalPoint::dodecagon(i32::MAX / 6 + 1, 0);
    let (x, y) = outside.to_xy();
    assert_ne!(TruncatedTrihexagonalPoint::from_xy(x, y), outside);
}

#[test]
fn neighbor_is_none_at_coordinate_overflow() {
    let t = TruncatedTrihexagonalTessellation;
    let missing = TruncatedTrihexagonalKind::ALL
        .into_iter()
        .flat_map(|kind| {
            let c = TruncatedTrihexagonalPoint::new(i32::MAX, 0, kind);
            t.faces_of(c)
                .iter()
                .map(|&f| t.neighbor(c, f))
                .collect::<Vec<_>>()
        })
        .filter(Option::is_none)
        .count();
    assert!(missing > 0);
}

/// Every cell is passed straight through its opposite face only, whatever its orientation.
#[test]
fn straight_passes_are_opposite_faces() {
    let t = TruncatedTrihexagonalTessellation;
    for c in tiles(2) {
        let faces = t.faces_of(c);
        for &a in faces {
            let straight: Vec<_> = faces.iter().filter(|&&b| t.is_straight(c, a, b)).collect();
            assert_eq!(straight.len(), 1, "{c:?} {a:?}");
            // The opposite face is the one whose edge is parallel to the entry edge.
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
fn shapes_are_regular_12_4_and_6() {
    let t = TruncatedTrihexagonalTessellation;
    let keys: Vec<_> = t.shape_descriptors().iter().map(|d| d.key()).collect();
    assert_eq!(keys, ["regular:12", "regular:4", "regular:6"]);
    for kind in TruncatedTrihexagonalKind::ALL {
        let c = TruncatedTrihexagonalPoint::new(0, 0, kind);
        let expected = if c.is_dodecagon() {
            "regular:12"
        } else if c.is_square() {
            "regular:4"
        } else {
            "regular:6"
        };
        assert_eq!(t.shape_of(c).unwrap().descriptor().key(), expected);
    }
}

#[test]
fn cells_have_unit_sides_and_shared_edges_match() {
    let t = TruncatedTrihexagonalTessellation;
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

/// A square, a hexagon and a dodecagon meet at every vertex.
#[test]
fn every_interior_vertex_is_4_6_12() {
    use std::collections::HashMap;
    let t = TruncatedTrihexagonalTessellation;
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
            assert_eq!(sides, &[4, 6, 12]);
            full += 1;
        }
    }
    assert!(full > 100);
}

/// The three squares are turned by 60° against each other: their center lies at the face normal.
#[test]
fn anchor_cells_lie_in_the_direction_of_their_face_normal() {
    let t = TruncatedTrihexagonalTessellation;
    let anchor = t.center(TruncatedTrihexagonalPoint::dodecagon(0, 0));
    for (kind, deg) in [
        (TruncatedTrihexagonalKind::Square0, 0.0f64),
        (TruncatedTrihexagonalKind::Square60, 60.0),
        (TruncatedTrihexagonalKind::Square120, 120.0),
        (TruncatedTrihexagonalKind::Hexagon30, 30.0),
        (TruncatedTrihexagonalKind::Hexagon90, 90.0),
    ] {
        let d = t.center(TruncatedTrihexagonalPoint::new(0, 0, kind)) - anchor;
        assert!((d.y.atan2(d.x) - deg.to_radians()).abs() < 1e-9, "{kind:?}");
        let expected = if t
            .faces_of(TruncatedTrihexagonalPoint::new(0, 0, kind))
            .len()
            == 4
        {
            (2.0 + SQRT_3) / 2.0 + 0.5
        } else {
            1.0 + SQRT_3
        };
        assert!((d.x.hypot(d.y) - expected).abs() < 1e-9, "{kind:?}");
    }
}

#[test]
fn cell_areas() {
    let t = TruncatedTrihexagonalTessellation;
    assert!(
        (t.area(TruncatedTrihexagonalPoint::dodecagon(0, 0)) - 3.0 * (2.0 + SQRT_3)).abs() < 1e-12
    );
    for kind in [
        TruncatedTrihexagonalKind::Square0,
        TruncatedTrihexagonalKind::Square60,
        TruncatedTrihexagonalKind::Square120,
    ] {
        assert!((t.area(TruncatedTrihexagonalPoint::new(1, -2, kind)) - 1.0).abs() < 1e-12);
    }
    for kind in [
        TruncatedTrihexagonalKind::Hexagon30,
        TruncatedTrihexagonalKind::Hexagon90,
    ] {
        assert!(
            (t.area(TruncatedTrihexagonalPoint::new(1, -2, kind)) - 3.0 * SQRT_3 / 2.0).abs()
                < 1e-12
        );
    }
}

#[test]
fn dodecagon_centers_form_the_triangular_lattice() {
    let t = TruncatedTrihexagonalTessellation;
    let at = |q, r| t.center(TruncatedTrihexagonalPoint::dodecagon(q, r));
    let origin = Point::new(0.0, 0.0);
    assert!((at(1, 0).distance(origin) - PITCH).abs() < 1e-12);
    assert!((at(1, 0).y).abs() < 1e-12);
    assert!((at(0, 1).distance(origin) - PITCH).abs() < 1e-12);
    assert!((at(0, 1).y.atan2(at(0, 1).x) - 60f64.to_radians()).abs() < 1e-12);
}

#[test]
fn cell_at_finds_cells_in_every_quadrant() {
    let t = TruncatedTrihexagonalTessellation;
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
    let t = TruncatedTrihexagonalTessellation;
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
    let t = TruncatedTrihexagonalTessellation;
    let origin = t.center(TruncatedTrihexagonalPoint::dodecagon(0, 0));
    for kind in TruncatedTrihexagonalKind::ALL {
        let cell = TruncatedTrihexagonalPoint::new(0, 0, kind);
        for s in t.boundary_path(cell).faces().iter().flatten() {
            assert!(
                s.start().distance(origin) <= 2.0 + SQRT_3 + 1e-9,
                "{kind:?}"
            );
        }
    }
}

#[test]
fn presets_are_nonempty_and_rect_scales_with_its_size() {
    let t = TruncatedTrihexagonalTessellation;
    let small = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    let large = t.build_preset("rect", &[("cols", 6), ("rows", 6)]).unwrap();
    assert!(large.len() > 3 * small.len());
    assert!(small.iter().any(|c| c.is_dodecagon()));
    assert!(small.iter().any(|c| c.is_square()));
    assert!(small.iter().any(|c| c.is_hexagon()));
}

#[test]
fn translation_by_a_lattice_vector_and_reflection_work() {
    let t = TruncatedTrihexagonalTessellation;
    let cells = [
        TruncatedTrihexagonalPoint::dodecagon(0, 0),
        TruncatedTrihexagonalPoint::new(0, 0, TruncatedTrihexagonalKind::Hexagon30),
    ];
    let moved = t.translate_cells(&cells, Point::new(PITCH, 0.0));
    assert_eq!(
        moved.unwrap(),
        [
            TruncatedTrihexagonalPoint::dodecagon(1, 0),
            TruncatedTrihexagonalPoint::new(1, 0, TruncatedTrihexagonalKind::Hexagon30)
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
    // The vertical axis through the origin dodecagon mirrors the hexagon across face 1 (at 30°)
    // onto the hexagon at 150°.
    let axis = (Point::new(0.0, 0.0), Point::new(0.0, 1.0));
    let mirrored = t.reflect_cells(&cells[1..], axis).unwrap();
    let before = t.center(cells[1]);
    let after = t.center(mirrored[0]);
    assert!((after.x + before.x).abs() < 1e-9 && (after.y - before.y).abs() < 1e-9);
}

#[test]
fn field_connectivity_matches_adjacency() {
    let t = Arc::new(TruncatedTrihexagonalTessellation);
    let mut ids = IdGenerator::new();
    let cells = t.build_preset("rect", &[("cols", 4), ("rows", 4)]).unwrap();
    let field = Field::new(t, cells, &mut ids).unwrap();
    let center = field.nodes_at(TruncatedTrihexagonalPoint::dodecagon(0, 0))[0];
    assert_eq!(field.neighbors(center).len(), 12);
}

/// Every preset stays one connected component for a wide range of sizes, not only small ones.
#[test]
fn presets_are_connected_for_every_size() {
    let t = TruncatedTrihexagonalTessellation;
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

/// Every kind, squares of all three orientations included, maps onto a cell of the same shape
/// under every lattice translation and under the mirror axes through the origin dodecagon.
#[test]
fn translation_and_reflection_map_every_kind_onto_the_same_shape() {
    let t = TruncatedTrihexagonalTessellation;
    let cells = tiles(1);
    let step_b = Point::new(PITCH / 2.0, PITCH * SQRT_3 / 2.0);
    for (vector, dq, dr) in [(Point::new(PITCH, 0.0), 1, 0), (step_b, 0, 1)] {
        for c in &cells {
            let moved = t.translate_cells(&[*c], vector).unwrap();
            assert_eq!(
                moved,
                [TruncatedTrihexagonalPoint::new(c.q + dq, c.r + dr, c.kind)]
            );
        }
    }
    let axes = [
        (Point::new(0.0, 0.0), Point::new(0.0, 1.0)),
        (Point::new(0.0, 0.0), Point::new(1.0, 0.0)),
    ];
    for axis in axes {
        let (dx, dy) = (axis.1.x - axis.0.x, axis.1.y - axis.0.y);
        for c in &cells {
            let mirrored = t.reflect_cells(&[*c], axis).unwrap()[0];
            assert_eq!(t.faces_of(*c).len(), t.faces_of(mirrored).len(), "{c:?}");
            let (before, after) = (t.center(*c), t.center(mirrored));
            // The segment joining a cell and its mirror image is perpendicular to the axis.
            assert!(
                ((after.x - before.x) * dx + (after.y - before.y) * dy).abs() < 1e-9,
                "{c:?}"
            );
            assert_eq!(t.reflect_cells(&[mirrored], axis).unwrap(), [*c]);
        }
    }
}
