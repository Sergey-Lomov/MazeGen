use super::boundary::{bounds_of, polygon_contains};
use super::{GEOM_EPS, Point, Segment, TessellationGeometry};
use crate::space::Tessellation;

/// Which cells a point/region query may return. `Cells` restricts to a cell set (e.g. a field
/// level's cells, for selection and hit-testing), given sorted by `CellId` without duplicates;
/// `Space` is the whole tessellation space (e.g. the field editor adding cells outside the current
/// field). Out-of-scope candidates are never returned and never win a tie-break.
#[derive(Clone, Copy)]
pub enum CellScope<'a, C> {
    Space,
    Cells(&'a [C]),
}

impl<C: Ord> CellScope<'_, C> {
    fn includes(&self, cell: &C) -> bool {
        match self {
            CellScope::Space => true,
            CellScope::Cells(cells) => cells.binary_search(cell).is_ok(),
        }
    }
}

/// How `cells_in_region` matches a cell against the region. The tool picks the mode, never the
/// tessellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegionMode {
    /// Cell and region share at least one point, boundaries included.
    Intersects,
    /// The whole cell boundary lies inside the region.
    Contained,
    /// The cell's center lies inside the region.
    CenterInside,
}

/// Most candidate cells a whole-space region query examines — a region whose bounding box would
/// hold more is rejected before any candidate is built, so an oversized request (e.g. a selection drawn over a
/// zoomed-out canvas) fails fast instead of stalling. Roughly a quarter second of work.
pub const MAX_REGION_CANDIDATES: usize = 250_000;

/// A region query whose bounding box holds more than `limit` candidate cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegionTooLarge {
    pub limit: usize,
}

pub(super) fn cell_at<T: Tessellation + ?Sized>(
    tessellation: &T,
    point: Point,
    scope: CellScope<'_, T::CellId>,
) -> Option<T::CellId> {
    let margin = Point::new(GEOM_EPS, GEOM_EPS);
    tessellation
        .candidate_cells(point - margin, point + margin, usize::MAX)?
        .into_iter()
        .filter(|cell| scope.includes(cell))
        .filter(|&cell| tessellation.boundary_path(cell).contains(point))
        .min()
}

pub(super) fn cells_in_region<T: Tessellation + ?Sized>(
    tessellation: &T,
    region: &[Point],
    mode: RegionMode,
    scope: CellScope<'_, T::CellId>,
) -> Result<Vec<T::CellId>, RegionTooLarge> {
    if region.is_empty() {
        return Ok(Vec::new());
    }
    let region_edges: Vec<(Point, Point)> = region
        .iter()
        .zip(region.iter().cycle().skip(1))
        .map(|(&a, &b)| (a, b))
        .collect();
    let matching = |&cell: &T::CellId| matches(tessellation, cell, region, &region_edges, mode);
    match scope {
        // A cell-set scope is bounded by itself: examine its cells, whatever the region's size.
        CellScope::Cells(cells) => {
            debug_assert!(
                cells.windows(2).all(|w| w[0] < w[1]),
                "CellScope::Cells must be sorted without duplicates"
            );
            Ok(cells.iter().copied().filter(matching).collect())
        }
        CellScope::Space => {
            let (min, max) = bounds_of(region);
            let margin = Point::new(GEOM_EPS, GEOM_EPS);
            let mut cells: Vec<T::CellId> = tessellation
                .candidate_cells(min - margin, max + margin, MAX_REGION_CANDIDATES)
                .ok_or(RegionTooLarge {
                    limit: MAX_REGION_CANDIDATES,
                })?
                .into_iter()
                .filter(matching)
                .collect();
            cells.sort();
            cells.dedup();
            Ok(cells)
        }
    }
}

fn matches<T: Tessellation + ?Sized>(
    tessellation: &T,
    cell: T::CellId,
    region: &[Point],
    region_edges: &[(Point, Point)],
    mode: RegionMode,
) -> bool {
    if mode == RegionMode::CenterInside {
        return polygon_contains(region, tessellation.center(cell));
    }
    let boundary = tessellation.boundary_path(cell);
    let segments: Vec<Segment> = boundary.segments().copied().collect();
    // A closed chain's vertices are its segments' starts.
    let vertices = || segments.iter().map(Segment::start);
    match mode {
        RegionMode::Intersects => {
            vertices().any(|p| polygon_contains(region, p))
                || region.iter().any(|&p| boundary.contains(p))
                || segments
                    .iter()
                    .any(|s| region_edges.iter().any(|&(a, b)| s.touches_line(a, b)))
        }
        RegionMode::Contained => {
            vertices().all(|p| polygon_contains(region, p))
                && !segments
                    .iter()
                    .any(|s| region_edges.iter().any(|&(a, b)| s.crosses_line(a, b)))
                && !region.iter().any(|&p| {
                    boundary.contains(p) && segments.iter().all(|s| s.distance_to(p) > GEOM_EPS)
                })
        }
        RegionMode::CenterInside => unreachable!(),
    }
}
