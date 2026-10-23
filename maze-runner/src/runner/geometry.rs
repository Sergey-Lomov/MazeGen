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
    /// Which representation of each cell's boundary to return.
    pub boundary: BoundaryRequest,
    pub field_version: u64,
}

/// The boundary representation a snapshot carries: one per request, never both.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BoundaryRequest {
    /// Exact drawing commands, arcs included; the caller decides how to flatten them.
    Path,
    /// The boundary flattened at `tolerance` (world units).
    Polyline { tolerance: f64 },
}

/// A region snapshot bound to the tessellation instance (`instance`, the serialized config —
/// equal configs build equal instances) and the caller's `field_version`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GeometrySnapshot {
    pub instance: String,
    pub field_version: u64,
    pub cells: Vec<CellGeometry>,
}

fn allowed_group(shape: maze_core::space::shape::CellShape) -> Vec<Vec<usize>> {
    shape
        .allowed_transforms()
        .iter()
        .map(|&transform| shape.descriptor().group()[transform].clone())
        .collect()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CellGeometry {
    pub cell: [i32; 2],
    pub center: [f64; 2],
    pub cell_scale: f64,
    /// The key of the cell's shape template (`ShapeDescriptor::key`); `None` for a cell without
    /// one.
    pub shape: Option<String>,
    /// The cell's allowed transform group: one permutation of canonical face indices per allowed
    /// transform (`CellShape::allowed_transforms` resolved through `ShapeDescriptor::group`),
    /// identity first; `None` for a cell without a shape template.
    pub allowed_group: Option<Vec<Vec<usize>>>,
    pub boundary: BoundaryDto,
    /// One entry per face, in `faces_of` order.
    pub faces: Vec<FaceGeometry>,
}

/// A cell's boundary in the representation the request asked for.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BoundaryDto {
    /// The boundary path's drawing commands.
    Path { commands: Vec<PathCommandDto> },
    /// The boundary flattened at the requested tolerance, first point not repeated.
    Polyline { points: Vec<[f64; 2]> },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FaceGeometry {
    /// The cell across this face (`Tessellation::neighbor`), `None` at the tessellation's edge.
    /// It is a neighbor in the tessellation, not necessarily a cell of the caller's field.
    pub neighbor: Option<[i32; 2]>,
    /// This face's index in the cell's shape template (`CellShape::canonical_of_local`), the
    /// index split patterns use; `None` for a cell without a template.
    pub canonical_face: Option<usize>,
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
    if let BoundaryRequest::Polyline { tolerance } = request.boundary {
        // Also rejects NaN.
        if tolerance.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            return Err(format!("tolerance must be positive, got {tolerance}"));
        }
    }
    let cells = build_tessellation(&request.tessellation, Snapshot { request })??;
    Ok(GeometrySnapshot {
        instance: instance_key(&request.tessellation),
        field_version: request.field_version,
        cells,
    })
}

/// `Err` when `scope` names a point that is not a cell.
pub fn cell_at(request: &CellAtRequest) -> Result<Option<[i32; 2]>, String> {
    build_tessellation(&request.tessellation, CellAt { request })?
}

/// `Err` when `scope` names a point that is not a cell, and also when an unscoped region's bounding box holds more than `MAX_REGION_CANDIDATES` cells —
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
        for cell in codec.decode_valid(&*tessellation, &self.request.cells)? {
            let mut faces = Vec::new();
            let mut face_segments = Vec::new();
            let shape = tessellation.shape_of(cell);
            for (local, &face) in tessellation.faces_of(cell).iter().enumerate() {
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
                    neighbor: tessellation
                        .neighbor(cell, face)
                        .map(|(neighbor, _)| wire(neighbor, codec)),
                    canonical_face: shape.map(|shape| shape.canonical_of_local(local)),
                    contact_point: xy(*contact),
                    segments: segments.iter().map(segment_dto).collect(),
                });
                face_segments.push(segments);
            }
            // Same chain as `boundary_path(cell)`, assembled from the cached edge geometry.
            let path = BoundaryPath::new(face_segments);
            out.push(CellGeometry {
                cell: wire(cell, codec),
                center: xy(tessellation.center(cell)),
                cell_scale: tessellation.cell_scale(cell),
                shape: shape.map(|shape| shape.descriptor().key().to_string()),
                allowed_group: shape.map(allowed_group),
                boundary: boundary_dto(&path, self.request.boundary),
                faces,
            });
        }
        Ok(out)
    }
}

