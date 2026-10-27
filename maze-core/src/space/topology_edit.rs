//! Authoring of a floor's topology: boundary contours, gluing of boundary runs, whole-group
//! edits. Every edit is transactional: the candidate topology is built and validated as a
//! whole (structure and activity against the field), then applied or rejected with no partial
//! result. See `Specs/topology.md`.

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
        let folds = Self::glue_folds(a, b, twist)?;
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

#[cfg(test)]
#[path = "topology_edit_tests.rs"]
mod tests;
