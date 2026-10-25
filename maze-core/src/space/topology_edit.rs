//! Authoring of a floor's topology: boundary contours, gluing of boundary runs, whole-group
//! edits and presets (cylinder, torus, Möbius, Klein bottle). Every edit is transactional: the
//! candidate topology is built and validated as a whole (structure and activity against the
//! field), then applied or rejected with no partial result. See `Specs/topology.md`.

use super::geometry::{FoldClass, classify_fold_faces};
use super::topology::ResolvedTopology;
use super::{
    Field, Fold, FoldEnd, FoldGroup, FoldGroupId, FoldId, InactiveReason, Tessellation,
    TessellationFingerprint, Topology, TopologyError,
};
use std::collections::HashSet;
use std::fmt;

/// A closed chain of boundary faces of a field, in traversal order (the field's cells stay on the
/// left, so an outer contour runs counter-clockwise and a hole clockwise). The last face is
/// followed by the first.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Contour<C> {
    pub faces: Vec<FoldEnd<C>>,
}

impl<C: Copy> Contour<C> {
    /// `len` consecutive faces starting at `start`, wrapping around the end. `None` for an empty
    /// run, a run longer than the contour or a `start` outside it.
    pub fn run(&self, start: usize, len: usize) -> Option<Vec<FoldEnd<C>>> {
        let n = self.faces.len();
        if len == 0 || len > n || start >= n {
            return None;
        }
        Some((0..len).map(|i| self.faces[(start + i) % n]).collect())
    }
}

/// Safety bound for one step of the contour walk (the cells around one vertex).
const MAX_WALK_STEPS: usize = 1024;

/// The contours of the field boundary: faces with no in-field ordinary neighbour. Faces already
/// glued by an installed topology are still boundary faces here. Deterministic: contours start at
/// the smallest cell / face index not yet visited. A boundary face whose walk does not close
/// (a degenerate tessellation) is an error, never silently dropped.
pub fn boundary_contours<T: Tessellation>(
    field: &Field<T>,
) -> Result<Vec<Contour<T::CellId>>, TopologyEditError<T::CellId>> {
    let tess = field.tessellation();
    let ordinary = |cell: T::CellId, idx: usize| {
        let face = tess.faces_of(cell)[idx];
        tess.neighbor(cell, face)
            .filter(|&(n, _)| field.contains(n))
    };
    let next = |start: (T::CellId, usize)| -> Option<(T::CellId, usize)> {
        let mut cur = start;
        for _ in 0..MAX_WALK_STEPS {
            let n = (cur.1 + 1) % tess.faces_of(cur.0).len();
            match ordinary(cur.0, n) {
                None => return Some((cur.0, n)),
                Some((cell, face)) => {
                    let j = tess.faces_of(cell).iter().position(|&f| f == face)?;
                    cur = (cell, j);
                }
            }
        }
        None
    };

    let mut cells: Vec<T::CellId> = field.all_cells().collect();
    cells.sort();
    let mut visited: HashSet<(T::CellId, usize)> = HashSet::new();
    let mut contours = Vec::new();
    for cell in cells {
        for idx in 0..tess.faces_of(cell).len() {
            if visited.contains(&(cell, idx)) || ordinary(cell, idx).is_some() {
                continue;
            }
            let mut faces = Vec::new();
            let mut cur = (cell, idx);
            let mut closed = false;
            loop {
                if !visited.insert(cur) {
                    closed = cur == (cell, idx);
                    break;
                }
                faces.push(FoldEnd {
                    cell: cur.0,
                    face_idx: cur.1,
                });
                match next(cur) {
                    Some(n) => cur = n,
                    None => break,
                }
            }
            if closed {
                contours.push(Contour { faces });
            } else {
                return Err(TopologyEditError::OpenContour(FoldEnd {
                    cell,
                    face_idx: idx,
                }));
            }
        }
    }
    Ok(contours)
}

