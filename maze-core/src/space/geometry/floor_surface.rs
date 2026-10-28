//! Surface distance across floors (GitHub issue #838, `Specs/topology.md`, "Floor distance").
//! `FloorMetrics` keeps one `SurfaceMetric` per floor of a `MultiLevelField` and answers the
//! floor-aware queries the geometric QC checks make.

use super::{DistanceError, DistancePolicy, DistanceResult, SurfaceMetric, WithinLimit};
use crate::comparison::Comparison;
use crate::space::{
    MultiLevelField, ScaledPoint, Tessellation, floor_aware_xy_distance, planar_distance,
};

/// One `SurfaceMetric` per floor, indexed like `MultiLevelField::level_index_of`. Holds interior
/// caches (see `SurfaceMetric`): build one per check run, not per query, and not across threads.
pub struct FloorMetrics {
    metrics: Vec<SurfaceMetric>,
}

impl FloorMetrics {
    pub fn new<T: Tessellation>(field: &MultiLevelField<T>, policy: DistancePolicy) -> Self {
        let metrics = field
            .levels_ordered()
            .filter_map(|level| field.field_of(level))
            .map(|floor| floor.surface_metric().with_policy(policy))
            .collect();
        Self { metrics }
    }

    /// The metric of the floor at `level` (`levels_ordered` position).
    pub fn floor(&self, level: usize) -> Option<&SurfaceMetric> {
        self.metrics.get(level)
    }

    /// Whether `level` has neither an isometric seam nor an unsupported fold, so its distance is
    /// the plain planar one.
    fn is_plain(&self, level: usize) -> bool {
        self.metrics
            .get(level)
            .is_none_or(|m| !m.has_seams() && !m.is_unsupported())
    }

    /// Floor-aware distance of two surface points in `cell_scale` units, the surface counterpart
    /// of `floor_aware_xy_distance`: `include_height` folds the floor difference in as a third
    /// coordinate, never as part of the surface path. A same-floor pair uses its floor's
    /// metric. A cross-floor pair has no single surface; its x/y part is the shorter of the two
    /// floors' surface distances (a seam on either floor makes the points closer in x/y).
    /// Without folds on the involved floors the result is exact and bit-identical to
    /// `floor_aware_xy_distance`.
    pub fn distance(
        &self,
        a_level: usize,
        a: ScaledPoint,
        b_level: usize,
        b: ScaledPoint,
        include_height: bool,
    ) -> Result<DistanceResult, DistanceError> {
        if self.is_plain(a_level) && self.is_plain(b_level) {
            return Ok(DistanceResult::exact(floor_aware_xy_distance(
                a_level,
                a,
                b_level,
                b,
                include_height,
            )));
        }
        let xy = match (self.metrics.get(a_level), self.metrics.get(b_level)) {
            (Some(ma), Some(mb)) if a_level != b_level => {
                let (ra, rb) = (ma.surface_distance(a, b)?, mb.surface_distance(a, b)?);
                let lower_bound = ra.lower_bound.min(rb.lower_bound);
                let upper_bound = ra.upper_bound.min(rb.upper_bound);
                DistanceResult {
                    lower_bound,
                    upper_bound,
                    exact: lower_bound == upper_bound && (ra.exact || rb.exact),
                }
            }
            (Some(m), _) | (None, Some(m)) => m.surface_distance(a, b)?,
            (None, None) => unreachable!("a plain pair returned above"),
        };
        if !include_height {
            return Ok(xy);
        }
        let dz = b_level as f64 - a_level as f64;
        let lift = |xy: f64| (xy.powi(2) + dz.powi(2)).sqrt();
        Ok(DistanceResult {
            lower_bound: lift(xy.lower_bound),
            upper_bound: lift(xy.upper_bound),
            exact: xy.exact,
        })
    }

    /// Floor-aware x/y distance for ranking candidates (never fails): the upper bound of
    /// `distance`, the planar distance when the floor has an unsupported fold. Bit-identical to
    /// `floor_aware_xy_distance` without folds.
    pub fn ranking_distance(
        &self,
        a_level: usize,
        a: ScaledPoint,
        b_level: usize,
        b: ScaledPoint,
    ) -> f64 {
        match self.distance(a_level, a, b_level, b, false) {
            Ok(result) => result.upper_bound,
            Err(_) => planar_distance(a, b),
        }
    }

    /// `distance <comparison> limit` as `Yes` / `No` / `Unknown` (`DistanceResult::compare`).
    #[allow(clippy::too_many_arguments)]
    pub fn compare(
        &self,
        a_level: usize,
        a: ScaledPoint,
        b_level: usize,
        b: ScaledPoint,
        include_height: bool,
        comparison: Comparison,
        limit: f64,
    ) -> Result<WithinLimit, DistanceError> {
        Ok(self
            .distance(a_level, a, b_level, b, include_height)?
            .compare(comparison, limit))
    }
}
