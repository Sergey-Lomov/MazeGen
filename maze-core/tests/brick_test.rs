use maze_core::IdGenerator;
use maze_core::space::{
    BrickFace, BrickPoint, BrickTessellation, CellScope, Field, Point, Tessellation,
    TessellationGeometry,
};
use std::sync::Arc;

fn cell(x: i32, y: i32) -> BrickPoint {
    BrickPoint { x, y }
}

fn bricks(radius: i32) -> Vec<BrickPoint> {
    (-radius..=radius)
        .flat_map(|y| (-radius..=radius).map(move |x| cell(x, y)))
        .collect()
}

#[test]
fn every_cell_has_six_distinct_neighbors() {
    let t = BrickTessellation;
    for c in bricks(8) {
        let faces = t.faces_of(c);
        assert_eq!(faces.len(), 6);
        let mut neighbors: Vec<_> = faces.iter().map(|&f| t.neighbor(c, f).unwrap().0).collect();
        neighbors.sort();
        neighbors.dedup();
        assert_eq!(neighbors.len(), 6, "{c:?}");
    }
}

#[test]
fn rows_are_shifted_by_parity_including_negative_rows() {
    let t = BrickTessellation;
    let step = |c: BrickPoint, f| t.neighbor(c, f).unwrap().0;
    assert_eq!(step(cell(0, 0), BrickFace::NE), cell(0, 1));
    assert_eq!(step(cell(0, 0), BrickFace::NW), cell(-1, 1));
    assert_eq!(step(cell(0, 0), BrickFace::SE), cell(0, -1));
    assert_eq!(step(cell(0, 1), BrickFace::NE), cell(1, 2));
    assert_eq!(step(cell(0, 1), BrickFace::NW), cell(0, 2));
    assert_eq!(step(cell(0, -1), BrickFace::SW), cell(0, -2));
    assert_eq!(step(cell(0, -1), BrickFace::SE), cell(1, -2));
    assert_eq!(step(cell(3, 4), BrickFace::E), cell(4, 4));
}

#[test]
fn neighbor_is_reciprocal() {
    let t = BrickTessellation;
    for c in bricks(8) {
        for &f in t.faces_of(c) {
            let (c2, f2) = t.neighbor(c, f).unwrap();
            assert_eq!(t.neighbor(c2, f2), Some((c, f)), "{c:?} {f:?}");
        }
    }
}

#[test]
fn neighbor_is_none_at_coordinate_overflow() {
    let t = BrickTessellation;
    assert_eq!(t.neighbor(cell(i32::MAX, 0), BrickFace::E), None);
    assert_eq!(t.neighbor(cell(i32::MIN, 0), BrickFace::W), None);
    assert_eq!(t.neighbor(cell(0, i32::MAX), BrickFace::NE), None);
    assert_eq!(t.neighbor(cell(i32::MIN, 0), BrickFace::NW), None);
}

#[test]
fn straight_pass_leaves_through_the_opposite_face_only() {
    let t = BrickTessellation;
    for c in bricks(3) {
        for &a in t.faces_of(c) {
            let straight: Vec<_> = t
                .faces_of(c)
                .iter()
                .filter(|&&b| t.is_straight(c, a, b))
                .collect();
            assert_eq!(straight, [&a.opposite()], "{c:?} {a:?}");
        }
    }
}

#[test]
fn shape_is_one_brick_template_with_the_two_mirrors_and_half_turn() {
    let t = BrickTessellation;
    let keys: Vec<_> = t.shape_descriptors().iter().map(|d| d.key()).collect();
    assert_eq!(keys, ["brick:brick"]);
    let group = t.shape_descriptors()[0].group();
    assert_eq!(group.len(), 4);
    assert!(group.contains(&vec![3, 4, 5, 0, 1, 2]));
}

