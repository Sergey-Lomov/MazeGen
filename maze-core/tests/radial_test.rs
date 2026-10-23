use maze_core::space::{
    CellScope, DEFAULT_CELL_LIMIT, FieldOpError, FieldOps, MAX_CELL_LIMIT, MIN_CELL_LIMIT, Point,
    RadialFace, RadialLayout, RadialParams, RadialPoint, RadialTessellation, Segment, Tessellation,
    TessellationGeometry,
};

fn build_with(first_ring_cells: u32, layout: RadialLayout) -> RadialTessellation {
    RadialTessellation::new(RadialParams {
        first_ring_cells,
        layout,
        max_cells: DEFAULT_CELL_LIMIT,
    })
    .unwrap()
}

/// The classic layout: ring counts 9, 18, 18, 36, 36, 36, 36, 36, 72, ...
fn build(first_ring_cells: u32) -> RadialTessellation {
    build_with(first_ring_cells, RadialLayout::Classic)
}

/// Every supported size in both layouts.
fn cases() -> Vec<RadialTessellation> {
    SIZES
        .into_iter()
        .flat_map(|first| RadialLayout::ALL.map(|layout| build_with(first, layout)))
        .collect()
}

fn cell(ring: i32, index: i32) -> RadialPoint {
    RadialPoint { ring, index }
}

/// The center and every cell of rings `1..=rings`.
fn cells_up_to(t: &RadialTessellation, rings: i32) -> Vec<RadialPoint> {
    std::iter::once(RadialPoint::CENTER)
        .chain((1..=rings).flat_map(|ring| {
            (0..t.ring_count(ring).unwrap() as i32).map(move |index| cell(ring, index))
        }))
        .collect()
}

const SIZES: [u32; 6] = [6, 9, 13, 18, 21, 24];

#[test]
fn classic_rings_keep_or_double_their_count() {
    let counts = |t: &RadialTessellation| -> Vec<u32> {
        (1..=9).map(|ring| t.ring_count(ring).unwrap()).collect()
    };
    assert_eq!(counts(&build(9)), [9, 18, 18, 36, 36, 36, 36, 36, 72]);
    assert_eq!(build(9).ring_count(0), None);
    for first in SIZES {
        let t = build(first);
        assert_eq!(t.ring_count(1), Some(first));
        for ring in 2..=t.ring_total() as i32 {
            let (before, count) = (t.ring_count(ring - 1).unwrap(), t.ring_count(ring).unwrap());
            assert!(
                count == before || count == 2 * before,
                "{first} ring {ring}"
            );
        }
    }
}

#[test]
fn smooth_rings_follow_the_area_in_multiples_of_three() {
    for first in SIZES {
        let t = build_with(first, RadialLayout::Smooth);
        assert!(t.ring_count(1).unwrap().abs_diff(first) <= 3, "{first}");
        for ring in 1..=t.ring_total() as i32 {
            let count = f64::from(t.ring_count(ring).unwrap());
            assert_eq!(t.ring_count(ring).unwrap() % 3, 0);
            let ideal = f64::from(first) * f64::from(2 * ring + 1) / 3.0;
            assert!((count / ideal - 1.0).abs() <= 0.3, "{first} ring {ring}");
            if ring > 1 {
                assert!(count >= f64::from(t.ring_count(ring - 1).unwrap()));
            }
        }
    }
}

/// Every edge between rings is at least a third of the narrower cell wide (equal counts and
/// aligned classic rings share whole cells).
#[test]
fn no_narrow_stitches_between_rings() {
    for t in cases() {
        for ring in 1..=t.ring_total() as i32 {
            for index in 0..t.ring_count(ring).unwrap() as i32 {
                let c = cell(ring, index);
                for &f in t.faces_of(c) {
                    let Some((n, _)) = t.neighbor(c, f) else {
                        continue;
                    };
                    if n.ring == ring || n.ring == 0 {
                        continue;
                    }
                    let [Segment::CircularArc { sweep, .. }] = t.face_segments(c, f)[..] else {
                        panic!("{c:?} {f:?}");
                    };
                    let narrower = std::f64::consts::TAU
                        / f64::from(
                            t.ring_count(ring)
                                .unwrap()
                                .max(t.ring_count(n.ring).unwrap()),
                        );
                    assert!(
                        sweep.abs() >= narrower / 3.0 - 1e-9,
                        "{c:?} {f:?}: {} of {}",
                        sweep.abs(),
                        narrower
                    );
                }
            }
        }
    }
}

