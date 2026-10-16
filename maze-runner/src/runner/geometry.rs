//! Geometry snapshots and point queries over a tessellation instance (GitHub issue #759) — the
//! wire layer `maze-wasm` exports and the benchmark's geometry stage measures. See
//! `Specs/space.md`'s "Geometry snapshot lifecycle".

use super::tessellation_factory::{CellCodec, TessellationVisitor, build_tessellation};
use crate::config::TessellationConfig;
use maze_core::space::{
    BoundaryPath, CellScope, PathCommand, Point, RegionMode, Segment, Tessellation,
    TessellationGeometry, chain_midpoint,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Request for an immutable geometry snapshot of `cells`. `field_version` is the caller's field
/// version counter, echoed back so the caller can tell which field state a snapshot describes.
#[derive(Debug, Clone, Deserialize)]
pub struct GeometrySnapshotRequest {
    pub tessellation: TessellationConfig,
    pub cells: Vec<[i32; 2]>,
    /// `flatten` tolerance for `polyline`, in world units.
    pub tolerance: f64,
    pub field_version: u64,
}

/// A region snapshot bound to the tessellation instance (`instance`, the serialized config —
/// equal configs build equal instances) and the caller's `field_version`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GeometrySnapshot {
    pub instance: String,
    pub field_version: u64,
    pub cells: Vec<CellGeometry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CellGeometry {
    pub cell: [i32; 2],
    pub center: [f64; 2],
    pub cell_scale: f64,
    /// The boundary path's drawing commands.
    pub path: Vec<PathCommandDto>,
    /// The boundary flattened at the requested tolerance, first point not repeated.
    pub polyline: Vec<[f64; 2]>,
    /// One entry per face, in `faces_of` order.
    pub faces: Vec<FaceGeometry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FaceGeometry {
    pub contact_point: [f64; 2],
    /// The face's segments, counter-clockwise along this cell's boundary.
    pub segments: Vec<SegmentDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SegmentDto {
    Line {
        from: [f64; 2],
        to: [f64; 2],
    },
    Arc {
        from: [f64; 2],
        to: [f64; 2],
        center: [f64; 2],
        radius: f64,
        start_angle: f64,
        sweep: f64,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PathCommandDto {
    MoveTo {
        to: [f64; 2],
    },
    LineTo {
        to: [f64; 2],
    },
    ArcTo {
        center: [f64; 2],
        radius: f64,
        start_angle: f64,
        end_angle: f64,
        ccw: bool,
    },
}

/// Point query: the cell at `point` within `scope` (`None` = the whole tessellation space).
#[derive(Debug, Clone, Deserialize)]
pub struct CellAtRequest {
    pub tessellation: TessellationConfig,
    pub point: [f64; 2],
    pub scope: Option<Vec<[i32; 2]>>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegionModeDto {
    Intersects,
    Contained,
    CenterInside,
}

/// Region query: cells matching the closed polygon `region` under `mode`, within `scope`.
#[derive(Debug, Clone, Deserialize)]
pub struct CellsInRegionRequest {
    pub tessellation: TessellationConfig,
    pub region: Vec<[f64; 2]>,
    pub mode: RegionModeDto,
    pub scope: Option<Vec<[i32; 2]>>,
}

pub fn geometry_snapshot(request: &GeometrySnapshotRequest) -> Result<GeometrySnapshot, String> {
    // Also rejects NaN.
    if request.tolerance.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return Err(format!(
            "tolerance must be positive, got {}",
            request.tolerance
        ));
    }
    let cells = build_tessellation(&request.tessellation, Snapshot { request })??;
    Ok(GeometrySnapshot {
        instance: instance_key(&request.tessellation),
        field_version: request.field_version,
        cells,
    })
}

pub fn cell_at(request: &CellAtRequest) -> Result<Option<[i32; 2]>, String> {
    build_tessellation(&request.tessellation, CellAt { request })
}

/// `Err` also when an unscoped region's bounding box holds more than `MAX_REGION_CANDIDATES` cells —
/// the caller is expected to keep such requests within it; a scoped query examines only its cells.
pub fn cells_in_region(request: &CellsInRegionRequest) -> Result<Vec<[i32; 2]>, String> {
    build_tessellation(&request.tessellation, CellsInRegion { request })?
}

/// Identity of a tessellation instance: equal configs build equal instances.
fn instance_key(config: &TessellationConfig) -> String {
    serde_json::to_string(config).expect("tessellation config serializes")
}

/// Canonical edge key `(owner, owner_face)` — see `TessellationGeometry::edge_owner`.
type EdgeKey<T> = (<T as Tessellation>::CellId, <T as Tessellation>::Face);

struct Snapshot<'a> {
    request: &'a GeometrySnapshotRequest,
}

impl TessellationVisitor for Snapshot<'_> {
    type Output = Result<Vec<CellGeometry>, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        // Edge geometry is computed once per canonical edge key, and only for the requested cells.
        let mut edges: HashMap<EdgeKey<T>, (Vec<Segment>, Point)> = HashMap::new();
        let mut out = Vec::with_capacity(self.request.cells.len());
        for &[x, y] in &self.request.cells {
            let cell = (codec.from_xy)(x, y);
            if !tessellation.is_valid_cell(cell) {
                return Err(format!("invalid cell [{x}, {y}]"));
            }
            let mut faces = Vec::new();
            let mut face_segments = Vec::new();
            for &face in tessellation.faces_of(cell) {
                let key = tessellation.edge_owner(cell, face);
                let (owner_segments, contact) = edges.entry(key).or_insert_with(|| {
                    let segments = tessellation.face_segments(key.0, key.1);
                    let contact = chain_midpoint(&segments);
                    (segments, contact)
                });
                let segments: Vec<Segment> = if key.0 == cell {
                    owner_segments.clone()
                } else {
                    owner_segments.iter().rev().map(Segment::reversed).collect()
                };
                faces.push(FaceGeometry {
                    contact_point: xy(*contact),
                    segments: segments.iter().map(segment_dto).collect(),
                });
                face_segments.push(segments);
            }
            // Same chain as `boundary_path(cell)`, assembled from the cached edge geometry.
            let path = BoundaryPath::new(face_segments);
            out.push(CellGeometry {
                cell: [x, y],
                center: xy(tessellation.center(cell)),
                cell_scale: tessellation.cell_scale(cell),
                path: path.path_commands().iter().map(command_dto).collect(),
                polyline: path
                    .flatten(self.request.tolerance)
                    .into_iter()
                    .map(xy)
                    .collect(),
                faces,
            });
        }
        Ok(out)
    }
}

struct CellAt<'a> {
    request: &'a CellAtRequest,
}

impl TessellationVisitor for CellAt<'_> {
    type Output = Option<[i32; 2]>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let [px, py] = self.request.point;
        let scope_cells = scope_cells(&self.request.scope, codec);
        tessellation
            .cell_at(Point::new(px, py), scope(&scope_cells))
            .map(|cell| wire(cell, codec))
    }
}

