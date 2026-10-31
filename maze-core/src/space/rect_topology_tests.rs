use crate::ids::IdGenerator;
use crate::space::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// A rectangle preset: its key, size and the `axis` of a cylinder.
type Params = (&'static str, [(&'static str, u32); 3]);

/// `topology`: `0` plain rectangle, `1` cylinder, `2` torus.
fn rect(cols: u32, rows: u32, topology: u32, axis: u32) -> Params {
    let key = ["rect", "cylinder", "torus"][topology as usize];
    (key, [("cols", cols), ("rows", rows), ("axis", axis)])
}

/// The params preset `p` accepts (`axis` belongs to a cylinder only).
fn args(p: &Params) -> &[(&'static str, u32)] {
    if p.0 == "cylinder" { &p.1 } else { &p.1[..2] }
}

fn glues<T: Tessellation>(t: &T, p: &Params) -> bool {
    t.build_preset(p.0, args(p)).is_ok() && t.build_preset_folds(p.0, args(p)).is_ok()
}

/// The field of a glued rectangle with its topology installed (every fold must be accepted).
fn glued_field<T: Tessellation + Clone>(t: &T, p: &Params, name: &str) -> Field<T> {
    let cells = t.build_preset(p.0, args(p)).unwrap();
    let groups = t.build_preset_folds(p.0, args(p)).unwrap();
    let fp = TessellationFingerprint::new(name);
    let mut field = Field::new(Arc::new(t.clone()), cells, &mut IdGenerator::new()).unwrap();
    field
        .set_topology(Topology::from_groups(fp.clone(), groups), &fp)
        .unwrap();
    field
}

/// Every fold is active and isometric, every crossing is reciprocal, and the number of faces
/// without a neighbour is `open_faces` (when given).
fn check_glued<T: Tessellation + Clone>(t: &T, p: &Params, name: &str, open_faces: Option<usize>) {
    let field = glued_field(t, p, name);
    let cells = t.build_preset(p.0, args(p)).unwrap();
    let set: HashSet<T::CellId> = cells.iter().copied().collect();
    assert!(
        field
            .fold_activity()
            .iter()
            .all(|a| *a == FoldActivity::Active),
        "{name} {p:?}"
    );
    for id in 0..field.fold_activity().len() {
        assert!(
            matches!(
                field.fold_class(FoldId(id)),
                Some(FoldClass::Isometric { .. })
            ),
            "{name} {p:?} fold {id}"
        );
    }
    let mut open = 0;
    for &cell in &cells {
        for &face in t.faces_of(cell) {
            let Some(crossing) = field.neighbor_via(cell, face) else {
                open += 1;
                continue;
            };
            if !set.contains(&crossing.cell) {
                open += 1;
                continue;
            }
            let back = field.neighbor_via(crossing.cell, crossing.face).unwrap();
            assert_eq!((back.cell, back.face), (cell, face), "{name} {p:?}");
        }
    }
    if let Some(expected) = open_faces {
        assert_eq!(open, expected, "{name} {p:?}");
    }
}

#[test]
fn a_plain_rectangle_defines_no_folds_and_the_axis_may_be_left_out() {
    let t = SquareTessellation;
    let rect_params = [("cols", 3), ("rows", 2)];
    assert_eq!(t.build_preset("rect", &rect_params).unwrap().len(), 6);
    assert!(
        t.build_preset_folds("rect", &rect_params)
            .unwrap()
            .is_empty()
    );
    // A cylinder defaults to left-right.
    assert_eq!(
        t.build_preset_folds("cylinder", &rect_params).unwrap(),
        t.build_preset_folds("cylinder", &[("cols", 3), ("rows", 2), ("axis", 0)])
            .unwrap()
    );
    // The axis never counts toward the size limit.
    assert!(
        t.build_preset("cylinder", &[("cols", 1000), ("rows", 1000)])
            .is_ok()
    );
    assert!(
        t.build_preset("cylinder", &[("cols", 1001), ("rows", 1000)])
            .is_err()
    );
}

#[test]
fn a_cylinder_glues_one_pair_of_sides_and_a_torus_both() {
    let t = SquareTessellation;
    let count = |p: Params| -> Vec<usize> {
        t.build_preset_folds(p.0, args(&p))
            .unwrap()
            .iter()
            .map(Vec::len)
            .collect()
    };
    assert_eq!(count(rect(5, 4, 1, 0)), vec![4]);
    assert_eq!(count(rect(5, 4, 1, 1)), vec![5]);
    assert_eq!(count(rect(5, 4, 2, 0)), vec![4, 5]);
    assert_eq!(count(rect(5, 4, 2, 1)), vec![4, 5]);
    assert!(
        t.build_preset_folds("torus", &[("cols", 5), ("rows", 4)])
            .unwrap()
            .iter()
            .flatten()
            .all(|fold| !fold.twist)
    );
}

#[test]
fn glued_square_fields_are_closed_in_the_glued_directions_only() {
    let t = SquareTessellation;
    // A cylinder left-right keeps the top and bottom rows open; top-bottom the left and right.
    check_glued(&t, &rect(5, 4, 1, 0), "square{}", Some(2 * 5));
    check_glued(&t, &rect(5, 4, 1, 1), "square{}", Some(2 * 4));
    check_glued(&t, &rect(5, 4, 2, 0), "square{}", Some(0));
    check_glued(&t, &rect(3, 3, 2, 0), "square{}", Some(0));
}

#[test]
fn a_torus_wraps_a_straight_line_after_one_lap() {
    let t = SquareTessellation;
    let field = glued_field(&t, &rect(5, 4, 2, 0), "square{}");
    let lap = |face: SquareFace| {
        let start = SquarePoint { x: 0, y: 0 };
        let mut cell = start;
        for steps in 1..=20 {
            cell = field.neighbor_via(cell, face).unwrap().cell;
            if cell == start {
                return steps;
            }
        }
        0
    };
    // The origin cell sits at `size / 2` of each axis, so it is a cell of the field.
    assert!(field.contains(SquarePoint { x: 0, y: 0 }));
    assert_eq!((lap(SquareFace::E), lap(SquareFace::N)), (5, 4));
}

#[test]
fn sizes_that_do_not_close_up_are_refused() {
    let sq = SquareTessellation;
    // Two cells wide: a cell would meet the other one through two faces.
    assert!(!glues(&sq, &rect(2, 5, 1, 0)));
    assert!(glues(&sq, &rect(2, 5, 1, 1)));
    assert!(glues(&sq, &rect(3, 5, 1, 0)));
    assert!(!glues(&sq, &rect(3, 2, 2, 0)));
    // Hex columns pair up along the rows, so an odd count cannot be glued left to right.
    let hex = HexTessellation;
    for cols in [3, 5, 7] {
        assert!(!glues(&hex, &rect(cols, 6, 1, 0)), "hex {cols}");
    }
    for cols in [4, 6, 8] {
        assert!(glues(&hex, &rect(cols, 6, 1, 0)), "hex {cols}");
    }
    for rows in 3..9 {
        assert!(glues(&hex, &rect(4, rows, 1, 1)), "hex rows {rows}");
    }
    // Triangle rows come in pairs.
    let tri = TriTessellation;
    assert!(!glues(&tri, &rect(4, 3, 1, 1)));
    assert!(glues(&tri, &rect(4, 4, 1, 1)));
    assert!(glues(&tri, &rect(3, 4, 1, 0)));
    // Cairo needs even sizes along the glued sides.
    let cairo = CairoTessellation;
    assert!(!glues(&cairo, &rect(3, 4, 1, 0)));
    assert!(glues(&cairo, &rect(4, 4, 1, 0)));
}

#[test]
fn a_plain_rectangle_is_valid_at_every_size_and_an_unknown_axis_is_refused() {
    let hex = HexTessellation;
    assert!(glues(&hex, &rect(3, 3, 0, 0)));
    let sq = SquareTessellation;
    assert!(!glues(&sq, &rect(5, 5, 1, 2)));
}

#[test]
fn every_gluable_tessellation_closes_up_and_the_others_offer_no_topology() {
    fn all<T: Tessellation + Clone>(t: &T, name: &str) {
        all_up_to(t, name, 6);
    }
    fn all_up_to<T: Tessellation + Clone>(t: &T, name: &str, max: u32) {
        let mut seen = false;
        for cols in 1..=max {
            for rows in 1..=max {
                for (topology, axis) in [(1, 0), (1, 1), (2, 0)] {
                    let p = rect(cols, rows, topology, axis);
                    if glues(t, &p) {
                        seen = true;
                        // A torus has no free face left, however staggered its edges are.
                        check_glued(t, &p, name, (topology == 2).then_some(0));
                    }
                }
            }
        }
        assert!(seen, "{name} glues no size");
    }
    all(&SquareTessellation, "square");
    all(&HexTessellation, "hex");
    all(&TriTessellation, "tri");
    all(&CairoTessellation, "cairo");
    all(&BrickTessellation, "brick");
    all(&CurvedQuadrilateralTessellation, "curved");
    all(&SquareOctagonTessellation, "square_octagon");
    all(&ElongatedTriangularTessellation, "elongated_triangular");
    all(&TrihexagonalTessellation, "trihexagonal");
    // Their rectangle is one lattice period per size step, and a period is big.
    all_up_to(&RhombitrihexagonalTessellation, "rhombitrihexagonal", 4);
    all_up_to(&TruncatedHexagonalTessellation, "truncated_hexagonal", 4);
    all_up_to(
        &TruncatedTrihexagonalTessellation,
        "truncated_trihexagonal",
        4,
    );
    all_up_to(&SnubHexagonalTessellation, "snub_hexagonal", 2);
    all_up_to(&SnubSquareTessellation, "snub_square", 4);

    fn offers<T: Tessellation>(t: &T) -> bool {
        t.presets().iter().any(|preset| preset.key == "torus")
    }
    assert!(offers(&SquareTessellation) && offers(&ElongatedTriangularTessellation));
    assert!(offers(&TrihexagonalTessellation));
    assert!(offers(&SnubSquareTessellation));
    assert!(offers(&RhombitrihexagonalTessellation) && offers(&SnubHexagonalTessellation));
    assert!(
        SnubSquareTessellation
            .build_preset("cylinder", &[("cols", 4), ("rows", 4)])
            .is_ok()
    );
}

#[test]
fn the_axis_bound_is_published_for_cylinder_only() {
    let sq = SquareTessellation;
    assert_eq!(sq.preset_param_max("cylinder", "axis"), Some(1));
    assert_eq!(sq.preset_param_max("cylinder", "cols"), None);
    assert_eq!(sq.preset_param_max("torus", "axis"), None);
    assert_eq!(sq.preset_param_max("rect", "axis"), None);
    assert_eq!(
        HexTessellation.preset_param_max("cylinder", "axis"),
        Some(1)
    );
    assert_eq!(
        SnubSquareTessellation.preset_param_max("cylinder", "axis"),
        Some(1)
    );
    assert_eq!(
        TrihexagonalTessellation.preset_param_max("cylinder", "axis"),
        Some(1)
    );
}

#[test]
fn a_trihexagonal_rectangle_has_straight_edges_and_glues_without_extra_cells() {
    let t = TrihexagonalTessellation;
    for (topology, axis) in [(1, 0), (1, 1), (2, 0)] {
        for size in [4, 8] {
            assert!(
                glues(&t, &rect(size, size, topology, axis)),
                "{topology} {axis}"
            );
        }
    }
    let params = [("cols", 4), ("rows", 4)];
    // The rectangle holds one cell of every class of a glued side: gluing adds none.
    let plain = t.build_preset("rect", &params).unwrap();
    assert_eq!(plain, t.build_preset("torus", &params).unwrap());
    assert_eq!(plain.iter().filter(|c| c.is_hexagon()).count(), 16);
    // A hexagon and a triangle alternate along the top and the bottom edge: 2 * cols faces each.
    let segments: Vec<Segment> = plain
        .iter()
        .flat_map(|&c| {
            t.faces_of(c)
                .iter()
                .flat_map(move |&f| t.face_segments(c, f))
        })
        .collect();
    let ys = segments
        .iter()
        .flat_map(|s| [s.point(0.0).y, s.point(1.0).y]);
    let (low, high) = ys.fold((f64::MAX, f64::MIN), |(lo, hi), y| (lo.min(y), hi.max(y)));
    let on_line = |y: f64| {
        segments
            .iter()
            .filter(|s| (s.point(0.0).y - y).abs() < 1e-6 && (s.point(1.0).y - y).abs() < 1e-6)
            .count()
    };
    assert_eq!((on_line(low), on_line(high)), (8, 8));
    // The outline of a 6 x 6 rectangle has the least total turning of all the ways to put the
    // triangles of the sides on one side or the other: 8 corners and 540 degrees per side.
    let tall = t.build_preset("rect", &[("cols", 6), ("rows", 6)]).unwrap();
    assert_eq!(outline_turning(&t, &tall).round(), 1080.0);
    // Rows come in pairs along the staggered gluing.
    assert!(!glues(&t, &rect(4, 5, 1, 1)));
}

#[test]
fn a_staggered_torus_glues_its_corner_faces_in_a_group_of_their_own() {
    let brick = BrickTessellation;
    let sizes = |t: &BrickTessellation| -> Vec<usize> {
        t.build_preset_folds("torus", &[("cols", 4), ("rows", 4)])
            .unwrap()
            .iter()
            .map(Vec::len)
            .collect()
    };
    assert_eq!(sizes(&brick).len(), 3);
    assert!(sizes(&brick)[2] > 0);
    // A square net has no staggered edge.
    assert_eq!(
        SquareTessellation
            .build_preset_folds("torus", &[("cols", 4), ("rows", 4)])
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn an_octagon_square_gluing_has_octagons_on_one_side_and_squares_on_the_other() {
    let t = SquareOctagonTessellation;
    let squares = |cells: &[SquareOctagonPoint], x: i32| {
        cells.iter().filter(|c| c.is_square() && c.x == x).count()
    };
    // 3 x 3 octagons at x = -2, 0, 2: the seam squares sit at x = 3, beyond the last octagon.
    let torus = t
        .build_preset("torus", &[("cols", 3), ("rows", 3)])
        .unwrap();
    assert_eq!(squares(&torus, 3), 3);
    let plain = t.build_preset("rect", &[("cols", 3), ("rows", 3)]).unwrap();
    assert_eq!(squares(&plain, 3), 0);
    // A cylinder glues one direction only: the squares of the other side stay out.
    let cylinder = t
        .build_preset("cylinder", &[("cols", 3), ("rows", 3), ("axis", 1)])
        .unwrap();
    assert_eq!(squares(&cylinder, 3), 0);
    assert_eq!(cylinder.iter().filter(|c| c.is_square()).count(), 2 * 3);
}

/// One group is one pair of sides: its `a` ends all lie on the low side, its `b` ends on the high
/// side, and the `a` ends follow their side in order (also on a zigzag edge such as a hex grid's).
#[test]
fn a_group_holds_one_side_as_a_and_the_opposite_one_as_b() {
    fn midpoint<T: Tessellation>(t: &T, end: &FoldEnd<T::CellId>) -> Point {
        let face = t.faces_of(end.cell)[end.face_idx];
        t.face_segments(end.cell, face)[0].point(0.5)
    }
    fn check<T: Tessellation>(t: &T, name: &str, p: Params) {
        let groups = t.build_preset_folds(p.0, args(&p)).unwrap();
        for (index, group) in groups.iter().enumerate() {
            let along = |point: Point| {
                if index == 0 && p.0 != "cylinder" || p.0 == "cylinder" && p.1[2].1 == 0 {
                    point.x
                } else {
                    point.y
                }
            };
            let across = |point: Point| {
                if index == 0 && p.0 != "cylinder" || p.0 == "cylinder" && p.1[2].1 == 0 {
                    point.y
                } else {
                    point.x
                }
            };
            let mut previous = f64::NEG_INFINITY;
            for fold in group {
                let (a, b) = (midpoint(t, &fold.a), midpoint(t, &fold.b));
                assert!(along(a) < along(b), "{name} {p:?} group {index}");
                assert!(
                    across(a) >= previous - 1e-9,
                    "{name} {p:?} group {index} order"
                );
                previous = across(a);
            }
            let low = group
                .iter()
                .map(|f| along(midpoint(t, &f.a)))
                .fold(f64::NEG_INFINITY, f64::max);
            let high = group
                .iter()
                .map(|f| along(midpoint(t, &f.b)))
                .fold(f64::INFINITY, f64::min);
            assert!(low < high, "{name} {p:?} group {index} sides overlap");
        }
    }
    check(&HexTessellation, "hex", rect(6, 6, 2, 0));
    check(&HexTessellation, "hex", rect(6, 6, 1, 0));
    check(&HexTessellation, "hex", rect(6, 6, 1, 1));
    check(&SquareTessellation, "square", rect(5, 4, 2, 0));
    check(&TriTessellation, "tri", rect(4, 4, 2, 0));
}

/// Sum of the angles (degrees) the outline of `cells` turns by at its corners, whichever way.
fn outline_turning<T: Tessellation>(t: &T, cells: &[T::CellId]) -> f64 {
    let set: HashSet<T::CellId> = cells.iter().copied().collect();
    let key = |p: Point| ((p.x * 1000.0).round() as i64, (p.y * 1000.0).round() as i64);
    let mut edges: HashMap<(i64, i64), Vec<Point>> = HashMap::new();
    let mut at: HashMap<(i64, i64), Point> = HashMap::new();
    for &cell in cells {
        for &face in t.faces_of(cell) {
            if t.neighbor(cell, face)
                .is_some_and(|(next, _)| set.contains(&next))
            {
                continue;
            }
            for segment in t.face_segments(cell, face) {
                let (a, b) = (segment.point(0.0), segment.point(1.0));
                at.insert(key(a), a);
                at.insert(key(b), b);
                edges.entry(key(a)).or_default().push(b);
                edges.entry(key(b)).or_default().push(a);
            }
        }
    }
    edges
        .iter()
        .filter(|(_, next)| next.len() == 2)
        .map(|(vertex, next)| {
            let p = at[vertex];
            let [u, v] = [next[0] - p, next[1] - p];
            let angle = (u.dot(v) / (u.length() * v.length()))
                .clamp(-1.0, 1.0)
                .acos();
            (std::f64::consts::PI - angle).to_degrees()
        })
        .sum()
}

#[test]
fn a_period_rectangle_is_centered_on_the_origin_cell() {
    fn centered<T: Tessellation>(t: &T, origin: T::CellId) {
        let basis = t.translation_basis().unwrap();
        // The mean sits within a lattice cell of the origin.
        let reach = basis[0].length().max(basis[1].length());
        let c = t.center(origin);
        for size in 2..=4 {
            let Ok(cells) = t.build_preset("torus", &[("cols", size), ("rows", size)]) else {
                continue;
            };
            let mean = cells
                .iter()
                .fold(Point::default(), |s, &cell| s + t.center(cell))
                * (1.0 / cells.len() as f64);
            assert!(
                (mean - c).length() <= reach * 0.75,
                "size {size}: mean {mean:?} vs origin {c:?}"
            );
        }
    }
    centered(
        &RhombitrihexagonalTessellation,
        RhombitrihexagonalPoint::hexagon(0, 0),
    );
    centered(
        &TruncatedHexagonalTessellation,
        TruncatedHexagonalPoint::dodecagon(0, 0),
    );
    centered(
        &SnubHexagonalTessellation,
        SnubHexagonalPoint::hexagon(0, 0),
    );
    centered(
        &SnubSquareTessellation,
        SnubSquarePoint::new(0, 0, SnubSquareKind::Square),
    );
    centered(
        &TruncatedTrihexagonalTessellation,
        TruncatedTrihexagonalPoint::dodecagon(0, 0),
    );
}

#[test]
fn only_the_snub_square_gluing_is_turned_with_its_lattice() {
    fn frame<T: Tessellation>(t: &T) -> Point {
        super::rect_topology::frame_of(t).unwrap()
    }
    assert_eq!(frame(&SquareTessellation), Point::new(1.0, 0.0));
    assert_eq!(frame(&SnubHexagonalTessellation), Point::new(1.0, 0.0));
    assert_eq!(frame(&TruncatedHexagonalTessellation), Point::new(1.0, 0.0));
    let turned = frame(&SnubSquareTessellation);
    assert!((turned.y.atan2(turned.x).to_degrees() + 15.0).abs() < 1e-6);
}

#[test]
fn a_period_rectangle_keeps_its_shape_when_centered() {
    // Moving the cells by a lattice vector must not change how jagged the outline is.
    let t = RhombitrihexagonalTessellation;
    let cells = t
        .build_preset("torus", &[("cols", 3), ("rows", 3)])
        .unwrap();
    assert_eq!(cells.len(), 3 * 3 * 12);
    assert!(
        (outline_turning(&t, &cells)
            - outline_turning(
                &t,
                &t.translate_cells(&cells, t.translation_basis().unwrap()[0])
                    .unwrap()
            ))
        .abs()
            < 1e-6
    );
}
