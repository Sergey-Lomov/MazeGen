use super::*;
use crate::generation::PresetState;
use crate::generation::split_pattern::{
    OneWayDirection, SplitFaceRequirement, SplitPattern, SplitPatternFace,
};
use crate::generation::test_utils::make_field_graph_ids;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::space::test_support::GappedSquareTessellation;
use crate::space::{MultiLevelField, SquareFace, SquarePoint};
use std::sync::Arc;

fn empty_presets() -> PresetState {
    PresetState::empty()
}

fn simple_two_node_pattern() -> SplitPattern {
    SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 2,
        faces: vec![
            vec![
                SplitPatternFace {
                    face_index: 1,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                },
                SplitPatternFace {
                    face_index: 3,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: Some(1),
                },
            ],
            vec![SplitPatternFace {
                face_index: 0,
                requirement: SplitFaceRequirement::Passage,
                sibling_target: None,
            }],
        ],
        weight: 1.0,
    }
}

// ─── Pattern adaptation enumeration ──────────────────────────────────────

#[test]
fn enumerate_adaptations_pure_rng_free_same_inputs_same_output() {
    let (field, graph, _ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let pattern = simple_two_node_pattern();
    let visited: std::collections::HashSet<NodeId> = std::collections::HashSet::new();

    let a = enumerate_adaptations(
        &graph,
        &field,
        &empty_presets(),
        &visited,
        &pattern,
        src,
        None,
        None,
        false,
    );
    let b = enumerate_adaptations(
        &graph,
        &field,
        &empty_presets(),
        &visited,
        &pattern,
        src,
        None,
        None,
        false,
    );

    assert_eq!(
        a.len(),
        b.len(),
        "enumerate_adaptations must be deterministic across identical calls"
    );
    for (x, y) in a.iter().zip(b.iter()) {
        assert_eq!(x.transform, y.transform);
    }
}

#[test]
fn enumerate_adaptations_boundary_excludes_off_field_non_wall_faces() {
    // A corner point of a small field has geometric neighbors missing on 2 of 4 sides — any
    // rotation placing a Passage face toward a missing neighbor must be excluded.
    let (field, graph, _ids) = make_field_graph_ids(2, 2);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    // Single-node pattern requiring Passage on face 1 (N) — only valid where its image exists.
    let pattern = SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 1,
        faces: vec![vec![SplitPatternFace {
            face_index: 1,
            requirement: SplitFaceRequirement::Passage,
            sibling_target: None,
        }]],
        weight: 1.0,
    };
    let visited: std::collections::HashSet<NodeId> = std::collections::HashSet::new();
    let adaptations = enumerate_adaptations(
        &graph,
        &field,
        &empty_presets(),
        &visited,
        &pattern,
        src,
        None,
        None,
        false,
    );
    // At (0,0) in a 2x2 field: N and E exist, S and W don't. The pattern's 4 distinct variants
    // (one per face) resolve its face to N or E in exactly 2 of them.
    assert_eq!(
        adaptations.len(),
        2,
        "only the variants landing on an existing neighbor survive"
    );
}

#[test]
fn resolve_face_rejects_a_required_connection_when_step_has_no_coordinate() {
    let origin = SquarePoint { x: 0, y: 0 };
    let east = SquarePoint { x: 1, y: 0 };
    let mut ids = crate::IdGenerator::new();
    let field: MultiLevelField<GappedSquareTessellation> =
        MultiLevelField::single_level(Arc::default(), [origin, east], &mut ids).unwrap();
    let level = field.single_level_id();
    let face = SplitPatternFace {
        face_index: east_face_index(),
        requirement: SplitFaceRequirement::Passage,
        sibling_target: None,
    };
    let mut builder = super::AdaptationBuilder {
        faces: Vec::new(),
        used_neighbors: std::collections::HashSet::new(),
        visited_face_used: false,
        bridge_targeted: false,
        parent_targeted: false,
    };

    assert!(!super::resolve_face(
        &field,
        level,
        origin,
        &std::collections::HashSet::new(),
        None,
        None,
        false,
        false,
        false,
        0,
        &face,
        east_face_index(),
        &mut builder,
    ));
    assert!(builder.faces.is_empty());
}

#[test]
fn enumerate_adaptations_requires_bridge_targeted_face_when_bridge_present() {
    let (field, graph, _ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let bridge = field
        .node_at(field_level, SquarePoint { x: 2, y: 3 })
        .unwrap(); // north neighbor
    let pattern = SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 1,
        faces: vec![vec![SplitPatternFace {
            face_index: 1,
            requirement: SplitFaceRequirement::Passage,
            sibling_target: None,
        }]],
        weight: 1.0,
    };
    let mut visited: std::collections::HashSet<NodeId> = std::collections::HashSet::new();
    visited.insert(bridge);
    let adaptations = enumerate_adaptations(
        &graph,
        &field,
        &empty_presets(),
        &visited,
        &pattern,
        src,
        Some(bridge),
        None,
        false,
    );
    // Every valid adaptation must have its single face resolve to `bridge` specifically.
    for a in &adaptations {
        assert!(
            a.faces.iter().any(|f| f.neighbor == Some(bridge)),
            "adaptation must target the bridge node"
        );
    }
    assert!(
        !adaptations.is_empty(),
        "at least one rotation must resolve to the bridge neighbor"
    );
}

// ─── Parent-edge relocation ───────────────────────────────────────────────

