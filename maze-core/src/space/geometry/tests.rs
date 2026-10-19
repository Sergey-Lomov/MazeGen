use super::segment::segments_cross;
use super::*;
use crate::space::test_support::{ScaledSquareTessellation, radial_cases};
use crate::space::{
    BrickPoint, BrickTessellation, CairoPoint, CairoTessellation, CurvedQuadrilateralPoint,
    CurvedQuadrilateralTessellation, HexPoint, HexTessellation, RhombitrihexagonalKind,
    RhombitrihexagonalPoint, RhombitrihexagonalTessellation, SnubHexagonalKind, SnubHexagonalPoint,
    SnubHexagonalTessellation, SquareOctagonPoint, SquareOctagonTessellation, SquarePoint,
    SquareTessellation, TriPoint, TriTessellation, TrihexagonalPoint, TrihexagonalTessellation,
    TruncatedHexagonalKind, TruncatedHexagonalPoint, TruncatedHexagonalTessellation,
};
use std::f64::consts::{FRAC_PI_2, PI};

fn square_cells() -> Vec<SquarePoint> {
    grid(3).map(|(x, y)| SquarePoint { x, y }).collect()
}

fn hex_cells() -> Vec<HexPoint> {
    grid(3).map(|(q, r)| HexPoint { q, r }).collect()
}

fn tri_cells() -> Vec<TriPoint> {
    grid(3).map(|(col, row)| TriPoint { col, row }).collect()
}

fn cairo_cells() -> Vec<CairoPoint> {
    grid(9)
        .map(|(x, y)| CairoPoint::new(x, y))
        .filter(|&cell| CairoTessellation::is_valid_cell(cell))
        .collect()
}

fn square_octagon_cells() -> Vec<SquareOctagonPoint> {
    grid(6)
        .map(|(x, y)| SquareOctagonPoint { x, y })
        .filter(|&p| SquareOctagonTessellation.is_valid_cell(p))
        .collect()
}

fn brick_cells() -> Vec<BrickPoint> {
    grid(6).map(|(x, y)| BrickPoint { x, y }).collect()
}

fn trihexagonal_cells() -> Vec<TrihexagonalPoint> {
    grid(3)
        .flat_map(|(q, r)| {
            [
                TrihexagonalPoint::hexagon(q, r),
                TrihexagonalPoint::up(q, r),
                TrihexagonalPoint::down(q, r),
            ]
        })
        .collect()
}

fn snub_hexagonal_cells() -> Vec<SnubHexagonalPoint> {
    grid(2)
        .flat_map(|(q, r)| {
            SnubHexagonalKind::ALL
                .into_iter()
                .map(move |kind| SnubHexagonalPoint::new(q, r, kind))
        })
        .collect()
}

fn rhombitrihexagonal_cells() -> Vec<RhombitrihexagonalPoint> {
    grid(2)
        .flat_map(|(q, r)| {
            RhombitrihexagonalKind::ALL
                .into_iter()
                .map(move |kind| RhombitrihexagonalPoint::new(q, r, kind))
        })
        .collect()
}

fn truncated_hexagonal_cells() -> Vec<TruncatedHexagonalPoint> {
    grid(2)
        .flat_map(|(q, r)| {
            TruncatedHexagonalKind::ALL
                .into_iter()
                .map(move |kind| TruncatedHexagonalPoint::new(q, r, kind))
        })
        .collect()
}

fn curved_quadrilateral_cells() -> Vec<CurvedQuadrilateralPoint> {
    grid(3)
        .map(|(x, y)| CurvedQuadrilateralPoint { x, y })
        .collect()
}

fn grid(radius: i32) -> impl Iterator<Item = (i32, i32)> {
    (-radius..=radius).flat_map(move |x| (-radius..=radius).map(move |y| (x, y)))
}

