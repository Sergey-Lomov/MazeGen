/// What a pattern face requires the resulting edge to be. `Wall` is the only requirement
/// satisfiable off-field (a face pointing past the tessellation's boundary). `Unspecified`
/// leaves the face open to the ordinary corridor/junction logic, like any other free neighbor —
/// it participates in `enumerate_adaptations`'s visited/unvisited bookkeeping but adds no edge of
/// its own.
#[derive(Debug, Clone, Copy, PartialEq)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OneWayDirection {
    Forward,
    Backward,
}

/// One face of one pattern-local node. `face_index` is a position into `Tessellation::faces()`
/// (see `Tessellation::face_index`/`face_at`), always interpreted against the tessellation the
/// pattern is currently authored/applied for — patterns are per-tessellation and never portable
/// across tessellations (see `SplitPattern`'s doc comment).
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

/// An abstract, tessellation-relative split template — rotated and mirrored at apply time to fit
/// a specific tile (see `enumerate_adaptations` in `vertex_based.rs`). `faces[i]` is
/// pattern-local node `i`'s face list; node `0` always corresponds to the tile's pre-existing
/// `src` node, every other index is a node newly minted when the pattern is applied.
///
/// Patterns are **per-tessellation, not portable**: a pattern's `face_index` values are only
/// meaningful against the tessellation they were authored for. The active tessellation owns its
/// own pattern list; switching tessellation discards it, the same as other tessellation-specific
/// project settings.
#[derive(Debug, Clone)]
pub struct SplitPattern {
    pub node_count: usize,
    pub faces: Vec<Vec<SplitPatternFace>>,
    /// Relative selection weight among patterns competing for the same split event. Clamped to
    /// `.max(0.0)` at the DTO boundary (NaN also maps to `0.0`) — a non-positive weight is simply
    /// never selected, not a config error.
    pub weight: f64,
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
        SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] }
    }
}

/// Validates every pattern in `config` against a tessellation of the given `degree`
/// (`Tessellation::faces().len()`) — shared by `maze-runner` and `maze-wasm`'s own generation
/// entry points, since neither is generic over `T: Tessellation` until this point in their own
/// call chain (see each caller's own doc comment for why the check lives here rather than at the
/// DTO-conversion layer). Two independent failure modes (GitHub issue #222):
/// - `face_index` outside `[0, degree)` — meaningless against the active tessellation, most likely
///   a hand-edited or stale project file (the UI itself can't produce one, patterns are edited per
///   tessellation via `TileFaceEditor`).
/// - `node_count` not matching `faces.len()` — the UI always keeps them in sync (`setNodeCount`/
///   `removeNode` both resize `faces` alongside `node_count`), but a hand-edited/stale project
///   file could have `node_count` larger than `faces.len()`; `apply_pattern_adaptation` still
///   mints exactly `node_count - 1` new nodes regardless, so any node index past `faces.len()`
///   would get no face applied at all.
///
/// A node with no `Passage`/`OneWay` face at all (only `Wall`/`Unspecified`, or none declared) is
/// **not** rejected here (GitHub issue #238): it mints a permanently disconnected split node, same
/// as any other unreachable-node case, and is left for QC to catch (or not) like other
/// reachability issues instead of aborting the whole generation.
pub fn validate_split_patterns(patterns: &[SplitPattern], degree: usize) -> Result<(), String> {
    for pattern in patterns {
        if pattern.faces.len() != pattern.node_count {
            return Err(format!(
                "split pattern node_count {} does not match faces.len() {}",
                pattern.node_count, pattern.faces.len()
            ));
        }
        for node_faces in pattern.faces.iter() {
            for face in node_faces {
                if face.face_index >= degree {
                    return Err(format!(
                        "split pattern face_index {} out of range for tessellation degree {degree}",
                        face.face_index
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod validate_split_patterns_tests {
    use super::*;

    fn passage_face(face_index: usize) -> SplitPatternFace {
        SplitPatternFace { face_index, requirement: SplitFaceRequirement::Passage, sibling_target: None }
    }

    #[test]
    fn empty_pattern_list_is_valid() {
        assert!(validate_split_patterns(&[], 4).is_ok());
    }

    #[test]
    fn a_pattern_where_every_node_has_a_connecting_face_is_valid() {
        let pattern = SplitPattern {
            node_count: 2,
            faces: vec![vec![passage_face(0)], vec![passage_face(2)]],
            weight: 1.0,
        };
        assert!(validate_split_patterns(&[pattern], 4).is_ok());
    }

    #[test]
    fn a_node_with_only_wall_and_unspecified_faces_is_accepted() {
        // GitHub issue #238: a node with no Passage/OneWay face is no longer a validation error —
        // it mints a permanently disconnected split node, left for QC to catch like any other
        // unreachable-node case, instead of aborting the whole generation.
        let pattern = SplitPattern {
            node_count: 2,
            faces: vec![
                vec![passage_face(0)],
                vec![
                    SplitPatternFace { face_index: 1, requirement: SplitFaceRequirement::Wall, sibling_target: None },
                    SplitPatternFace { face_index: 2, requirement: SplitFaceRequirement::Unspecified, sibling_target: None },
                ],
            ],
            weight: 1.0,
        };
        assert!(validate_split_patterns(&[pattern], 4).is_ok());
    }

    #[test]
    fn a_node_with_no_faces_declared_at_all_is_accepted() {
        let pattern = SplitPattern { node_count: 2, faces: vec![vec![passage_face(0)], vec![]], weight: 1.0 };
        assert!(validate_split_patterns(&[pattern], 4).is_ok());
    }

    #[test]
    fn a_one_way_face_is_accepted() {
        let pattern = SplitPattern {
            node_count: 1,
            faces: vec![vec![SplitPatternFace { face_index: 0, requirement: SplitFaceRequirement::OneWay(OneWayDirection::Forward), sibling_target: None }]],
            weight: 1.0,
        };
        assert!(validate_split_patterns(&[pattern], 4).is_ok());
    }

    #[test]
    fn out_of_range_face_index_is_rejected() {
        let pattern = SplitPattern { node_count: 1, faces: vec![vec![passage_face(4)]], weight: 1.0 };
        let err = validate_split_patterns(&[pattern], 4).unwrap_err();
        assert!(err.contains("out of range"), "error should mention the range violation: {err}");
    }

    #[test]
    fn node_count_larger_than_faces_len_is_rejected() {
        // Regression: apply_pattern_adaptation mints exactly node_count - 1 new nodes regardless
        // of faces.len() — a node index past faces.len() would get no face applied at all,
        // permanently disconnected, with no validation error to catch it (the UI always keeps
        // node_count and faces.len() in sync, but a hand-edited project file might not).
        let pattern = SplitPattern { node_count: 3, faces: vec![vec![passage_face(0)], vec![passage_face(2)]], weight: 1.0 };
        let err = validate_split_patterns(&[pattern], 4).unwrap_err();
        assert!(err.contains("node_count"), "error should mention the node_count/faces.len() mismatch: {err}");
    }

    #[test]
    fn node_count_smaller_than_faces_len_is_rejected() {
        let pattern = SplitPattern { node_count: 1, faces: vec![vec![passage_face(0)], vec![passage_face(2)]], weight: 1.0 };
        let err = validate_split_patterns(&[pattern], 4).unwrap_err();
        assert!(err.contains("node_count"), "error should mention the node_count/faces.len() mismatch: {err}");
    }
}