/// A fold before it is placed in a group.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NewFold<C> {
    pub a: FoldEnd<C>,
    pub b: FoldEnd<C>,
    pub twist: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TopologyEditError<C> {
    /// The base or candidate topology failed structural validation.
    Invalid(TopologyError<C>),
    /// A fold of the candidate would not glue anything in the field.
    Inactive {
        fold: FoldId,
        reason: InactiveReason,
    },
    UnknownGroup(FoldGroupId),
    /// The boundary walk from this face never returned to it.
    OpenContour(FoldEnd<C>),
    EmptyRun,
    RunLengthMismatch {
        a: usize,
        b: usize,
    },
    FaceCountMismatch {
        a: FoldEnd<C>,
        b: FoldEnd<C>,
    },
    /// Preset: the glued faces do not match geometrically (different shapes along the seam).
    IncompatibleFaces {
        a: FoldEnd<C>,
        b: FoldEnd<C>,
    },
    /// Preset: a glued pair is one cell or two neighbouring cells (fewer than 3 cells across).
    TooSmall {
        a: C,
        b: C,
    },
    /// Preset: the field is not a single rectangle-like region with four distinct sides.
    NotRectangular(&'static str),
}

impl<C: fmt::Debug> fmt::Display for TopologyEditError<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use TopologyEditError::*;
        match self {
            Invalid(e) => write!(f, "{e}"),
            Inactive { fold, reason } => {
                write!(f, "fold {} would be inactive: {reason:?}", fold.0)
            }
            UnknownGroup(g) => write!(f, "group {} does not exist", g.0),
            OpenContour(end) => write!(
                f,
                "the boundary walk from face {} of cell {:?} does not close",
                end.face_idx, end.cell
            ),
            EmptyRun => f.write_str("a glued run is empty"),
            RunLengthMismatch { a, b } => {
                write!(f, "glued runs differ in length: {a} faces against {b}")
            }
            FaceCountMismatch { a, b } => write!(
                f,
                "cell {:?} and cell {:?} have a different number of faces",
                a.cell, b.cell
            ),
            IncompatibleFaces { a, b } => write!(
                f,
                "face {} of cell {:?} does not match face {} of cell {:?} geometrically",
                a.face_idx, a.cell, b.face_idx, b.cell
            ),
            TooSmall { a, b } => write!(
                f,
                "cells {a:?} and {b:?} are the same or neighbouring: at least 3 cells are needed \
                 along a glued dimension"
            ),
            NotRectangular(reason) => write!(f, "field is not rectangular: {reason}"),
        }
    }
}

impl<C: fmt::Debug> std::error::Error for TopologyEditError<C> {}

type Entries<C> = Vec<(FoldGroupId, Vec<NewFold<C>>)>;

impl<T: Tessellation> Topology<T> {
    /// Pairs run `a` with run `b` into one fold per face. Untwisted, `a[i]` meets `b[len-1-i]`
    /// (both runs traverse their boundary in the same rotational sense, so this is the ordinary
    /// orientation-reversing match); twisted, `a[i]` meets `b[i]`.
    pub fn glue_folds(
        tessellation: &T,
        a: &[FoldEnd<T::CellId>],
        b: &[FoldEnd<T::CellId>],
        twist: bool,
    ) -> Result<Vec<NewFold<T::CellId>>, TopologyEditError<T::CellId>> {
        if a.is_empty() || b.is_empty() {
            return Err(TopologyEditError::EmptyRun);
        }
        if a.len() != b.len() {
            return Err(TopologyEditError::RunLengthMismatch {
                a: a.len(),
                b: b.len(),
            });
        }
        let n = a.len();
        let mut folds = Vec::with_capacity(n);
        for (i, &end_a) in a.iter().enumerate() {
            let end_b = if twist { b[i] } else { b[n - 1 - i] };
            if tessellation.faces_of(end_a.cell).len() != tessellation.faces_of(end_b.cell).len() {
                return Err(TopologyEditError::FaceCountMismatch { a: end_a, b: end_b });
            }
            folds.push(NewFold {
                a: end_a,
                b: end_b,
                twist,
            });
        }
        Ok(folds)
    }

