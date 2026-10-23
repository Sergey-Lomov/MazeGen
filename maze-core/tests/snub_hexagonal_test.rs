use maze_core::IdGenerator;
use maze_core::space::{
    CellScope, Field, FieldOpError, FieldOperation, FieldOps, Point, SnubHexagonalKind,
    SnubHexagonalPoint, SnubHexagonalTessellation, Tessellation, TessellationGeometry,
};
use std::sync::Arc;

fn tiles(radius: i32) -> Vec<SnubHexagonalPoint> {
    (-radius..=radius)
        .flat_map(|r| (-radius..=radius).map(move |q| (q, r)))
        .flat_map(|(q, r)| {
            SnubHexagonalKind::ALL
                .into_iter()
                .map(move |kind| SnubHexagonalPoint::new(q, r, kind))
        })
        .collect()
}

fn neighbors(t: &SnubHexagonalTessellation, c: SnubHexagonalPoint) -> Vec<SnubHexagonalPoint> {
    t.faces_of(c)
        .iter()
        .map(|&f| t.neighbor(c, f).unwrap().0)
        .collect()
}

#[test]
fn hexagons_have_six_edge_triangle_neighbors_edge_triangles_one_hexagon() {
    let t = SnubHexagonalTessellation;
    for c in tiles(5) {
        let around = neighbors(&t, c);
        let mut unique = around.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), around.len(), "{c:?}");
        let hexagons = around.iter().filter(|n| n.is_hexagon()).count();
        match c.kind {
            SnubHexagonalKind::Hexagon => {
                assert_eq!(around.len(), 6);
                assert_eq!(hexagons, 0, "{c:?}");
            }
            SnubHexagonalKind::Inner0 | SnubHexagonalKind::Inner1 => {
                assert_eq!((around.len(), hexagons), (3, 0), "{c:?}");
            }
            _ => {
                assert_eq!((around.len(), hexagons), (3, 1), "{c:?}");
                // Face 0 is the one shared with the anchor hexagon.
                assert_eq!(around[0], SnubHexagonalPoint::hexagon(c.q, c.r), "{c:?}");
            }
        }
    }
}

#[test]
fn hexagon_face_k_leads_to_edge_triangle_k() {
    let t = SnubHexagonalTessellation;
    let hexagon = SnubHexagonalPoint::hexagon(3, -2);
    for (k, n) in neighbors(&t, hexagon).into_iter().enumerate() {
        assert_eq!(n.kind, SnubHexagonalKind::ALL[k + 1]);
        assert_eq!((n.q, n.r), (3, -2));
    }
}

#[test]
fn neighbor_is_reciprocal() {
    let t = SnubHexagonalTessellation;
    for c in tiles(5) {
        for &f in t.faces_of(c) {
            let (c2, f2) = t.neighbor(c, f).unwrap();
            assert_eq!(t.neighbor(c2, f2), Some((c, f)), "{c:?} {f:?}");
        }
    }
}

#[test]
fn neighbor_is_none_at_coordinate_overflow() {
    let t = SnubHexagonalTessellation;
    let missing = SnubHexagonalKind::ALL
        .into_iter()
        .flat_map(|kind| neighbors_opt(&t, SnubHexagonalPoint::new(i32::MAX, 0, kind)))
        .filter(Option::is_none)
        .count();
    assert!(missing > 0);
}

fn neighbors_opt(
    t: &SnubHexagonalTessellation,
    c: SnubHexagonalPoint,
) -> Vec<Option<SnubHexagonalPoint>> {
    t.faces_of(c)
        .iter()
        .map(|&f| t.neighbor(c, f).map(|n| n.0))
        .collect()
}

#[test]
fn only_hexagons_have_straight_passes() {
    let t = SnubHexagonalTessellation;
    for c in tiles(2) {
        let straight = t
            .faces_of(c)
            .iter()
            .flat_map(|&a| t.faces_of(c).iter().map(move |&b| (a, b)))
            .filter(|&(a, b)| t.is_straight(c, a, b))
            .count();
        assert_eq!(straight, if c.is_hexagon() { 6 } else { 0 }, "{c:?}");
    }
}

#[test]
fn shapes_are_regular_6_and_regular_3() {
    let t = SnubHexagonalTessellation;
    let keys: Vec<_> = t.shape_descriptors().iter().map(|d| d.key()).collect();
    assert_eq!(keys, ["regular:6", "regular:3"]);
    let key = |c| t.shape_of(c).unwrap().descriptor().key().to_owned();
    assert_eq!(key(SnubHexagonalPoint::hexagon(0, 0)), "regular:6");
    for kind in &SnubHexagonalKind::ALL[1..] {
        assert_eq!(key(SnubHexagonalPoint::new(0, 0, *kind)), "regular:3");
    }
}