fn boundary_dto(path: &BoundaryPath, request: BoundaryRequest) -> BoundaryDto {
    match request {
        BoundaryRequest::Path => BoundaryDto::Path {
            commands: path.path_commands().iter().map(command_dto).collect(),
        },
        BoundaryRequest::Polyline { tolerance } => BoundaryDto::Polyline {
            points: path.flatten(tolerance).into_iter().map(xy).collect(),
        },
    }
}

struct CellAt<'a> {
    request: &'a CellAtRequest,
}

impl TessellationVisitor for CellAt<'_> {
    type Output = Result<Option<[i32; 2]>, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let [px, py] = self.request.point;
        let scope_cells = scope_cells(&self.request.scope, &*tessellation, codec)?;
        Ok(tessellation
            .cell_at(Point::new(px, py), scope(&scope_cells))
            .map(|cell| wire(cell, codec)))
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
        let scope_cells = scope_cells(&self.request.scope, &*tessellation, codec)?;
        let cells = tessellation
            .cells_in_region(&region, mode, scope(&scope_cells))
            .map_err(|e| format!("region too large: more than {} candidate cells", e.limit))?;
        Ok(cells.into_iter().map(|cell| wire(cell, codec)).collect())
    }
}

/// The request's scope cells, validated, sorted and deduplicated as `CellScope::Cells` requires.
fn scope_cells<T: Tessellation>(
    scope: &Option<Vec<[i32; 2]>>,
    tessellation: &T,
    codec: CellCodec<T>,
) -> Result<Option<Vec<T::CellId>>, String> {
    scope
        .as_ref()
        .map(|cells| {
            let mut cells = codec.decode_valid(tessellation, cells)?;
            cells.sort();
            cells.dedup();
            Ok(cells)
        })
        .transpose()
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

    const POLYLINE: BoundaryRequest = BoundaryRequest::Polyline { tolerance: 0.01 };

    fn request(kind: TessellationKind, cells: Vec<[i32; 2]>) -> GeometrySnapshotRequest {
        request_with(kind, cells, POLYLINE)
    }

    fn request_with(
        kind: TessellationKind,
        cells: Vec<[i32; 2]>,
        boundary: BoundaryRequest,
    ) -> GeometrySnapshotRequest {
        GeometrySnapshotRequest {
            tessellation: config(kind),
            cells,
            boundary,
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
        assert_eq!(cell.shape.as_deref(), Some("regular:4"));
        let group = cell
            .allowed_group
            .as_ref()
            .expect("square cell has a group");
        assert_eq!(group.len(), 8);
        assert_eq!(group[0], vec![0, 1, 2, 3]);
        let BoundaryDto::Polyline { points } = &cell.boundary else {
            panic!("a polyline request returns a polyline");
        };
        assert_eq!(points.len(), 4);
        assert_eq!(
            cell.faces[0],
            FaceGeometry {
                neighbor: Some([1, 0]),
                canonical_face: Some(0),
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
                    let shape = tessellation.shape_of(cell);
                    let faces = tessellation
                        .faces_of(cell)
                        .iter()
                        .enumerate()
                        .map(|(local, &face)| FaceGeometry {
                            neighbor: tessellation
                                .neighbor(cell, face)
                                .map(|(neighbor, _)| wire(neighbor, codec)),
                            canonical_face: shape.map(|shape| shape.canonical_of_local(local)),
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
                        shape: shape.map(|shape| shape.descriptor().key().to_string()),
                        allowed_group: shape.map(allowed_group),
                        boundary: BoundaryDto::Polyline {
                            points: path.flatten(0.01).into_iter().map(xy).collect(),
                        },
                        faces,
                    });
                }
            }
            cells
        }
    }

    #[test]
    fn snapshot_carries_only_the_requested_boundary() {
        let path = geometry_snapshot(&request_with(
            TessellationKind::Square,
            vec![[0, 0]],
            BoundaryRequest::Path,
        ))
        .unwrap();
        let BoundaryDto::Path { commands } = &path.cells[0].boundary else {
            panic!("a path request returns a path");
        };
        assert_eq!(commands.len(), 5);
    }

    #[test]
    fn snapshot_equals_the_core_per_cell_geometry() {
        for kind in [
            TessellationKind::Square,
            TessellationKind::Hex,
            TessellationKind::Tri,
            TessellationKind::Cairo,
            TessellationKind::SquareOctagon,
            TessellationKind::Brick,
            TessellationKind::Trihexagonal,
            TessellationKind::SnubHexagonal,
            TessellationKind::SnubSquare,
            TessellationKind::Rhombitrihexagonal,
            TessellationKind::TruncatedHexagonal,
            TessellationKind::TruncatedTrihexagonal,
            TessellationKind::ElongatedTriangular,
            TessellationKind::CurvedQuadrilateral,
        ] {
            let expected = build_tessellation(&config(kind), CoreGeometry).unwrap();
            let cells = expected.iter().map(|cell| cell.cell).collect();
            let snapshot = geometry_snapshot(&request(kind, cells)).unwrap();
            assert_eq!(snapshot.cells, expected, "{kind:?}");
        }
    }

    #[test]
    fn radial_snapshot_equals_the_core_per_cell_geometry() {
        let mut cfg = config(TessellationKind::Radial);
        cfg.params.insert("first_ring_cells".to_string(), 9.into());
        cfg.params.insert("max_cells".to_string(), 3000.into());
        cfg.params
            .insert("ring_layout".to_string(), "smooth".into());
        let expected = build_tessellation(&cfg, CoreGeometry).unwrap();
        let cells = expected.iter().map(|cell| cell.cell).collect();
        let mut request = request(TessellationKind::Radial, cells);
        request.tessellation = cfg;
        assert_eq!(geometry_snapshot(&request).unwrap().cells, expected);
    }

    #[test]
    fn snapshot_rejects_invalid_cells_and_tolerance() {
        assert!(geometry_snapshot(&request(TessellationKind::Cairo, vec![[0, 0]])).is_err());
        for tolerance in [0.0, -1.0, f64::NAN] {
            let bad = request_with(
                TessellationKind::Square,
                vec![[0, 0]],
                BoundaryRequest::Polyline { tolerance },
            );
            assert!(geometry_snapshot(&bad).is_err());
        }
        // A path request has no tolerance to reject.
        let path = request_with(
            TessellationKind::Square,
            vec![[0, 0]],
            BoundaryRequest::Path,
        );
        assert!(geometry_snapshot(&path).is_ok());
    }

    #[test]
    fn point_queries_reject_a_non_cell_scope_point() {
        let square_octagon = || config(TessellationKind::SquareOctagon);
        let scope = Some(vec![[0, 0], [1, 2]]);
        let expected = Err("invalid cell [1, 2]".to_string());
        assert_eq!(
            cell_at(&CellAtRequest {
                tessellation: square_octagon(),
                point: [0.5, 0.5],
                scope: scope.clone(),
            }),
            expected
        );
        assert_eq!(
            cells_in_region(&CellsInRegionRequest {
                tessellation: square_octagon(),
                region: vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]],
                mode: RegionModeDto::Intersects,
                scope,
            }),
            Err("invalid cell [1, 2]".to_string())
        );
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
