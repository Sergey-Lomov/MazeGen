//! Shape templates: reusable topological cell templates with a canonical circular face order and a
//! symmetry group, plus the per-cell binding (`CellShape`) of a template onto a cell's local faces.
//! See `Specs/space.md`'s "Shape templates".

use std::collections::HashSet;

/// The family a `ShapeDescriptor` belongs to; it fixes the template's key and symmetry group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShapeFamily {
    /// A regular `n`-gon: dihedral group, `n` rotations + `n` reflections. Key `regular:<n>`.
    RegularPolygon { n: usize },
    /// The Cairo pentagon: identity + the reflection fixing the long side (canonical face 0).
    /// Key `cairo_pentagon`.
    CairoPentagon,
    /// A template registered by a tessellation. Key `<kind>:<name>`; the group is the closure of
    /// `generators` under composition.
    Registered {
        kind: &'static str,
        name: &'static str,
        face_count: usize,
        generators: Vec<Vec<usize>>,
    },
}

/// A reusable topological template: a stable key, a face count `n`, the canonical circular
/// (counter-clockwise) face order `0..n`, and the template's symmetry group. The group is computed
/// once, at construction, and cached. Descriptors are equal iff their keys are equal.
#[derive(Debug, Clone)]
pub struct ShapeDescriptor {
    key: String,
    group: Vec<Vec<usize>>,
    all_transforms: Vec<usize>,
}

impl PartialEq for ShapeDescriptor {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

impl Eq for ShapeDescriptor {}

impl ShapeDescriptor {
    pub fn new(family: ShapeFamily) -> Self {
        let (key, group) = match family {
            ShapeFamily::RegularPolygon { n } => (format!("regular:{n}"), dihedral_group(n)),
            ShapeFamily::CairoPentagon => (
                "cairo_pentagon".to_string(),
                vec![vec![0, 1, 2, 3, 4], vec![0, 4, 3, 2, 1]],
            ),
            ShapeFamily::Registered {
                kind,
                name,
                face_count,
                generators,
            } => {
                // `regular:<n>` belongs to `RegularPolygon`; a registered template reusing it
                // would compare equal to a descriptor with a different group.
                assert!(
                    kind != "regular",
                    "registered shape template kind must not be `regular`"
                );
                (
                    format!("{kind}:{name}"),
                    group_closure(face_count, &generators),
                )
            }
        };
        let all_transforms = (0..group.len()).collect();
        Self {
            key,
            group,
            all_transforms,
        }
    }

    pub fn regular_polygon(n: usize) -> Self {
        Self::new(ShapeFamily::RegularPolygon { n })
    }

    pub fn cairo_pentagon() -> Self {
        Self::new(ShapeFamily::CairoPentagon)
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    /// Number of faces `n`; canonical face indices are `0..n` in counter-clockwise order.
    pub fn face_count(&self) -> usize {
        self.group[0].len()
    }

    /// The symmetry group as permutations of canonical indices: `group()[g][i]` is the image of
    /// canonical face `i` under transform `g`. Element 0 is the identity; the list is closed under
    /// composition.
    pub fn group(&self) -> &[Vec<usize>] {
        &self.group
    }

    /// Every transform index of the group (`0..group().len()`) — the default allowed transform
    /// group of a cell.
    pub fn all_transforms(&self) -> &[usize] {
        &self.all_transforms
    }
}

/// Dihedral group of a regular `n`-gon over the counter-clockwise canonical order: rotations
/// `i -> i + k` for `k` in `0..n` (identity first), then reflections `i -> k - i` (mod `n`).
fn dihedral_group(n: usize) -> Vec<Vec<usize>> {
    assert!(n >= 3, "RegularPolygon needs at least 3 faces, got {n}");
    let rotations = (0..n).map(|k| (0..n).map(|i| (i + k) % n).collect());
    let reflections = (0..n).map(|k| (0..n).map(|i| (k + n - i) % n).collect());
    rotations.chain(reflections).collect()
}

/// Closure of `generators` under composition, identity first, then breadth-first discovery order
/// (deterministic for a given generator list).
fn group_closure(face_count: usize, generators: &[Vec<usize>]) -> Vec<Vec<usize>> {
    assert!(face_count > 0, "a shape template needs at least one face");
    for generator in generators {
        assert!(
            is_permutation(generator, face_count),
            "shape template generator {generator:?} is not a permutation of 0..{face_count}"
        );
    }
    let mut group: Vec<Vec<usize>> = vec![(0..face_count).collect()];
    let mut seen: HashSet<Vec<usize>> = HashSet::from([group[0].clone()]);
    let mut next = 0;
    while next < group.len() {
        for generator in generators {
            let composed = compose(generator, &group[next]);
            if seen.insert(composed.clone()) {
                group.push(composed);
            }
        }
        next += 1;
    }
    group
}

/// `(outer ∘ inner)[i] = outer[inner[i]]`.
pub(crate) fn compose(outer: &[usize], inner: &[usize]) -> Vec<usize> {
    inner.iter().map(|&i| outer[i]).collect()
}

pub(crate) fn is_permutation(perm: &[usize], n: usize) -> bool {
    let mut hit = vec![false; n];
    perm.len() == n
        && perm
            .iter()
            .all(|&i| i < n && !std::mem::replace(&mut hit[i], true))
}

/// A cell's binding to its template: the descriptor, the bijection from local face index
/// (position in `faces_of(cell)`) to canonical index, and the cell's allowed transform group
/// (indices into `descriptor.group()`; a subgroup containing the identity, the full group by
/// default).
///
/// Face chain `local → canonical → transformed → local`: under transform `g`, canonical face `k`
/// of a template-relative object lands on local face `local_of_canonical(group[g][k])`. Every
/// step is a bijection, so the chain is invertible.
#[derive(Debug, Clone, Copy)]
pub struct CellShape<'a> {
    descriptor: &'a ShapeDescriptor,
    local_to_canonical: &'a [usize],
    allowed_transforms: &'a [usize],
}

impl<'a> CellShape<'a> {
    /// The cell's template with its full symmetry group allowed.
    pub fn full(descriptor: &'a ShapeDescriptor, local_to_canonical: &'a [usize]) -> Self {
        Self::restricted(descriptor, local_to_canonical, descriptor.all_transforms())
    }

