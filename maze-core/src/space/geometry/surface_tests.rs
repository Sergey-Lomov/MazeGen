use super::*;
use crate::comparison::Comparison;
use crate::ids::IdGenerator;
use crate::space::topology::{Fold, FoldEnd, FoldGroup, FoldGroupId, FoldId};
use crate::space::{
    Field, RadialFace, RadialLayout, RadialParams, RadialPoint, RadialTessellation, ScaledPoint,
    SquarePoint, SquareTessellation, TessellationFingerprint, Topology, cell_position,
    planar_distance,
};
use std::sync::Arc;

const E: usize = 0;
const N: usize = 1;
const W: usize = 2;
const S: usize = 3;
const EPS: f64 = 1e-6;

fn fp() -> TessellationFingerprint {
    TessellationFingerprint::new("test")
}

fn p(x: i32, y: i32) -> SquarePoint {
    SquarePoint { x, y }
}

fn fold<C>(a: (C, usize), b: (C, usize), twist: bool) -> Fold<C> {
    Fold {
        a: FoldEnd {
            cell: a.0,
            face_idx: a.1,
        },
        b: FoldEnd {
            cell: b.0,
            face_idx: b.1,
        },
        twist,
        group: FoldGroupId(0),
    }
}

fn field<T: Tessellation>(
    tessellation: T,
    cells: Vec<T::CellId>,
    folds: Vec<Fold<T::CellId>>,
) -> Field<T> {
    let mut field = Field::new(Arc::new(tessellation), cells, &mut IdGenerator::new()).unwrap();
    if !folds.is_empty() {
        let ids = (0..folds.len()).map(FoldId).collect();
        let topology = Topology::new(
            fp(),
            folds,
            vec![FoldGroup {
                id: FoldGroupId(0),
                folds: ids,
            }],
        );
        field.set_topology(topology, &fp()).unwrap();
    }
    field
}

fn rect(width: i32, height: i32) -> Vec<SquarePoint> {
    (0..width)
        .flat_map(|x| (0..height).map(move |y| p(x, y)))
        .collect()
}

fn point(x: f64, y: f64) -> ScaledPoint {
    ScaledPoint {
        point: Point::new(x, y),
        scale: 1.0,
    }
}

fn centers(field: &Field<SquareTessellation>) -> Vec<ScaledPoint> {
    field
        .all_cells()
        .map(|cell| cell_position(field.tessellation(), cell))
        .collect()
}

fn cylinder() -> Field<SquareTessellation> {
    let folds = (0..2).map(|y| fold((p(3, y), E), (p(0, y), W), false));
    field(SquareTessellation, rect(4, 2), folds.collect())
}

/// A 4×3 torus: x wraps with period 4, y with period 3.
fn torus() -> Field<SquareTessellation> {
    let mut folds: Vec<_> = (0..3)
        .map(|y| fold((p(3, y), E), (p(0, y), W), false))
        .collect();
    folds.extend((0..4).map(|x| fold((p(x, 2), N), (p(x, 0), S), false)));
    field(SquareTessellation, rect(4, 3), folds)
}

/// A 4×2 Möbius strip: `T(x, y) = (x + 4, 2 − y)` maps the west edge onto the east edge.
fn mobius() -> Field<SquareTessellation> {
    let folds = [(0, 1), (1, 0)].map(|(y, partner)| fold((p(3, y), E), (p(0, partner), W), true));
    field(SquareTessellation, rect(4, 2), folds.to_vec())
}

