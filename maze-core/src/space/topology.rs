//! Topology of one floor: folds that glue two faces of the tessellation together (cylinder,
//! torus, twisted gluings). Pure data plus structural validation, independent of the field.
//! See `Specs/topology.md`.

use super::Tessellation;
use std::collections::{HashMap, HashSet};
use std::fmt;

/// Index of a fold in `Topology::folds`.
#[derive(Copy, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct FoldId(pub usize);

/// Id of a `FoldGroup`, unique within one `Topology`.
#[derive(Copy, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct FoldGroupId(pub u32);

/// One side of a fold: a cell and the position of the face in `faces_of(cell)`.
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub struct FoldEnd<C> {
    pub cell: C,
    pub face_idx: usize,
}

/// Which side of a fold an end is.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum FoldSide {
    A,
    B,
}

impl fmt::Display for FoldSide {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            FoldSide::A => "a",
            FoldSide::B => "b",
        })
    }
}

/// Gluing of face `a` to face `b`. `twist` reverses the endpoint correspondence along the glued
/// boundary piece (a Möbius-like gluing) instead of the default orientation-reversing match.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Fold<C> {
    pub a: FoldEnd<C>,
    pub b: FoldEnd<C>,
    pub twist: bool,
    pub group: FoldGroupId,
}

/// Editable unit of a topology: operations address whole groups.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FoldGroup {
    pub id: FoldGroupId,
    pub folds: Vec<FoldId>,
}

/// Identity of the tessellation config (kind + params) a topology was authored for. `face_idx`
/// is stable only within one config, so a topology is usable only with an equal fingerprint.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct TessellationFingerprint(String);

impl TessellationFingerprint {
    /// `canonical` must be a canonical rendering of the config (same config, same string).
    pub fn new(canonical: impl Into<String>) -> Self {
        Self(canonical.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TopologyError<C> {
    FingerprintMismatch {
        expected: TessellationFingerprint,
        found: TessellationFingerprint,
    },
    InvalidCell {
        fold: FoldId,
        side: FoldSide,
        cell: C,
    },
    FaceOutOfRange {
        fold: FoldId,
        side: FoldSide,
        cell: C,
        face_idx: usize,
        face_count: usize,
    },
    FaceInMultipleFolds {
        fold: FoldId,
        other: FoldId,
        cell: C,
        face_idx: usize,
    },
    SelfGlued {
        fold: FoldId,
    },
    UnknownGroup {
        fold: FoldId,
        group: FoldGroupId,
    },
    DuplicateGroupId {
        group: FoldGroupId,
    },
    GroupRefersUnknownFold {
        group: FoldGroupId,
        fold: FoldId,
    },
    /// The fold's `group` field does not list it, or it is listed by a different group too.
    FoldGroupMismatch {
        fold: FoldId,
        group: FoldGroupId,
    },
    FoldInMultipleGroups {
        fold: FoldId,
        group: FoldGroupId,
        other: FoldGroupId,
    },
    FoldWithoutGroup {
        fold: FoldId,
    },
}

impl<C: fmt::Debug> fmt::Display for TopologyError<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use TopologyError::*;
        match self {
            FingerprintMismatch { expected, found } => write!(
                f,
                "topology was authored for tessellation `{}`, current is `{}`",
                found.as_str(),
                expected.as_str()
            ),
            InvalidCell { fold, side, cell } => write!(
                f,
                "fold {}: side {side} cell {cell:?} is not valid for the tessellation",
                fold.0
            ),
            FaceOutOfRange {
                fold,
                side,
                cell,
                face_idx,
                face_count,
            } => write!(
                f,
                "fold {}: side {side} face {face_idx} does not exist in cell {cell:?} ({face_count} faces)",
                fold.0
            ),
            FaceInMultipleFolds {
                fold,
                other,
                cell,
                face_idx,
            } => write!(
                f,
                "fold {}: face {face_idx} of cell {cell:?} also belongs to fold {}",
                fold.0, other.0
            ),
            SelfGlued { fold } => write!(f, "fold {}: face is glued to itself", fold.0),
            UnknownGroup { fold, group } => {
                write!(f, "fold {}: group {} does not exist", fold.0, group.0)
            }
            DuplicateGroupId { group } => write!(f, "group {} is declared twice", group.0),
            GroupRefersUnknownFold { group, fold } => {
                write!(f, "group {} lists unknown fold {}", group.0, fold.0)
            }
            FoldGroupMismatch { fold, group } => write!(
                f,
                "fold {}: group {} does not list the fold",
                fold.0, group.0
            ),
            FoldInMultipleGroups { fold, group, other } => write!(
                f,
                "fold {}: listed by both group {} and group {}",
                fold.0, group.0, other.0
            ),
            FoldWithoutGroup { fold } => write!(f, "fold {}: belongs to no group", fold.0),
        }
    }
}

impl<C: fmt::Debug> std::error::Error for TopologyError<C> {}

/// Folds and fold groups of one floor, plus the fingerprint of the tessellation they were
/// authored for. Construction does not validate: `validate` checks every stored fold, active or
/// not.
pub struct Topology<T: Tessellation> {
    fingerprint: TessellationFingerprint,
    folds: Vec<Fold<T::CellId>>,
    groups: Vec<FoldGroup>,
    by_end: HashMap<(T::CellId, usize), (FoldId, FoldSide)>,
}

// Manual impls: `derive` would require `T: Clone + Debug`, but only `T::CellId` is stored.
impl<T: Tessellation> Clone for Topology<T> {
    fn clone(&self) -> Self {
        Self {
            fingerprint: self.fingerprint.clone(),
            folds: self.folds.clone(),
            groups: self.groups.clone(),
            by_end: self.by_end.clone(),
        }
    }
}

impl<T: Tessellation> fmt::Debug for Topology<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Topology")
            .field("fingerprint", &self.fingerprint)
            .field("folds", &self.folds)
            .field("groups", &self.groups)
            .finish()
    }
}

