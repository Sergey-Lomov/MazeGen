use crate::space::{CellShape, Tessellation};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// What a pattern face requires the resulting edge to be. `Wall` is the only requirement
/// satisfiable off-field (a face pointing past the tessellation's boundary). `Unspecified`
/// leaves the face open to the ordinary corridor/junction logic, like any other free neighbor —
/// it participates in `enumerate_adaptations`'s visited/unvisited bookkeeping but adds no edge of
/// its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SplitFaceRequirement {
    Passage,
    OneWay(OneWayDirection),
    Wall,
    Unspecified,
}

/// Direction of a `OneWay` face's edge relative to the pattern-local node that owns the face —
/// `Forward` means the edge points away from this node (toward `sibling_target` or the outside
/// neighbor), `Backward` means it points into this node. Reuses `PresetConnectionState`'s
/// `OneWayForward`/`OneWayBackward` naming convention for consistency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum OneWayDirection {
    Forward,
    Backward,
}

/// One face of one pattern-local node. `face_index` is a **canonical** index into the circular
/// face order of the pattern's shape template (`SplitPattern::shape`, `0..face_count`), never a
/// position in a particular cell's `faces_of` — the face chain of the cell's `CellShape` maps it
/// onto a local face when the pattern is applied (see `pattern_variants`).
///
/// `sibling_target: Some(i)` means this face must connect to pattern-local node `i` (an
/// inter-split edge, never geometrically resolved — the two split nodes share the same point).
/// `None` means the face resolves to whatever the tessellation's geometry places on the other
/// side of this face, an ordinary outside neighbor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SplitPatternFace {
    pub face_index: usize,
    pub requirement: SplitFaceRequirement,
    pub sibling_target: Option<usize>,
}

/// An abstract split template bound to a shape template (`shape`, a `ShapeDescriptor` key such as
/// `regular:4`) — transformed at apply time by each element of the target cell's allowed transform
/// group (see `pattern_variants`). `faces[i]` is pattern-local node `i`'s face list; node `0`
/// always corresponds to the tile's pre-existing `src` node, every other index is a node newly
/// minted when the pattern is applied.
///
/// Patterns belong to a descriptor, not to a tessellation: a pattern applies only to cells whose
/// `shape_of` descriptor key equals `shape` (see `Specs/split-patterns.md`'s two-level
/// applicability).
#[derive(Debug, Clone)]
pub struct SplitPattern {
    /// Key of the `ShapeDescriptor` the canonical `face_index` values refer to.
    pub shape: String,
    pub node_count: usize,
    pub faces: Vec<Vec<SplitPatternFace>>,
    /// Relative selection weight among patterns competing for the same split event. Clamped to
    /// `.max(0.0)` at the DTO boundary (NaN also maps to `0.0`) — a non-positive weight is simply
    /// never selected, not a config error.
    pub weight: f64,
}

impl SplitPattern {
    /// Whether this pattern is a candidate for a cell with template `shape` (descriptor level of
    /// the two-level applicability rule): the cell has a template and its key equals `self.shape`.
    pub fn applies_to(&self, shape: Option<&CellShape<'_>>) -> bool {
        shape.is_some_and(|shape| shape.descriptor().key() == self.shape)
    }
}

/// One variant of a pattern on one cell: the allowed transform that produced it and, parallel to
/// `SplitPattern::faces`, the local face index (position in the cell's `faces_of`) each pattern
/// face lands on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternVariant {
    /// Index into the cell's `descriptor().group()`, one of its `allowed_transforms()`.
    pub transform: usize,
    pub local_faces: Vec<Vec<usize>>,
}

/// Every variant of `pattern` on a cell with template `shape`: one per element of the cell's
/// allowed transform group (in `allowed_transforms` order), each pattern face mapped through the
/// face chain `canonical → transformed → local`. Variants producing an identical local face
/// assignment (same `(node, local face, requirement, sibling_target)` set) are deduplicated,
/// keeping the first. Empty when the pattern does not apply to `shape` or a `face_index` is out of
/// the descriptor's range. Pure; the topology level (neighbors, visited state, parent edge) is
/// checked by each consumer on application.
pub fn pattern_variants(pattern: &SplitPattern, shape: &CellShape<'_>) -> Vec<PatternVariant> {
    let face_count = shape.descriptor().face_count();
    if !pattern.applies_to(Some(shape))
        || pattern
            .faces
            .iter()
            .flatten()
            .any(|face| face.face_index >= face_count)
    {
        return Vec::new();
    }
    let mut seen: HashSet<Vec<AssignmentKey>> = HashSet::new();
    let mut variants = Vec::new();
    for &transform in shape.allowed_transforms() {
        let local_faces: Vec<Vec<usize>> = pattern
            .faces
            .iter()
            .map(|node_faces| {
                node_faces
                    .iter()
                    .map(|face| shape.transformed_local(transform, face.face_index))
                    .collect()
            })
            .collect();
        let mut key: Vec<AssignmentKey> = pattern
            .faces
            .iter()
            .zip(&local_faces)
            .enumerate()
            .flat_map(|(node, (node_faces, locals))| {
                node_faces
                    .iter()
                    .zip(locals)
                    .map(move |(face, &local)| (node, local, face.requirement, face.sibling_target))
            })
            .collect();
        key.sort();
        if seen.insert(key) {
            variants.push(PatternVariant {
                transform,
                local_faces,
            });
        }
    }
    variants
}

