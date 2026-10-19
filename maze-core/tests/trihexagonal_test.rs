use maze_core::IdGenerator;
use maze_core::space::{
    CellScope, Field, Point, Tessellation, TessellationGeometry, TrihexagonalFace,
    TrihexagonalKind, TrihexagonalPoint, TrihexagonalTessellation,
};
use std::sync::Arc;

fn tiles(radius: i32) -> Vec<TrihexagonalPoint> {
    (-radius..=radius)
        .flat_map(|r| (-radius..=radius).map(move |q| (q, r)))
        .flat_map(|(q, r)| {
            [
                TrihexagonalPoint::hexagon(q, r),
                TrihexagonalPoint::up(q, r),
                TrihexagonalPoint::down(q, r),
            ]
        })
        .collect()
}

#[test]
fn hexagons_have_six_triangle_neighbors_triangles_three_hexagons() {
    let t = TrihexagonalTessellation;
    for c in tiles(6) {
        let faces = t.faces_of(c);
        let neighbors: Vec<_> = faces.iter().map(|&f| t.neighbor(c, f).unwrap().0).collect();
        let mut unique = neighbors.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), neighbors.len(), "{c:?}");
        if c.is_hexagon() {
            assert_eq!(faces.len(), 6);
            assert!(neighbors.iter().all(|n| !n.is_hexagon()), "{c:?}");
        } else {
            assert_eq!(faces.len(), 3);
            assert!(neighbors.iter().all(|n| n.is_hexagon()), "{c:?}");
        }
    }
}

#[test]
fn neighbor_is_reciprocal_and_faces_are_opposite() {
    let t = TrihexagonalTessellation;
    for c in tiles(6) {
        for &f in t.faces_of(c) {
            let (c2, f2) = t.neighbor(c, f).unwrap();
            assert_eq!(f2, f.opposite());
            assert_eq!(t.neighbor(c2, f2), Some((c, f)), "{c:?} {f:?}");
        }
    }
}

#[test]
fn step_is_none_for_faces_the_cell_lacks_and_at_overflow() {
    assert_eq!(
        TrihexagonalPoint::hexagon(0, 0).step(TrihexagonalFace::NE),
        Some(TrihexagonalPoint::down(0, 0))
    );
    assert_eq!(TrihexagonalPoint::up(0, 0).step(TrihexagonalFace::N), None);
    assert_eq!(
        TrihexagonalPoint::down(0, 0).step(TrihexagonalFace::NE),
        None
    );
    assert_eq!(
        TrihexagonalPoint::down(i32::MAX, 0).step(TrihexagonalFace::SE),
        None
    );
    assert_eq!(
        TrihexagonalPoint::hexagon(i32::MIN, 0).step(TrihexagonalFace::N),
        None
    );
}

#[test]
fn only_hexagons_have_straight_passes() {
    let t = TrihexagonalTessellation;
    for c in tiles(3) {
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
    let t = TrihexagonalTessellation;
    let keys: Vec<_> = t.shape_descriptors().iter().map(|d| d.key()).collect();
    assert_eq!(keys, ["regular:6", "regular:3"]);
    let key = |c| t.shape_of(c).unwrap().descriptor().key().to_owned();
    assert_eq!(key(TrihexagonalPoint::hexagon(0, 0)), "regular:6");
    assert_eq!(key(TrihexagonalPoint::up(0, 0)), "regular:3");
    assert_eq!(key(TrihexagonalPoint::down(0, 0)), "regular:3");
}

#[test]
fn cells_have_unit_sides_and_shared_edges_match() {
    let t = TrihexagonalTessellation;
    for c in tiles(4) {
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

#[test]
fn hexagon_and_triangle_areas() {
    let t = TrihexagonalTessellation;
    assert!((t.area(TrihexagonalPoint::hexagon(0, 0)) - 1.5 * 3f64.sqrt()).abs() < 1e-12);
    assert!((t.area(TrihexagonalPoint::up(0, 0)) - 3f64.sqrt() / 4.0).abs() < 1e-12);
    assert_eq!(
        t.area(TrihexagonalPoint::up(3, -2)),
        t.area(TrihexagonalPoint::down(-1, 5))
    );
}

#[test]
fn triangles_point_the_way_their_kind_says() {
    let t = TrihexagonalTessellation;
    for (cell, apex_up) in [
        (TrihexagonalPoint::up(0, 0), true),
        (TrihexagonalPoint::down(0, 0), false),
    ] {
        let center = t.center(cell);
        let ys: Vec<f64> = t
            .boundary_path(cell)
            .segments()
            .map(|s| s.start().y)
            .collect();
        let above = ys.iter().filter(|&&y| y > center.y).count();
        assert_eq!(above, if apex_up { 1 } else { 2 }, "{cell:?}");
    }
}

#[test]
fn cell_at_finds_cells_in_every_quadrant() {
    let t = TrihexagonalTessellation;
    for c in tiles(5) {
        assert_eq!(t.cell_at(t.center(c), CellScope::Space), Some(c), "{c:?}");
    }
    assert!(
        t.cell_at(Point::new(-100.0, 100.0), CellScope::Space)
            .is_some()
    );
}

#[test]
fn candidate_cells_cover_the_box_and_respect_the_limit() {
    let t = TrihexagonalTessellation;
    let (min, max) = (Point::new(-3.0, -3.0), Point::new(3.0, 3.0));
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
fn rect_preset_holds_the_hexagons_and_the_triangles_between_them() {
    let t = TrihexagonalTessellation;
    let cells = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    let hexagons = cells.iter().filter(|c| c.is_hexagon()).count();
    assert_eq!(hexagons, 9);
    assert!(cells.contains(&TrihexagonalPoint::hexagon(0, 0)));
    // Every kept triangle has all three hexagons in the field.
    for &c in cells.iter().filter(|c| !c.is_hexagon()) {
        for &f in t.faces_of(c) {
            assert!(cells.contains(&t.neighbor(c, f).unwrap().0), "{c:?}");
        }
    }
    assert!(cells.iter().any(|c| c.kind == TrihexagonalKind::Up));
    assert!(cells.iter().any(|c| c.kind == TrihexagonalKind::Down));
}

#[test]
fn single_hexagon_rect_has_no_triangles() {
    let t = TrihexagonalTessellation;
    let cells = t.build_preset("rect", &[("cols", 1), ("rows", 1)]).unwrap();
    assert_eq!(cells, [TrihexagonalPoint::hexagon(0, 0)]);
}

#[test]
fn field_connectivity_matches_adjacency() {
    let t = Arc::new(TrihexagonalTessellation);
    let mut ids = IdGenerator::new();
    let cells = t.build_preset("rect", &[("cols", 4), ("rows", 4)]).unwrap();
    let field = Field::new(t, cells, &mut ids).unwrap();
    let center = field.nodes_at(TrihexagonalPoint::hexagon(0, 0))[0];
    assert_eq!(field.neighbors(center).len(), 6);
}