struct CellsInRegion<'a> {
    request: &'a CellsInRegionRequest,
}

impl TessellationVisitor for CellsInRegion<'_> {
    type Output = Result<Vec<[i32; 2]>, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let region: Vec<Point> = self
            .request
            .region
            .iter()
            .map(|&[x, y]| Point::new(x, y))
            .collect();
        let mode = match self.request.mode {
            RegionModeDto::Intersects => RegionMode::Intersects,
            RegionModeDto::Contained => RegionMode::Contained,
            RegionModeDto::CenterInside => RegionMode::CenterInside,
        };
        let scope_cells = scope_cells(&self.request.scope, codec);
        let cells = tessellation
            .cells_in_region(&region, mode, scope(&scope_cells))
            .map_err(|e| format!("region too large: more than {} candidate cells", e.limit))?;
        Ok(cells.into_iter().map(|cell| wire(cell, codec)).collect())
    }
}

/// The request's scope cells, sorted and deduplicated as `CellScope::Cells` requires.
fn scope_cells<T: Tessellation>(
    scope: &Option<Vec<[i32; 2]>>,
    codec: CellCodec<T>,
) -> Option<Vec<T::CellId>> {
    scope.as_ref().map(|cells| {
        let mut cells: Vec<T::CellId> = cells.iter().map(|&[x, y]| (codec.from_xy)(x, y)).collect();
        cells.sort();
        cells.dedup();
        cells
    })
}

/// `Space` when the request names no scope, else the request's cell set.
fn scope<C>(scope_cells: &Option<Vec<C>>) -> CellScope<'_, C> {
    match scope_cells {
        Some(cells) => CellScope::Cells(cells),
        None => CellScope::Space,
    }
}

fn wire<T: Tessellation>(cell: T::CellId, codec: CellCodec<T>) -> [i32; 2] {
    let (x, y) = (codec.to_xy)(cell);
    [x, y]
}

fn xy(point: Point) -> [f64; 2] {
    [point.x, point.y]
}

fn segment_dto(segment: &Segment) -> SegmentDto {
    match *segment {
        Segment::Line { from, to } => SegmentDto::Line {
            from: xy(from),
            to: xy(to),
        },
        Segment::CircularArc {
            from,
            to,
            center,
            radius,
            start_angle,
            sweep,
        } => SegmentDto::Arc {
            from: xy(from),
            to: xy(to),
            center: xy(center),
            radius,
            start_angle,
            sweep,
        },
    }
}