impl<T: Tessellation> Topology<T> {
    pub fn new(
        fingerprint: TessellationFingerprint,
        folds: Vec<Fold<T::CellId>>,
        groups: Vec<FoldGroup>,
    ) -> Self {
        let mut by_end = HashMap::new();
        for (i, fold) in folds.iter().enumerate() {
            by_end
                .entry((fold.a.cell, fold.a.face_idx))
                .or_insert((FoldId(i), FoldSide::A));
            by_end
                .entry((fold.b.cell, fold.b.face_idx))
                .or_insert((FoldId(i), FoldSide::B));
        }
        Self {
            fingerprint,
            folds,
            groups,
            by_end,
        }
    }

    pub fn empty(fingerprint: TessellationFingerprint) -> Self {
        Self::new(fingerprint, Vec::new(), Vec::new())
    }

    pub fn fingerprint(&self) -> &TessellationFingerprint {
        &self.fingerprint
    }

    pub fn folds(&self) -> &[Fold<T::CellId>] {
        &self.folds
    }

    pub fn groups(&self) -> &[FoldGroup] {
        &self.groups
    }

    pub fn fold(&self, id: FoldId) -> Option<&Fold<T::CellId>> {
        self.folds.get(id.0)
    }

    pub fn group(&self, id: FoldGroupId) -> Option<&FoldGroup> {
        self.groups.iter().find(|g| g.id == id)
    }

    pub fn is_empty(&self) -> bool {
        self.folds.is_empty()
    }

    /// The fold gluing face `face_idx` of `cell`, with the side the face is on.
    pub fn fold_of(
        &self,
        cell: T::CellId,
        face_idx: usize,
    ) -> Option<(&Fold<T::CellId>, FoldSide)> {
        let &(id, side) = self.by_end.get(&(cell, face_idx))?;
        Some((&self.folds[id.0], side))
    }

    /// Errors when the topology was authored for a different tessellation config.
    pub fn check_fingerprint(
        &self,
        current: &TessellationFingerprint,
    ) -> Result<(), TopologyError<T::CellId>> {
        if &self.fingerprint == current {
            Ok(())
        } else {
            Err(TopologyError::FingerprintMismatch {
                expected: current.clone(),
                found: self.fingerprint.clone(),
            })
        }
    }