/// A cube of side 2 (2×2 cells per face) unfolded as a cross with the back face below the bottom
/// one: F (0..2, 0..2), U above it, D below, L left, R right, B (0..2, −4..−2).
fn cube() -> Field<SquareTessellation> {
    let block = |x0: i32, y0: i32| (0..2).flat_map(move |x| (0..2).map(move |y| p(x0 + x, y0 + y)));
    let cells: Vec<_> = [(0, 0), (0, 2), (0, -2), (-2, 0), (2, 0), (0, -4)]
        .into_iter()
        .flat_map(|(x, y)| block(x, y))
        .collect();
    let mut folds = Vec::new();
    for k in 0..2 {
        folds.push(fold((p(k, 3), N), (p(k, -4), S), false)); // U top – B bottom
        folds.push(fold((p(0, 2 + k), W), (p(-1 - k, 1), N), false)); // U left – L top
        folds.push(fold((p(1, 2 + k), E), (p(2 + k, 1), N), false)); // U right – R top
        folds.push(fold((p(0, -1 - k), W), (p(-1 - k, 0), S), false)); // D left – L bottom
        folds.push(fold((p(1, -1 - k), E), (p(2 + k, 0), S), false)); // D right – R bottom
        folds.push(fold((p(-2, k), W), (p(0, -3 - k), W), false)); // L left – B left
        folds.push(fold((p(3, k), E), (p(1, -3 - k), E), false)); // R right – B right
    }
    field(SquareTessellation, cells, folds)
}

fn surface(metric: &SurfaceMetric, a: ScaledPoint, b: ScaledPoint) -> DistanceResult {
    metric.surface_distance(a, b).unwrap()
}

/// The invariants every result obeys.
fn assert_sound(result: DistanceResult, planar: f64) {
    assert!(result.lower_bound <= result.upper_bound + EPS, "{result:?}");
    assert!(result.upper_bound <= planar + EPS, "{result:?} vs {planar}");
    if result.exact {
        assert!(
            (result.upper_bound - result.lower_bound).abs() <= EPS,
            "{result:?}"
        );
    }
}

#[test]
fn without_folds_surface_equals_planar_and_is_exact() {
    let field = field(SquareTessellation, rect(3, 3), Vec::new());
    let metric = field.surface_metric();
    assert!(!metric.has_seams());
    for a in centers(&field) {
        for b in centers(&field) {
            assert_eq!(
                surface(&metric, a, b),
                DistanceResult::exact(planar_distance(a, b))
            );
        }
    }
}

#[test]
fn cylinder_matches_brute_force_exactly() {
    let field = cylinder();
    let metric = field.surface_metric();
    let mut points = centers(&field);
    // Points on the seam itself and off the cell centers.
    points.extend([
        point(4.0, 0.5),
        point(0.0, 1.5),
        point(3.9, 0.1),
        point(0.1, 1.9),
    ]);
    for &a in &points {
        for &b in &points {
            let brute = (-3..=3)
                .map(|k| (a.point - b.point - Point::new(4.0 * k as f64, 0.0)).length())
                .fold(f64::INFINITY, f64::min);
            let result = surface(&metric, a, b);
            assert!(result.exact, "{a:?} {b:?} {result:?}");
            assert!(
                (result.upper_bound - brute).abs() < EPS,
                "{a:?} {b:?} {result:?} {brute}"
            );
        }
    }
}

#[test]
fn torus_matches_brute_force_exactly() {
    let field = torus();
    let metric = field.surface_metric();
    let points = centers(&field);
    for &a in &points {
        for &b in &points {
            let brute = (-2..=2)
                .flat_map(|i| (-2..=2).map(move |j| Point::new(4.0 * i as f64, 3.0 * j as f64)))
                .map(|v| (a.point - b.point - v).length())
                .fold(f64::INFINITY, f64::min);
            let result = surface(&metric, a, b);
            assert!(result.exact, "{a:?} {b:?} {result:?}");
            assert!(
                (result.upper_bound - brute).abs() < EPS,
                "{a:?} {b:?} {result:?} {brute}"
            );
        }
    }
}

#[test]
fn torus_shortest_path_crosses_two_seams() {
    let field = torus();
    let metric = field.surface_metric();
    // From the north-east corner cell to the south-west one: around the corner through both seams.
    let a = cell_position(field.tessellation(), p(3, 2));
    let b = cell_position(field.tessellation(), p(0, 0));
    assert!(planar_distance(a, b) > 3.0);
    let result = surface(&metric, a, b);
    assert!(result.exact);
    assert!((result.upper_bound - 2f64.sqrt()).abs() < EPS, "{result:?}");
}

