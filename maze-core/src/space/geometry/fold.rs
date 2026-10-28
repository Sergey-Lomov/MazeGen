//! Fold-aware geometry (GitHub issue #833, `Specs/topology.md` and `Specs/space.md`): a face glued
//! by an active fold has no ordinary partner, so each side computes its own segments and contact
//! point; a fold is classified as isometric (its two faces coincide after a rigid transform) or
//! topological-only.

use super::{GEOM_EPS, Point, Segment, TessellationGeometry, chain_midpoint};
use crate::space::topology::{Fold, FoldEnd, FoldId, FoldSide};
use crate::space::{Field, Tessellation};

/// World-unit tolerance of the isometry test. Looser than `GEOM_EPS`: the transform is built from
/// trigonometry, so coincident geometry differs by rounding noise a few ulps wide.
pub const FOLD_ISOMETRY_EPS: f64 = 100.0 * GEOM_EPS;

/// Parameters at which two segments are compared. With the endpoints and the kind agreeing,
/// three points of an arc fix its circle, so five samples also pin the curvature.
const SAMPLES: [f64; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];

/// A plane isometry: an optional reflection across the x axis, then a rotation, then a
/// translation. `reflects` is `true` for a twisted fold (it flips chirality).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RigidTransform {
    pub reflects: bool,
    pub cos: f64,
    pub sin: f64,
    pub translation: Point,
}

impl RigidTransform {
    pub fn apply(&self, point: Point) -> Point {
        let p = if self.reflects {
            Point::new(point.x, -point.y)
        } else {
            point
        };
        Point::new(
            self.cos * p.x - self.sin * p.y + self.translation.x,
            self.sin * p.x + self.cos * p.y + self.translation.y,
        )
    }

    /// The transform undoing this one.
    pub fn inverse(&self) -> RigidTransform {
        // x = M(Rᵀ(y − t)) with M the optional reflection, and M·Rᵀ = R·M when `reflects`.
        let (cos, sin) = (self.cos, if self.reflects { self.sin } else { -self.sin });
        let t = self.translation;
        let rotated = Point::new(cos * t.x - sin * t.y, sin * t.x + cos * t.y);
        let translation = if self.reflects {
            Point::new(-rotated.x, rotated.y)
        } else {
            -rotated
        };
        RigidTransform {
            reflects: self.reflects,
            cos,
            sin,
            translation,
        }
    }

    /// The affine matrix `[a, b, c, d, e, f]` with `x' = a·x + c·y + e`, `y' = b·x + d·y + f`
    /// (the layout of canvas `setTransform`).
    pub fn matrix(&self) -> [f64; 6] {
        let flip = if self.reflects { -1.0 } else { 1.0 };
        [
            self.cos,
            self.sin,
            -self.sin * flip,
            self.cos * flip,
            self.translation.x,
            self.translation.y,
        ]
    }
}

/// How the two faces of a fold relate geometrically.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FoldClass {
    /// `transform` maps the geometry of side `b` onto the geometry of side `a`, endpoints
    /// corresponding as the fold's `twist` says.
    Isometric { transform: RigidTransform },
    /// The faces differ in shape or size: the fold only joins topology and is not passed to a
    /// distance algorithm.
    TopologicalOnly,
}

/// The fold glued at a face and the face it is glued to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FoldedFace<C> {
    pub fold: FoldId,
    pub side: FoldSide,
    pub partner: FoldEnd<C>,
    pub twist: bool,
}

/// The chain of side `b` traversed in the direction of side `a`'s chain: reversed for an
/// untwisted fold (the ordinary orientation-reversing match), as is for a twisted one.
fn partner_chain(b: &[Segment], twist: bool) -> Vec<Segment> {
    if twist {
        b.to_vec()
    } else {
        b.iter().rev().map(Segment::reversed).collect()
    }
}

fn segments_match(
    transform: &RigidTransform,
    source: &[Segment],
    target: &[Segment],
    tolerance: f64,
) -> bool {
    source.len() == target.len()
        && source.iter().zip(target).all(|(s, t)| {
            let same_kind = match (s, t) {
                (Segment::Line { .. }, Segment::Line { .. }) => true,
                (
                    Segment::CircularArc { radius: rs, .. },
                    Segment::CircularArc { radius: rt, .. },
                ) => (rs - rt).abs() <= tolerance,
                _ => false,
            };
            same_kind
                && SAMPLES
                    .iter()
                    .all(|&u| transform.apply(s.point(u)).distance(t.point(u)) <= tolerance)
        })
}

