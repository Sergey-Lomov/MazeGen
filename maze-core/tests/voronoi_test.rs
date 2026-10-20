use maze_core::space::voronoi::{DEFAULT_CELL_LIMIT, DEFAULT_JITTER, MAX_JITTER};
use maze_core::space::{
    CellScope, FieldOpError, FieldOps, Point, Tessellation, TessellationGeometry, VoronoiParams,
    VoronoiPoint, VoronoiTessellation,
};

fn build(jitter: f64, seed: u32) -> VoronoiTessellation {
    VoronoiTessellation::new(VoronoiParams {
        jitter,
        seed,
        max_cells: DEFAULT_CELL_LIMIT,
    })
    .unwrap()
}

fn all_cells(t: &VoronoiTessellation) -> Vec<VoronoiPoint> {
    let radius = t.radius();
    (-radius..=radius)
        .flat_map(|q| (-radius..=radius).map(move |r| VoronoiPoint { q, r }))
        .filter(|&cell| t.is_valid_cell(cell))
        .collect()
}

/// Vertices of the cell's boundary, counter-clockwise.
fn polygon(t: &VoronoiTessellation, cell: VoronoiPoint) -> Vec<Point> {
    t.faces_of(cell)
        .iter()
        .map(|&face| t.face_segments(cell, face)[0].start())
        .collect()
}

/// Seeds and jitters covering the supported range.
const CASES: [(f64, u32); 5] = [
    (0.0, 0),
    (DEFAULT_JITTER, 1),
    (0.3, 5),
    (0.35, 11),
    (MAX_JITTER, 7),
];

#[test]
fn zero_jitter_is_the_regular_hexagonal_grid() {
    let t = build(0.0, 42);
    for cell in all_cells(&t) {
        assert_eq!(t.faces_of(cell).len(), 6, "{cell:?}");
        assert!((t.area(cell) - 1.0).abs() < 1e-9, "{cell:?}");
        let vertices = polygon(&t, cell);
        let length = vertices[0].distance(vertices[1]);
        for (i, &v) in vertices.iter().enumerate() {
            assert!((v.distance(vertices[(i + 1) % 6]) - length).abs() < 1e-9);
            assert!((v.distance(t.center(cell)) - length).abs() < 1e-9);
        }
    }
}

#[test]
fn cells_are_convex_counter_clockwise_polygons() {
    for (jitter, seed) in CASES {
        let t = build(jitter, seed);
        for cell in all_cells(&t) {
            let v = polygon(&t, cell);
            assert!(v.len() >= 3, "{cell:?}");
            for i in 0..v.len() {
                let (a, b, c) = (v[i], v[(i + 1) % v.len()], v[(i + 2) % v.len()]);
                assert!(
                    (b - a).cross(c - b) > 0.0,
                    "{jitter} {seed} {cell:?} vertex {i} is not a left turn"
                );
            }
            assert!(t.area(cell) > 0.0);
        }
    }
}

/// The cells of a hexagonal disc tile a region without gaps or overlaps: their areas add up to the
/// area enclosed by the outer boundary faces, and every sampled point lies in exactly one cell.
#[test]
fn cells_cover_the_plane_without_gaps_or_overlaps() {
    for (jitter, seed) in CASES {
        let t = build(jitter, seed);
        let cells = all_cells(&t);
        let reach = f64::from(t.radius()) * t.spacing() * 0.5;
        for i in 0..120 {
            let point = Point::new(
                reach * ((i * 37 % 101) as f64 / 50.0 - 1.0) + 0.0123456789,
                reach * ((i * 53 % 103) as f64 / 51.0 - 1.0) + 0.0987654321,
            );
            let containing: Vec<_> = cells
                .iter()
                .copied()
                .filter(|&cell| {
                    let v = polygon(&t, cell);
                    (0..v.len()).all(|k| (v[(k + 1) % v.len()] - v[k]).cross(point - v[k]) >= 0.0)
                })
                .collect();
            assert_eq!(containing.len(), 1, "{jitter} {seed} {point:?}");
            assert_eq!(t.cell_at(point, CellScope::Space), Some(containing[0]));
        }
        let mut boundary_area = 0.0;
        for &cell in &cells {
            for &face in t.faces_of(cell) {
                if t.neighbor(cell, face).is_none() {
                    let segment = t.face_segments(cell, face)[0];
                    boundary_area += segment.start().cross(segment.end()) / 2.0;
                }
            }
        }
        let total: f64 = cells.iter().map(|&cell| t.area(cell)).sum();
        assert!(
            (boundary_area - total).abs() < 1e-6 * total,
            "{jitter} {seed}: {boundary_area} vs {total}"
        );
    }
}

#[test]
fn neighbors_are_reciprocal_and_share_their_edge() {
    for (jitter, seed) in CASES {
        let t = build(jitter, seed);
        for cell in all_cells(&t) {
            for &face in t.faces_of(cell) {
                let Some((other, back)) = t.neighbor(cell, face) else {
                    continue;
                };
                assert_eq!(t.neighbor(other, back), Some((cell, face)));
                let own = t.face_segments(cell, face)[0];
                let theirs = t.face_segments(other, back)[0];
                assert_eq!(own.start(), theirs.end());
                assert_eq!(own.end(), theirs.start());
            }
        }
    }
}