    /// Glues run `a` with run `b` as a new group; see `glue_folds`. Transactional.
    pub fn glue(
        &mut self,
        field: &Field<T>,
        current: &TessellationFingerprint,
        a: &[FoldEnd<T::CellId>],
        b: &[FoldEnd<T::CellId>],
        twist: bool,
    ) -> Result<FoldGroupId, TopologyEditError<T::CellId>> {
        let folds = Self::glue_folds(field.tessellation(), a, b, twist)?;
        self.add_group(field, current, folds)
    }

    /// Adds `folds` as a new group and returns its id. Transactional.
    pub fn add_group(
        &mut self,
        field: &Field<T>,
        current: &TessellationFingerprint,
        folds: Vec<NewFold<T::CellId>>,
    ) -> Result<FoldGroupId, TopologyEditError<T::CellId>> {
        let mut entries = self.entries(field, current)?;
        let id = FoldGroupId(entries.iter().map(|(g, _)| g.0 + 1).max().unwrap_or(0));
        entries.push((id, folds));
        *self = self.candidate(field, current, entries)?;
        Ok(id)
    }

    /// Replaces the whole group `id` by `folds`, keeping its id and position. Transactional.
    pub fn replace_group(
        &mut self,
        field: &Field<T>,
        current: &TessellationFingerprint,
        id: FoldGroupId,
        folds: Vec<NewFold<T::CellId>>,
    ) -> Result<(), TopologyEditError<T::CellId>> {
        let mut entries = self.entries(field, current)?;
        let slot = entries
            .iter_mut()
            .find(|(g, _)| *g == id)
            .ok_or(TopologyEditError::UnknownGroup(id))?;
        slot.1 = folds;
        *self = self.candidate(field, current, entries)?;
        Ok(())
    }

    /// Removes the whole group `id`. Transactional.
    pub fn remove_group(
        &mut self,
        field: &Field<T>,
        current: &TessellationFingerprint,
        id: FoldGroupId,
    ) -> Result<(), TopologyEditError<T::CellId>> {
        let mut entries = self.entries(field, current)?;
        let before = entries.len();
        entries.retain(|(g, _)| *g != id);
        if entries.len() == before {
            return Err(TopologyEditError::UnknownGroup(id));
        }
        *self = self.candidate(field, current, entries)?;
        Ok(())
    }

    /// The groups with their folds, in group order. Requires the base topology to be valid.
    fn entries(
        &self,
        field: &Field<T>,
        current: &TessellationFingerprint,
    ) -> Result<Entries<T::CellId>, TopologyEditError<T::CellId>> {
        self.validate(field.tessellation(), current)
            .map_err(TopologyEditError::Invalid)?;
        Ok(self
            .groups()
            .iter()
            .map(|group| {
                let folds = group
                    .folds
                    .iter()
                    .map(|&id| {
                        let fold = &self.folds()[id.0];
                        NewFold {
                            a: fold.a,
                            b: fold.b,
                            twist: fold.twist,
                        }
                    })
                    .collect();
                (group.id, folds)
            })
            .collect())
    }

    /// Builds the topology of `entries` and validates it as a whole: structure, then activity of
    /// every fold in the field.
    fn candidate(
        &self,
        field: &Field<T>,
        current: &TessellationFingerprint,
        entries: Entries<T::CellId>,
    ) -> Result<Topology<T>, TopologyEditError<T::CellId>> {
        let mut folds = Vec::new();
        let mut groups = Vec::new();
        for (id, new_folds) in entries {
            let first = folds.len();
            for new in new_folds {
                folds.push(Fold {
                    a: new.a,
                    b: new.b,
                    twist: new.twist,
                    group: id,
                });
            }
            groups.push(FoldGroup {
                id,
                folds: (first..folds.len()).map(FoldId).collect(),
            });
        }
        let candidate = Topology::new(self.fingerprint().clone(), folds, groups);
        candidate
            .validate(field.tessellation(), current)
            .map_err(TopologyEditError::Invalid)?;
        let resolved =
            ResolvedTopology::resolve(candidate, field.tessellation(), |c| field.contains(c));
        for (i, activity) in resolved.activity.iter().enumerate() {
            if let super::FoldActivity::Inactive(reason) = activity {
                return Err(TopologyEditError::Inactive {
                    fold: FoldId(i),
                    reason: *reason,
                });
            }
        }
        Ok(resolved.topology)
    }
}

