use maze_core::space::{
    CellScope, CurvedQuadrilateralFace, CurvedQuadrilateralPoint, CurvedQuadrilateralTessellation,
    FieldOpError, FieldOps, Point, Segment, Tessellation, TessellationGeometry,
};

const T: CurvedQuadrilateralTessellation = CurvedQuadrilateralTessellation;

fn cell(x: i32, y: i32) -> CurvedQuadrilateralPoint {
    CurvedQuadrilateralPoint { x, y }
}

fn tiles(radius: i32) -> Vec<CurvedQuadrilateralPoint> {
    (-radius..=radius)
        .flat_map(|y| (-radius..=radius).map(move |x| cell(x, y)))
        .collect()
}

/// Whether the arc bulges away from the cell's center (convex) or toward it (concave).
fn is_convex(c: CurvedQuadrilateralPoint, face: CurvedQuadrilateralFace) -> bool {
    let Segment::CircularArc { center, .. } = T.face_segments(c, face)[0] else {
        panic!("{c:?} {face:?} is not an arc");
    };
    center == T.center(c)
}

#[test]
fn every_cell_has_four_distinct_neighbors() {
    for c in tiles(4) {
        let mut around: Vec<_> = T
            .faces_of(c)
            .iter()
            .map(|&f| T.neighbor(c, f).unwrap().0)
            .collect();
        assert_eq!(around.len(), 4);
        around.sort();
        around.dedup();
        assert_eq!(around.len(), 4, "{c:?}");
    }
}

#[test]
fn neighbors_are_symmetric_with_negative_coordinates() {
    for c in tiles(4) {
        for &f in T.faces_of(c) {
            let (n, nf) = T.neighbor(c, f).unwrap();
            assert_eq!(T.neighbor(n, nf), Some((c, f)), "{c:?} {f:?}");
        }
    }
    assert_eq!(
        T.neighbor(cell(0, 0), CurvedQuadrilateralFace::W),
        Some((cell(-1, 0), CurvedQuadrilateralFace::E))
    );
    assert_eq!(
        T.neighbor(cell(i32::MAX, 0), CurvedQuadrilateralFace::E),
        None
    );
}

#[test]
fn each_tile_has_two_opposite_convex_and_two_opposite_concave_sides() {
    use CurvedQuadrilateralFace::*;
    for c in tiles(4) {
        let [e, n, w, s] = [E, N, W, S].map(|f| is_convex(c, f));
        assert_eq!((e, w), (e, e), "{c:?}");
        assert_eq!((n, s), (n, n), "{c:?}");
        assert_ne!(e, n, "{c:?}");
        assert_eq!(e, (c.x + c.y).rem_euclid(2) == 0, "{c:?}");
    }
}

#[test]
fn a_shared_edge_is_one_arc_convex_on_one_side_and_concave_on_the_other() {
    for c in tiles(4) {
        for &f in T.faces_of(c) {
            let (n, nf) = T.neighbor(c, f).unwrap();
            assert_ne!(is_convex(c, f), is_convex(n, nf), "{c:?} {f:?}");
            let mine = T.edge_segments(c, f);
            let theirs: Vec<Segment> = T
                .edge_segments(n, nf)
                .iter()
                .rev()
                .map(Segment::reversed)
                .collect();
            assert_eq!(mine, theirs, "{c:?} {f:?}");
            assert_eq!(T.contact_point(c, f), T.contact_point(n, nf));
        }
    }
}

#[test]
fn tiles_have_unit_area_and_contain_their_center() {
    for c in tiles(3) {
        let path = T.boundary_path(c);
        assert!((path.signed_area() - 1.0).abs() < 1e-9, "{c:?}");
        assert!(path.contains(T.center(c)), "{c:?}");
    }
}

#[test]
fn convex_side_reaches_beyond_the_square() {
    let apex = T.contact_point(cell(0, 0), CurvedQuadrilateralFace::E);
    assert!((apex.x - (0.5 + 0.5_f64.sqrt())).abs() < 1e-12);
    assert!((apex.y - 0.5).abs() < 1e-12);
    let dent = T.contact_point(cell(0, 0), CurvedQuadrilateralFace::N);
    assert!((dent.y - (1.5 - 0.5_f64.sqrt())).abs() < 1e-12);
}

#[test]
fn straight_pass_leaves_by_the_opposite_face() {
    use CurvedQuadrilateralFace::*;
    let c = cell(1, 0);
    assert!(T.is_straight(c, E, W));
    assert!(T.is_straight(c, N, S));
    assert!(!T.is_straight(c, E, N));
    assert!(!T.is_straight(c, E, E));
}

#[test]
fn geometry_is_deterministic() {
    for c in tiles(2) {
        for &f in T.faces_of(c) {
            assert_eq!(T.face_segments(c, f), T.face_segments(c, f));
        }
    }
    assert_eq!(
        T.candidate_cells(Point::new(-2.0, -2.0), Point::new(2.0, 2.0), 1000),
        T.candidate_cells(Point::new(-2.0, -2.0), Point::new(2.0, 2.0), 1000),
    );
}

#[test]
fn candidate_cells_cover_every_cell_touching_the_box() {
    let (min, max) = (Point::new(-2.3, 0.1), Point::new(1.7, 3.2));
    let candidates = T.candidate_cells(min, max, 10_000).unwrap();
    for c in tiles(8) {
        let touches = T
            .boundary_path(c)
            .segments()
            .flat_map(|s| s.flatten(1e-3))
            .any(|p| p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y);
        if touches {
            assert!(candidates.contains(&c), "{c:?}");
        }
    }
    assert_eq!(T.candidate_cells(min, max, 3), None);
}

#[test]
fn cell_at_finds_cells_in_every_quadrant() {
    for c in tiles(4) {
        assert_eq!(T.cell_at(T.center(c), CellScope::Space), Some(c), "{c:?}");
    }
    // The east apex of an even cell lies inside that cell, past the square's edge.
    assert_eq!(
        T.cell_at(Point::new(1.1, 0.5), CellScope::Space),
        Some(cell(0, 0))
    );
    // The concave north side of cell (0, 0) dips to y ≈ 0.917 at x = 0.9: the point above belongs
    // to the cell across it although it is inside the square of (0, 0).
    assert_eq!(
        T.cell_at(Point::new(0.9, 0.95), CellScope::Space),
        Some(cell(0, 1))
    );
}

#[test]
fn translation_keeps_the_convex_pair_orientation() {
    let cells = vec![cell(0, 0), cell(1, 0)];
    // A shift by one cell swaps convex and concave sides: not a symmetry.
    assert_eq!(
        T.translate_cells(&cells, Point::new(1.0, 0.0)),
        Err(FieldOpError::NotASymmetry)
    );
    assert_eq!(
        T.translate_cells(&cells, Point::new(2.0, 0.0)),
        Ok(vec![cell(2, 0), cell(3, 0)])
    );
    assert_eq!(
        T.translate_cells(&cells, Point::new(1.0, 1.0)),
        Ok(vec![cell(1, 1), cell(2, 1)])
    );
}

#[test]
fn presets_build_connected_sorted_fields() {
    let rect = T.build_preset("rect", &[("cols", 5), ("rows", 4)]).unwrap();
    assert_eq!(rect.len(), 20);
    assert!(rect.windows(2).all(|w| w[0] < w[1]));
    assert!(rect.contains(&cell(0, 0)));
}