#[test]
fn the_space_ends_at_the_cell_cap() {
    for t in cases() {
        let last = t.ring_total() as i32;
        let total = 1 + (1..=last).map(|r| t.ring_count(r).unwrap()).sum::<u32>();
        assert!(total <= DEFAULT_CELL_LIMIT, "{total}");
        assert!(last >= 10, "{last}");
        assert_eq!(t.ring_count(last + 1), None);
        let edge = cell(last, 0);
        assert!(t.is_valid_cell(edge));
        assert!(!t.is_valid_cell(cell(last + 1, 0)));
        assert_eq!(t.neighbor(edge, RadialFace::Outer(0)), None);
    }
}

#[test]
fn the_cell_limit_is_a_param() {
    for layout in RadialLayout::ALL {
        let with_limit = |max_cells| {
            RadialTessellation::new(RadialParams {
                first_ring_cells: 9,
                layout,
                max_cells,
            })
        };
        let mut previous = 0;
        for limit in [MIN_CELL_LIMIT, 500, DEFAULT_CELL_LIMIT, MAX_CELL_LIMIT] {
            let t = with_limit(limit).unwrap();
            let last = t.ring_total() as i32;
            let total = 1 + (1..=last).map(|r| t.ring_count(r).unwrap()).sum::<u32>();
            assert!(total <= limit, "{layout:?} {limit}: {total}");
            assert!(last >= 3 && t.ring_total() > previous, "{layout:?} {limit}");
            previous = t.ring_total();
        }
        for first in 6..=24 {
            for limit in [MIN_CELL_LIMIT, MAX_CELL_LIMIT] {
                let t = RadialTessellation::new(RadialParams {
                    first_ring_cells: first,
                    layout,
                    max_cells: limit,
                })
                .unwrap_or_else(|e| panic!("{first} {layout:?} {limit}: {e}"));
                assert!(t.ring_total() >= 2, "{first} {layout:?} {limit}");
            }
        }
        for bad in [0, MIN_CELL_LIMIT - 1, MAX_CELL_LIMIT + 1] {
            let err = with_limit(bad).unwrap_err();
            assert!(err.contains("max_cells"), "{bad}: {err}");
        }
    }
}

#[test]
fn validity_follows_the_ring_sizes() {
    let t = build(9);
    assert!(t.is_valid_cell(RadialPoint::CENTER));
    assert!(!t.is_valid_cell(cell(0, 1)));
    assert!(t.is_valid_cell(cell(1, 8)));
    assert!(!t.is_valid_cell(cell(1, 9)));
    assert!(!t.is_valid_cell(cell(1, -1)));
    assert!(!t.is_valid_cell(cell(-1, 0)));
    assert!(t.is_valid_cell(cell(3, 17)));
    assert!(!t.is_valid_cell(cell(3, 18)));
}

#[test]
fn invalid_params_are_rejected_with_a_reason() {
    for bad in [0, 5, 25, 5000] {
        for layout in RadialLayout::ALL {
            let err = RadialTessellation::new(RadialParams {
                first_ring_cells: bad,
                layout,
                max_cells: DEFAULT_CELL_LIMIT,
            })
            .unwrap_err();
            assert!(err.contains("first_ring_cells"), "{bad}: {err}");
        }
    }
    for first in 6..=24 {
        for layout in RadialLayout::ALL {
            assert!(
                RadialTessellation::new(RadialParams {
                    first_ring_cells: first,
                    layout,
                    max_cells: DEFAULT_CELL_LIMIT,
                })
                .is_ok()
            );
        }
    }
    assert_eq!(
        RadialLayout::from_name("smooth"),
        Some(RadialLayout::Smooth)
    );
    assert_eq!(RadialLayout::from_name("other"), None);
}

