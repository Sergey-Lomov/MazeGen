//! Surface distance across isometric folds (GitHub issue #835, `Specs/topology.md`, "Surface
//! distance"). `SurfaceMetric` is built once per field and answers `surface_distance` and
//! `surface_distance_at_most` queries under the result contract of the "Distance contract" section.

use super::{FoldClass, Point, RigidTransform, Segment};
use crate::comparison::Comparison;
use crate::space::topology::FoldId;
use crate::space::{Field, ScaledPoint, Tessellation, planar_distance};
use std::cell::{OnceCell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fmt;

/// World-unit tolerance of seam crossings and of lattice integrality.
const TOL: f64 = 1e-7;
/// A traced path must end on the unfolded target within this distance.
const SUCCESS_TOL: f64 = 1e-6;
/// Most seam crossings a traced straight path may make.
const MAX_CROSSINGS: usize = 6;
/// Longest word of seam transforms enumerated as unfolding candidates (non-lattice case).
const MAX_WORD_DEPTH: usize = 3;
/// Most distinct unfolding candidates kept (non-lattice case).
const MAX_WORDS: usize = 4096;
/// Most lattice points one query may enumerate; beyond it the lattice proof is not applied.
const MAX_LATTICE_POINTS: i64 = 40_000;
/// Most candidates traced per query.
const MAX_TRIED: usize = 64;
/// Most seam-crossing tests one trace may spend.
const MAX_TRACE_STEPS: usize = 20_000;
/// Cached results kept before the cache is dropped.
const MAX_CACHED: usize = 1 << 18;

/// The distance of two surface points as a bracket: `lower_bound <= true distance <=
/// upper_bound`, both in `cell_scale` units. `exact` iff the value is computed exactly (then the
/// bounds are equal).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DistanceResult {
    pub lower_bound: f64,
    pub upper_bound: f64,
    pub exact: bool,
}

impl DistanceResult {
    pub fn exact(value: f64) -> Self {
        Self {
            lower_bound: value,
            upper_bound: value,
            exact: true,
        }
    }

    /// Whether `distance <comparison> limit` holds for every value of the bracket (`Yes`), for
    /// none (`No`), or only for some (`Unknown`). An exact result is never `Unknown`.
    pub fn compare(&self, comparison: Comparison, limit: f64) -> WithinLimit {
        let (lo, hi) = (self.lower_bound, self.upper_bound);
        if self.exact || lo == hi {
            return WithinLimit::from_bool(comparison.compare_f64(hi, limit));
        }
        let (yes, no) = match comparison {
            Comparison::Lt => (hi < limit, lo >= limit),
            Comparison::Le => (hi <= limit, lo > limit),
            Comparison::Gt => (lo > limit, hi <= limit),
            Comparison::Ge => (lo >= limit, hi < limit),
            Comparison::Eq => (false, limit < lo || limit > hi),
        };
        if yes {
            WithinLimit::Yes
        } else if no {
            WithinLimit::No
        } else {
            WithinLimit::Unknown
        }
    }

    fn scaled(self, factor: f64) -> Self {
        Self {
            lower_bound: self.lower_bound * factor,
            upper_bound: self.upper_bound * factor,
            exact: self.exact,
        }
    }
}

/// Answer of a distance-versus-limit question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WithinLimit {
    Yes,
    No,
    Unknown,
}

impl WithinLimit {
    fn from_bool(value: bool) -> Self {
        if value { Self::Yes } else { Self::No }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistanceError {
    /// The floor has an active topological-only fold and the caller did not opt into
    /// approximation.
    Unsupported,
}

impl fmt::Display for DistanceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => {
                write!(
                    f,
                    "surface distance is unsupported across a topological-only fold"
                )
            }
        }
    }
}

impl std::error::Error for DistanceError {}

/// How a caller treats a pair that `surface_distance` cannot measure. Never a global switch: the
/// caller chooses, and the choice is visible in its config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DistancePolicy {
    /// `Unsupported` is returned to the caller.
    #[default]
    Strict,
    /// An unsupported pair yields the planar distance flagged `exact = false`.
    Approximate,
}