/// Runs `check` on every built-in tessellation over a patch of cells around the origin.
macro_rules! for_each_tessellation {
    ($check:ident) => {
        $check(&SquareTessellation, &square_cells());
        $check(&HexTessellation, &hex_cells());
        $check(&TriTessellation, &tri_cells());
        $check(&CairoTessellation, &cairo_cells());
        $check(&SquareOctagonTessellation, &square_octagon_cells());
        $check(&BrickTessellation, &brick_cells());
        $check(&TrihexagonalTessellation, &trihexagonal_cells());
        $check(&SnubHexagonalTessellation, &snub_hexagonal_cells());
        $check(&RhombitrihexagonalTessellation, &rhombitrihexagonal_cells());
        $check(
            &TruncatedHexagonalTessellation,
            &truncated_hexagonal_cells(),
        );
        $check(
            &CurvedQuadrilateralTessellation,
            &curved_quadrilateral_cells(),
        );
        $check(&ScaledSquareTessellation { scale: 2.5 }, &square_cells());
        for (tessellation, cells) in radial_cases() {
            $check(&tessellation, &cells);
        }
    };
}

fn assert_paired_faces_identical<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
    for &cell in cells {
        for &face in tessellation.faces_of(cell) {
            let (other, other_face) = tessellation.neighbor(cell, face).unwrap();
            let mine = tessellation.edge_segments(cell, face);
            let theirs: Vec<Segment> = tessellation
                .edge_segments(other, other_face)
                .iter()
                .rev()
                .map(Segment::reversed)
                .collect();
            assert_eq!(mine, theirs, "{cell:?} {face:?}");
            let flatten = |chain: &[Segment]| -> Vec<Point> {
                chain.iter().flat_map(|s| s.flatten(1e-3)).collect()
            };
            let mut their_polyline = flatten(&tessellation.edge_segments(other, other_face));
            their_polyline.reverse();
            assert_eq!(flatten(&mine), their_polyline, "{cell:?} {face:?}");
            assert_eq!(
                tessellation.contact_point(cell, face),
                tessellation.contact_point(other, other_face),
                "{cell:?} {face:?}"
            );
        }
    }
}

#[test]
fn paired_faces_are_identical_segments_and_polylines() {
    for_each_tessellation!(assert_paired_faces_identical);
}

fn assert_boundary_invariants<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
    for &cell in cells {
        let path = tessellation.boundary_path(cell);
        let faces = tessellation.faces_of(cell);
        assert_eq!(path.faces().len(), faces.len(), "{cell:?}");
        for (chain, &face) in path.faces().iter().zip(faces) {
            assert_eq!(*chain, tessellation.edge_segments(cell, face), "{cell:?}");
        }
        let segments: Vec<Segment> = path.segments().copied().collect();
        for (i, segment) in segments.iter().enumerate() {
            let next = segments[(i + 1) % segments.len()];
            assert_eq!(segment.end(), next.start(), "exact joint, {cell:?}");
        }
        for i in 0..segments.len() {
            for j in (i + 1)..segments.len() {
                let (a, b) = (segments[i], segments[j]);
                assert!(
                    !segments_cross(a.start(), a.end(), b.start(), b.end()),
                    "self-intersection, {cell:?}"
                );
            }
        }
        let area = path.signed_area();
        assert!(area > 0.0, "counter-clockwise, {cell:?}");
        assert!(
            (tessellation.area(cell) - area).abs() < 1e-9,
            "area matches boundary, {cell:?}"
        );
        assert!(path.contains(tessellation.center(cell)), "{cell:?}");
    }
}

#[test]
fn boundary_path_is_closed_exact_simple_and_counter_clockwise() {
    for_each_tessellation!(assert_boundary_invariants);
}