#[test]
fn torus_path_off_the_corner_crosses_two_seams() {
    let field = torus();
    let metric = field.surface_metric();
    let (a, b) = (point(3.7, 2.8), point(0.4, 0.2));
    let expected = (Point::new(3.7, 2.8) - Point::new(0.4 + 4.0, 0.2 + 3.0)).length();
    let result = surface(&metric, a, b);
    assert!(result.exact);
    assert!(
        (result.upper_bound - expected).abs() < EPS,
        "{result:?} {expected}"
    );
}

#[test]
fn mobius_upper_bound_matches_brute_force_and_lower_bound_is_sound() {
    let field = mobius();
    let metric = field.surface_metric();
    let twice = |q: Point, k: i32| {
        // T^k: odd powers reflect y about 1.
        let y = if k % 2 == 0 { q.y } else { 2.0 - q.y };
        Point::new(q.x + 4.0 * k as f64, y)
    };
    let points = centers(&field);
    for &a in &points {
        for &b in &points {
            let brute = (-3..=3)
                .map(|k| (a.point - twice(b.point, k)).length())
                .fold(f64::INFINITY, f64::min);
            let result = surface(&metric, a, b);
            assert_sound(result, planar_distance(a, b));
            assert!(
                result.lower_bound <= brute + EPS,
                "{a:?} {b:?} {result:?} {brute}"
            );
            assert!(
                (result.upper_bound - brute).abs() < EPS,
                "{a:?} {b:?} {result:?} {brute}"
            );
        }
    }
}

#[test]
fn mobius_bracket_is_not_exact_and_limits_can_be_unknown() {
    let field = mobius();
    let metric = field.surface_metric();
    let (a, b) = (point(0.5, 0.5), point(3.5, 0.5));
    let result = surface(&metric, a, b);
    // Through the seam: |(0.5, 0.5) − (−0.5, 1.5)|; the seam bound d(a, S) + d(S, b) is 1.
    assert!(!result.exact);
    assert!((result.lower_bound - 1.0).abs() < EPS, "{result:?}");
    assert!((result.upper_bound - 2f64.sqrt()).abs() < EPS, "{result:?}");
    assert_eq!(
        metric.surface_distance_at_most(a, b, 0.9),
        Ok(WithinLimit::No)
    );
    assert_eq!(
        metric.surface_distance_at_most(a, b, 1.2),
        Ok(WithinLimit::Unknown)
    );
    assert_eq!(
        metric.surface_distance_at_most(a, b, 1.5),
        Ok(WithinLimit::Yes)
    );
    // The bracket is not narrowed by asking with a limit.
    assert_eq!(surface(&metric, a, b), result);
}

#[test]
fn far_pair_is_pruned_to_planar_by_the_seam_bound() {
    let field = cylinder();
    let metric = field.surface_metric();
    // Both cells are 1.5 from the nearest seam: any seam path is at least 3 long, the planar
    // distance is 0, so no search is needed.
    let (a, b) = (point(1.5, 0.5), point(2.5, 0.5));
    assert_eq!(surface(&metric, a, b), DistanceResult::exact(1.0));
}

#[test]
fn cube_adjacent_faces_across_a_seam() {
    let field = cube();
    let metric = field.surface_metric();
    let t = field.tessellation();
    // The top row of U meets the bottom row of B; 0.5 on either side of the seam.
    let result = surface(
        &metric,
        cell_position(t, p(0, 3)),
        cell_position(t, p(0, -4)),
    );
    assert!(result.exact);
    assert!((result.upper_bound - 1.0).abs() < EPS, "{result:?}");
    // A rotated seam: U's left column against L's top row.
    let result = surface(
        &metric,
        cell_position(t, p(0, 3)),
        cell_position(t, p(-2, 1)),
    );
    assert!(result.exact);
    assert!((result.upper_bound - 1.0).abs() < EPS, "{result:?}");
}