impl DistancePolicy {
    /// `Approximate` when the caller's config opts in (`approximate_topology`), else `Strict`.
    pub fn from_approximate(approximate: bool) -> Self {
        if approximate {
            Self::Approximate
        } else {
            Self::Strict
        }
    }
}

/// A plane isometry `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty` (the layout of
/// `RigidTransform::matrix`).
#[derive(Debug, Clone, Copy)]
struct Affine {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    tx: f64,
    ty: f64,
}

impl Affine {
    const IDENTITY: Affine = Affine {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        tx: 0.0,
        ty: 0.0,
    };

    fn from_rigid(transform: &RigidTransform) -> Self {
        let [a, b, c, d, tx, ty] = transform.matrix();
        Self { a, b, c, d, tx, ty }
    }

    fn translation(v: Point) -> Self {
        Self {
            tx: v.x,
            ty: v.y,
            ..Self::IDENTITY
        }
    }

    fn apply(&self, p: Point) -> Point {
        Point::new(
            self.a * p.x + self.c * p.y + self.tx,
            self.b * p.x + self.d * p.y + self.ty,
        )
    }

    /// `self ∘ inner`: `inner` first.
    fn compose(&self, inner: &Affine) -> Affine {
        let t = self.apply(Point::new(inner.tx, inner.ty));
        Affine {
            a: self.a * inner.a + self.c * inner.b,
            b: self.b * inner.a + self.d * inner.b,
            c: self.a * inner.c + self.c * inner.d,
            d: self.b * inner.c + self.d * inner.d,
            tx: t.x,
            ty: t.y,
        }
    }

    fn inverse(&self) -> Affine {
        let det = self.a * self.d - self.b * self.c;
        let (a, b, c, d) = (self.d / det, -self.b / det, -self.c / det, self.a / det);
        Affine {
            a,
            b,
            c,
            d,
            tx: -(a * self.tx + c * self.ty),
            ty: -(b * self.tx + d * self.ty),
        }
    }

    /// The translation vector when the linear part is the identity.
    fn as_translation(&self) -> Option<Point> {
        ((self.a - 1.0).abs() <= TOL
            && (self.d - 1.0).abs() <= TOL
            && self.b.abs() <= TOL
            && self.c.abs() <= TOL)
            .then(|| Point::new(self.tx, self.ty))
    }

    fn key(&self) -> [i64; 6] {
        [self.a, self.b, self.c, self.d, self.tx, self.ty].map(|v| (v * 1e6).round() as i64)
    }
}

/// One way of crossing a seam: leaving the cell whose boundary is `chain`. The unfolding frame
/// `g` becomes `g ∘ step`.
struct SeamSide {
    chain: Vec<Segment>,
    step: Affine,
    min: Point,
    max: Point,
}

impl SeamSide {
    fn new(chain: Vec<Segment>, step: Affine) -> Self {
        let points: Vec<Point> = chain.iter().flat_map(Segment::extreme_points).collect();
        let min = Point::new(
            points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min) - TOL,
            points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min) - TOL,
        );
        let max = Point::new(
            points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max) + TOL,
            points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max) + TOL,
        );
        Self {
            chain,
            step,
            min,
            max,
        }
    }
}

/// The group generated by pure translations: all `Σ nᵢ·bᵢ` over an integer basis.
enum Lattice {
    Line(Point),
    Plane(Point, Point),
}

impl Lattice {
    /// `None` unless every vector is an integer combination of a basis picked from them.
    fn from_vectors(vectors: &[Point]) -> Option<Lattice> {
        let nonzero: Vec<Point> = vectors
            .iter()
            .copied()
            .filter(|v| v.length() > TOL)
            .collect();
        let first = *nonzero.first()?;
        let integral = |x: f64| (x - x.round()).abs() <= 1e-6;
        let second = nonzero
            .iter()
            .find(|v| first.cross(**v).abs() > 1e-7 * first.length() * v.length());
        match second {
            None => nonzero
                .iter()
                .all(|v| integral(v.dot(first) / first.dot(first)))
                .then_some(Lattice::Line(first)),
            Some(&second) => {
                let det = first.cross(second);
                nonzero
                    .iter()
                    .all(|v| integral(v.cross(second) / det) && integral(first.cross(*v) / det))
                    .then_some(Lattice::Plane(first, second))
            }
        }
    }