/// Classifies the fold gluing the unpaired face geometry `a` (counter-clockwise along its cell)
/// to `b`. Isometric iff one rigid transform maps the whole chain `b` — segment kinds, positions
/// and curvature — onto `a`; a length match alone is not enough.
///
/// The endpoint correspondence follows `twist`: untwisted, `a`'s start meets `b`'s end and the
/// transform preserves orientation (the glued cells end up on opposite sides); twisted, the
/// starts meet and the transform reflects.
pub fn classify_fold_faces(a: &[Segment], b: &[Segment], twist: bool) -> FoldClass {
    let (Some(a_first), Some(a_last)) = (a.first(), a.last()) else {
        return FoldClass::TopologicalOnly;
    };
    let source = partner_chain(b, twist);
    let (Some(s_first), Some(s_last)) = (source.first(), source.last()) else {
        return FoldClass::TopologicalOnly;
    };
    let (raw_s0, raw_s1) = (s_first.start(), s_last.end());
    let reflect = |p: Point| if twist { Point::new(p.x, -p.y) } else { p };
    let (t0, t1) = (a_first.start(), a_last.end());
    let (u, v) = (reflect(raw_s1) - reflect(raw_s0), t1 - t0);
    if u.length() <= FOLD_ISOMETRY_EPS
        || v.length() <= FOLD_ISOMETRY_EPS
        || (u.length() - v.length()).abs() > FOLD_ISOMETRY_EPS
    {
        return FoldClass::TopologicalOnly;
    }
    let angle = v.angle() - u.angle();
    let (sin, cos) = angle.sin_cos();
    let mut transform = RigidTransform {
        reflects: twist,
        cos,
        sin,
        translation: Point::default(),
    };
    transform.translation = t0 - transform.apply(raw_s0);
    if segments_match(&transform, &source, a, FOLD_ISOMETRY_EPS) {
        FoldClass::Isometric { transform }
    } else {
        FoldClass::TopologicalOnly
    }
}

impl<T: Tessellation> Field<T> {
    /// The active fold glued at `(cell, face)`, with the partner end. `None` for an ordinary
    /// face and for a face of an inactive fold.
    pub fn folded_face(&self, cell: T::CellId, face: T::Face) -> Option<FoldedFace<T::CellId>> {
        let resolved = self.topology.as_ref().filter(|r| r.has_links())?;
        let idx = self
            .tessellation()
            .faces_of(cell)
            .iter()
            .position(|&f| f == face)?;
        let (fold_id, fold, side) = resolved.active_fold_at(cell, idx)?;
        let partner = match side {
            FoldSide::A => fold.b,
            FoldSide::B => fold.a,
        };
        Some(FoldedFace {
            fold: fold_id,
            side,
            partner,
            twist: fold.twist,
        })
    }

    /// `TessellationGeometry::edge_owner`, except that a folded face has no partner and owns
    /// itself.
    pub fn edge_owner(&self, cell: T::CellId, face: T::Face) -> (T::CellId, T::Face) {
        if self.folded_face(cell, face).is_some() {
            (cell, face)
        } else {
            self.tessellation().edge_owner(cell, face)
        }
    }

    /// `TessellationGeometry::edge_segments`, except that a folded face computes its own
    /// segments, counter-clockwise along its cell, with no pairing to the other side.
    pub fn edge_segments(&self, cell: T::CellId, face: T::Face) -> Vec<Segment> {
        if self.folded_face(cell, face).is_some() {
            self.tessellation().face_segments(cell, face)
        } else {
            self.tessellation().edge_segments(cell, face)
        }
    }

    /// `TessellationGeometry::contact_point`, except that a folded face uses its own segments.
    pub fn contact_point(&self, cell: T::CellId, face: T::Face) -> Point {
        if self.folded_face(cell, face).is_some() {
            chain_midpoint(&self.tessellation().face_segments(cell, face))
        } else {
            self.tessellation().contact_point(cell, face)
        }
    }

    /// Geometric classification of an active fold; `None` for an unknown or inactive fold.
    pub fn fold_class(&self, fold: FoldId) -> Option<FoldClass> {
        let resolved = self.topology.as_ref()?;
        if !resolved.activity.get(fold.0)?.is_active() {
            return None;
        }
        let fold = resolved.topology.fold(fold)?;
        Some(self.classify(fold))
    }

    fn classify(&self, fold: &Fold<T::CellId>) -> FoldClass {
        let tessellation = self.tessellation();
        let chain = |end: FoldEnd<T::CellId>| {
            let face = tessellation.faces_of(end.cell)[end.face_idx];
            tessellation.face_segments(end.cell, face)
        };
        classify_fold_faces(&chain(fold.a), &chain(fold.b), fold.twist)
    }
}
