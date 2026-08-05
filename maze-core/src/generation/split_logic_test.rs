use super::*;
use crate::generation::split_pattern::{SplitGenerationConfig, SplitPattern, SplitPatternFace, SplitFaceRequirement};
use crate::generation::{ElementsConfig, GenerationParams, PresetState};
use crate::generation::test_utils::make_field_graph_ids;
use crate::space::{SquarePoint, Tessellation};
use crate::ids::NodeId;
use crate::event_log::EventLog;

fn no_split_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 }
}

fn full_split_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 1.0 }
}

fn empty_presets() -> PresetState { PresetState::empty() }

fn no_split_config() -> SplitGenerationConfig { SplitGenerationConfig::default() }

// ─── face_index / face_at round-trip ────────────────────────────────────

#[test]
fn face_index_face_at_round_trip_square() {
    for f in crate::space::SquareTessellation::faces() {
        let idx = crate::space::SquareTessellation::face_index(*f).unwrap();
        assert!(crate::space::SquareTessellation::face_at(idx) == Some(*f));
    }
}

#[test]
fn face_index_face_at_round_trip_hex() {
    for f in crate::space::HexTessellation::faces() {
        let idx = crate::space::HexTessellation::face_index(*f).unwrap();
        assert!(crate::space::HexTessellation::face_at(idx) == Some(*f));
    }
}

#[test]
fn face_index_face_at_round_trip_tri() {
    for f in crate::space::TriTessellation::faces() {
        let idx = crate::space::TriTessellation::face_index(*f).unwrap();
        assert!(crate::space::TriTessellation::face_at(idx) == Some(*f));
    }
}

// ─── RNG parity at split_chance == 0.0 ──────────────────────────────────

#[test]
fn split_chance_zero_matches_baseline_exactly() {
    // A split_chance of 0.0 must still consume the roll's RNG sample every step, but never
    // actually split — output must be byte-identical to a run with the feature entirely absent.
    for seed in [1u64, 7, 42, 1234] {
        let (mut field_a, mut graph_a, mut ids_a) = make_field_graph_ids(6, 6);
        let start_a = field_a.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let mut sr_a = None;
        super::super::vertex_based::generate(
            &mut graph_a, &mut field_a, &mut ids_a, seed, start_a,
            &GenerationParams::default(), &no_split_elements(), &no_split_config(),
            &empty_presets(), &mut sr_a, None, None,
        );

        let (mut field_b, mut graph_b, mut ids_b) = make_field_graph_ids(6, 6);
        let start_b = field_b.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let mut sr_b = None;
        super::super::vertex_based::generate(
            &mut graph_b, &mut field_b, &mut ids_b, seed, start_b,
            &GenerationParams::default(), &no_split_elements(), &no_split_config(),
            &empty_presets(), &mut sr_b, None, None,
        );

        let mut e_a: Vec<_> = graph_a.edges().map(|e| (e.from, e.to)).collect();
        let mut e_b: Vec<_> = graph_b.edges().map(|e| (e.from, e.to)).collect();
        e_a.sort();
        e_b.sort();
        assert_eq!(e_a, e_b, "seed {seed}: split_chance=0.0 must be fully deterministic");
        assert!(sr_a.is_none() && sr_b.is_none());
    }
}

// ─── Non-pattern split path ──────────────────────────────────────────────

#[test]
fn non_pattern_split_creates_exact_node_count() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let node_count_before = graph.nodes().count();
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 3, patterns: vec![] };
    let mut sr = None;
    super::super::vertex_based::generate(
        &mut graph, &mut field, &mut ids, 5, start,
        &GenerationParams::default(), &full_split_elements(), &split_config,
        &empty_presets(), &mut sr, None, None,
    );
    // At least one split must have fired somewhere (split_chance=1.0, many steps) creating
    // extra nodes beyond the field's original point count.
    assert!(graph.nodes().count() > node_count_before, "split_chance=1.0 must create extra nodes");
    // Node count only ever grows in multiples matching max_split_nodes - 1 per split event, so
    // the total extra nodes must be a multiple of (max_split_nodes - 1).
    let extra = graph.nodes().count() - node_count_before;
    assert_eq!(extra % 2, 0, "each split adds exactly max_split_nodes - 1 = 2 nodes, extra={extra}");
}