    /// The lattice vectors `v` with `|w − v| < radius`, nearest first, or `None` when there are
    /// too many to enumerate.
    fn near(&self, w: Point, radius: f64) -> Option<Vec<(Point, f64)>> {
        let mut found = Vec::new();
        match *self {
            Lattice::Line(g) => {
                let k0 = (w.dot(g) / g.dot(g)).round() as i64;
                let r = ((radius / g.length()).ceil() as i64).saturating_add(1);
                if r > MAX_LATTICE_POINTS {
                    return None;
                }
                for k in k0 - r..=k0 + r {
                    found.push(g * k as f64);
                }
            }
            Lattice::Plane(g1, g2) => {
                let det = g1.cross(g2);
                let (x0, y0) = (
                    (w.cross(g2) / det).round() as i64,
                    (g1.cross(w) / det).round() as i64,
                );
                let trace = g1.dot(g1) + g2.dot(g2);
                let sigma_min =
                    ((trace - (trace * trace - 4.0 * det * det).max(0.0).sqrt()) / 2.0).sqrt();
                let r = ((radius / sigma_min).ceil() as i64).saturating_add(1);
                if r > MAX_LATTICE_POINTS || (2 * r + 1) * (2 * r + 1) > MAX_LATTICE_POINTS {
                    return None;
                }
                for i in x0 - r..=x0 + r {
                    for j in y0 - r..=y0 + r {
                        found.push(g1 * i as f64 + g2 * j as f64);
                    }
                }
            }
        }
        let mut near: Vec<(Point, f64)> = found
            .into_iter()
            .map(|v| (v, (w - v).length()))
            .filter(|&(_, dist)| dist < radius)
            .collect();
        near.sort_by(|x, y| x.1.total_cmp(&y.1));
        Some(near)
    }
}

/// Surface distance on one floor with its active folds. See `Specs/topology.md`, "Surface
/// distance", for the model, the bounds and their proofs.
pub struct SurfaceMetric {
    sides: Vec<SeamSide>,
    /// An active fold is topological-only.
    unsupported: bool,
    lattice: Option<Lattice>,
    generators: Vec<Affine>,
    /// Group elements up to `MAX_WORD_DEPTH` seam crossings: the unfolding candidates when the
    /// lattice proof does not apply. Built on first use.
    words: OnceCell<Vec<Affine>>,
    policy: DistancePolicy,
    seam_distance_cache: RefCell<HashMap<(u64, u64), f64>>,
    result_cache: RefCell<HashMap<[u64; 4], DistanceResult>>,
}

impl SurfaceMetric {
    pub fn new<T: Tessellation>(field: &Field<T>) -> Self {
        let mut sides = Vec::new();
        let mut unsupported = false;
        if let Some(topology) = field.topology() {
            let tessellation = field.tessellation();
            let chain_of = |end: crate::space::FoldEnd<T::CellId>| {
                let face = tessellation.faces_of(end.cell)[end.face_idx];
                tessellation.face_segments(end.cell, face)
            };
            for (index, fold) in topology.folds().iter().enumerate() {
                match field.fold_class(FoldId(index)) {
                    None => {}
                    Some(FoldClass::TopologicalOnly) => unsupported = true,
                    Some(FoldClass::Isometric { transform }) => {
                        let step = Affine::from_rigid(&transform);
                        sides.push(SeamSide::new(chain_of(fold.a), step));
                        sides.push(SeamSide::new(chain_of(fold.b), step.inverse()));
                    }
                }
            }
        }
        let mut seen = HashSet::new();
        let generators: Vec<Affine> = sides
            .iter()
            .map(|side| side.step)
            .filter(|step| seen.insert(step.key()))
            .collect();
        let translations: Option<Vec<Point>> =
            generators.iter().map(Affine::as_translation).collect();
        let lattice = translations
            .filter(|_| !generators.is_empty())
            .and_then(|vectors| Lattice::from_vectors(&vectors));
        Self {
            generators,
            words: OnceCell::new(),
            sides,
            unsupported,
            lattice,
            policy: DistancePolicy::Strict,
            seam_distance_cache: RefCell::new(HashMap::new()),
            result_cache: RefCell::new(HashMap::new()),
        }
    }