    /// Structural validation of every stored fold, independent of the field: endpoints exist,
    /// a face is in at most one fold, no face is glued to itself, every fold is in exactly one
    /// group. Returns the first violation in fold order, then group order.
    pub fn validate(
        &self,
        tessellation: &T,
        current: &TessellationFingerprint,
    ) -> Result<(), TopologyError<T::CellId>> {
        self.check_fingerprint(current)?;

        let mut seen: HashMap<(T::CellId, usize), FoldId> = HashMap::new();
        for (i, fold) in self.folds.iter().enumerate() {
            let id = FoldId(i);
            for (side, end) in [(FoldSide::A, fold.a), (FoldSide::B, fold.b)] {
                if !tessellation.is_valid_cell(end.cell) {
                    return Err(TopologyError::InvalidCell {
                        fold: id,
                        side,
                        cell: end.cell,
                    });
                }
                let face_count = tessellation.faces_of(end.cell).len();
                if end.face_idx >= face_count {
                    return Err(TopologyError::FaceOutOfRange {
                        fold: id,
                        side,
                        cell: end.cell,
                        face_idx: end.face_idx,
                        face_count,
                    });
                }
            }
            if fold.a == fold.b {
                return Err(TopologyError::SelfGlued { fold: id });
            }
            for end in [fold.a, fold.b] {
                if let Some(&other) = seen.get(&(end.cell, end.face_idx)) {
                    return Err(TopologyError::FaceInMultipleFolds {
                        fold: id,
                        other,
                        cell: end.cell,
                        face_idx: end.face_idx,
                    });
                }
                seen.insert((end.cell, end.face_idx), id);
            }
        }

        let mut group_ids = HashSet::new();
        for group in &self.groups {
            if !group_ids.insert(group.id) {
                return Err(TopologyError::DuplicateGroupId { group: group.id });
            }
        }

        let mut owner: HashMap<FoldId, FoldGroupId> = HashMap::new();
        for group in &self.groups {
            for &fold in &group.folds {
                if fold.0 >= self.folds.len() {
                    return Err(TopologyError::GroupRefersUnknownFold {
                        group: group.id,
                        fold,
                    });
                }
                if let Some(&other) = owner.get(&fold) {
                    return Err(TopologyError::FoldInMultipleGroups {
                        fold,
                        group: other,
                        other: group.id,
                    });
                }
                owner.insert(fold, group.id);
            }
        }
        for (i, fold) in self.folds.iter().enumerate() {
            let id = FoldId(i);
            if !group_ids.contains(&fold.group) {
                return Err(TopologyError::UnknownGroup {
                    fold: id,
                    group: fold.group,
                });
            }
            match owner.get(&id) {
                None => return Err(TopologyError::FoldWithoutGroup { fold: id }),
                Some(&g) if g != fold.group => {
                    return Err(TopologyError::FoldGroupMismatch {
                        fold: id,
                        group: fold.group,
                    });
                }
                Some(_) => {}
            }
        }
        Ok(())
    }
}

/// Why a fold does not currently glue anything in a field.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum InactiveReason {
    /// An end cell is not in the field.
    MissingCell,
    /// A glued face has an ordinary in-field neighbour: the fold must not silently override it.
    InteriorNeighbor,
    /// Gluing would make a cell neighbour the same cell twice among the active links.
    DuplicateNeighbor,
}

/// Whether a fold glues anything in a given field.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum FoldActivity {
    Active,
    Inactive(InactiveReason),
}

impl FoldActivity {
    pub fn is_active(self) -> bool {
        self == FoldActivity::Active
    }
}

/// How the faces around a crossing correspond. `entry` is the face of the source cell the
/// crossing leaves through.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct Orientation<F> {
    /// Chirality change. `false` for an ordinary neighbour and for an untwisted fold; `true` for
    /// a twisted fold.
    pub flips: bool,
    pub entry: F,
}

/// The result of leaving a cell through a face: the adjacent cell, the face of it that is the
/// same boundary piece, and how the faces around correspond. Ordinary adjacency and an active
/// fold produce the same shape.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct Crossing<C, F> {
    pub cell: C,
    pub face: F,
    pub orientation: Orientation<F>,
}

impl<C: Copy, F: Copy + PartialEq> Crossing<C, F> {
    /// Maps `face` of the source cell `from` to the face of the destination cell in the same
    /// direction. With equal face counts the face at circular offset `k` from the entry face
    /// maps to the face at offset `-k` (not flipped) or `+k` (flipped) from the exit face.
    /// `None` when the face counts differ or `face` is not a face of `from`.
    pub fn transfer<T: Tessellation<Face = F, CellId = C>>(
        &self,
        tessellation: &T,
        from: C,
        face: F,
    ) -> Option<F> {
        let src = tessellation.faces_of(from);
        let dst = tessellation.faces_of(self.cell);
        if src.len() != dst.len() {
            return None;
        }
        let n = src.len();
        let entry = src.iter().position(|&f| f == self.orientation.entry)?;
        let idx = src.iter().position(|&f| f == face)?;
        let exit = dst.iter().position(|&f| f == self.face)?;
        let k = (idx + n - entry) % n;
        let target = if self.orientation.flips {
            (exit + k) % n
        } else {
            (exit + n - k) % n
        };
        Some(dst[target])
    }
}