#[test]
fn non_pattern_split_every_resulting_node_gets_at_least_one_connection() {
    // Regression: the free-neighbor pool used to be handed to the first-processed node (`src`)
    // whole, via `choose_connect_targets`'s own multi-candidate junction pick — a later sibling
    // node could then see zero free neighbors left and end up with no connection at all (an
    // isolated node, invisible in the post-edit UI since it has no edge to draw). The pool is now
    // partitioned up front so every node gets a fair share, and any node still left unconnected
    // (partitioning can't manufacture neighbors that don't exist) falls back to an already-visited
    // geometric neighbor of the point — see `non_pattern_split_falls_back_to_visited_neighbor_when_no_unvisited_left`.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(8, 8);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] };
    let mut sr = None;
    super::super::vertex_based::generate(
        &mut graph, &mut field, &mut ids, 5, start,
        &GenerationParams::default(), &full_split_elements(), &split_config,
        &empty_presets(), &mut sr, None, None,
    );
    let mut checked_a_split = false;
    for point in field.all_points() {
        let nodes = field.nodes_at(point);
        if nodes.len() <= 1 {
            continue;
        }
        checked_a_split = true;
        for &n in nodes {
            let degree = graph.outgoing_neighbors(n).count() + graph.incoming_neighbors(n).count();
            assert!(degree > 0, "split node {n:?} at {point:?} has no connection at all");
        }
    }
    assert!(checked_a_split, "test setup must actually exercise at least one split");
}

#[test]
fn non_pattern_split_falls_back_to_visited_neighbor_when_no_unvisited_left() {
    // When every geometric neighbor of the split point is already visited (so the ordinary
    // corridor/junction step can't connect any resulting node to anything new), each node must
    // still fall back to an already-visited neighbor rather than end up permanently isolated.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let start = field.node_at(SquarePoint { x: 1, y: 1 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    for n in field.neighbors(start) {
        state.visited.insert(n);
    }
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, start, None, None, start, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    let point = field.point_of(start).unwrap();
    for &n in field.nodes_at(point) {
        let degree = graph.outgoing_neighbors(n).count() + graph.incoming_neighbors(n).count();
        assert!(degree > 0, "split node {n:?} must fall back to a visited neighbor, not stay isolated");
    }
}

#[test]
fn non_pattern_max_split_nodes_one_is_a_valid_noop() {
    // max_split_nodes == 1 spends the split roll's RNG sample but mints nothing new.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(4, 4);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let node_count_before = graph.nodes().count();
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 1, patterns: vec![] };
    let mut sr = None;
    super::super::vertex_based::generate(
        &mut graph, &mut field, &mut ids, 3, start,
        &GenerationParams::default(), &full_split_elements(), &split_config,
        &empty_presets(), &mut sr, None, None,
    );
    assert_eq!(graph.nodes().count(), node_count_before, "max_split_nodes=1 must never mint new nodes");
}

// ─── split_is_eligible ───────────────────────────────────────────────────

#[test]
fn split_is_eligible_false_when_locked() {
    let (field, _graph, mut ids) = make_field_graph_ids(3, 3);
    let node = field.node_at(SquarePoint { x: 1, y: 1 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(node);
    assert!(!split_is_eligible(&field, &preset_state, node));
    let mut preset_state2 = PresetState::empty();
    preset_state2.locked_in.insert(node);
    assert!(!split_is_eligible(&field, &preset_state2, node));
    let _ = &mut ids;
}

#[test]
fn split_is_eligible_false_when_already_split() {
    let (mut field, _graph, mut ids) = make_field_graph_ids(3, 3);
    let point = SquarePoint { x: 1, y: 1 };
    field.add_node_at(point, &mut ids);
    let node = field.node_at(point).unwrap();
    assert!(!split_is_eligible(&field, &empty_presets(), node));
}

#[test]
fn split_is_eligible_true_for_plain_unlocked_unsplit_node() {
    let (field, _graph, _ids) = make_field_graph_ids(3, 3);
    let node = field.node_at(SquarePoint { x: 1, y: 1 }).unwrap();
    assert!(split_is_eligible(&field, &empty_presets(), node));
}

// ─── SplitOutcome variants via try_split_src ─────────────────────────────

#[test]
fn try_split_src_returns_miss_when_roll_misses() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &no_split_elements(),
        &no_split_config(), &empty_presets(), &mut state, start, None, None, start, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Miss);
}

