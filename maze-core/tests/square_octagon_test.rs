use maze_core::IdGenerator;
use maze_core::space::{
    CellScope, Field, Point, SquareOctagonFace, SquareOctagonPoint, SquareOctagonTessellation,
    Tessellation, TessellationGeometry,
};
use std::sync::Arc;

fn cell(x: i32, y: i32) -> SquareOctagonPoint {
    SquareOctagonPoint { x, y }
}

fn tiles(radius: i32) -> Vec<SquareOctagonPoint> {
    (-radius..=radius)
        .flat_map(|y| (-radius..=radius).map(move |x| cell(x, y)))
        .filter(|&c| SquareOctagonTessellation.is_valid_cell(c))
        .collect()
}

#[test]
fn only_same_parity_points_are_tiles_including_negative() {
    let t = SquareOctagonTessellation;
    assert!(t.is_valid_cell(cell(0, 0)));
    assert!(t.is_valid_cell(cell(-2, 4)));
    assert!(t.is_valid_cell(cell(-1, -3)));
    assert!(t.is_valid_cell(cell(1, 1)));
    assert!(!t.is_valid_cell(cell(0, 1)));
    assert!(!t.is_valid_cell(cell(-1, 0)));
    assert!(cell(-2, -4).is_octagon());
    assert!(cell(-1, -3).is_square());
}

#[test]
fn step_is_none_for_non_tiles_and_missing_faces() {
    assert_eq!(cell(0, 0).step(SquareOctagonFace::E), Some(cell(2, 0)));
    assert_eq!(cell(0, 0).step(SquareOctagonFace::NE), Some(cell(1, 1)));
    assert_eq!(cell(-1, -1).step(SquareOctagonFace::SW), Some(cell(-2, -2)));
    assert_eq!(cell(1, 1).step(SquareOctagonFace::E), None);
    assert_eq!(cell(0, 1).step(SquareOctagonFace::NE), None);
    assert_eq!(cell(i32::MAX - 1, 0).step(SquareOctagonFace::E), None);
    assert_eq!(cell(i32::MAX, i32::MAX).step(SquareOctagonFace::NE), None);
}

#[test]
fn octagons_have_eight_neighbors_squares_four_of_the_other_kind() {
    let t = SquareOctagonTessellation;
    for c in tiles(8) {
        let faces = t.faces_of(c);
        let neighbors: Vec<_> = faces.iter().map(|&f| t.neighbor(c, f).unwrap().0).collect();
        let mut unique = neighbors.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), neighbors.len(), "{c:?}");
        if c.is_octagon() {
            assert_eq!(faces.len(), 8);
            assert_eq!(neighbors.iter().filter(|n| n.is_octagon()).count(), 4);
            assert_eq!(neighbors.iter().filter(|n| n.is_square()).count(), 4);
        } else {
            assert_eq!(faces.len(), 4);
            assert!(neighbors.iter().all(|n| n.is_octagon()));
        }
        assert!(neighbors.iter().all(|&n| t.is_valid_cell(n)));
    }
}

#[test]
fn neighbor_is_reciprocal() {
    let t = SquareOctagonTessellation;
    for c in tiles(8) {
        for &f in t.faces_of(c) {
            let (c2, f2) = t.neighbor(c, f).unwrap();
            assert_eq!(t.neighbor(c2, f2), Some((c, f)), "{c:?} {f:?}");
        }
    }
}

#[test]
fn neighbor_is_none_at_coordinate_overflow() {
    let t = SquareOctagonTessellation;
    assert_eq!(
        t.neighbor(cell(i32::MAX - 1, 0), SquareOctagonFace::E),
        None
    );
    assert_eq!(t.neighbor(cell(i32::MIN, 0), SquareOctagonFace::W), None);
}

#[test]
fn straight_passes_go_through_the_opposite_face_only() {
    let t = SquareOctagonTessellation;
    for c in tiles(4) {
        let straight = t
            .faces_of(c)
            .iter()
            .flat_map(|&a| t.faces_of(c).iter().map(move |&b| (a, b)))
            .filter(|&(a, b)| t.is_straight(c, a, b))
            .count();
        assert_eq!(straight, t.faces_of(c).len(), "{c:?}");
    }
}

#[test]
fn shapes_are_regular_8_and_regular_4() {
    let t = SquareOctagonTessellation;
    let keys: Vec<_> = t.shape_descriptors().iter().map(|d| d.key()).collect();
    assert_eq!(keys, ["regular:8", "regular:4"]);
    assert_eq!(
        t.shape_of(cell(0, 0)).unwrap().descriptor().key(),
        "regular:8"
    );
    assert_eq!(
        t.shape_of(cell(1, 1)).unwrap().descriptor().key(),
        "regular:4"
    );
}

#[test]
fn cells_are_regular_with_unit_sides_and_shared_edges_match() {
    let t = SquareOctagonTessellation;
    for c in tiles(6) {
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
fn octagon_and_square_areas() {
    let t = SquareOctagonTessellation;
    assert!((t.area(cell(0, 0)) - 2.0 * (1.0 + 2f64.sqrt())).abs() < 1e-12);
    assert!((t.area(cell(1, 1)) - 1.0).abs() < 1e-12);
}

#[test]
fn cell_at_finds_cells_in_every_quadrant() {
    let t = SquareOctagonTessellation;
    for c in tiles(5) {
        assert_eq!(t.cell_at(t.center(c), CellScope::Space), Some(c), "{c:?}");
    }
    assert_eq!(
        t.cell_at(Point::new(-100.0, 100.0), CellScope::Space)
            .map(|c| t.is_valid_cell(c)),
        Some(true)
    );
}

#[test]
fn candidate_cells_cover_the_box_and_respect_the_limit() {
    let t = SquareOctagonTessellation;
    let (min, max) = (Point::new(-3.0, -3.0), Point::new(3.0, 3.0));
    let cells = t.candidate_cells(min, max, 10_000).unwrap();
    assert!(cells.iter().all(|&c| t.is_valid_cell(c)));
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
fn field_connectivity_matches_adjacency() {
    let t = Arc::new(SquareOctagonTessellation);
    let mut ids = IdGenerator::new();
    let cells = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    assert_eq!(cells.len(), 9 + 4);
    let field = Field::new(t, cells, &mut ids).unwrap();
    let center = field.nodes_at(cell(0, 0))[0];
    assert_eq!(field.neighbors(center).len(), 8);
    let corner = field.nodes_at(cell(-2, -2))[0];
    assert_eq!(field.neighbors(corner).len(), 3);
}
