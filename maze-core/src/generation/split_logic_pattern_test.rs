use super::super::*;
use crate::event_log::EventLog;
use crate::generation::split_pattern::{
    SplitFaceRequirement, SplitGenerationConfig, SplitPattern, SplitPatternFace,
};
use crate::generation::test_utils::make_field_graph_ids;
use crate::generation::{ElementsConfig, GenerationParams, PresetState};
use crate::ids::NodeId;
use crate::space::SquarePoint;

fn full_split_elements() -> ElementsConfig {
    ElementsConfig {
        one_way_chance: 0.0,
        teleport_chance: 0.0,
        teleport_one_way_chance: 0.0,
        split_chance: 1.0,
        ..Default::default()
    }
}

fn empty_presets() -> PresetState {
    PresetState::empty()
}

// ─── Pattern adaptation enumeration (end-to-end via try_split_src) ───────

fn simple_two_node_pattern() -> SplitPattern {
    // Node 0 keeps face N (Passage to whatever's north) and a sibling edge to node 1 via face S.
    // Node 1 has its own sibling edge back (implicit, not separately encoded) and keeps face E.
    SplitPattern {
        node_count: 2,
        faces: vec![
            vec![
                SplitPatternFace {
                    face_index: 0,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                },
                SplitPatternFace {
                    face_index: 1,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: Some(1),
                },
            ],
            vec![SplitPatternFace {
                face_index: 2,
                requirement: SplitFaceRequirement::Passage,
                sibling_target: None,
            }],
        ],
        weight: 1.0,
    }
}

#[test]
fn pattern_split_emits_edge_added_for_every_face_edge_it_creates() {
    // Regression: `apply_pattern_adaptation` used to add edges to the graph directly (both the
    // sibling connection and the outside-neighbor connection) without ever emitting
    // `VertexBasedEvent::EdgeAdded` — the debug-tape replay (`applyVertexBased`, maze-web) never
    // saw these edges, so a pattern-split point (and its neighbors) rendered as fully closed at
    // every debug step, including the final one, even though the real graph was fully connected.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let split_config = SplitGenerationConfig {
        pattern_mode: true,
        max_split_nodes: 2,
        patterns: vec![simple_two_node_pattern()],
    };
    let mut state = super::super::super::vertex_based::GenState::new(&graph, 1, src);
    let mut sr = None;
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    let mut scope = log.enter("step");
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state,
        src,
        None,
        None,
        src,
        &mut sr,
        Some(&mut scope),
        None,
    );
    drop(scope);
    assert_eq!(outcome, SplitOutcome::Handled);

    let point = field.point_of(src).unwrap();
    let split_nodes: Vec<NodeId> = field.nodes_at(field_level, point).to_vec();
    assert_eq!(
        split_nodes.len(),
        2,
        "simple_two_node_pattern mints exactly 2 nodes total"
    );

    // Every edge actually present in the graph between the split point's own nodes, or between a
    // split node and an outside neighbor, must have a matching EdgeAdded event in the log.
    let graph_edges: std::collections::HashSet<(NodeId, NodeId)> = graph
        .edges()
        .map(|e| (e.from, e.to))
        .filter(|(a, b)| split_nodes.contains(a) || split_nodes.contains(b))
        .collect();
    assert!(
        !graph_edges.is_empty(),
        "the chosen adaptation must have added at least one edge"
    );

    let logged_edges: std::collections::HashSet<(NodeId, NodeId)> = log
        .finish()
        .iter()
        .filter_map(|e| match e {
            VertexBasedEvent::EdgeAdded {
                src,
                dst,
                bidirectional,
            } => Some(if *bidirectional {
                vec![(*src, *dst), (*dst, *src)]
            } else {
                vec![(*src, *dst)]
            }),
            _ => None,
        })
        .flatten()
        .collect();

    for edge in &graph_edges {
        assert!(
            logged_edges.contains(edge),
            "graph edge {edge:?} has no matching EdgeAdded event"
        );
    }
}

#[test]
fn pattern_split_never_pushes_src_or_siblings_into_frontier() {
    // Regression: every node a pattern split mints (src and every sibling) is fully resolved by
    // this one event — none of them is a pending traversal step the way an ordinary frontier entry
    // is. `apply_pattern_adaptation` used to push both `src` and every sibling into `frontier`
    // directly, and `mark_connected` also pushed a `sibling_target` face's destination (another of
    // this event's own nodes) into `frontier` — either path let a split node get popped from
    // `frontier` again on a later step, even though it was already fully processed.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let split_config = SplitGenerationConfig {
        pattern_mode: true,
        max_split_nodes: 2,
        patterns: vec![simple_two_node_pattern()],
    };
    // Seeded with a different node as `start` — GenState::new unconditionally seeds frontier with
    // `start` itself, which would make `src` already-in-frontier before try_split_src even runs,
    // an artifact of this direct call bypassing step_from_frontier (which always pops `src` out of
    // frontier first) rather than anything this test means to exercise.
    let other = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let mut state = super::super::super::vertex_based::GenState::new(&graph, 1, other);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state,
        src,
        None,
        None,
        src,
        &mut sr,
        None,
        None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);

    let point = field.point_of(src).unwrap();
    let split_nodes: Vec<NodeId> = field.nodes_at(field_level, point).to_vec();
    assert_eq!(
        split_nodes.len(),
        2,
        "simple_two_node_pattern mints exactly 2 nodes total"
    );

    for &node in &split_nodes {
        assert!(
            state.visited.contains(&node),
            "split node {node:?} must be visited immediately"
        );
        assert!(
            !state.in_frontier.contains(&node),
            "split node {node:?} must never enter frontier"
        );
    }
}