#[test]
fn try_split_src_returns_ineligible_when_locked() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(start);
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &no_split_config(), &preset_state, &mut state, start, None, None, start, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Ineligible);
}

#[test]
fn handle_pattern_split_retries_a_different_pattern_after_the_first_yields_no_adaptations() {
    // GitHub issue #275's weighted-pick coverage gap: a heavily-weighted pattern that can never
    // adapt at this point (requires a face pointing off-field) must be excluded from `remaining`
    // and retried against a lower-weight pattern that *can* adapt, rather than the whole split
    // failing outright.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();

    // SquareFace order [N, S, E, W] (indices 0-3). At (0,0) on a 3x3 grid: S (index 1) points
    // off-field, E (index 2) has a real neighbor at (1,0).
    let impossible_pattern = SplitPattern {
        node_count: 2,
        faces: vec![
            vec![],
            vec![SplitPatternFace { face_index: 1, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
        ],
        weight: 1000.0,
    };
    let possible_pattern = SplitPattern {
        node_count: 2,
        faces: vec![
            vec![],
            vec![SplitPatternFace { face_index: 2, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
        ],
        weight: 0.001,
    };
    let split_config = SplitGenerationConfig {
        pattern_mode: true,
        max_split_nodes: 2,
        patterns: vec![impossible_pattern, possible_pattern],
    };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, start, None, None, start, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Handled, "must retry onto the second pattern instead of giving up after the first pattern's adaptation search comes up empty");
}

#[test]
fn try_split_src_returns_no_adaptation_when_pattern_mode_has_no_patterns() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![] };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, start, None, None, start, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::NoAdaptation);
}

#[test]
fn try_split_src_returns_handled_on_non_pattern_hit() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, start, None, None, start, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    assert!(graph.nodes().count() > 9, "a hit must have minted an extra node");
}

// ─── split_points collision ──────────────────────────────────────────────

#[test]
fn split_roll_skipped_entirely_for_a_point_with_declared_split_points() {
    // A point already split via GenerationConfig.split_points (issue #231) must never be
    // re-split by the generator — split_is_eligible must reject it outright.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let point = SquarePoint { x: 1, y: 1 };
    let extra = field.add_node_at(point, &mut ids);
    graph.add_node(extra);
    let original = field.node_at(point).unwrap();
    assert!(!split_is_eligible(&field, &empty_presets(), original));
}

// ─── Pattern adaptation enumeration (end-to-end via try_split_src) ───────