#[test]
fn built_in_cells_have_area_one_and_center_at_the_centroid() {
    fn check<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
        for &cell in cells {
            let polygon = tessellation.boundary_path(cell).flatten(GEOM_EPS);
            let n = polygon.len();
            let (mut cx, mut cy, mut doubled) = (0.0, 0.0, 0.0);
            for k in 0..n {
                let (a, b) = (polygon[k], polygon[(k + 1) % n]);
                doubled += a.cross(b);
                cx += (a.x + b.x) * a.cross(b);
                cy += (a.y + b.y) * a.cross(b);
            }
            let centroid = Point::new(cx / (3.0 * doubled), cy / (3.0 * doubled));
            assert!((doubled / 2.0 - 1.0).abs() < 1e-9, "{cell:?}");
            assert!((tessellation.cell_scale(cell) - 1.0).abs() < 1e-12);
            assert!(
                tessellation.center(cell).distance(centroid) < 1e-9,
                "{cell:?}"
            );
        }
    }
    check(&SquareTessellation, &square_cells());
    check(&HexTessellation, &hex_cells());
    check(&TriTessellation, &tri_cells());
    check(&CairoTessellation, &cairo_cells());
}

fn assert_straight_table_is_geometric<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
    for &cell in cells {
        for &in_face in tessellation.faces_of(cell) {
            for &out_face in tessellation.faces_of(cell) {
                assert_eq!(
                    tessellation.is_straight(cell, in_face, out_face),
                    is_straight_geometric(tessellation, cell, in_face, out_face),
                    "{cell:?} {in_face:?} -> {out_face:?}"
                );
            }
        }
    }
}

#[test]
fn is_straight_tables_equal_the_geometric_definition() {
    for_each_tessellation!(assert_straight_table_is_geometric);
}

#[test]
fn triangle_has_no_straight_pass() {
    for cell in tri_cells() {
        for &a in TriTessellation.faces_of(cell) {
            for &b in TriTessellation.faces_of(cell) {
                assert!(!TriTessellation.is_straight(cell, a, b));
            }
        }
    }
}

fn line() -> Segment {
    Segment::line(Point::new(1.0, 1.0), Point::new(4.0, 5.0))
}

fn arc() -> Segment {
    Segment::arc(Point::new(1.0, -2.0), 3.0, 0.25, 2.0)
}

fn clockwise_arc() -> Segment {
    Segment::arc(Point::new(0.0, 0.0), 2.0, PI, -FRAC_PI_2)
}

#[test]
fn segment_point_length_and_tangent() {
    let l = line();
    assert_eq!(l.length(), 5.0);
    assert_eq!(l.point(0.5), Point::new(2.5, 3.0));
    assert!(l.tangent(0.3).distance(Point::new(0.6, 0.8)) < 1e-12);

    let a = arc();
    assert!((a.length() - 6.0).abs() < 1e-12);
    let mid = a.point(0.5);
    assert!((mid.distance(Point::new(1.0, -2.0)) - 3.0).abs() < 1e-12);
    // Counter-clockwise tangent is the radius turned by +90°.
    let radial = (mid - Point::new(1.0, -2.0)).normalized();
    assert!(a.tangent(0.5).distance(Point::new(-radial.y, radial.x)) < 1e-12);

    let c = clockwise_arc();
    assert!(c.point(1.0).distance(Point::new(0.0, 2.0)) < 1e-12);
    assert!(c.tangent(0.0).distance(Point::new(0.0, 1.0)) < 1e-12);
}

#[test]
fn segment_endpoints_are_exact() {
    for segment in [line(), arc(), clockwise_arc()] {
        assert_eq!(segment.point(0.0), segment.start());
        assert_eq!(segment.point(1.0), segment.end());
        let flat = segment.flatten(1e-4);
        assert_eq!(flat[0], segment.start());
        assert_eq!(*flat.last().unwrap(), segment.end());
    }
}

#[test]
fn segment_reversed_traverses_backwards() {
    for segment in [line(), arc(), clockwise_arc()] {
        let reversed = segment.reversed();
        assert_eq!(reversed.start(), segment.end());
        assert_eq!(reversed.end(), segment.start());
        for t in [0.1, 0.4, 0.75] {
            assert!(reversed.point(t).distance(segment.point(1.0 - t)) < 1e-12);
        }
        assert!((reversed.length() - segment.length()).abs() < 1e-12);
    }
}