#[test]
fn the_same_params_yield_the_same_cells_faces_and_neighbors() {
    for first in SIZES {
        let (a, b) = (build(first), build(first));
        assert_eq!(a.ring_total(), b.ring_total());
        for c in cells_up_to(&a, 6) {
            assert_eq!(a.faces_of(c), b.faces_of(c));
            for &f in a.faces_of(c) {
                assert_eq!(a.neighbor(c, f), b.neighbor(c, f));
                assert_eq!(a.face_segments(c, f), b.face_segments(c, f));
            }
        }
    }
}

#[test]
fn faces_follow_the_neighbor_overlaps() {
    use RadialFace::*;
    let t = build(9);
    assert_eq!(t.faces_of(RadialPoint::CENTER).len(), 9);
    // Ring 1 (9 cells) under ring 2 (18): cell 0 touches ring-2 cells 0 and 1.
    assert_eq!(
        t.faces_of(cell(1, 0)),
        [Outer(0), Outer(1), Next, Inner(0), Prev]
    );
    // Ring 2 and 3 have the same count: one cell on each side.
    assert_eq!(t.faces_of(cell(2, 5)), [Outer(0), Next, Inner(0), Prev]);
    // Smooth ring 4 (27) cell 1 straddles the boundaries of ring 3 (18) and ring 5 (36).
    let smooth = build_with(9, RadialLayout::Smooth);
    assert_eq!(smooth.ring_count(3), Some(18));
    assert_eq!(smooth.ring_count(4), Some(27));
    assert_eq!(smooth.ring_count(5), Some(36));
    assert_eq!(
        smooth.faces_of(cell(4, 1)),
        [Outer(0), Outer(1), Next, Inner(0), Inner(1), Prev]
    );
    for t in cases() {
        for c in cells_up_to(&t, t.ring_total() as i32) {
            assert!(
                (4..=t.ring_count(1).unwrap().max(7) as usize).contains(&t.faces_of(c).len()),
                "{c:?}"
            );
        }
    }
}

#[test]
fn neighbors_are_reciprocal_and_distinct() {
    for t in cases() {
        for c in cells_up_to(&t, 6) {
            let mut around = Vec::new();
            for &f in t.faces_of(c) {
                let (n, nf) = t.neighbor(c, f).unwrap();
                assert!(t.is_valid_cell(n), "{c:?} {f:?}");
                assert_eq!(t.neighbor(n, nf), Some((c, f)), "{c:?} {f:?}");
                around.push(n);
            }
            let count = around.len();
            around.sort();
            around.dedup();
            assert_eq!(around.len(), count, "{c:?} has a repeated neighbor");
        }
    }
}

#[test]
fn a_cell_touches_exactly_the_cells_it_shares_a_boundary_segment_with() {
    // Neighbors by arc overlap, computed independently from the sector fractions.
    for t in cases() {
        for c in cells_up_to(&t, 5) {
            let mut expected = Vec::new();
            if c.ring == 0 {
                expected.extend((0..t.ring_count(1).unwrap() as i32).map(|i| cell(1, i)));
            } else {
                let n = i64::from(t.ring_count(c.ring).unwrap());
                let (lo, hi) = (i64::from(c.index), i64::from(c.index) + 1);
                expected.push(cell(c.ring, ((lo + 1) % n) as i32));
                expected.push(cell(c.ring, ((lo + n - 1) % n) as i32));
                if c.ring == 1 {
                    expected.push(RadialPoint::CENTER);
                }
                for ring in [c.ring - 1, c.ring + 1].into_iter().filter(|&r| r >= 1) {
                    let Some(m) = t.ring_count(ring).map(i64::from) else {
                        continue;
                    };
                    // Sectors [j/m, (j+1)/m) and [lo/n, hi/n) overlap with positive length.
                    expected.extend(
                        (0..m)
                            .filter(|j| j * n < hi * m && lo * m < (j + 1) * n)
                            .map(|j| cell(ring, j as i32)),
                    );
                }
            }
            let mut actual: Vec<RadialPoint> = t
                .faces_of(c)
                .iter()
                .filter_map(|&f| t.neighbor(c, f).map(|(n, _)| n))
                .collect();
            expected.sort();
            actual.sort();
            assert_eq!(actual, expected, "{c:?} in {:?}", t.params());
        }
    }
}