fn command_dto(command: &PathCommand) -> PathCommandDto {
    match *command {
        PathCommand::MoveTo(to) => PathCommandDto::MoveTo { to: xy(to) },
        PathCommand::LineTo(to) => PathCommandDto::LineTo { to: xy(to) },
        PathCommand::ArcTo {
            center,
            radius,
            start_angle,
            end_angle,
            ccw,
        } => PathCommandDto::ArcTo {
            center: xy(center),
            radius,
            start_angle,
            end_angle,
            ccw,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TessellationKind;

    fn config(kind: TessellationKind) -> TessellationConfig {
        TessellationConfig {
            kind,
            params: serde_json::Map::new(),
        }
    }

    fn request(kind: TessellationKind, cells: Vec<[i32; 2]>) -> GeometrySnapshotRequest {
        GeometrySnapshotRequest {
            tessellation: config(kind),
            cells,
            tolerance: 0.01,
            field_version: 7,
        }
    }

    #[test]
    fn snapshot_is_bound_to_instance_and_field_version() {
        let snapshot = geometry_snapshot(&request(TessellationKind::Square, vec![[0, 0]])).unwrap();
        assert_eq!(snapshot.field_version, 7);
        assert_eq!(snapshot.instance, r#"{"kind":"square","params":{}}"#);
        let cell = &snapshot.cells[0];
        assert_eq!(cell.center, [0.5, 0.5]);
        assert_eq!(cell.cell_scale, 1.0);
        assert_eq!(cell.path.len(), 5);
        assert_eq!(cell.polyline.len(), 4);
        assert_eq!(
            cell.faces[0],
            FaceGeometry {
                contact_point: [1.0, 0.5],
                segments: vec![SegmentDto::Line {
                    from: [1.0, 0.0],
                    to: [1.0, 1.0]
                }],
            }
        );
    }

    /// The snapshot assembles each cell from cached edge geometry; it must equal the core's
    /// per-cell answers, from both sides of every shared face.
    struct CoreGeometry;

    impl TessellationVisitor for CoreGeometry {
        type Output = Vec<CellGeometry>;

        fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
            let mut cells = Vec::new();
            for y in -3..=3 {
                for x in -3..=3 {
                    let cell = (codec.from_xy)(x, y);
                    if !tessellation.is_valid_cell(cell) {
                        continue;
                    }
                    let path = tessellation.boundary_path(cell);
                    let faces = tessellation
                        .faces_of(cell)
                        .iter()
                        .map(|&face| FaceGeometry {
                            contact_point: xy(tessellation.contact_point(cell, face)),
                            segments: tessellation
                                .edge_segments(cell, face)
                                .iter()
                                .map(segment_dto)
                                .collect(),
                        })
                        .collect();
                    cells.push(CellGeometry {
                        cell: [x, y],
                        center: xy(tessellation.center(cell)),
                        cell_scale: tessellation.cell_scale(cell),
                        path: path.path_commands().iter().map(command_dto).collect(),
                        polyline: path.flatten(0.01).into_iter().map(xy).collect(),
                        faces,
                    });
                }
            }
            cells
        }
    }

    #[test]
    fn snapshot_equals_the_core_per_cell_geometry() {
        for kind in [
            TessellationKind::Square,
            TessellationKind::Hex,
            TessellationKind::Tri,
            TessellationKind::Cairo,
        ] {
            let expected = build_tessellation(&config(kind), CoreGeometry).unwrap();
            let cells = expected.iter().map(|cell| cell.cell).collect();
            let snapshot = geometry_snapshot(&request(kind, cells)).unwrap();
            assert_eq!(snapshot.cells, expected, "{kind:?}");
        }
    }

    #[test]
    fn snapshot_rejects_invalid_cells_and_tolerance() {
        assert!(geometry_snapshot(&request(TessellationKind::Cairo, vec![[0, 0]])).is_err());
        let mut bad = request(TessellationKind::Square, vec![[0, 0]]);
        bad.tolerance = 0.0;
        assert!(geometry_snapshot(&bad).is_err());
    }

    #[test]
    fn point_queries_respect_scope() {
        let at = |scope| {
            cell_at(&CellAtRequest {
                tessellation: config(TessellationKind::Square),
                point: [1.0, 1.0],
                scope,
            })
            .unwrap()
        };
        assert_eq!(at(None), Some([0, 0]));
        assert_eq!(at(Some(vec![[1, 1], [0, 1]])), Some([0, 1]));
        let region = cells_in_region(&CellsInRegionRequest {
            tessellation: config(TessellationKind::Square),
            region: vec![[0.2, 0.2], [1.8, 0.2], [1.8, 0.8], [0.2, 0.8]],
            mode: RegionModeDto::CenterInside,
            scope: None,
        })
        .unwrap();
        assert_eq!(region, vec![[0, 0], [1, 0]]);
        let huge = cells_in_region(&CellsInRegionRequest {
            tessellation: config(TessellationKind::Square),
            region: vec![[-1e4, -1e4], [1e4, -1e4], [1e4, 1e4], [-1e4, 1e4]],
            mode: RegionModeDto::Intersects,
            scope: None,
        });
        assert!(huge.is_err());
    }
}