/// Ready-made topologies of a rectangular field.
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum TopologyPreset {
    /// Left side glued to right side.
    Cylinder,
    /// Left to right and bottom to top.
    Torus,
    /// Left to right with a twist.
    Mobius,
    /// Left to right with a twist, bottom to top without.
    Klein,
}

impl TopologyPreset {
    pub const ALL: [TopologyPreset; 4] = [
        TopologyPreset::Cylinder,
        TopologyPreset::Torus,
        TopologyPreset::Mobius,
        TopologyPreset::Klein,
    ];

    pub fn key(self) -> &'static str {
        match self {
            TopologyPreset::Cylinder => "cylinder",
            TopologyPreset::Torus => "torus",
            TopologyPreset::Mobius => "mobius",
            TopologyPreset::Klein => "klein",
        }
    }

    pub fn from_key(key: &str) -> Option<TopologyPreset> {
        Self::ALL.into_iter().find(|p| p.key() == key)
    }

    /// `(left-right twist, bottom-top twist)`; `None` when that pair is not glued.
    fn gluing(self) -> (bool, Option<bool>) {
        match self {
            TopologyPreset::Cylinder => (false, None),
            TopologyPreset::Torus => (false, Some(false)),
            TopologyPreset::Mobius => (true, None),
            TopologyPreset::Klein => (true, Some(false)),
        }
    }
}

#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
enum Side {
    Left,
    Right,
    Bottom,
    Top,
}

/// The four sides of a rectangle-like field as contour runs. Opposite sides are `(left, right)`
/// and `(bottom, top)`.
struct Sides<C> {
    left: Vec<FoldEnd<C>>,
    right: Vec<FoldEnd<C>>,
    bottom: Vec<FoldEnd<C>>,
    top: Vec<FoldEnd<C>>,
}

/// Splits the single contour of `field` into four runs by the side of the bounding box each
/// boundary face lies on (by its contact point, relative to the box center and half extents).
fn rectangle_sides<T: Tessellation>(
    field: &Field<T>,
) -> Result<Sides<T::CellId>, TopologyEditError<T::CellId>> {
    use TopologyEditError::NotRectangular;
    let contours = boundary_contours(field)?;
    let [contour] = contours.as_slice() else {
        return Err(NotRectangular("the boundary is not a single contour"));
    };
    let points: Vec<_> = contour
        .faces
        .iter()
        .map(|end| {
            let face = field.tessellation().faces_of(end.cell)[end.face_idx];
            field.contact_point(end.cell, face)
        })
        .collect();
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for p in &points {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }
    let (cx, cy) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
    let (hw, hh) = ((max_x - min_x) / 2.0, (max_y - min_y) / 2.0);
    if hw <= 0.0 || hh <= 0.0 {
        return Err(NotRectangular("the field has no extent in one direction"));
    }
    let labels: Vec<Side> = points
        .iter()
        .map(|p| {
            let (nx, ny) = ((p.x - cx) / hw, (p.y - cy) / hh);
            if nx.abs() >= ny.abs() {
                if nx < 0.0 { Side::Left } else { Side::Right }
            } else if ny < 0.0 {
                Side::Bottom
            } else {
                Side::Top
            }
        })
        .collect();

    let n = labels.len();
    let Some(start) = (0..n).find(|&i| labels[i] != labels[(i + n - 1) % n]) else {
        return Err(NotRectangular("the boundary has a single side"));
    };
    let mut runs: Vec<(Side, Vec<usize>)> = Vec::new();
    for k in 0..n {
        let i = (start + k) % n;
        match runs.last_mut() {
            Some((side, indices)) if *side == labels[i] => indices.push(i),
            _ => runs.push((labels[i], vec![i])),
        }
    }
    let distinct: HashSet<Side> = runs.iter().map(|(s, _)| *s).collect();
    if runs.len() != 4 || distinct.len() != 4 {
        return Err(NotRectangular(
            "the boundary does not split into four sides",
        ));
    }
    let take = |side: Side| {
        runs.iter()
            .find(|(s, _)| *s == side)
            .map(|(_, indices)| indices.iter().map(|&i| contour.faces[i]).collect())
            .unwrap_or_default()
    };
    Ok(Sides {
        left: take(Side::Left),
        right: take(Side::Right),
        bottom: take(Side::Bottom),
        top: take(Side::Top),
    })
}