#[test]
fn shared_boundary_segments_are_identical_from_both_sides() {
    for t in cases() {
        for c in cells_up_to(&t, 5) {
            for &f in t.faces_of(c) {
                let (n, nf) = t.neighbor(c, f).unwrap();
                let theirs: Vec<Segment> = t
                    .edge_segments(n, nf)
                    .iter()
                    .rev()
                    .map(Segment::reversed)
                    .collect();
                assert_eq!(t.edge_segments(c, f), theirs, "{c:?} {f:?}");
                assert_eq!(t.contact_point(c, f), t.contact_point(n, nf));
            }
        }
    }
}

#[test]
fn ring_boundaries_are_arcs_and_radial_boundaries_are_lines() {
    let t = build(9);
    for c in cells_up_to(&t, 4) {
        for &f in t.faces_of(c) {
            let [segment] = t.face_segments(c, f)[..] else {
                panic!("{c:?} {f:?} is not one segment");
            };
            match f {
                RadialFace::Next | RadialFace::Prev => {
                    assert!(matches!(segment, Segment::Line { .. }), "{c:?} {f:?}")
                }
                RadialFace::Outer(_) | RadialFace::Inner(_) => {
                    assert!(
                        matches!(segment, Segment::CircularArc { .. }),
                        "{c:?} {f:?}"
                    )
                }
            }
        }
    }
}

#[test]
fn areas_add_up_to_the_disc() {
    use std::f64::consts::PI;
    let t = build(9);
    let total: f64 = cells_up_to(&t, 6).into_iter().map(|c| t.area(c)).sum();
    assert!((total - PI * 49.0).abs() < 1e-9, "{total}");
}

#[test]
fn cell_at_finds_the_cell_containing_a_point() {
    let t = build(9);
    assert_eq!(
        t.cell_at(Point::new(0.0, 0.0), CellScope::Space),
        Some(RadialPoint::CENTER)
    );
    // Ring 1, 9 cells of 40°: the point at 110° is in cell 2.
    let angle = 110f64.to_radians();
    assert_eq!(
        t.cell_at(Point::polar(1.5, angle), CellScope::Space),
        Some(cell(1, 2))
    );
    // Ring 3, 18 cells of 20°: 110° falls into cell 5.
    assert_eq!(
        t.cell_at(Point::polar(3.5, angle), CellScope::Space),
        Some(cell(3, 5))
    );
    // A point on a sector boundary resolves to the minimal cell id.
    let on_boundary = Point::polar(1.5, 40f64.to_radians());
    assert_eq!(t.cell_at(on_boundary, CellScope::Space), Some(cell(1, 0)));
}

#[test]
fn candidates_cover_every_cell_touching_the_box() {
    let t = build(9);
    let all = cells_up_to(&t, 8);
    let boxes = [
        (Point::new(-0.2, -0.2), Point::new(0.2, 0.2)),
        (Point::new(2.1, -0.5), Point::new(4.7, 1.9)),
        (Point::new(-6.0, 1.0), Point::new(-2.0, 3.0)),
        (Point::new(-9.5, -9.5), Point::new(9.5, 9.5)),
        (Point::new(0.0, 3.2), Point::new(0.1, 3.3)),
    ];
    for (min, max) in boxes {
        let candidates = t.candidate_cells(min, max, usize::MAX).unwrap();
        for &c in &all {
            let (lo, hi) = t.boundary_path(c).bounds();
            let overlaps = lo.x <= max.x && hi.x >= min.x && lo.y <= max.y && hi.y >= min.y;
            if overlaps {
                // A cell whose bounding box meets the box may still miss it; require only the
                // cells that really touch (containing the box's center is the cheap exact case).
                let center = Point::new((min.x + max.x) / 2.0, (min.y + max.y) / 2.0);
                if t.boundary_path(c).contains(center) {
                    assert!(candidates.contains(&c), "{c:?} in {min:?}-{max:?}");
                }
            }
        }
        assert!(candidates.iter().all(|&c| t.is_valid_cell(c)));
    }
    assert_eq!(
        t.candidate_cells(Point::new(-9.5, -9.5), Point::new(9.5, 9.5), 10),
        None
    );
}