#[test]
fn cells_have_unit_sides_and_shared_edges_match() {
    let t = SnubHexagonalTessellation;
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

/// Four triangles and one hexagon meet at every vertex, so the angles sum to 360°: counting
/// the corners at each vertex gives `3.3.3.3.6`.
#[test]
fn every_interior_vertex_has_four_triangles_and_one_hexagon() {
    use std::collections::HashMap;
    let t = SnubHexagonalTessellation;
    let mut corners: HashMap<(i64, i64), (u32, u32)> = HashMap::new();
    for c in tiles(3) {
        for &f in t.faces_of(c) {
            let start = t.edge_segments(c, f)[0].start();
            let key = (
                (start.x * 4.0).round() as i64,
                (start.y * 8.0).round() as i64,
            );
            let entry = corners.entry(key).or_default();
            if c.is_hexagon() {
                entry.1 += 1;
            } else {
                entry.0 += 1;
            }
        }
    }
    let center = t.center(SnubHexagonalPoint::hexagon(0, 0));
    let central = (
        (center.x * 4.0).round() as i64,
        (center.y * 8.0).round() as i64,
    );
    let mut full = 0;
    for (&key, &(triangles, hexagons)) in &corners {
        if key == central {
            continue;
        }
        if triangles + hexagons == 5 {
            assert_eq!((triangles, hexagons), (4, 1), "{key:?}");
            full += 1;
        }
    }
    assert!(full > 50);
}

#[test]
fn hexagon_and_triangle_areas() {
    let t = SnubHexagonalTessellation;
    assert!((t.area(SnubHexagonalPoint::hexagon(0, 0)) - 1.5 * 3f64.sqrt()).abs() < 1e-12);
    for kind in &SnubHexagonalKind::ALL[1..] {
        let area = t.area(SnubHexagonalPoint::new(1, -2, *kind));
        assert!((area - 3f64.sqrt() / 4.0).abs() < 1e-12);
    }
}

#[test]
fn hexagon_centers_form_the_counter_clockwise_lattice() {
    let t = SnubHexagonalTessellation;
    let at = |q, r| t.center(SnubHexagonalPoint::hexagon(q, r));
    let first = at(1, 0);
    assert!((first.x - 2.5).abs() < 1e-12);
    assert!((first.y - 3f64.sqrt() / 2.0).abs() < 1e-12);
    // 19.1 degrees counter-clockwise from the hexagon's vertex axis.
    assert!((first.y.atan2(first.x) - (3f64.sqrt() / 5.0).atan()).abs() < 1e-12);
    assert!((first.distance(Point::new(0.0, 0.0)) - 7f64.sqrt()).abs() < 1e-12);
}

#[test]
fn cell_at_finds_cells_in_every_quadrant() {
    let t = SnubHexagonalTessellation;
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
    let t = SnubHexagonalTessellation;
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
fn kind_index_follows_the_wire_order() {
    for (i, kind) in SnubHexagonalKind::ALL.into_iter().enumerate() {
        assert_eq!(kind.index(), i);
    }
}

#[test]
fn rect_pitch_is_the_hexagon_center_distance() {
    let t = SnubHexagonalTessellation;
    // A 1 x 1 rect is exactly one pitch wide: it holds the origin hexagon and nothing of the
    // hexagon one pitch away (whose cell extends past the rectangle).
    let cells = t.build_preset("rect", &[("cols", 1), ("rows", 1)]).unwrap();
    assert!(cells.contains(&SnubHexagonalPoint::hexagon(0, 0)));
    assert!(!cells.contains(&SnubHexagonalPoint::hexagon(1, 0)));
    let width = t
        .center(SnubHexagonalPoint::hexagon(1, -1))
        .distance(t.center(SnubHexagonalPoint::hexagon(0, 0)));
    assert!((width - 7f64.sqrt()).abs() < 1e-12);
}

#[test]
fn anchor_reach_bounds_every_cell_vertex() {
    let t = SnubHexagonalTessellation;
    let origin = t.center(SnubHexagonalPoint::hexagon(0, 0));
    for kind in SnubHexagonalKind::ALL {
        let cell = SnubHexagonalPoint::new(0, 0, kind);
        for s in t.boundary_path(cell).faces().iter().flatten() {
            assert!(s.start().distance(origin) <= 2.0 + 1e-9, "{kind:?}");
        }
    }
}

#[test]
fn presets_are_nonempty_and_rect_scales_with_its_size() {
    let t = SnubHexagonalTessellation;
    let small = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    let large = t.build_preset("rect", &[("cols", 6), ("rows", 6)]).unwrap();
    assert!(large.len() > 3 * small.len());
    assert!(small.iter().any(|c| c.is_hexagon()));
    assert!(small.iter().any(|c| !c.is_hexagon()));
}

#[test]
fn translation_by_a_lattice_vector_works_and_reflection_is_unavailable() {
    let t = SnubHexagonalTessellation;
    let cells = [
        SnubHexagonalPoint::hexagon(0, 0),
        SnubHexagonalPoint::new(0, 0, SnubHexagonalKind::Edge2),
    ];
    let moved = t.translate_cells(&cells, Point::new(2.5, 3f64.sqrt() / 2.0));
    assert_eq!(
        moved.unwrap(),
        [
            SnubHexagonalPoint::hexagon(1, 0),
            SnubHexagonalPoint::new(1, 0, SnubHexagonalKind::Edge2)
        ]
    );
    assert_eq!(
        t.translate_cells(&cells, Point::new(1.0, 0.0)),
        Err(FieldOpError::NotASymmetry)
    );
    // The tiling is chiral: reflection is not offered at all.
    assert_eq!(t.field_operations(), [FieldOperation::Translate]);
    let axis = (Point::new(0.0, 0.0), Point::new(1.0, 0.0));
    assert_eq!(
        t.reflect_cells(&cells, axis),
        Err(FieldOpError::Unavailable)
    );
}

#[test]
fn field_connectivity_matches_adjacency() {
    let t = Arc::new(SnubHexagonalTessellation);
    let mut ids = IdGenerator::new();
    let cells = t.build_preset("rect", &[("cols", 4), ("rows", 4)]).unwrap();
    let field = Field::new(t, cells, &mut ids).unwrap();
    let center = field.nodes_at(SnubHexagonalPoint::hexagon(0, 0))[0];
    assert_eq!(field.neighbors(center).len(), 6);
}