    pub fn with_policy(mut self, policy: DistancePolicy) -> Self {
        self.policy = policy;
        self
    }

    /// Whether an active fold is topological-only, so strict queries are `Unsupported`.
    pub fn is_unsupported(&self) -> bool {
        self.unsupported
    }

    /// Whether the floor has any active isometric seam.
    pub fn has_seams(&self) -> bool {
        !self.sides.is_empty()
    }

    /// The distance for decisions that only *order* candidates (nearest, farthest), never
    /// threshold them (`Specs/topology.md`, "Consumer policy"): the upper bound of the surface
    /// distance, planar when the floor has no isometric seam, and planar for a pair the metric
    /// cannot measure (an unsupported fold). Never fails, never raises an issue. Without seams it
    /// is bit-identical to `planar_distance`.
    pub fn ranking_distance(&self, a: ScaledPoint, b: ScaledPoint) -> f64 {
        if !self.has_seams() {
            return planar_distance(a, b);
        }
        match self.surface_distance(a, b) {
            Ok(result) => result.upper_bound,
            Err(DistanceError::Unsupported) => planar_distance(a, b),
        }
    }

    /// Shortest surface path between two points, in `cell_scale` units of their mean scale.
    pub fn surface_distance(
        &self,
        a: ScaledPoint,
        b: ScaledPoint,
    ) -> Result<DistanceResult, DistanceError> {
        let scale = (a.scale + b.scale) / 2.0;
        if let Some(fallback) = self.unsupported_fallback(a, b)? {
            return Ok(fallback);
        }
        Ok(self.solve(a.point, b.point, None).scaled(1.0 / scale))
    }

    /// Whether the surface distance is at most `limit` (`cell_scale` units), pruning the search
    /// as soon as the bracket decides.
    pub fn surface_distance_at_most(
        &self,
        a: ScaledPoint,
        b: ScaledPoint,
        limit: f64,
    ) -> Result<WithinLimit, DistanceError> {
        let scale = (a.scale + b.scale) / 2.0;
        if let Some(fallback) = self.unsupported_fallback(a, b)? {
            return Ok(fallback.compare(Comparison::Le, limit));
        }
        let result = self.solve(a.point, b.point, Some(limit * scale));
        Ok(result.scaled(1.0 / scale).compare(Comparison::Le, limit))
    }

    /// `Ok(Some(planar))` for an unsupported pair under `Approximate`, `Err` under `Strict`,
    /// `Ok(None)` when the pair is supported.
    fn unsupported_fallback(
        &self,
        a: ScaledPoint,
        b: ScaledPoint,
    ) -> Result<Option<DistanceResult>, DistanceError> {
        if !self.unsupported {
            return Ok(None);
        }
        match self.policy {
            DistancePolicy::Strict => Err(DistanceError::Unsupported),
            DistancePolicy::Approximate => {
                let planar = planar_distance(a, b);
                Ok(Some(DistanceResult {
                    lower_bound: planar,
                    upper_bound: planar,
                    exact: false,
                }))
            }
        }
    }