impl TopologyPreset {
    /// Builds this preset's topology for the rectangular `field`. Verifies, for every glued pair,
    /// the face counts of both cells, that the seam is isometric (the two faces have the same
    /// shape) and that the cells are neither one cell nor neighbours (at least 3 cells along the
    /// glued dimension). Fails with the reason instead of returning a partial topology.
    pub fn build<T: Tessellation>(
        self,
        field: &Field<T>,
        current: &TessellationFingerprint,
    ) -> Result<Topology<T>, TopologyEditError<T::CellId>> {
        let sides = rectangle_sides(field)?;
        let (lr_twist, tb_twist) = self.gluing();
        let tess = field.tessellation();
        let mut topology = Topology::<T>::empty(current.clone());

        let mut pairs = vec![(&sides.left, &sides.right, lr_twist)];
        if let Some(twist) = tb_twist {
            pairs.push((&sides.bottom, &sides.top, twist));
        }
        for (a, b, twist) in pairs {
            let folds = Topology::<T>::glue_folds(tess, a, b, twist)?;
            for fold in &folds {
                check_preset_fold(field, fold)?;
            }
            topology.add_group(field, current, folds)?;
        }
        Ok(topology)
    }
}

fn check_preset_fold<T: Tessellation>(
    field: &Field<T>,
    fold: &NewFold<T::CellId>,
) -> Result<(), TopologyEditError<T::CellId>> {
    let tess = field.tessellation();
    let (a, b) = (fold.a, fold.b);
    let adjacent = |from: FoldEnd<T::CellId>, to: T::CellId| {
        tess.faces_of(from.cell)
            .iter()
            .any(|&f| tess.neighbor(from.cell, f).is_some_and(|(n, _)| n == to))
    };
    if a.cell == b.cell || adjacent(a, b.cell) {
        return Err(TopologyEditError::TooSmall {
            a: a.cell,
            b: b.cell,
        });
    }
    let segments = |end: FoldEnd<T::CellId>| {
        tess.face_segments(end.cell, tess.faces_of(end.cell)[end.face_idx])
    };
    match classify_fold_faces(&segments(a), &segments(b), fold.twist) {
        FoldClass::Isometric { .. } => Ok(()),
        FoldClass::TopologicalOnly => Err(TopologyEditError::IncompatibleFaces { a, b }),
    }
}

/// A preset with `Ok` when it builds, or the reason it does not.
pub type PresetAvailability<T> = (
    TopologyPreset,
    Result<(), TopologyEditError<<T as Tessellation>::CellId>>,
);

/// Per preset, in `TopologyPreset::ALL` order, whether it builds for `field` and the reason when
/// it does not: the capability list a UI shows for the current field.
pub fn topology_preset_availability<T: Tessellation>(
    field: &Field<T>,
    current: &TessellationFingerprint,
) -> Vec<PresetAvailability<T>> {
    TopologyPreset::ALL
        .into_iter()
        .map(|p| (p, p.build(field, current).map(|_| ())))
        .collect()
}

#[cfg(test)]
#[path = "topology_edit_tests.rs"]
mod tests;