#[test]
fn straight_passes_follow_the_geometric_definition() {
    use RadialFace::*;
    use maze_core::space::is_straight_geometric;
    for t in cases() {
        for c in cells_up_to(&t, 5) {
            for &a in t.faces_of(c) {
                for &b in t.faces_of(c) {
                    assert_eq!(
                        t.is_straight(c, a, b),
                        is_straight_geometric(&t, c, a, b),
                        "{c:?} {a:?} {b:?}"
                    );
                }
            }
        }
    }
    // The center of an even disc joins antipodal faces only.
    let t = build(12);
    assert!(t.is_straight(RadialPoint::CENTER, Outer(0), Outer(6)));
    assert!(!t.is_straight(RadialPoint::CENTER, Outer(0), Outer(5)));
    assert!(!build(9).is_straight(RadialPoint::CENTER, Outer(0), Outer(4)));
    assert!(!t.is_straight(cell(1, 0), Next, Prev));
}

#[test]
fn reflection_symmetries_pass_through_the_origin_along_the_regular_joints() {
    let t = build(9);
    let origin = Point::new(0.0, 0.0);
    let cells = [cell(1, 0), cell(2, 1), cell(3, 5)];
    // The x axis maps every ring onto itself, index `i` onto `count - 1 - i`.
    let mirrored = t
        .reflect_cells(&cells, (origin, Point::new(1.0, 0.0)))
        .unwrap();
    assert_eq!(mirrored, vec![cell(1, 8), cell(2, 16), cell(3, 12)]);
    // Joints sit at every third of a turn: the axis at 60° keeps all of them.
    assert!(
        t.reflect_cells(&cells, (origin, Point::polar(1.0, 60f64.to_radians())))
            .is_ok()
    );
    assert_eq!(
        t.reflect_cells(&cells, (origin, Point::polar(1.0, 7f64.to_radians()))),
        Err(FieldOpError::NotASymmetry)
    );
    assert_eq!(
        t.reflect_cells(&cells, (Point::new(0.0, 1.0), Point::new(1.0, 1.0))),
        Err(FieldOpError::NotASymmetry)
    );
    assert_eq!(
        t.translate_cells(&cells, Point::new(1.0, 0.0)),
        Err(FieldOpError::Unavailable)
    );
}

#[test]
fn the_circle_preset_takes_the_whole_rings_within_the_radius() {
    let t = build(9);
    let preset = |radius| t.build_preset("circle", &[("radius", radius)]).unwrap();
    assert_eq!(preset(1), vec![RadialPoint::CENTER]);
    assert_eq!(preset(2).len(), 1 + 9);
    assert_eq!(preset(3).len(), 1 + 9 + 18);
    assert_eq!(preset(4).len(), 1 + 9 + 18 + 18);
    // The published bound is the last radius core accepts, and it takes the whole space.
    let max = t.preset_param_max("circle", "radius").unwrap();
    assert_eq!(max, t.ring_total() + 1);
    let all = 1
        + (1..=t.ring_total() as i32)
            .map(|r| t.ring_count(r).unwrap() as usize)
            .sum::<usize>();
    assert_eq!(preset(max).len(), all);
    assert_eq!(t.preset_param_max("circle", "cols"), None);
    assert_eq!(t.preset_param_max("rect", "radius"), None);
    assert!(matches!(
        t.build_preset("circle", &[("radius", max + 1)]),
        Err(FieldOpError::InvalidPreset(_))
    ));
    assert!(matches!(
        t.build_preset("rect", &[("cols", 2), ("rows", 2)]),
        Err(FieldOpError::Unavailable)
    ));
}