type AssignmentKey = (usize, usize, SplitFaceRequirement, Option<usize>);

/// Memoizes `pattern_variants` per (pattern index, cell binding) for one generation run, whose
/// pattern list is fixed. A binding is identified by content — descriptor key, local-to-canonical
/// map and allowed transforms, the only inputs `pattern_variants` reads besides the pattern — so
/// cells with equal bindings share one entry wherever the tessellation stores the binding data.
/// A lookup hashes the content and compares it against the bucket; it allocates only on a miss.
#[derive(Debug, Default)]
pub(crate) struct PatternVariantCache {
    buckets: HashMap<u64, Vec<CachedVariants>>,
}

#[derive(Debug)]
struct CachedVariants {
    pattern_idx: usize,
    shape_key: String,
    local_to_canonical: Vec<usize>,
    allowed_transforms: Vec<usize>,
    variants: Arc<[PatternVariant]>,
}

impl CachedVariants {
    fn matches(&self, pattern_idx: usize, shape: &CellShape<'_>) -> bool {
        self.pattern_idx == pattern_idx
            && self.shape_key == shape.descriptor().key()
            && self.local_to_canonical == shape.local_to_canonical()
            && self.allowed_transforms == shape.allowed_transforms()
    }
}

impl PatternVariantCache {
    /// `pattern_variants(&patterns[pattern_idx], shape)`, computed once per binding.
    pub(crate) fn variants(
        &mut self,
        patterns: &[SplitPattern],
        pattern_idx: usize,
        shape: &CellShape<'_>,
    ) -> Arc<[PatternVariant]> {
        let mut hasher = DefaultHasher::new();
        (
            pattern_idx,
            shape.descriptor().key(),
            shape.local_to_canonical(),
            shape.allowed_transforms(),
        )
            .hash(&mut hasher);
        let bucket = self.buckets.entry(hasher.finish()).or_default();
        if let Some(cached) = bucket.iter().find(|c| c.matches(pattern_idx, shape)) {
            return Arc::clone(&cached.variants);
        }
        let variants: Arc<[PatternVariant]> =
            pattern_variants(&patterns[pattern_idx], shape).into();
        bucket.push(CachedVariants {
            pattern_idx,
            shape_key: shape.descriptor().key().to_string(),
            local_to_canonical: shape.local_to_canonical().to_vec(),
            allowed_transforms: shape.allowed_transforms().to_vec(),
            variants: Arc::clone(&variants),
        });
        variants
    }
}

/// Per-run configuration for `CustomVertexBased`'s automatic split-point assignment (GitHub issue
/// #222). Consulted only by `CustomVertexBased` — every other generation algorithm ignores it.
#[derive(Debug, Clone)]
pub struct SplitGenerationConfig {
    pub pattern_mode: bool,
    /// Non-pattern mode only: the **total** node count on a split tile, including the
    /// pre-existing `src` node itself. An exact count, not a ceiling. `0` is invalid (clamped to
    /// `1` at the DTO boundary); `1` is a valid, deliberate no-op (the split roll's RNG sample is
    /// still spent, but no new node is minted).
    pub max_split_nodes: u32,
    pub patterns: Vec<SplitPattern>,
}

impl Default for SplitGenerationConfig {
    fn default() -> Self {
        SplitGenerationConfig {
            pattern_mode: false,
            max_split_nodes: 2,
            patterns: vec![],
        }
    }
}