#[test]
fn cube_results_are_sound_and_agree_when_exact() {
    let field = cube();
    let metric = field.surface_metric();
    let points = centers(&field);
    for &a in &points {
        for &b in &points {
            let ab = surface(&metric, a, b);
            let ba = surface(&metric, b, a);
            assert_sound(ab, planar_distance(a, b));
            // Both directions bound the same distance.
            assert!(ab.lower_bound <= ba.upper_bound + EPS, "{a:?} {b:?}");
            assert!(ba.lower_bound <= ab.upper_bound + EPS, "{a:?} {b:?}");
            if ab.exact && ba.exact {
                assert!((ab.upper_bound - ba.upper_bound).abs() < EPS, "{a:?} {b:?}");
            }
        }
    }
}

#[test]
fn radial_arc_seam_is_traced() {
    let tessellation = RadialTessellation::new(RadialParams {
        first_ring_cells: 6,
        layout: RadialLayout::Classic,
        max_cells: 200,
    })
    .unwrap();
    let face_idx = |cell: RadialPoint, face: RadialFace| {
        tessellation
            .faces_of(cell)
            .iter()
            .position(|&f| f == face)
            .unwrap()
    };
    // The outer arc of ring 1 / cell 0 glued to the inner arc of ring 2 / cell 6, two cells that
    // are not neighbours: the seam brings them next to each other.
    let (a, b) = (
        RadialPoint { ring: 1, index: 0 },
        RadialPoint { ring: 2, index: 6 },
    );
    let folds = vec![fold(
        (a, face_idx(a, RadialFace::Outer(0))),
        (b, face_idx(b, RadialFace::Inner(0))),
        false,
    )];
    let field = field(tessellation.clone(), vec![a, b], folds);
    let metric = field.surface_metric();
    let FoldClass::Isometric { transform } = field.fold_class(FoldId(0)).unwrap() else {
        panic!("expected an isometric fold");
    };
    // Two points on the radial line through the middle of the glued arc, 0.2 inside and 0.3
    // outside it once the second cell is unfolded across the seam.
    let arc = tessellation.face_segments(a, RadialFace::Outer(0))[0];
    let middle = arc.point(0.5);
    let outward = middle.normalized();
    let from = ScaledPoint {
        point: middle - outward * 0.2,
        scale: 1.0,
    };
    let to = ScaledPoint {
        point: transform.inverse().apply(middle + outward * 0.3),
        scale: 1.0,
    };
    let result = surface(&metric, from, to);
    assert!(result.exact, "{result:?}");
    assert!((result.upper_bound - 0.5).abs() < 1e-6, "{result:?}");
    assert!(result.upper_bound < planar_distance(from, to));
}

#[test]
fn topological_only_fold_is_unsupported_unless_approximated() {
    let tessellation = RadialTessellation::new(RadialParams {
        first_ring_cells: 6,
        layout: RadialLayout::Classic,
        max_cells: 200,
    })
    .unwrap();
    let face_idx = |cell: RadialPoint, face: RadialFace| {
        tessellation
            .faces_of(cell)
            .iter()
            .position(|&f| f == face)
            .unwrap()
    };
    let (a, b) = (
        RadialPoint { ring: 1, index: 0 },
        RadialPoint { ring: 2, index: 6 },
    );
    // Both outer arcs: different radii, topological-only.
    let folds = vec![fold(
        (a, face_idx(a, RadialFace::Outer(0))),
        (b, face_idx(b, RadialFace::Outer(0))),
        false,
    )];
    let field = field(tessellation.clone(), vec![a, b], folds);
    let (pa, pb) = (
        cell_position(&tessellation, a),
        cell_position(&tessellation, b),
    );

    let strict = field.surface_metric();
    assert!(strict.is_unsupported());
    assert_eq!(
        strict.surface_distance(pa, pb),
        Err(DistanceError::Unsupported)
    );
    assert_eq!(
        strict.surface_distance_at_most(pa, pb, 1.0),
        Err(DistanceError::Unsupported)
    );

    let approximate = field
        .surface_metric()
        .with_policy(DistancePolicy::Approximate);
    let planar = planar_distance(pa, pb);
    let result = approximate.surface_distance(pa, pb).unwrap();
    assert_eq!(
        result,
        DistanceResult {
            lower_bound: planar,
            upper_bound: planar,
            exact: false
        }
    );
    assert_eq!(
        approximate.surface_distance_at_most(pa, pb, planar + 1.0),
        Ok(WithinLimit::Yes)
    );
}