#[test]
fn enumerate_adaptations_accepts_a_face_matching_the_existing_parent_edge() {
    // `src` already has a bidirectional edge to its real traversal parent (north neighbor) —
    // a Passage face resolving to `parent` must be accepted (parent_targeted requirement
    // satisfied), not rejected as "targets an already-visited neighbor".
    let (field, mut graph, _ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let parent = field
        .node_at(field_level, SquarePoint { x: 2, y: 3 })
        .unwrap(); // north neighbor
    graph.add_bidirectional_edge(src, parent, EdgeKind::Basic);
    let pattern = SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 1,
        faces: vec![vec![SplitPatternFace {
            face_index: 1,
            requirement: SplitFaceRequirement::Passage,
            sibling_target: None,
        }]],
        weight: 1.0,
    };
    let mut visited: std::collections::HashSet<NodeId> = std::collections::HashSet::new();
    visited.insert(parent);
    let adaptations = enumerate_adaptations(
        &graph,
        &field,
        &empty_presets(),
        &visited,
        &pattern,
        src,
        None,
        Some(parent),
        false,
    );
    assert!(
        !adaptations.is_empty(),
        "at least one rotation must resolve to and match the parent edge"
    );
    for a in &adaptations {
        assert!(
            a.faces.iter().any(|f| f.neighbor == Some(parent)),
            "adaptation must target the parent node"
        );
    }
}

#[test]
fn enumerate_adaptations_rejects_a_one_way_face_against_a_bidirectional_parent_edge() {
    // The pattern's only face toward `parent`'s direction is OneWay, but the real parent edge is
    // bidirectional (Passage) — direction/kind mismatch must invalidate every adaptation that
    // would otherwise resolve there, not silently reinterpret the edge.
    let (field, mut graph, _ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let parent = field
        .node_at(field_level, SquarePoint { x: 2, y: 3 })
        .unwrap();
    graph.add_bidirectional_edge(src, parent, EdgeKind::Basic);
    let pattern = SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 1,
        faces: vec![vec![SplitPatternFace {
            face_index: 1,
            requirement: SplitFaceRequirement::OneWay(OneWayDirection::Forward),
            sibling_target: None,
        }]],
        weight: 1.0,
    };
    let visited: std::collections::HashSet<NodeId> = std::collections::HashSet::new();
    let adaptations = enumerate_adaptations(
        &graph,
        &field,
        &empty_presets(),
        &visited,
        &pattern,
        src,
        None,
        Some(parent),
        false,
    );
    assert!(
        adaptations.is_empty(),
        "a OneWay face can never match a bidirectional parent edge"
    );
}

#[test]
fn enumerate_adaptations_requires_parent_targeted_face_when_parent_present() {
    // No face of this pattern can ever resolve to `parent` at all (single Wall face, no
    // geometric resolution) — every adaptation must be rejected, mirroring bridge_targeted.
    let (field, mut graph, _ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let parent = field
        .node_at(field_level, SquarePoint { x: 2, y: 3 })
        .unwrap();
    graph.add_bidirectional_edge(src, parent, EdgeKind::Basic);
    let pattern = SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 1,
        faces: vec![vec![SplitPatternFace {
            face_index: 1,
            requirement: SplitFaceRequirement::Wall,
            sibling_target: None,
        }]],
        weight: 1.0,
    };
    let visited: std::collections::HashSet<NodeId> = std::collections::HashSet::new();
    let adaptations = enumerate_adaptations(
        &graph,
        &field,
        &empty_presets(),
        &visited,
        &pattern,
        src,
        None,
        Some(parent),
        false,
    );
    assert!(
        adaptations.is_empty(),
        "a Wall-only pattern can never target parent, so must be rejected entirely"
    );
}

// ─── Preset rejection (per-face) vs. whole-node ineligibility ────────────

#[test]
fn adaptation_respects_presets_rejects_locked_out_node_zero_passage() {
    let (field, _graph, _ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let neighbor = field
        .node_at(field_level, SquarePoint { x: 2, y: 3 })
        .unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(src);
    let faces = vec![ResolvedFace_for_test(
        0,
        SplitFaceRequirement::Passage,
        None,
        Some(neighbor),
    )];
    assert!(!adaptation_respects_presets(src, &faces, &preset_state));
}

#[test]
fn adaptation_respects_presets_allows_unconstrained_new_node_faces() {
    // Presets only ever constrain pattern-local node 0 (= src) — a face on node 1+ must never be
    // rejected regardless of what's locked, since PresetState can't know about it.
    let (field, _graph, _ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let neighbor = field
        .node_at(field_level, SquarePoint { x: 2, y: 3 })
        .unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(neighbor); // locks the *neighbor*, not src or node 1
    let faces = vec![ResolvedFace_for_test(
        1,
        SplitFaceRequirement::Passage,
        None,
        Some(neighbor),
    )];
    assert!(
        adaptation_respects_presets(src, &faces, &preset_state),
        "node 1+ faces are never preset-constrained"
    );
}

#[allow(non_snake_case)]
fn ResolvedFace_for_test(
    node_index: usize,
    requirement: SplitFaceRequirement,
    sibling_target: Option<usize>,
    neighbor: Option<NodeId>,
) -> ResolvedFace {
    ResolvedFace {
        node_index,
        requirement,
        sibling_target,
        neighbor,
    }
}

/// Position of `SquareFace::E` in `GappedSquareTessellation`'s (uniform) face order.
fn east_face_index() -> usize {
    GappedSquareTessellation
        .faces_of(SquarePoint { x: 0, y: 0 })
        .iter()
        .position(|&face| face == SquareFace::E)
        .unwrap()
}