#[test]
fn cells_stay_compact_with_no_tiny_edges() {
    for (jitter, seed) in CASES {
        let t = build(jitter, seed);
        for cell in all_cells(&t) {
            let v = polygon(&t, cell);
            let center = t.center(cell);
            let far = v.iter().map(|p| p.distance(center)).fold(0.0, f64::max);
            let near = (0..v.len())
                .map(|i| {
                    let (a, b) = (v[i], v[(i + 1) % v.len()]);
                    (b - a).cross(center - a) / a.distance(b)
                })
                .fold(f64::INFINITY, f64::min);
            assert!(
                far / near < 1.2 + 5.0 * jitter,
                "{jitter} {seed} {cell:?}: {far} / {near}"
            );
            for i in 0..v.len() {
                let length = v[i].distance(v[(i + 1) % v.len()]);
                assert!(
                    length >= 0.19 * t.spacing(),
                    "{jitter} {seed} {cell:?}: {length}"
                );
            }
        }
    }
}

/// The clip reach is sufficient only while displaced sites stay near their lattice points.
#[test]
fn every_seed_builds_at_maximum_jitter() {
    for seed in 0..60 {
        let t = VoronoiTessellation::new(VoronoiParams {
            jitter: MAX_JITTER,
            seed,
            max_cells: 100,
        })
        .unwrap_or_else(|error| panic!("seed {seed}: {error}"));
        assert!(
            all_cells(&t)
                .iter()
                .all(|&cell| t.faces_of(cell).len() >= 3)
        );
    }
}

/// Every cell whose polygon reaches the box is a candidate, and a tight limit yields `None`.
#[test]
fn candidate_cells_cover_the_box_and_respect_the_limit() {
    let t = build(0.3, 5);
    let (min, max) = (Point::new(-3.0, -2.0), Point::new(4.0, 3.0));
    let candidates = t.candidate_cells(min, max, usize::MAX).unwrap();
    for cell in all_cells(&t) {
        let touches = polygon(&t, cell)
            .iter()
            .any(|p| p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y);
        assert!(!touches || candidates.contains(&cell), "{cell:?}");
    }
    assert!(t.candidate_cells(min, max, 3).is_none());
}

#[test]
fn sites_outside_the_table_follow_the_same_displacement_rule() {
    let t = build(0.3, 5);
    let far = t.radius() + 50;
    let lattice = Point::new(t.spacing() * (f64::from(far)), 0.0);
    assert!(t.site(far, 0).distance(lattice) <= 1.5 * t.spacing());
    assert_eq!(t.site(far, 0), t.site(far, 0));
}

#[test]
fn the_same_params_give_the_same_tessellation_and_the_seed_changes_it() {
    let (a, b, c) = (build(0.3, 5), build(0.3, 5), build(0.3, 6));
    let cell = VoronoiPoint { q: 2, r: -1 };
    assert_eq!(a.faces_of(cell), b.faces_of(cell));
    assert_eq!(polygon(&a, cell), polygon(&b, cell));
    assert_ne!(polygon(&a, cell), polygon(&c, cell));
}

#[test]
fn the_space_is_the_largest_disc_within_the_cell_limit() {
    for max_cells in [100, 1000, DEFAULT_CELL_LIMIT, 10_000] {
        let t = VoronoiTessellation::new(VoronoiParams {
            jitter: DEFAULT_JITTER,
            seed: 0,
            max_cells,
        })
        .unwrap();
        let count = all_cells(&t).len() as u32;
        let next = 3 * (t.radius() + 1) * (t.radius() + 2) + 1;
        assert!(
            count <= max_cells && next as u32 > max_cells,
            "{max_cells}: {count}"
        );
        let edge = VoronoiPoint {
            q: t.radius(),
            r: 0,
        };
        assert!(t.is_valid_cell(edge));
        assert!(!t.is_valid_cell(VoronoiPoint {
            q: t.radius() + 1,
            r: 0
        }));
        assert!(
            t.faces_of(edge)
                .iter()
                .any(|&face| t.neighbor(edge, face).is_none())
        );
    }
}

#[test]
fn cells_have_no_shape_templates() {
    let t = build(DEFAULT_JITTER, 0);
    assert!(t.shape_descriptors().is_empty());
    assert!(t.shape_of(VoronoiPoint { q: 0, r: 0 }).is_none());
}

#[test]
fn rejects_params_out_of_range() {
    let params = |jitter, max_cells| VoronoiParams {
        jitter,
        seed: 0,
        max_cells,
    };
    for (bad, needle) in [
        (params(-0.01, 3000), "jitter"),
        (params(0.41, 3000), "jitter"),
        (params(f64::NAN, 3000), "jitter"),
        (params(0.1, 99), "max_cells"),
        (params(0.1, 10_001), "max_cells"),
    ] {
        let error = VoronoiTessellation::new(bad).unwrap_err();
        assert!(error.contains(needle), "{error}");
    }
}

#[test]
fn offers_the_circle_preset_and_no_symmetries() {
    let t = build(DEFAULT_JITTER, 3);
    assert!(t.field_operations().is_empty());
    assert_eq!(
        t.translate_cells(&[VoronoiPoint { q: 0, r: 0 }], Point::new(1.0, 0.0)),
        Err(FieldOpError::Unavailable)
    );
    let cells = t.build_preset("circle", &[("radius", 3)]).unwrap();
    assert!(cells.contains(&VoronoiPoint { q: 0, r: 0 }));
    assert!(cells.len() > 7 && cells.len() < 80);
    let max = t.preset_param_max("circle", "radius").unwrap();
    assert!(t.build_preset("circle", &[("radius", max + 1)]).is_err());
}
