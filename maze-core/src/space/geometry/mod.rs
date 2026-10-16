//! Geometry API over `Tessellation` — see `Specs/space.md`'s "Geometry" (GitHub issue #759).
//!
//! Coordinates are world units in math convention (x right, y up, counter-clockwise positive),
//! with no display orientation, Y flip or pixel scale. A tessellation supplies four primitives
//! (`Tessellation::center`, `face_segments`, `candidate_cells` and `area`, which defaults to the
//! boundary's signed area);
//! everything else — canonical edge geometry, boundary paths, contact points, scale, point and
//! region queries — is derived here, identically for every tessellation, by the
//! `TessellationGeometry` extension trait.

mod boundary;
mod point;
mod query;
mod segment;
#[cfg(test)]
mod tests;

pub use boundary::{BoundaryPath, chain_midpoint};
pub use point::Point;
pub use query::{CellScope, MAX_REGION_CANDIDATES, RegionMode, RegionTooLarge};
pub use segment::{PathCommand, Segment};

use super::Tessellation;

/// The single world-unit tolerance for every geometric equality, containment and boundary test.
/// Distinct from `STRAIGHT_TOLERANCE` (relative, angular) and from a caller's `flatten` tolerance.
pub const GEOM_EPS: f64 = 1e-9;

/// Relative tolerance of the geometric `is_straight` definition — absorbs floating-point noise
/// only; it is not an "almost straight" threshold.
pub const STRAIGHT_TOLERANCE: f64 = 1e-6;

/// Derived geometry queries, available on every `Tessellation` (blanket impl). See the module
/// doc comment and `Specs/space.md`.
pub trait TessellationGeometry: Tessellation {
    /// The owner side of the boundary piece `(cell, face)`: the side with the smaller `CellId`
    /// (a face with no neighbor is owned by its cell). Edge geometry is always computed from it.
    fn edge_owner(&self, cell: Self::CellId, face: Self::Face) -> (Self::CellId, Self::Face) {
        match self.neighbor(cell, face) {
            Some((other, other_face)) if other < cell => (other, other_face),
            _ => (cell, face),
        }
    }

    /// The segments of `face`, running counter-clockwise along `cell`'s boundary. Computed from
    /// the canonical edge key, so both sides of a face get the same segments (the non-owner side
    /// reversed) — paired faces are identical as segments and as flattened polylines.
    fn edge_segments(&self, cell: Self::CellId, face: Self::Face) -> Vec<Segment> {
        let (owner, owner_face) = self.edge_owner(cell, face);
        let segments = self.face_segments(owner, owner_face);
        if owner == cell {
            segments
        } else {
            segments.iter().rev().map(Segment::reversed).collect()
        }
    }

    /// `cell`'s closed boundary: each face's segments in `faces_of` order.
    fn boundary_path(&self, cell: Self::CellId) -> BoundaryPath {
        BoundaryPath::new(
            self.faces_of(cell)
                .iter()
                .map(|&face| self.edge_segments(cell, face))
                .collect(),
        )
    }

    /// The point where a corridor crosses `face`: the arc-length midpoint of the face's segment
    /// chain, computed on the owner side so it is identical from both sides of the face.
    fn contact_point(&self, cell: Self::CellId, face: Self::Face) -> Point {
        let (owner, owner_face) = self.edge_owner(cell, face);
        chain_midpoint(&self.face_segments(owner, owner_face))
    }

    /// `sqrt(area(cell))` — the unit distance-based QC thresholds are expressed in.
    fn cell_scale(&self, cell: Self::CellId) -> f64 {
        self.area(cell).sqrt()
    }

    /// The in-scope cell whose closed boundary contains `point` (within `GEOM_EPS`); on shared
    /// boundaries and vertices the minimal `CellId` among in-scope candidates wins.
    fn cell_at(&self, point: Point, scope: CellScope<'_, Self::CellId>) -> Option<Self::CellId> {
        query::cell_at(self, point, scope)
    }

    /// Every in-scope cell matching `region` (a closed polygon) under `mode`, sorted by `CellId`.
    /// With `CellScope::Space`, `Err` when the region's bounding box holds more than
    /// `MAX_REGION_CANDIDATES` cells; a `Cells` scope examines only its own cells.
    fn cells_in_region(
        &self,
        region: &[Point],
        mode: RegionMode,
        scope: CellScope<'_, Self::CellId>,
    ) -> Result<Vec<Self::CellId>, RegionTooLarge> {
        query::cells_in_region(self, region, mode, scope)
    }
}

impl<T: Tessellation + ?Sized> TessellationGeometry for T {}

/// The geometric definition of `Tessellation::is_straight` (`Specs/space.md`): with `A` the
/// contact point of `in_face`, `C` the center of `cell` and `B` the contact point of `out_face`,
/// straight iff the faces differ, `dot(C − A, B − C) > 0` and
/// `|cross(C − A, B − C)| <= STRAIGHT_TOLERANCE · |C − A| · |B − C|`. Tessellations answer
/// `is_straight` from tables; tests check every table against this.
pub fn is_straight_geometric<T: Tessellation>(
    tessellation: &T,
    cell: T::CellId,
    in_face: T::Face,
    out_face: T::Face,
) -> bool {
    if in_face == out_face {
        return false;
    }
    let a = tessellation.contact_point(cell, in_face);
    let c = tessellation.center(cell);
    let b = tessellation.contact_point(cell, out_face);
    let (incoming, outgoing) = (c - a, b - c);
    incoming.dot(outgoing) > 0.0
        && incoming.cross(outgoing).abs()
            <= STRAIGHT_TOLERANCE * incoming.length() * outgoing.length()
}