type TessCrossing<T> = Crossing<<T as Tessellation>::CellId, <T as Tessellation>::Face>;

/// A topology resolved against one field: per-fold activity and the active gluing links.
pub(crate) struct ResolvedTopology<T: Tessellation> {
    pub(crate) topology: Topology<T>,
    pub(crate) activity: Vec<FoldActivity>,
    links: HashMap<(T::CellId, usize), TessCrossing<T>>,
}

impl<T: Tessellation> Clone for ResolvedTopology<T> {
    fn clone(&self) -> Self {
        Self {
            topology: self.topology.clone(),
            activity: self.activity.clone(),
            links: self.links.clone(),
        }
    }
}

impl<T: Tessellation> ResolvedTopology<T> {
    /// Resolves activity of every fold against the field's cell set (`contains`). Pure function
    /// of topology and cell set, so callers recompute after every change of the cell set.
    /// Folds are considered in fold order, which makes the `DuplicateNeighbor` outcome
    /// deterministic.
    pub(crate) fn resolve(
        topology: Topology<T>,
        tessellation: &T,
        contains: impl Fn(T::CellId) -> bool,
    ) -> Self {
        let ordinary_neighbors = |cell: T::CellId| -> HashSet<T::CellId> {
            tessellation
                .faces_of(cell)
                .iter()
                .filter_map(|&face| tessellation.neighbor(cell, face))
                .map(|(n, _)| n)
                .filter(|&n| contains(n))
                .collect()
        };
        let mut neighbors: HashMap<T::CellId, HashSet<T::CellId>> = HashMap::new();
        let mut activity = Vec::with_capacity(topology.folds.len());
        let mut links = HashMap::new();

        for fold in &topology.folds {
            let (a, b) = (fold.a, fold.b);
            if !contains(a.cell) || !contains(b.cell) {
                activity.push(FoldActivity::Inactive(InactiveReason::MissingCell));
                continue;
            }
            let face_a = tessellation.faces_of(a.cell)[a.face_idx];
            let face_b = tessellation.faces_of(b.cell)[b.face_idx];
            let interior = [(a.cell, face_a), (b.cell, face_b)].iter().any(|&(c, f)| {
                tessellation
                    .neighbor(c, f)
                    .is_some_and(|(n, _)| contains(n))
            });
            if interior {
                activity.push(FoldActivity::Inactive(InactiveReason::InteriorNeighbor));
                continue;
            }
            neighbors
                .entry(a.cell)
                .or_insert_with(|| ordinary_neighbors(a.cell));
            neighbors
                .entry(b.cell)
                .or_insert_with(|| ordinary_neighbors(b.cell));
            if neighbors[&a.cell].contains(&b.cell) || neighbors[&b.cell].contains(&a.cell) {
                activity.push(FoldActivity::Inactive(InactiveReason::DuplicateNeighbor));
                continue;
            }
            neighbors.get_mut(&a.cell).unwrap().insert(b.cell);
            neighbors.get_mut(&b.cell).unwrap().insert(a.cell);
            activity.push(FoldActivity::Active);
            links.insert(
                (a.cell, a.face_idx),
                Crossing {
                    cell: b.cell,
                    face: face_b,
                    orientation: Orientation {
                        flips: fold.twist,
                        entry: face_a,
                    },
                },
            );
            links.insert(
                (b.cell, b.face_idx),
                Crossing {
                    cell: a.cell,
                    face: face_a,
                    orientation: Orientation {
                        flips: fold.twist,
                        entry: face_b,
                    },
                },
            );
        }
        Self {
            topology,
            activity,
            links,
        }
    }

    pub(crate) fn has_links(&self) -> bool {
        !self.links.is_empty()
    }

    pub(crate) fn link(&self, cell: T::CellId, face_idx: usize) -> Option<TessCrossing<T>> {
        self.links.get(&(cell, face_idx)).copied()
    }
}

#[cfg(test)]
#[path = "topology_tests.rs"]
mod tests;