#[test]
fn compare_follows_the_bracket() {
    let exact = DistanceResult::exact(2.0);
    assert_eq!(exact.compare(Comparison::Lt, 2.0), WithinLimit::No);
    assert_eq!(exact.compare(Comparison::Le, 2.0), WithinLimit::Yes);
    assert_eq!(exact.compare(Comparison::Eq, 2.0), WithinLimit::Yes);

    let bracket = DistanceResult {
        lower_bound: 1.0,
        upper_bound: 3.0,
        exact: false,
    };
    assert_eq!(bracket.compare(Comparison::Lt, 4.0), WithinLimit::Yes);
    assert_eq!(bracket.compare(Comparison::Lt, 3.0), WithinLimit::Unknown);
    assert_eq!(bracket.compare(Comparison::Lt, 1.0), WithinLimit::No);
    assert_eq!(bracket.compare(Comparison::Le, 3.0), WithinLimit::Yes);
    assert_eq!(bracket.compare(Comparison::Le, 0.5), WithinLimit::No);
    assert_eq!(bracket.compare(Comparison::Gt, 0.5), WithinLimit::Yes);
    assert_eq!(bracket.compare(Comparison::Gt, 3.0), WithinLimit::No);
    assert_eq!(bracket.compare(Comparison::Ge, 1.0), WithinLimit::Yes);
    assert_eq!(bracket.compare(Comparison::Ge, 3.5), WithinLimit::No);
    assert_eq!(bracket.compare(Comparison::Eq, 2.0), WithinLimit::Unknown);
    assert_eq!(bracket.compare(Comparison::Eq, 5.0), WithinLimit::No);
}

#[test]
fn distances_are_in_cell_scale_units() {
    let field = cylinder();
    let metric = field.surface_metric();
    let scaled = |x: f64| ScaledPoint {
        point: Point::new(x, 0.5),
        scale: 2.0,
    };
    // 1 world unit across the seam, 2 world units per scale unit.
    let result = surface(&metric, scaled(3.5), scaled(0.5));
    assert!((result.upper_bound - 0.5).abs() < EPS, "{result:?}");
    assert_eq!(
        metric.surface_distance_at_most(scaled(3.5), scaled(0.5), 0.5),
        Ok(WithinLimit::Yes)
    );
    assert_eq!(
        metric.surface_distance_at_most(scaled(3.5), scaled(0.5), 0.4),
        Ok(WithinLimit::No)
    );
}

#[test]
fn translation_only_seams_without_a_lattice_are_still_traced() {
    // Row 0 wraps with period 4, row 1 with period 3: the translation (3, 0) is not an integer
    // multiple of (4, 0), so the lattice proof is not applied.
    let mut cells: Vec<_> = (0..4).map(|x| p(x, 0)).collect();
    cells.extend((0..3).map(|x| p(x, 1)));
    let folds = vec![
        fold((p(3, 0), E), (p(0, 0), W), false),
        fold((p(2, 1), E), (p(0, 1), W), false),
    ];
    let field = field(SquareTessellation, cells, folds);
    let metric = field.surface_metric();
    for &a in &centers(&field) {
        for &b in &centers(&field) {
            assert_sound(surface(&metric, a, b), planar_distance(a, b));
        }
    }
    let result = surface(&metric, point(2.9, 1.5), point(0.1, 1.5));
    assert!(result.exact, "{result:?}");
    assert!((result.upper_bound - 0.2).abs() < EPS, "{result:?}");
}