#[test]
fn unit_cells_and_half_edges_are_shared_bit_identically() {
    let t = BrickTessellation;
    for c in bricks(6) {
        let path = t.boundary_path(c);
        assert!((path.signed_area() - 1.0).abs() < 1e-12, "{c:?}");
        assert_eq!(t.area(c), 1.0);
        for &f in t.faces_of(c) {
            let segments = t.edge_segments(c, f);
            let length: f64 = segments.iter().map(|s| s.length()).sum();
            let expected = if matches!(f, BrickFace::E | BrickFace::W) {
                1.0
            } else {
                0.5
            };
            assert!((length - expected).abs() < 1e-12, "{c:?} {f:?}");
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
fn cell_at_finds_cells_in_every_quadrant() {
    let t = BrickTessellation;
    for c in bricks(5) {
        assert_eq!(t.cell_at(t.center(c), CellScope::Space), Some(c), "{c:?}");
    }
}

#[test]
fn candidate_cells_cover_the_box_and_respect_the_limit() {
    let t = BrickTessellation;
    let (min, max) = (Point::new(-3.0, -3.0), Point::new(3.0, 3.0));
    let cells = t.candidate_cells(min, max, 10_000).unwrap();
    for c in bricks(12) {
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
fn rect_preset_is_a_ragged_brick_wall() {
    let t = BrickTessellation;
    let cells = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    assert_eq!(cells.len(), 9);
    assert!(cells.contains(&cell(0, 0)));
    let mut ids = IdGenerator::new();
    let field = Field::new(Arc::new(t), cells, &mut ids).unwrap();
    // The odd rows are shifted right, so the wall is ragged at its edges.
    assert_eq!(field.neighbors(field.nodes_at(cell(0, 0))[0]).len(), 6);
    assert_eq!(field.neighbors(field.nodes_at(cell(0, -1))[0]).len(), 4);
    assert_eq!(field.neighbors(field.nodes_at(cell(-1, -1))[0]).len(), 3);
    assert_eq!(field.neighbors(field.nodes_at(cell(1, -1))[0]).len(), 2);
}

/// Each row of the pyramid has one brick fewer and rests on two bricks of the row below, so the
/// sides keep one slope all the way up.
#[test]
fn triangle_preset_is_a_pyramid_with_one_brick_fewer_per_row() {
    let t = BrickTessellation;
    for side in 1..=12u32 {
        let cells = t.build_preset("triangle", &[("side", side)]).unwrap();
        assert_eq!(cells.len() as u32, side * (side + 1) / 2, "side {side}");
        let mut rows: std::collections::BTreeMap<i32, Vec<i32>> = Default::default();
        for c in &cells {
            rows.entry(c.y).or_default().push(c.x);
        }
        assert_eq!(rows.len() as u32, side);
        for (n, (&y, xs)) in rows.iter().rev().enumerate() {
            assert_eq!(xs.len() as u32, n as u32 + 1, "side {side} row {y}");
            assert!(
                xs.windows(2).all(|w| w[1] == w[0] + 1),
                "side {side} row {y}"
            );
            if let Some(below) = rows.get(&(y - 1)) {
                let supports = |x: i32, f| {
                    let (c, _) = t.neighbor(cell(x, y), f).unwrap();
                    below.contains(&c.x)
                };
                assert!(
                    xs.iter()
                        .all(|&x| supports(x, BrickFace::SW) && supports(x, BrickFace::SE)),
                    "side {side} row {y}"
                );
            }
        }
        // Left and right edges each step half a brick per row.
        let edge = |pick: fn(&Vec<i32>) -> i32, y: i32| {
            let x = pick(&rows[&y]);
            t.center(cell(x, y)).x
        };
        let ys: Vec<i32> = rows.keys().copied().collect();
        for w in ys.windows(2) {
            let left = edge(|xs| *xs.iter().min().unwrap(), w[1])
                - edge(|xs| *xs.iter().min().unwrap(), w[0]);
            let right = edge(|xs| *xs.iter().max().unwrap(), w[1])
                - edge(|xs| *xs.iter().max().unwrap(), w[0]);
            assert_eq!(left, 0.5, "side {side}");
            assert_eq!(right, -0.5, "side {side}");
        }
    }
    assert!(t.build_preset("triangle", &[("side", 2000)]).is_err());
}

#[test]
fn circle_preset_is_centered_and_mirror_symmetric() {
    let t = BrickTessellation;
    let cells = t.build_preset("circle", &[("radius", 4)]).unwrap();
    assert!(cells.contains(&cell(0, 0)));
    let origin = t.center(cell(0, 0));
    for c in &cells {
        let p = t.center(*c);
        let mirrored = Point::new(2.0 * origin.x - p.x, p.y);
        assert!(
            cells.iter().any(|m| t.center(*m) == mirrored),
            "{c:?} has no mirror image"
        );
    }
}

/// The pyramid cap counts bricks, not `side`: the largest allowed pyramid is 1413 rows.
#[test]
fn triangle_preset_cap_is_on_the_brick_count() {
    let t = BrickTessellation;
    assert!(t.build_preset("triangle", &[("side", 1413)]).is_ok());
    assert!(t.build_preset("triangle", &[("side", 1414)]).is_err());
}