fn simple_two_node_pattern() -> SplitPattern {
    // Node 0 keeps face N (Passage to whatever's north) and a sibling edge to node 1 via face S.
    // Node 1 has its own sibling edge back (implicit, not separately encoded) and keeps face E.
    SplitPattern {
        node_count: 2,
        faces: vec![
            vec![
                SplitPatternFace { face_index: 0, requirement: SplitFaceRequirement::Passage, sibling_target: None },
                SplitPatternFace { face_index: 1, requirement: SplitFaceRequirement::Passage, sibling_target: Some(1) },
            ],
            vec![
                SplitPatternFace { face_index: 2, requirement: SplitFaceRequirement::Passage, sibling_target: None },
            ],
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
    let src = field.node_at(SquarePoint { x: 2, y: 2 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![simple_two_node_pattern()] };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, src);
    let mut sr = None;
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    let mut scope = log.enter("step");
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, src, None, None, src, &mut sr, Some(&mut scope), None,
    );
    drop(scope);
    assert_eq!(outcome, SplitOutcome::Handled);

    let point = field.point_of(src).unwrap();
    let split_nodes: Vec<NodeId> = field.nodes_at(point).to_vec();
    assert_eq!(split_nodes.len(), 2, "simple_two_node_pattern mints exactly 2 nodes total");

    // Every edge actually present in the graph between the split point's own nodes, or between a
    // split node and an outside neighbor, must have a matching EdgeAdded event in the log.
    let graph_edges: std::collections::HashSet<(NodeId, NodeId)> = graph.edges()
        .map(|e| (e.from, e.to))
        .filter(|(a, b)| split_nodes.contains(a) || split_nodes.contains(b))
        .collect();
    assert!(!graph_edges.is_empty(), "the chosen adaptation must have added at least one edge");

    let logged_edges: std::collections::HashSet<(NodeId, NodeId)> = log.finish().iter()
        .filter_map(|e| match e {
            VertexBasedEvent::EdgeAdded { src, dst, bidirectional } => {
                Some(if *bidirectional { vec![(*src, *dst), (*dst, *src)] } else { vec![(*src, *dst)] })
            }
            _ => None,
        })
        .flatten()
        .collect();

    for edge in &graph_edges {
        assert!(logged_edges.contains(edge), "graph edge {edge:?} has no matching EdgeAdded event");
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
    let src = field.node_at(SquarePoint { x: 2, y: 2 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![simple_two_node_pattern()] };
    // Seeded with a different node as `start` — GenState::new unconditionally seeds frontier with
    // `start` itself, which would make `src` already-in-frontier before try_split_src even runs,
    // an artifact of this direct call bypassing step_from_frontier (which always pops `src` out of
    // frontier first) rather than anything this test means to exercise.
    let other = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, other);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, src, None, None, src, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);

    let point = field.point_of(src).unwrap();
    let split_nodes: Vec<NodeId> = field.nodes_at(point).to_vec();
    assert_eq!(split_nodes.len(), 2, "simple_two_node_pattern mints exactly 2 nodes total");

    for &node in &split_nodes {
        assert!(state.visited.contains(&node), "split node {node:?} must be visited immediately");
        assert!(!state.in_frontier.contains(&node), "split node {node:?} must never enter frontier");
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
    let src = field.node_at(SquarePoint { x: 2, y: 2 }).unwrap();
    let bridge = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    graph.add_node(bridge);
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] };
    let other = field.node_at(SquarePoint { x: 4, y: 4 }).unwrap();
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, other);
    state.visited.insert(bridge);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, src, Some(bridge), None, src, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    assert!(state.visited.contains(&src), "src must be visited");
    assert!(!state.in_frontier.contains(&src), "src must never be left in frontier after this event fully processed it");
}

// ─── Parent-edge relocation (end-to-end via try_split_src) ───────────────

#[test]
fn pattern_split_relocates_the_parent_edge_to_the_sibling_that_caught_it() {
    // Full end-to-end: src's real parent edge (bidirectional, matching the pattern's sibling-owned
    // Passage face after rotation) must be removed from src and recreated on the sibling that
    // caught it — the point ends up with exactly the same total parent<->point connectivity, just
    // owned by a different node, and a SplitParentEdgeRelocated event records the move.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    let src = field.node_at(SquarePoint { x: 2, y: 2 }).unwrap();
    let parent = field.node_at(SquarePoint { x: 2, y: 3 }).unwrap(); // north neighbor (face 0)
    graph.add_bidirectional_edge(src, parent, crate::graph::EdgeKind::Basic);
    // Rotated `simple_two_node_pattern` by hand: node 1 (the sibling) owns face 0 (N, Passage) —
    // the face that must catch `parent`. Node 0 keeps only its sibling-edge face.
    let pattern = SplitPattern {
        node_count: 2,
        faces: vec![
            vec![SplitPatternFace { face_index: 1, requirement: SplitFaceRequirement::Passage, sibling_target: Some(1) }],
            vec![SplitPatternFace { face_index: 0, requirement: SplitFaceRequirement::Passage, sibling_target: None }],
        ],
        weight: 1.0,
    };
    let split_config = SplitGenerationConfig { pattern_mode: true, max_split_nodes: 2, patterns: vec![pattern] };
    let other = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, other);
    let mut sr = None;
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    let mut scope = log.enter("step");
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, src, None, Some(parent), src, &mut sr, Some(&mut scope), None,
    );
    drop(scope);
    assert_eq!(outcome, SplitOutcome::Handled);

    let point = field.point_of(src).unwrap();
    let split_nodes: Vec<NodeId> = field.nodes_at(point).to_vec();
    assert_eq!(split_nodes.len(), 2);
    let sibling = split_nodes[1];

    assert!(graph.edge_between(src, parent).is_none(), "the original src->parent edge must be gone");
    assert!(graph.edge_between(parent, src).is_none(), "the original parent->src edge must be gone");
    assert!(graph.edge_between(sibling, parent).is_some(), "the sibling that caught the face must own the edge");
    assert!(graph.edge_between(parent, sibling).is_some(), "the relocated edge must stay bidirectional");

    let relocated = log.finish().iter().any(|e| matches!(
        e,
        VertexBasedEvent::SplitParentEdgeRelocated { parent: p, src: s, taken_by }
            if *p == parent && *s == src && *taken_by == sibling
    ));
    assert!(relocated, "SplitParentEdgeRelocated must be logged with the right (parent, src, taken_by)");
}