#[test]
fn non_pattern_split_with_bridge_never_pushes_src_into_frontier() {
    // Regression: the bridge branch used to push `src` into `frontier` after connecting it to
    // `bridge`, even though this same event's per-node loop processes `src` synchronously right
    // afterward (never via a later frontier pop) — `src` was left stuck in `frontier`, so a later
    // `step_from_frontier` would pop and re-process it a second time (re-rolling `split_chance`
    // and re-running corridor/junction logic on an already-connected node).
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let bridge = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    graph.add_node(bridge);
    let split_config = SplitGenerationConfig {
        pattern_mode: false,
        max_split_nodes: 2,
        patterns: vec![],
    };
    let other = field
        .node_at(field_level, SquarePoint { x: 4, y: 4 })
        .unwrap();
    let mut state = super::super::super::vertex_based::GenState::new(&graph, 1, other);
    state.visited.insert(bridge);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state,
        src,
        Some(bridge),
        None,
        src,
        &mut sr,
        None,
        None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    assert!(state.visited.contains(&src), "src must be visited");
    assert!(
        !state.in_frontier.contains(&src),
        "src must never be left in frontier after this event fully processed it"
    );
}

// ─── Parent-edge relocation (end-to-end via try_split_src) ───────────────

#[test]
fn pattern_split_relocates_the_parent_edge_to_the_sibling_that_caught_it() {
    // Full end-to-end: src's real parent edge (bidirectional, matching the pattern's sibling-owned
    // Passage face after rotation) must be removed from src and recreated on the sibling that
    // caught it — the point ends up with exactly the same total parent<->point connectivity, just
    // owned by a different node, and a SplitParentEdgeRelocated event records the move.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let src = field
        .node_at(field_level, SquarePoint { x: 2, y: 2 })
        .unwrap();
    let parent = field
        .node_at(field_level, SquarePoint { x: 2, y: 3 })
        .unwrap(); // north neighbor (face 0)
    graph.add_bidirectional_edge(src, parent, crate::graph::EdgeKind::Basic);
    // Rotated `simple_two_node_pattern` by hand: node 1 (the sibling) owns face 0 (N, Passage) —
    // the face that must catch `parent`. Node 0 keeps only its sibling-edge face.
    let pattern = SplitPattern {
        node_count: 2,
        faces: vec![
            vec![SplitPatternFace {
                face_index: 1,
                requirement: SplitFaceRequirement::Passage,
                sibling_target: Some(1),
            }],
            vec![SplitPatternFace {
                face_index: 0,
                requirement: SplitFaceRequirement::Passage,
                sibling_target: None,
            }],
        ],
        weight: 1.0,
    };
    let split_config = SplitGenerationConfig {
        pattern_mode: true,
        max_split_nodes: 2,
        patterns: vec![pattern],
    };
    let other = field
        .node_at(field_level, SquarePoint { x: 0, y: 0 })
        .unwrap();
    let mut state = super::super::super::vertex_based::GenState::new(&graph, 1, other);
    let mut sr = None;
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    let mut scope = log.enter("step");
    let outcome = try_split_src(
        &mut graph,
        &mut field,
        &mut ids,
        &GenerationParams::default(),
        &full_split_elements(),
        &split_config,
        &empty_presets(),
        &mut state,
        src,
        None,
        Some(parent),
        src,
        &mut sr,
        Some(&mut scope),
        None,
    );
    drop(scope);
    assert_eq!(outcome, SplitOutcome::Handled);

    let point = field.point_of(src).unwrap();
    let split_nodes: Vec<NodeId> = field.nodes_at(field_level, point).to_vec();
    assert_eq!(split_nodes.len(), 2);
    let sibling = split_nodes[1];

    assert!(
        graph.edge_between(src, parent).is_none(),
        "the original src->parent edge must be gone"
    );
    assert!(
        graph.edge_between(parent, src).is_none(),
        "the original parent->src edge must be gone"
    );
    assert!(
        graph.edge_between(sibling, parent).is_some(),
        "the sibling that caught the face must own the edge"
    );
    assert!(
        graph.edge_between(parent, sibling).is_some(),
        "the relocated edge must stay bidirectional"
    );

    let relocated = log.finish().iter().any(|e| {
        matches!(
            e,
            VertexBasedEvent::SplitParentEdgeRelocated { parent: p, src: s, taken_by }
                if *p == parent && *s == src && *taken_by == sibling
        )
    });
    assert!(
        relocated,
        "SplitParentEdgeRelocated must be logged with the right (parent, src, taken_by)"
    );
}
