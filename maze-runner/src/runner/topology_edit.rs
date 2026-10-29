//! Wire layer of topology authoring (GitHub issue #839, `Specs/topology.md`, "Web authoring"):
//! stateless queries and transactional edits over one floor's topology, which `maze-wasm` exports.
//! The caller sends the floor's cell set and current topology; core does all validation and the
//! result is the whole new topology (no partial seams), or an error naming the reason.

use super::tessellation_factory::{CellCodec, TessellationVisitor, build_tessellation};
use crate::config::TessellationConfig;
use crate::topology_wire::{
    FoldEndDto, TopologyDto, decode_topology, encode_topology, tessellation_fingerprint,
};
use maze_core::ids::IdGenerator;
use maze_core::space::{
    Field, FoldActivity, FoldEnd, FoldGroupId, InactiveReason, NewFold, Tessellation,
    TessellationFingerprint, Topology, TopologyEditError, TopologyError, boundary_contours,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// The floor a topology request is about: the tessellation, the floor's whole cell set and its
/// current topology (`None` = no folds).
#[derive(Debug, Clone, Deserialize)]
pub struct TopologyFloor {
    pub tessellation: TessellationConfig,
    pub field_cells: Vec<[i32; 2]>,
    #[serde(default)]
    pub topology: Option<TopologyDto>,
}

/// One edit; every variant is applied as a whole or not at all.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TopologyOp {
    /// Glues two boundary runs, face by face, as a new group, or, with `replace`, in place of
    /// that existing group (keeping its id and position).
    Glue {
        a: Vec<FoldEndDto>,
        b: Vec<FoldEndDto>,
        twist: bool,
        #[serde(default)]
        replace: Option<u32>,
    },
    RemoveGroup {
        id: u32,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct TopologyEditRequest {
    #[serde(flatten)]
    pub floor: TopologyFloor,
    pub op: TopologyOp,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TopologyEditResult {
    pub topology: TopologyDto,
    /// Id of the group the edit created; `None` for remove / replace.
    pub group: Option<u32>,
}

/// Activity of one fold, in `topology.folds` order.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum FoldActivityDto {
    Active,
    Inactive { reason: InactiveReasonDto },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InactiveReasonDto {
    MissingCell,
    InteriorNeighbor,
    DuplicateNeighbor,
}

/// Why an edit was refused, in a form the client can translate and point at the
/// problem sides with. Serialized as JSON into the error string of `topology_edit`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum TopologyErrorDto {
    EmptyRun,
    RunLengthMismatch {
        a: usize,
        b: usize,
    },
    OpenContour {
        face: FoldEndDto,
    },
    /// A fold of the resulting topology glues nothing; `existing` tells a fold the floor already
    /// had from one the edit adds.
    InactiveFold {
        reason: InactiveReasonDto,
        a: FoldEndDto,
        b: FoldEndDto,
        existing: bool,
        /// For a duplicate neighbor: every other connection between the two cells (shared faces
        /// and earlier folds), each as the two faces it joins.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        connections: Vec<[FoldEndDto; 2]>,
    },
    FaceInUse {
        face: FoldEndDto,
    },
    SelfGlued {
        a: FoldEndDto,
        b: FoldEndDto,
    },
    UnknownGroup {
        group: u32,
    },
    /// A structural inconsistency of the topology that the editor cannot cause; core's text.
    Inconsistent {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TopologyInfo {
    pub activity: Vec<FoldActivityDto>,
    /// Closed chains of boundary faces, in traversal order; empty with `contours_error` set when a
    /// boundary walk does not close.
    pub contours: Vec<Vec<FoldEndDto>>,
    pub contours_error: Option<TopologyErrorDto>,
}

/// Activity and boundary contours of the floor.
pub fn topology_info(request: &TopologyFloor) -> Result<TopologyInfo, String> {
    build_tessellation(&request.tessellation, Info { request })?
}

/// Applies one edit and returns the resulting topology.
pub fn topology_edit(request: &TopologyEditRequest) -> Result<TopologyEditResult, String> {
    build_tessellation(&request.floor.tessellation, Edit { request })?
}

struct Info<'a> {
    request: &'a TopologyFloor,
}

struct Edit<'a> {
    request: &'a TopologyEditRequest,
}

fn build_field<T: Tessellation>(
    tessellation: &Arc<T>,
    codec: CellCodec<T>,
    cells: &[[i32; 2]],
) -> Result<Field<T>, String> {
    let cells = codec.decode_valid(&**tessellation, cells)?;
    Field::new(Arc::clone(tessellation), cells, &mut IdGenerator::new()).map_err(str::to_string)
}

fn decode_current<T: Tessellation>(
    floor: &TopologyFloor,
    tessellation: &T,
    codec: CellCodec<T>,
    fingerprint: &TessellationFingerprint,
) -> Result<Topology<T>, String> {
    match &floor.topology {
        Some(dto) => decode_topology(
            dto,
            tessellation,
            |x, y| Some((codec.from_xy)(x, y)),
            fingerprint,
        ),
        None => Ok(Topology::empty(fingerprint.clone())),
    }
}

fn decode_end<T: Tessellation>(
    tessellation: &T,
    codec: CellCodec<T>,
    end: &FoldEndDto,
) -> Result<FoldEnd<T::CellId>, String> {
    let cells = codec.decode_valid(tessellation, &[end.cell])?;
    Ok(FoldEnd {
        cell: cells[0],
        face_idx: end.face_idx,
    })
}

fn decode_run<T: Tessellation>(
    tessellation: &T,
    codec: CellCodec<T>,
    run: &[FoldEndDto],
) -> Result<Vec<FoldEnd<T::CellId>>, String> {
    run.iter()
        .map(|end| decode_end(tessellation, codec, end))
        .collect()
}

fn end_dto<T: Tessellation>(codec: CellCodec<T>, end: FoldEnd<T::CellId>) -> FoldEndDto {
    let (x, y) = (codec.to_xy)(end.cell);
    FoldEndDto {
        cell: [x, y],
        face_idx: end.face_idx,
    }
}

/// The ends of a candidate topology's folds in its fold order (existing groups in order, the new
/// group last), with whether each fold already existed.
type EndPair<C> = (FoldEnd<C>, FoldEnd<C>, bool);

enum Change<C> {
    None,
    Add(Vec<NewFold<C>>),
    Replace(FoldGroupId, Vec<NewFold<C>>),
    Remove(FoldGroupId),
}

fn candidate_ends<T: Tessellation>(
    topology: &Topology<T>,
    change: &Change<T::CellId>,
) -> Vec<EndPair<T::CellId>> {
    let mut ends = Vec::new();
    for group in topology.groups() {
        match change {
            Change::Remove(id) if *id == group.id => {}
            Change::Replace(id, new) if *id == group.id => {
                ends.extend(new.iter().map(|f| (f.a, f.b, false)));
            }
            _ => ends.extend(group.folds.iter().map(|&id| {
                let fold = &topology.folds()[id.0];
                (fold.a, fold.b, true)
            })),
        }
    }
    if let Change::Add(new) = change {
        ends.extend(new.iter().map(|f| (f.a, f.b, false)));
    }
    ends
}

fn reason_dto(reason: InactiveReason) -> InactiveReasonDto {
    match reason {
        InactiveReason::MissingCell => InactiveReasonDto::MissingCell,
        InactiveReason::InteriorNeighbor => InactiveReasonDto::InteriorNeighbor,
        InactiveReason::DuplicateNeighbor => InactiveReasonDto::DuplicateNeighbor,
    }
}

/// The connections other than the fold `a`-`b` itself that already join the cells of `a` and `b`:
/// faces they share in the tessellation, and the folds before `fold_index` between the same cells.
fn connections_between<T: Tessellation>(
    tessellation: &T,
    codec: CellCodec<T>,
    fold_index: usize,
    ends: &[EndPair<T::CellId>],
) -> Vec<[FoldEndDto; 2]> {
    let Some(&(a, b, _)) = ends.get(fold_index) else {
        return Vec::new();
    };
    let mut connections = Vec::new();
    let faces_b = tessellation.faces_of(b.cell);
    for (face_idx, &face) in tessellation.faces_of(a.cell).iter().enumerate() {
        let Some((neighbor, neighbor_face)) = tessellation.neighbor(a.cell, face) else {
            continue;
        };
        if neighbor != b.cell {
            continue;
        }
        if let Some(neighbor_idx) = faces_b.iter().position(|&f| f == neighbor_face) {
            connections.push([
                end_dto(codec, FoldEnd { cell: a.cell, face_idx }),
                end_dto(codec, FoldEnd { cell: b.cell, face_idx: neighbor_idx }),
            ]);
        }
    }
    for &(x, y, _) in &ends[..fold_index] {
        let same = (x.cell == a.cell && y.cell == b.cell) || (x.cell == b.cell && y.cell == a.cell);
        if same {
            connections.push([end_dto(codec, x), end_dto(codec, y)]);
        }
    }
    connections
}

fn error_dto<T: Tessellation>(
    tessellation: &T,
    codec: CellCodec<T>,
    error: &TopologyEditError<T::CellId>,
    ends: &[EndPair<T::CellId>],
) -> TopologyErrorDto {
    use TopologyEditError as E;
    let dto = |end| end_dto(codec, end);
    let inconsistent = || TopologyErrorDto::Inconsistent {
        message: error.to_string(),
    };
    match error {
        E::Invalid(TopologyError::FaceInMultipleFolds { cell, face_idx, .. }) => {
            TopologyErrorDto::FaceInUse {
                face: dto(FoldEnd {
                    cell: *cell,
                    face_idx: *face_idx,
                }),
            }
        }
        E::Invalid(TopologyError::SelfGlued { fold }) => match ends.get(fold.0) {
            Some(&(a, b, _)) => TopologyErrorDto::SelfGlued {
                a: dto(a),
                b: dto(b),
            },
            None => inconsistent(),
        },
        E::Invalid(_) => inconsistent(),
        E::Inactive { fold, reason } => match ends.get(fold.0) {
            Some(&(a, b, existing)) => TopologyErrorDto::InactiveFold {
                reason: reason_dto(*reason),
                a: dto(a),
                b: dto(b),
                existing,
                connections: if matches!(reason, InactiveReason::DuplicateNeighbor) {
                    connections_between(tessellation, codec, fold.0, ends)
                } else {
                    Vec::new()
                },
            },
            None => inconsistent(),
        },
        E::UnknownGroup(group) => TopologyErrorDto::UnknownGroup { group: group.0 },
        E::OpenContour(face) => TopologyErrorDto::OpenContour { face: dto(*face) },
        E::EmptyRun => TopologyErrorDto::EmptyRun,
        E::RunLengthMismatch { a, b } => TopologyErrorDto::RunLengthMismatch { a: *a, b: *b },
    }
}

fn encode_error(dto: &TopologyErrorDto) -> String {
    serde_json::to_string(dto).expect("a topology error serializes to JSON")
}

impl TessellationVisitor for Info<'_> {
    type Output = Result<TopologyInfo, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let fingerprint = tessellation_fingerprint(&self.request.tessellation);
        let mut field = build_field(&tessellation, codec, &self.request.field_cells)?;
        let (contours, contours_error) = match boundary_contours(&field) {
            Ok(contours) => (
                contours
                    .iter()
                    .map(|c| c.faces.iter().map(|&end| end_dto(codec, end)).collect())
                    .collect(),
                None,
            ),
            Err(error) => (Vec::new(), Some(error_dto(&*tessellation, codec, &error, &[]))),
        };
        let topology = decode_current(self.request, &*tessellation, codec, &fingerprint)?;
        field
            .set_topology(topology, &fingerprint)
            .map_err(|e| e.to_string())?;
        let activity = field
            .fold_activity()
            .iter()
            .map(|activity| match activity {
                FoldActivity::Active => FoldActivityDto::Active,
                FoldActivity::Inactive(reason) => FoldActivityDto::Inactive {
                    reason: reason_dto(*reason),
                },
            })
            .collect();
        Ok(TopologyInfo {
            activity,
            contours,
            contours_error,
        })
    }
}