#[test]
fn segment_split_halves_share_the_split_point() {
    for segment in [line(), arc(), clockwise_arc()] {
        let (first, second) = segment.split(0.3);
        assert_eq!(first.end(), second.start());
        assert_eq!(first.start(), segment.start());
        assert_eq!(second.end(), segment.end());
        assert!((first.length() - 0.3 * segment.length()).abs() < 1e-12);
        assert!(first.point(0.5).distance(segment.point(0.15)) < 1e-12);
    }
}

#[test]
fn line_flattens_to_its_endpoints() {
    assert_eq!(line().flatten(1e-9), vec![line().start(), line().end()]);
}

#[test]
fn arc_flatten_stays_within_tolerance() {
    for tolerance in [1e-1, 1e-3, 1e-6] {
        for segment in [arc(), clockwise_arc()] {
            let Segment::CircularArc { center, radius, .. } = segment else {
                unreachable!()
            };
            let flat = segment.flatten(tolerance);
            assert_eq!(flat, segment.flatten(tolerance), "deterministic");
            for pair in flat.windows(2) {
                // The farthest point of the true arc from a chord is its sagitta at the middle.
                let mid = (pair[0] + pair[1]) * 0.5;
                let deviation = radius - mid.distance(center);
                assert!(deviation <= tolerance + 1e-12, "{deviation} > {tolerance}");
            }
        }
    }
}

#[test]
fn arc_flatten_floors_the_tolerance_at_geom_eps() {
    for segment in [arc(), clockwise_arc()] {
        assert_eq!(segment.flatten(1e-300), segment.flatten(GEOM_EPS));
    }
}

#[test]
fn path_commands_describe_each_segment() {
    assert_eq!(line().path_command(), PathCommand::LineTo(line().end()));
    assert_eq!(
        clockwise_arc().path_command(),
        PathCommand::ArcTo {
            center: Point::new(0.0, 0.0),
            radius: 2.0,
            start_angle: PI,
            end_angle: FRAC_PI_2,
            ccw: false,
        }
    );
    let commands = SquareTessellation
        .boundary_path(SquarePoint { x: 0, y: 0 })
        .path_commands();
    assert_eq!(
        commands,
        vec![
            PathCommand::MoveTo(Point::new(1.0, 0.0)),
            PathCommand::LineTo(Point::new(1.0, 1.0)),
            PathCommand::LineTo(Point::new(0.0, 1.0)),
            PathCommand::LineTo(Point::new(0.0, 0.0)),
            PathCommand::LineTo(Point::new(1.0, 0.0)),
        ]
    );
}

#[test]
fn arc_boundary_area_and_containment() {
    // A half disk: diameter from (-1, 0) to (1, 0), arc over the top.
    let path = BoundaryPath::new(vec![
        vec![Segment::arc(Point::new(0.0, 0.0), 1.0, 0.0, PI)],
        vec![Segment::line(Point::new(-1.0, 0.0), Point::new(1.0, 0.0))],
    ]);
    assert!((path.signed_area() - PI / 2.0).abs() < 1e-12);
    assert!(path.contains(Point::new(0.0, 0.5)));
    assert!(path.contains(Point::new(0.0, 1.0)), "on the arc");
    assert!(!path.contains(Point::new(0.0, -0.1)));
    assert!(!path.contains(Point::new(0.9, 0.9)));
}