#[test]
fn a_path_entering_a_cell_from_outside_does_not_use_the_seam() {
    // (4.5, 0.5) lies beyond the east edge, outside the cylinder's cells: reaching (0.5, 0.5)
    // would mean entering cell (3, 0) through its glued face, which is not a crossing.
    let field = cylinder();
    let metric = field.surface_metric();
    let result = surface(&metric, point(4.5, 0.5), point(0.5, 0.5));
    assert_eq!(result.upper_bound, 4.0);
    assert!(!result.exact);
}

#[test]
fn approximate_policy_never_degrades_a_supported_result() {
    let field = cylinder();
    let metric = field
        .surface_metric()
        .with_policy(DistancePolicy::Approximate);
    assert_eq!(
        surface(&metric, point(3.5, 0.5), point(0.5, 0.5)),
        DistanceResult::exact(1.0)
    );
}

#[test]
fn line_crossings_report_fraction_and_direction() {
    let wall = Segment::line(Point::new(0.0, 0.0), Point::new(0.0, 2.0));
    let cross = |from: (f64, f64), to: (f64, f64)| {
        wall.line_crossings(Point::new(from.0, from.1), Point::new(to.0, to.1), 1e-7)
    };
    let hits = cross((-1.0, 1.0), (1.0, 1.0));
    assert_eq!(hits.len(), 1);
    assert!((hits[0].u - 0.5).abs() < 1e-12);
    assert_eq!(hits[0].tangent, Point::new(0.0, 2.0));
    // Parallel, short of the wall and past the chain's end: no crossing.
    assert!(cross((1.0, 0.0), (1.0, 2.0)).is_empty());
    assert!(cross((-1.0, 1.0), (-0.5, 1.0)).is_empty());
    assert!(cross((-1.0, 3.0), (1.0, 3.0)).is_empty());
    // Touching the chain's end counts (closed chain), within the tolerance.
    assert_eq!(cross((-1.0, 2.0), (1.0, 2.0)).len(), 1);
    assert_eq!(cross((-1.0, 2.0 + 5e-8), (1.0, 2.0 + 5e-8)).len(), 1);
}

#[test]
fn arc_crossings_follow_the_sweep_and_skip_tangents() {
    // Unit quarter circle from angle 0 counter-clockwise.
    let arc = Segment::arc(Point::default(), 1.0, 0.0, std::f64::consts::FRAC_PI_2);
    let cross = |arc: &Segment, from: (f64, f64), to: (f64, f64)| {
        arc.line_crossings(Point::new(from.0, from.1), Point::new(to.0, to.1), 1e-7)
    };
    // A horizontal chord through y = 0.5 meets the arc once, at angle 30°.
    let hits = cross(&arc, (0.0, 0.5), (2.0, 0.5));
    assert_eq!(hits.len(), 1);
    let x = (1.0f64 - 0.25).sqrt();
    assert!((hits[0].u - x / 2.0).abs() < 1e-9);
    // Counter-clockwise tangent at 30°.
    assert!((hits[0].tangent - Point::new(-0.5, x)).length() < 1e-9);
    // Outside the sweep, a tangent line and a miss.
    assert!(cross(&arc, (-2.0, -0.5), (2.0, -0.5)).is_empty());
    assert!(cross(&arc, (1.0, -1.0), (1.0, 1.0)).is_empty());
    assert!(cross(&arc, (3.0, 0.0), (3.0, 1.0)).is_empty());
    // A clockwise arc reverses the tangent.
    let hits = cross(&arc.reversed(), (0.0, 0.5), (2.0, 0.5));
    assert!((hits[0].tangent - Point::new(0.5, -x)).length() < 1e-9);
}