    /// The cell's template with only `allowed_transforms` (indices into `descriptor.group()`, a
    /// subgroup containing the identity) allowed. `local_to_canonical` must be a permutation of
    /// `0..descriptor.face_count()`.
    pub fn restricted(
        descriptor: &'a ShapeDescriptor,
        local_to_canonical: &'a [usize],
        allowed_transforms: &'a [usize],
    ) -> Self {
        debug_assert!(
            is_permutation(local_to_canonical, descriptor.face_count()),
            "local_to_canonical {local_to_canonical:?} is not a permutation for {}",
            descriptor.key()
        );
        debug_assert!(
            allowed_transforms.contains(&0)
                && allowed_transforms
                    .iter()
                    .all(|&g| g < descriptor.group().len()),
            "allowed transforms {allowed_transforms:?} must contain the identity and index {}'s group",
            descriptor.key()
        );
        Self {
            descriptor,
            local_to_canonical,
            allowed_transforms,
        }
    }

    pub fn descriptor(&self) -> &'a ShapeDescriptor {
        self.descriptor
    }

    /// Bijection from local face index (position in `faces_of(cell)`) to canonical index.
    pub fn local_to_canonical(&self) -> &'a [usize] {
        self.local_to_canonical
    }

    /// The cell's allowed transform group, as indices into `descriptor().group()`.
    pub fn allowed_transforms(&self) -> &'a [usize] {
        self.allowed_transforms
    }

    pub fn canonical_of_local(&self, local: usize) -> usize {
        self.local_to_canonical[local]
    }

    /// Inverse of `canonical_of_local`. Allocation-free, O(n).
    pub fn local_of_canonical(&self, canonical: usize) -> usize {
        self.local_to_canonical
            .iter()
            .position(|&c| c == canonical)
            .expect("local_to_canonical must be a bijection")
    }

    /// Local face that canonical face `canonical` lands on under transform `transform` (an index
    /// into `descriptor.group()` that must be in `allowed_transforms`).
    pub fn transformed_local(&self, transform: usize, canonical: usize) -> usize {
        debug_assert!(
            self.allowed_transforms.contains(&transform),
            "transform {transform} is not allowed for this cell"
        );
        self.local_of_canonical(self.descriptor.group()[transform][canonical])
    }

    /// Inverse of `transformed_local`: the canonical face that lands on local face `local` under
    /// transform `transform`.
    pub fn canonical_of_transformed_local(&self, transform: usize, local: usize) -> usize {
        debug_assert!(
            self.allowed_transforms.contains(&transform),
            "transform {transform} is not allowed for this cell"
        );
        let target = self.canonical_of_local(local);
        self.descriptor.group()[transform]
            .iter()
            .position(|&c| c == target)
            .expect("group elements must be permutations")
    }
}

#[cfg(test)]
#[path = "shape_tests.rs"]
mod shape_tests;