    /// `d(p, S)` with `S` the union of all seam chains (both sides of every isometric seam).
    fn seam_distance(&self, p: Point) -> f64 {
        let key = (p.x.to_bits(), p.y.to_bits());
        if let Some(&cached) = self.seam_distance_cache.borrow().get(&key) {
            return cached;
        }
        let value = self
            .sides
            .iter()
            .flat_map(|side| side.chain.iter())
            .map(|segment| segment.distance_to(p))
            .fold(f64::INFINITY, f64::min);
        let mut cache = self.seam_distance_cache.borrow_mut();
        if cache.len() >= MAX_CACHED {
            cache.clear();
        }
        cache.insert(key, value);
        value
    }

    /// The bracket of the world-unit distance of `s` and `t`. With `limit` the search stops as
    /// soon as the bracket decides `distance <= limit`; such a partial result is not cached.
    fn solve(&self, s: Point, t: Point, limit: Option<f64>) -> DistanceResult {
        let key = [s.x, s.y, t.x, t.y].map(f64::to_bits);
        if let Some(&cached) = self.result_cache.borrow().get(&key) {
            return cached;
        }
        let result = self.search(s, t, limit);
        if limit.is_none() || result.exact {
            let mut cache = self.result_cache.borrow_mut();
            if cache.len() >= MAX_CACHED {
                cache.clear();
            }
            cache.insert(key, result);
        }
        result
    }

    fn search(&self, s: Point, t: Point, limit: Option<f64>) -> DistanceResult {
        let planar = s.distance(t);
        if self.sides.is_empty() {
            return DistanceResult::exact(planar);
        }
        // Every path through a seam is no shorter than d(s, S) + d(S, t); with no seam crossing it
        // is no shorter than the planar distance, which is also a real path.
        let seam_bound = self.seam_distance(s) + self.seam_distance(t);
        if seam_bound >= planar {
            return DistanceResult::exact(planar);
        }
        let eps = 1e-9 * (1.0 + planar);
        let decided =
            |lower: f64, upper: f64| limit.is_some_and(|limit| upper <= limit || lower > limit);
        let mut lower = seam_bound;
        let mut upper = planar;
        if decided(lower, upper) {
            return bracket(lower, upper, eps);
        }

        let w = s - t;
        let mut candidates: Vec<(Affine, f64)> = Vec::new();
        let mut lattice_done = false;
        if let Some(lattice) = &self.lattice
            && let Some(near) = lattice.near(w, planar)
        {
            lattice_done = true;
            // Every path with at least one crossing unfolds to `s → t + v` for a lattice vector
            // `v`, and no crossing means `v = 0`: all of them are at least min(planar, |w − v|).
            let nearest = near
                .iter()
                .filter(|(v, _)| v.length() > TOL)
                .map(|&(_, dist)| dist)
                .fold(planar, f64::min);
            lower = lower.max(nearest).min(planar);
            candidates = near
                .into_iter()
                .filter(|(v, _)| v.length() > TOL)
                .map(|(v, dist)| (Affine::translation(v), dist))
                .collect();
        }
        if !lattice_done {
            candidates = self
                .words
                .get_or_init(|| enumerate_words(&self.generators))
                .iter()
                .map(|g| (*g, s.distance(g.apply(t))))
                .filter(|&(_, dist)| dist < planar)
                .collect();
            candidates.sort_by(|x, y| x.1.total_cmp(&y.1));
        }
        if decided(lower, upper) {
            return bracket(lower, upper, eps);
        }

        for (g, dist) in candidates.into_iter().take(MAX_TRIED) {
            if dist >= upper - eps {
                break;
            }
            if self.trace(s, t, &g) {
                upper = dist;
                break;
            }
        }
        bracket(lower, upper, eps)
    }

    /// Whether a straight path from `s` to the unfolded target `g(t)` is realizable: following
    /// it, each seam it leaves a cell through is crossed in order, and the frame it ends in maps
    /// `t` onto `g(t)`.
    fn trace(&self, s: Point, t: Point, g: &Affine) -> bool {
        let mut tracer = Tracer {
            sides: &self.sides,
            s,
            e: g.apply(t),
            t,
            steps: 0,
        };
        tracer.walk(&Affine::IDENTITY, 0.0, 0)
    }
}