#[test]
fn cell_at_breaks_ties_on_shared_boundaries_by_minimal_cell_id() {
    // (1, 1) is a vertex of the four squares (0,0), (1,0), (0,1), (1,1).
    let vertex = Point::new(1.0, 1.0);
    assert_eq!(
        SquareTessellation.cell_at(vertex, CellScope::Space),
        Some(SquarePoint { x: 0, y: 0 })
    );
    let without_origin = [
        SquarePoint { x: 0, y: 1 },
        SquarePoint { x: 1, y: 0 },
        SquarePoint { x: 1, y: 1 },
    ];
    assert_eq!(
        SquareTessellation.cell_at(vertex, CellScope::Cells(&without_origin)),
        Some(SquarePoint { x: 0, y: 1 })
    );
    assert_eq!(
        SquareTessellation.cell_at(vertex, CellScope::Cells(&[])),
        None
    );
}

#[test]
fn cell_at_finds_the_cell_containing_its_own_center() {
    fn check<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
        for &cell in cells {
            assert_eq!(
                tessellation.cell_at(tessellation.center(cell), CellScope::Space),
                Some(cell)
            );
            // Every vertex resolves to the minimal cell among those touching it.
            for segment in tessellation.boundary_path(cell).segments() {
                let at = tessellation
                    .cell_at(segment.start(), CellScope::Space)
                    .unwrap();
                assert!(at <= cell, "{cell:?}");
                assert_eq!(
                    tessellation.cell_at(segment.start(), CellScope::Space),
                    Some(at),
                    "deterministic"
                );
            }
        }
    }
    for_each_tessellation!(check);
}

#[test]
fn cells_in_region_modes() {
    // Region [0.5, 2] × [0.5, 2] over unit squares.
    let region = [
        Point::new(0.5, 0.5),
        Point::new(2.0, 0.5),
        Point::new(2.0, 2.0),
        Point::new(0.5, 2.0),
    ];
    let cells = |mode| {
        SquareTessellation
            .cells_in_region(&region, mode, CellScope::Space)
            .unwrap()
    };
    let p = |x, y| SquarePoint { x, y };
    assert_eq!(
        cells(RegionMode::Intersects),
        vec![
            p(0, 0),
            p(0, 1),
            p(0, 2),
            p(1, 0),
            p(1, 1),
            p(1, 2),
            p(2, 0),
            p(2, 1),
            p(2, 2)
        ]
    );
    assert_eq!(cells(RegionMode::Contained), vec![p(1, 1)]);
    assert_eq!(
        cells(RegionMode::CenterInside),
        vec![p(0, 0), p(0, 1), p(1, 0), p(1, 1)]
    );
    let only_row_one = [p(0, 1), p(1, 1), p(2, 1), p(7, 1)];
    assert_eq!(
        SquareTessellation
            .cells_in_region(
                &region,
                RegionMode::CenterInside,
                CellScope::Cells(&only_row_one)
            )
            .unwrap(),
        vec![p(0, 1), p(1, 1)]
    );
}

#[test]
fn contained_rejects_a_concave_region_notch_inside_the_cell() {
    // Square region [0, 3]² with a notch reaching into cell (1, 1)'s interior from the top.
    let region = [
        Point::new(0.0, 0.0),
        Point::new(3.0, 0.0),
        Point::new(3.0, 3.0),
        Point::new(1.6, 3.0),
        Point::new(1.5, 1.5),
        Point::new(1.4, 3.0),
        Point::new(0.0, 3.0),
    ];
    let contained = SquareTessellation
        .cells_in_region(&region, RegionMode::Contained, CellScope::Space)
        .unwrap();
    assert!(!contained.contains(&SquarePoint { x: 1, y: 1 }));
    assert!(contained.contains(&SquarePoint { x: 0, y: 0 }));
}