/// Validates every pattern against the active tessellation instance — shared by `maze-runner` and
/// `maze-wasm`'s own generation entry points, since neither is generic over `T: Tessellation`
/// until this point in their own call chain. Rejected (see `Specs/split-patterns.md`):
/// - a `shape` the tessellation does not provide (`shape_descriptors`) — most likely a stale or
///   hand-edited project file;
/// - a `face_index >= face_count` of the pattern's descriptor;
/// - `node_count` not matching `faces.len()` — the UI always keeps them in sync, but a
///   hand-edited/stale project file could have `node_count` larger than `faces.len()`;
///   `apply_pattern_adaptation` still mints exactly `node_count - 1` new nodes regardless, so any
///   node index past `faces.len()` would get no face applied at all.
///
/// A node with no `Passage`/`OneWay` face at all (only `Wall`/`Unspecified`, or none declared) is
/// **not** rejected here (GitHub issue #238): it mints a permanently disconnected split node, same
/// as any other unreachable-node case, and is left for QC to catch (or not) like other
/// reachability issues instead of aborting the whole generation.
pub fn validate_split_patterns<T: Tessellation>(
    patterns: &[SplitPattern],
    tessellation: &T,
) -> Result<(), String> {
    for pattern in patterns {
        if pattern.faces.len() != pattern.node_count {
            return Err(format!(
                "split pattern node_count {} does not match faces.len() {}",
                pattern.node_count,
                pattern.faces.len()
            ));
        }
        let Some(descriptor) = tessellation
            .shape_descriptors()
            .iter()
            .find(|descriptor| descriptor.key() == pattern.shape)
        else {
            return Err(format!(
                "split pattern shape `{}` is not provided by the tessellation",
                pattern.shape
            ));
        };
        let face_count = descriptor.face_count();
        for face in pattern.faces.iter().flatten() {
            if face.face_index >= face_count {
                return Err(format!(
                    "split pattern face_index {} out of range for shape `{}` with {face_count} faces",
                    face.face_index, pattern.shape
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod validate_split_patterns_tests {
    use super::*;
    use crate::space::{ShapeDescriptor, SquareTessellation, TriTessellation};

    const SQUARE: SquareTessellation = SquareTessellation;

    fn passage_face(face_index: usize) -> SplitPatternFace {
        SplitPatternFace {
            face_index,
            requirement: SplitFaceRequirement::Passage,
            sibling_target: None,
        }
    }

    #[test]
    fn empty_pattern_list_is_valid() {
        assert!(validate_split_patterns(&[], &SQUARE).is_ok());
    }

    #[test]
    fn a_pattern_where_every_node_has_a_connecting_face_is_valid() {
        let pattern = SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 2,
            faces: vec![vec![passage_face(0)], vec![passage_face(2)]],
            weight: 1.0,
        };
        assert!(validate_split_patterns(&[pattern], &SQUARE).is_ok());
    }

    #[test]
    fn a_node_with_only_wall_and_unspecified_faces_is_accepted() {
        // GitHub issue #238: a node with no Passage/OneWay face is no longer a validation error —
        // it mints a permanently disconnected split node, left for QC to catch like any other
        // unreachable-node case, instead of aborting the whole generation.
        let pattern = SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 2,
            faces: vec![
                vec![passage_face(0)],
                vec![
                    SplitPatternFace {
                        face_index: 1,
                        requirement: SplitFaceRequirement::Wall,
                        sibling_target: None,
                    },
                    SplitPatternFace {
                        face_index: 2,
                        requirement: SplitFaceRequirement::Unspecified,
                        sibling_target: None,
                    },
                ],
            ],
            weight: 1.0,
        };
        assert!(validate_split_patterns(&[pattern], &SQUARE).is_ok());
    }

    #[test]
    fn a_node_with_no_faces_declared_at_all_is_accepted() {
        let pattern = SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 2,
            faces: vec![vec![passage_face(0)], vec![]],
            weight: 1.0,
        };
        assert!(validate_split_patterns(&[pattern], &SQUARE).is_ok());
    }

    #[test]
    fn a_one_way_face_is_accepted() {
        let pattern = SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 1,
            faces: vec![vec![SplitPatternFace {
                face_index: 0,
                requirement: SplitFaceRequirement::OneWay(OneWayDirection::Forward),
                sibling_target: None,
            }]],
            weight: 1.0,
        };
        assert!(validate_split_patterns(&[pattern], &SQUARE).is_ok());
    }

    #[test]
    fn out_of_range_face_index_is_rejected() {
        let pattern = SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 1,
            faces: vec![vec![passage_face(4)]],
            weight: 1.0,
        };
        let err = validate_split_patterns(&[pattern], &SQUARE).unwrap_err();
        assert!(
            err.contains("out of range"),
            "error should mention the range violation: {err}"
        );
    }

    #[test]
    fn node_count_larger_than_faces_len_is_rejected() {
        // Regression: apply_pattern_adaptation mints exactly node_count - 1 new nodes regardless
        // of faces.len() — a node index past faces.len() would get no face applied at all,
        // permanently disconnected, with no validation error to catch it (the UI always keeps
        // node_count and faces.len() in sync, but a hand-edited project file might not).
        let pattern = SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 3,
            faces: vec![vec![passage_face(0)], vec![passage_face(2)]],
            weight: 1.0,
        };
        let err = validate_split_patterns(&[pattern], &SQUARE).unwrap_err();
        assert!(
            err.contains("node_count"),
            "error should mention the node_count/faces.len() mismatch: {err}"
        );
    }

    #[test]
    fn node_count_smaller_than_faces_len_is_rejected() {
        let pattern = SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 1,
            faces: vec![vec![passage_face(0)], vec![passage_face(2)]],
            weight: 1.0,
        };
        let err = validate_split_patterns(&[pattern], &SQUARE).unwrap_err();
        assert!(
            err.contains("node_count"),
            "error should mention the node_count/faces.len() mismatch: {err}"
        );
    }

    #[test]
    fn unknown_shape_is_rejected() {
        let pattern = SplitPattern {
            shape: "regular:4".to_string(),
            node_count: 1,
            faces: vec![vec![passage_face(0)]],
            weight: 1.0,
        };
        let err = validate_split_patterns(&[pattern], &TriTessellation).unwrap_err();
        assert!(
            err.contains("shape"),
            "error should mention the shape: {err}"
        );
    }

    fn square_pattern(faces: Vec<Vec<SplitPatternFace>>) -> SplitPattern {
        SplitPattern {
            shape: "regular:4".to_string(),
            node_count: faces.len(),
            faces,
            weight: 1.0,
        }
    }

    #[test]
    fn variants_are_the_allowed_group_deduplicated_by_local_assignment() {
        let cell = crate::space::SquarePoint { x: 0, y: 0 };
        let shape = SQUARE.shape_of(cell).unwrap();
        // One face: every rotation lands it on a different face, each reflection repeats one.
        let single = square_pattern(vec![vec![passage_face(0)]]);
        assert_eq!(pattern_variants(&single, &shape).len(), 4);
        // Opposite pair on one node: only two distinct placements.
        let through = square_pattern(vec![vec![passage_face(0), passage_face(2)]]);
        assert_eq!(pattern_variants(&through, &shape).len(), 2);
        // An asymmetric two-node pattern keeps every group element.
        let corner = square_pattern(vec![vec![passage_face(0)], vec![passage_face(1)]]);
        let variants = pattern_variants(&corner, &shape);
        assert_eq!(variants.len(), 8);
        assert_eq!(variants[0].transform, 0, "identity comes first");
    }

    #[test]
    fn variants_map_canonical_faces_through_the_face_chain() {
        let cell = crate::space::SquarePoint { x: 0, y: 0 };
        let shape = SQUARE.shape_of(cell).unwrap();
        let pattern = square_pattern(vec![vec![passage_face(1)]]);
        for variant in pattern_variants(&pattern, &shape) {
            let local = variant.local_faces[0][0];
            assert_eq!(shape.transformed_local(variant.transform, 1), local);
        }
    }

    #[test]
    fn variants_are_empty_for_another_shape_or_an_out_of_range_face() {
        let cell = crate::space::SquarePoint { x: 0, y: 0 };
        let shape = SQUARE.shape_of(cell).unwrap();
        let mut hex = square_pattern(vec![vec![passage_face(0)]]);
        hex.shape = "regular:6".to_string();
        assert!(pattern_variants(&hex, &shape).is_empty());
        let out_of_range = square_pattern(vec![vec![passage_face(4)]]);
        assert!(pattern_variants(&out_of_range, &shape).is_empty());
    }

    #[test]
    fn variant_cache_shares_equal_bindings_stored_at_different_addresses() {
        let descriptor = ShapeDescriptor::regular_polygon(4);
        let identity_a = vec![0, 1, 2, 3];
        let identity_b = vec![0, 1, 2, 3];
        let rotated = vec![1, 2, 3, 0];
        let patterns = [square_pattern(vec![
            vec![passage_face(0)],
            vec![passage_face(1)],
        ])];
        let mut cache = PatternVariantCache::default();

        let a = cache.variants(&patterns, 0, &CellShape::full(&descriptor, &identity_a));
        let b = cache.variants(&patterns, 0, &CellShape::full(&descriptor, &identity_b));
        assert!(Arc::ptr_eq(&a, &b), "equal bindings must share one entry");

        let shape = CellShape::full(&descriptor, &rotated);
        let c = cache.variants(&patterns, 0, &shape);
        assert!(!Arc::ptr_eq(&a, &c));
        assert_eq!(&*c, pattern_variants(&patterns[0], &shape).as_slice());
    }
}