fn bracket(lower: f64, upper: f64, eps: f64) -> DistanceResult {
    let lower = lower.min(upper);
    if upper - lower <= eps {
        DistanceResult::exact(upper)
    } else {
        DistanceResult {
            lower_bound: lower,
            upper_bound: upper,
            exact: false,
        }
    }
}

/// Distinct products of up to `MAX_WORD_DEPTH` generators (identity excluded).
fn enumerate_words(generators: &[Affine]) -> Vec<Affine> {
    let mut seen = HashSet::from([Affine::IDENTITY.key()]);
    let mut all = Vec::new();
    let mut frontier = vec![Affine::IDENTITY];
    for _ in 0..MAX_WORD_DEPTH {
        let mut next = Vec::new();
        for g in &frontier {
            for step in generators {
                let word = g.compose(step);
                if all.len() < MAX_WORDS && seen.insert(word.key()) {
                    all.push(word);
                    next.push(word);
                }
            }
        }
        frontier = next;
    }
    all
}

struct Tracer<'a> {
    sides: &'a [SeamSide],
    s: Point,
    e: Point,
    t: Point,
    steps: usize,
}

impl Tracer<'_> {
    /// In frame `g` (the transform taking the current sheet into the unfolded plane), having
    /// crossed up to fraction `u0` of the segment `s`–`e`.
    fn walk(&mut self, g: &Affine, u0: f64, depth: usize) -> bool {
        if g.apply(self.t).distance(self.e) <= SUCCESS_TOL {
            return true;
        }
        if depth == MAX_CROSSINGS || self.steps > MAX_TRACE_STEPS {
            return false;
        }
        let inverse = g.inverse();
        // The sheet's own coordinates: seam chains are stored there, and an isometry keeps the
        // fractions `u` along the segment.
        let (p0, p1) = (inverse.apply(self.s), inverse.apply(self.e));
        let direction = p1 - p0;
        let length = direction.length().max(TOL);
        let (low, high) = (
            Point::new(p0.x.min(p1.x), p0.y.min(p1.y)),
            Point::new(p0.x.max(p1.x), p0.y.max(p1.y)),
        );
        for side in self.sides {
            if side.max.x < low.x
                || side.min.x > high.x
                || side.max.y < low.y
                || side.min.y > high.y
            {
                continue;
            }
            // A target on a seam is also the glued point of the partner sheet: reaching it needs
            // no crossing (the path may even run along the seam).
            if side
                .chain
                .iter()
                .any(|segment| segment.distance_to(p1) <= TOL)
                && g.compose(&side.step).apply(self.t).distance(self.e) <= SUCCESS_TOL
            {
                return true;
            }
            for segment in &side.chain {
                for hit in segment.line_crossings(p0, p1, TOL) {
                    self.steps += 1;
                    // Only a crossing that leaves the cell (its interior is left of the chain)
                    // glues to the partner sheet.
                    if hit.u < u0 - TOL / length || hit.tangent.cross(direction) >= 0.0 {
                        continue;
                    }
                    let next = g.compose(&side.step);
                    if self.walk(&next, hit.u.max(u0), depth + 1) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

impl<T: Tessellation> Field<T> {
    /// A surface-distance evaluator for this field's active folds (`Strict` policy).
    pub fn surface_metric(&self) -> SurfaceMetric {
        SurfaceMetric::new(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rigid(reflects: bool, angle: f64, tx: f64, ty: f64) -> Affine {
        let (sin, cos) = angle.sin_cos();
        Affine::from_rigid(&RigidTransform {
            reflects,
            cos,
            sin,
            translation: Point::new(tx, ty),
        })
    }

    fn assert_near(a: Point, b: Point) {
        assert!(a.distance(b) < 1e-9, "{a:?} vs {b:?}");
    }

    #[test]
    fn affine_inverse_and_compose_undo_each_other() {
        let probe = Point::new(1.3, -0.7);
        for reflects in [false, true] {
            let g = rigid(reflects, 0.9, 2.0, -3.0);
            let h = rigid(!reflects, -2.1, 0.5, 4.0);
            assert_near(g.inverse().apply(g.apply(probe)), probe);
            assert_near(g.compose(&g.inverse()).apply(probe), probe);
            // `compose` applies the inner transform first.
            assert_near(g.compose(&h).apply(probe), g.apply(h.apply(probe)));
            // Isometries keep distances.
            let other = Point::new(-2.0, 5.0);
            let before = probe.distance(other);
            assert!((g.apply(probe).distance(g.apply(other)) - before).abs() < 1e-9);
        }
    }

    #[test]
    fn only_a_pure_translation_is_a_translation() {
        assert_eq!(
            Affine::translation(Point::new(4.0, 1.0)).as_translation(),
            Some(Point::new(4.0, 1.0))
        );
        assert_eq!(rigid(false, 0.3, 1.0, 0.0).as_translation(), None);
        assert_eq!(rigid(true, 0.0, 1.0, 0.0).as_translation(), None);
    }

    #[test]
    fn lattice_requires_integer_combinations_of_its_basis() {
        let v = |x: f64, y: f64| Point::new(x, y);
        assert!(matches!(
            Lattice::from_vectors(&[v(4.0, 0.0), v(-4.0, 0.0), v(8.0, 0.0)]),
            Some(Lattice::Line(_))
        ));
        assert!(matches!(
            Lattice::from_vectors(&[v(4.0, 0.0), v(0.0, 3.0), v(4.0, 3.0), v(-4.0, 0.0)]),
            Some(Lattice::Plane(..))
        ));
        // 2 is half of 4: the generated group is finer than the first vector's multiples.
        assert!(Lattice::from_vectors(&[v(4.0, 0.0), v(2.0, 0.0)]).is_none());
        assert!(Lattice::from_vectors(&[v(4.0, 0.0), v(0.0, 3.0), v(2.0, 1.5)]).is_none());
        assert!(Lattice::from_vectors(&[]).is_none());
    }

    #[test]
    fn lattice_near_lists_vectors_within_the_radius_nearest_first() {
        let lattice = Lattice::Plane(Point::new(4.0, 0.0), Point::new(0.0, 3.0));
        let w = Point::new(3.5, 2.0);
        let near = lattice.near(w, 2.0).unwrap();
        assert_eq!(near[0].0, Point::new(4.0, 3.0));
        assert!(near.windows(2).all(|pair| pair[0].1 <= pair[1].1));
        assert!(
            near.iter()
                .all(|&(v, dist)| dist < 2.0 && (w - v).length() == dist)
        );
        // Everything within the radius is listed, not only the nearest.
        let expected = (-3..=3)
            .flat_map(|i| (-3..=3).map(move |j| Point::new(4.0 * i as f64, 3.0 * j as f64)))
            .filter(|v| (w - *v).length() < 2.0)
            .count();
        assert_eq!(near.len(), expected);
    }

    #[test]
    fn lattice_near_gives_up_on_too_many_points() {
        let lattice = Lattice::Plane(Point::new(1.0, 0.0), Point::new(0.0, 1.0));
        assert!(lattice.near(Point::default(), 1e6).is_none());
        assert!(
            Lattice::Line(Point::new(1.0, 0.0))
                .near(Point::default(), 1e9)
                .is_none()
        );
        // A degenerate radius must not overflow either.
        assert!(lattice.near(Point::default(), f64::INFINITY).is_none());
    }

    #[test]
    fn words_are_distinct_and_exclude_the_identity() {
        let step = rigid(false, 0.5, 1.0, 0.0);
        let words = enumerate_words(&[step, step.inverse()]);
        let keys: HashSet<_> = words.iter().map(Affine::key).collect();
        assert_eq!(keys.len(), words.len());
        assert!(!keys.contains(&Affine::IDENTITY.key()));
        // Depth 3 of a single generator and its inverse: powers -3..=3 without 0.
        assert_eq!(words.len(), 6);
    }
}