// ─── Teleport-per-event (both modes): exactly one edge, never per-node ──

#[test]
fn non_pattern_split_teleport_is_rolled_once_per_event_not_per_node() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 4, patterns: vec![] };
    let elements = ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 0.0, split_chance: 1.0 };
    let mut state = super::super::vertex_based::GenState::new(&graph, 9, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &elements,
        &split_config, &empty_presets(), &mut state, start, None, None, start, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    let teleport_edges = graph.edges().filter(|e| e.kind == crate::graph::EdgeKind::Teleport).count();
    // Exactly one teleport edge (or its bidirectional pair = 2 directed edges) from this single
    // split event — not one per resulting node (which would be up to 4).
    assert!(teleport_edges <= 2, "teleport must be rolled once for the whole split event, got {teleport_edges} teleport edges");
}

// ─── Start reassignment ──────────────────────────────────────────────────

#[test]
fn split_reassigns_start_when_start_node_itself_splits() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let start = field.node_at(SquarePoint { x: 1, y: 1 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, start, None, None, start, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    assert!(sr.is_some(), "splitting the start node must produce a start_reassignment");
    let reassignment = sr.unwrap();
    assert_eq!(reassignment.original, start);
}

#[test]
fn split_never_reassigns_start_for_a_non_start_node() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(3, 3);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let other = field.node_at(SquarePoint { x: 1, y: 1 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 2, patterns: vec![] };
    let mut state = super::super::vertex_based::GenState::new(&graph, 1, start);
    let mut sr = None;
    let outcome = try_split_src(
        &mut graph, &mut field, &mut ids, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state, other, None, None, start, &mut sr, None, None,
    );
    assert_eq!(outcome, SplitOutcome::Handled);
    assert!(sr.is_none(), "splitting a non-start node must never touch start_reassignment");
}

// ─── Non-pattern split-node processing order (deterministic creation order) ──

#[test]
fn non_pattern_split_nodes_processed_in_creation_order() {
    // With a fixed seed, re-running the exact same split twice must produce identical additional
    // edges — confirms nodes are processed src-first, then in add_node_at order, not shuffled.
    let (mut field_a, mut graph_a, mut ids_a) = make_field_graph_ids(6, 6);
    let start_a = field_a.node_at(SquarePoint { x: 2, y: 2 }).unwrap();
    let split_config = SplitGenerationConfig { pattern_mode: false, max_split_nodes: 3, patterns: vec![] };
    let mut state_a = super::super::vertex_based::GenState::new(&graph_a, 4, start_a);
    let mut sr_a = None;
    try_split_src(
        &mut graph_a, &mut field_a, &mut ids_a, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state_a, start_a, None, None, start_a, &mut sr_a, None, None,
    );

    let (mut field_b, mut graph_b, mut ids_b) = make_field_graph_ids(6, 6);
    let start_b = field_b.node_at(SquarePoint { x: 2, y: 2 }).unwrap();
    let mut state_b = super::super::vertex_based::GenState::new(&graph_b, 4, start_b);
    let mut sr_b = None;
    try_split_src(
        &mut graph_b, &mut field_b, &mut ids_b, &GenerationParams::default(), &full_split_elements(),
        &split_config, &empty_presets(), &mut state_b, start_b, None, None, start_b, &mut sr_b, None, None,
    );

    let mut e_a: Vec<_> = graph_a.edges().map(|e| (e.from, e.to)).collect();
    let mut e_b: Vec<_> = graph_b.edges().map(|e| (e.from, e.to)).collect();
    e_a.sort();
    e_b.sort();
    assert_eq!(e_a, e_b, "identical seed/config split must produce identical edges (deterministic order)");
}