impl TessellationVisitor for Edit<'_> {
    type Output = Result<TopologyEditResult, String>;

    fn visit<T: Tessellation>(self, tessellation: Arc<T>, codec: CellCodec<T>) -> Self::Output {
        let request = self.request;
        let fingerprint = tessellation_fingerprint(&request.floor.tessellation);
        let field = build_field(&tessellation, codec, &request.floor.field_cells)?;
        let mut topology = decode_current(&request.floor, &*tessellation, codec, &fingerprint)?;
        let t = &*tessellation;
        let (edited, change) = match &request.op {
            TopologyOp::Glue {
                a,
                b,
                twist,
                replace,
            } => {
                let (run_a, run_b) = (decode_run(t, codec, a)?, decode_run(t, codec, b)?);
                match (Topology::<T>::glue_folds(&run_a, &run_b, *twist), replace) {
                    (Ok(folds), None) => (
                        topology
                            .add_group(&field, &fingerprint, folds.clone())
                            .map(|id| Some(id.0)),
                        Change::Add(folds),
                    ),
                    (Ok(folds), Some(id)) => {
                        let id = FoldGroupId(*id);
                        (
                            topology
                                .replace_group(&field, &fingerprint, id, folds.clone())
                                .map(|()| None),
                            Change::Replace(id, folds),
                        )
                    }
                    (Err(error), _) => (Err(error), Change::None),
                }
            }
            TopologyOp::RemoveGroup { id } => {
                let id = FoldGroupId(*id);
                (
                    topology
                        .remove_group(&field, &fingerprint, id)
                        .map(|()| None),
                    Change::Remove(id),
                )
            }
        };
        // A refused edit leaves `topology` as it was, so the candidate's fold order is rebuilt
        // from it to point at the sides of an inactive fold.
        let group = edited.map_err(|e| {
            encode_error(&error_dto(t, codec, &e, &candidate_ends(&topology, &change)))
        })?;
        Ok(TopologyEditResult {
            topology: encode_topology(&topology, codec.to_xy),
            group,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TessellationKind;

    fn floor(width: i32, height: i32, topology: Option<TopologyDto>) -> TopologyFloor {
        TopologyFloor {
            tessellation: TessellationConfig {
                kind: TessellationKind::Square,
                params: serde_json::Map::new(),
            },
            field_cells: (0..width)
                .flat_map(|x| (0..height).map(move |y| [x, y]))
                .collect(),
            topology,
        }
    }

    fn end(x: i32, y: i32, face_idx: usize) -> FoldEndDto {
        FoldEndDto {
            cell: [x, y],
            face_idx,
        }
    }

    fn edit(floor: TopologyFloor, op: TopologyOp) -> Result<TopologyEditResult, String> {
        topology_edit(&TopologyEditRequest { floor, op })
    }

    fn glue(floor: TopologyFloor, a: Vec<FoldEndDto>, b: Vec<FoldEndDto>) -> TopologyDto {
        let op = TopologyOp::Glue {
            a,
            b,
            twist: false,
            replace: None,
        };
        edit(floor, op).unwrap().topology
    }

    /// Left glued to right on a `width` x `height` square field.
    fn cylinder(width: i32, height: i32) -> TopologyDto {
        let left = (0..height).rev().map(|y| end(0, y, 2)).collect();
        let right = (0..height).map(|y| end(width - 1, y, 0)).collect();
        glue(floor(width, height, None), left, right)
    }

    /// Left glued to right and bottom to top on a 4x4 square field.
    fn torus() -> TopologyDto {
        let contour = &topology_info(&floor(4, 4, None)).unwrap().contours[0];
        let run = |y: i32| -> Vec<FoldEndDto> {
            let mut faces: Vec<_> = contour
                .iter()
                .copied()
                .filter(|f| f.face_idx % 2 == 1 && f.cell[1] == y)
                .collect();
            faces.sort_by_key(|f| f.cell[0]);
            faces
        };
        let (bottom, mut top) = (run(0), run(3));
        top.reverse();
        glue(floor(4, 4, Some(cylinder(4, 4))), bottom, top)
    }

    #[test]
    fn info_lists_contours_and_no_activity_without_folds() {
        let info = topology_info(&floor(4, 4, None)).unwrap();
        assert!(info.activity.is_empty());
        assert_eq!(info.contours.len(), 1);
        assert_eq!(info.contours[0].len(), 16);
        assert_eq!(info.contours_error, None);
    }

    #[test]
    fn glued_topology_round_trips_into_info_with_all_folds_active() {
        let built = torus();
        assert_eq!(built.groups.len(), 2);
        let info = topology_info(&floor(4, 4, Some(built))).unwrap();
        assert!(info.activity.iter().all(|a| *a == FoldActivityDto::Active));
    }

    #[test]
    fn removing_a_cell_deactivates_the_fold_with_its_reason() {
        let built = cylinder(4, 4);
        let mut shrunk = floor(4, 4, Some(built));
        shrunk.field_cells.retain(|&c| c != [3, 1]);
        let info = topology_info(&shrunk).unwrap();
        assert!(info.activity.iter().any(|a| matches!(
            a,
            FoldActivityDto::Inactive {
                reason: InactiveReasonDto::MissingCell
            }
        )));
    }

    #[test]
    fn glue_add_replace_and_remove_are_transactional() {
        let a = vec![end(0, 0, 2), end(0, 1, 2)];
        let b = vec![end(3, 0, 0), end(3, 1, 0)];
        let glued = edit(
            floor(4, 4, None),
            TopologyOp::Glue {
                a: a.clone(),
                b: b.clone(),
                twist: false,
                replace: None,
            },
        )
        .unwrap();
        assert_eq!(glued.group, Some(0));
        assert_eq!(glued.topology.folds.len(), 2);

        // A conflicting glue (the same faces again) leaves the caller's topology untouched.
        let again = edit(
            floor(4, 4, Some(glued.topology.clone())),
            TopologyOp::Glue {
                a,
                b,
                twist: true,
                replace: None,
            },
        );
        assert!(again.unwrap_err().contains(r#""code":"face_in_use""#));

        // Gluing in place of the existing group keeps its id and swaps the pairs.
        let reglued = edit(
            floor(4, 4, Some(glued.topology.clone())),
            TopologyOp::Glue {
                a: vec![end(0, 0, 2), end(0, 1, 2)],
                b: vec![end(3, 0, 0), end(3, 1, 0)],
                twist: true,
                replace: Some(0),
            },
        )
        .unwrap();
        assert_eq!(reglued.group, None);
        assert_eq!(reglued.topology.groups.len(), 1);
        assert!(reglued.topology.folds.iter().all(|f| f.twist));

        let removed = edit(
            floor(4, 4, Some(glued.topology)),
            TopologyOp::RemoveGroup { id: 0 },
        )
        .unwrap();
        assert!(removed.topology.folds.is_empty());
    }

    #[test]
    fn unknown_group_is_an_error() {
        let error = edit(floor(4, 4, None), TopologyOp::RemoveGroup { id: 5 }).unwrap_err();
        assert!(
            error.contains(r#""code":"unknown_group""#) && error.contains(r#""group":5"#),
            "{error}"
        );
    }

    #[test]
    fn topology_for_another_tessellation_is_rejected() {
        let mut topology = cylinder(4, 4);
        topology.fingerprint = "hex{}".to_string();
        let error = topology_info(&floor(4, 4, Some(topology))).unwrap_err();
        assert!(error.contains("hex{}"), "{error}");
    }

    #[test]
    fn inactive_fold_blocks_glue_but_never_removal() {
        let built = torus();
        let mut shrunk = floor(4, 4, Some(built));
        // A right-edge cell: only the left-right group (0) glues it.
        shrunk.field_cells.retain(|&c| c != [3, 1]);
        let blocked = edit(
            shrunk.clone(),
            TopologyOp::Glue {
                a: vec![end(1, 1, 0)],
                b: vec![end(2, 2, 2)],
                twist: false,
                replace: None,
            },
        )
        .unwrap_err();
        assert!(blocked.contains(r#""code":"inactive_fold""#), "{blocked}");
        assert!(blocked.contains(r#""existing":true"#), "{blocked}");
        // Removing the healthy group works although group 0 stays inactive; so does removing it.
        let other = edit(shrunk.clone(), TopologyOp::RemoveGroup { id: 1 }).unwrap();
        assert_eq!(other.topology.groups.len(), 1);
        let own = edit(shrunk, TopologyOp::RemoveGroup { id: 0 }).unwrap();
        assert_eq!(own.topology.groups.len(), 1);
    }
}