#[test]
fn cells_in_region_over_space_covers_every_tessellation() {
    fn check<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
        // A region around one cell's boundary contains it and intersects its neighbors.
        let cell = cells[cells.len() / 2];
        let (min, max) = tessellation.boundary_path(cell).bounds();
        let region = [
            min - Point::new(0.01, 0.01),
            Point::new(max.x + 0.01, min.y - 0.01),
            max + Point::new(0.01, 0.01),
            Point::new(min.x - 0.01, max.y + 0.01),
        ];
        let contained = tessellation
            .cells_in_region(&region, RegionMode::Contained, CellScope::Space)
            .unwrap();
        assert!(contained.contains(&cell), "{cell:?}");
        let intersects = tessellation
            .cells_in_region(&region, RegionMode::Intersects, CellScope::Space)
            .unwrap();
        for &face in tessellation.faces_of(cell) {
            let (other, _) = tessellation.neighbor(cell, face).unwrap();
            assert!(intersects.contains(&other), "{cell:?} {other:?}");
        }
        assert!(intersects.windows(2).all(|w| w[0] < w[1]), "sorted");
    }
    for_each_tessellation!(check);
}

/// A unit disk as two arcs joined at (±1, 0) — the joints and both y-extrema sit on grid rows the
/// ray test passes exactly through.
fn disk() -> BoundaryPath {
    BoundaryPath::new(vec![
        vec![Segment::arc(Point::new(0.0, 0.0), 1.0, 0.0, PI)],
        vec![Segment::arc(Point::new(0.0, 0.0), 1.0, PI, PI)],
    ])
}

#[test]
fn arc_containment_is_exact() {
    let disk = disk();
    for i in -12..=12 {
        for j in -12..=12 {
            let p = Point::new(i as f64 / 8.0, j as f64 / 8.0);
            let inside = p.length() <= 1.0 + GEOM_EPS;
            assert_eq!(disk.contains(p), inside, "{p:?}");
        }
    }
    let (min, max) = disk.bounds();
    assert!(min.distance(Point::new(-1.0, -1.0)) < 1e-12);
    assert!(max.distance(Point::new(1.0, 1.0)) < 1e-12);
}

#[test]
fn arc_touches_and_crosses_lines() {
    let top = Segment::arc(Point::new(0.0, 0.0), 1.0, 0.0, PI);
    let p = Point::new;
    // A chord through the upper half crosses it twice.
    assert!(top.crosses_line(p(-2.0, 0.5), p(2.0, 0.5)));
    // Tangent at the top: touches, never crosses.
    assert!(top.touches_line(p(-1.0, 1.0), p(1.0, 1.0)));
    assert!(!top.crosses_line(p(-1.0, 1.0), p(1.0, 1.0)));
    // Below the arc (the arc covers only the upper half): no contact.
    assert!(!top.touches_line(p(-0.5, -0.5), p(0.5, -0.5)));
    // Through an arc endpoint: touches, not a crossing.
    assert!(top.touches_line(p(1.0, -1.0), p(1.0, 1.0)));
    assert!(!top.crosses_line(p(1.0, -1.0), p(1.0, 1.0)));
}

#[test]
fn oversized_region_is_rejected_unscoped_but_answered_within_a_cell_scope() {
    fn check<T: Tessellation>(tessellation: &T, cells: &[T::CellId]) {
        let side = 10_000.0;
        let region = [
            Point::new(-side, -side),
            Point::new(side, -side),
            Point::new(side, side),
            Point::new(-side, side),
        ];
        // An unbounded space has more candidates than the limit; a finite one (radial, capped at
        // `max_cells`) answers with every cell of its space.
        match tessellation.cells_in_region(&region, RegionMode::Intersects, CellScope::Space) {
            Err(error) => assert_eq!(
                error,
                RegionTooLarge {
                    limit: MAX_REGION_CANDIDATES
                }
            ),
            Ok(found) => {
                assert!(found.len() <= MAX_REGION_CANDIDATES);
                assert!(cells.iter().all(|cell| found.contains(cell)));
            }
        }
        let mut scope = cells.to_vec();
        scope.sort();
        scope.dedup();
        assert_eq!(
            tessellation.cells_in_region(&region, RegionMode::Contained, CellScope::Cells(&scope)),
            Ok(scope.clone()),
            "a cell scope is bounded by itself, whatever the region's size"
        );
    }
    for_each_tessellation!(check);
}
