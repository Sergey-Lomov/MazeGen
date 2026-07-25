use maze_core::generation::{generate_maze, generate_wilson, wilson_debug_value_names, GenerationAlgorithm, GenerationConfig, WilsonEvent};
use maze_core::event_log::{DebugEvent, DebugMapDelta, DebugMapOp, DebugValueDelta, DebugValueKind, DebugValueOp, DebugVertexDelta, DebugVertexOp, EncodeEventPayload, EventLog, NodePayload, TAG_SCOPE};
use maze_core::validation::is_connected;
use super::helpers::*;

#[test]
fn wilson_visits_all_nodes() {
    let (mut graph, mut field, start, mut ids) = build_with_ids(5, 5);
    let node_count = graph.nodes().count();
    generate_maze(&mut graph, &mut field, &mut ids, 42, start, GenerationConfig {
        algorithm: GenerationAlgorithm::WilsonAlgorithm,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn wilson_traverses_preset_teleport_into_visited() {
    // GitHub issue #226: a preset teleport bridging two otherwise-disconnected halves must be
    // followed by the algorithm, not treated as a dead end.
    let (mut graph, field, start, preset_state, node_count, _, _, _ids) = build_with_preset_teleport_bridge();
    generate_wilson(&mut graph, &field, 42, start, &preset_state, None);
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn wilson_traverses_one_way_preset_teleport_into_visited() {
    // GitHub issue #226: a one-way preset teleport must also be traversed, not just the two-way
    // case. Only a single directed teleport edge exists (not two), so the resulting graph isn't a
    // plain 2*(n-1) perfect maze — checking connectivity is the right level of assertion here.
    let (mut graph, field, start, preset_state, _node_count, _ids) = build_with_one_way_preset_teleport_bridge();
    generate_wilson(&mut graph, &field, 42, start, &preset_state, None);
    assert!(is_connected(&graph, start));
}

#[test]
fn wilson_is_deterministic() {
    let (mut g1, mut f1, s1, mut ids1) = build_with_ids(4, 4);
    let (mut g2, mut f2, s2, mut ids2) = build_with_ids(4, 4);
    let config = || GenerationConfig { algorithm: GenerationAlgorithm::WilsonAlgorithm, elements: no_one_way_elements(), ..GenerationConfig::default() };
    generate_maze(&mut g1, &mut f1, &mut ids1, 7, s1, config(), &empty_preset());
    generate_maze(&mut g2, &mut f2, &mut ids2, 7, s2, config(), &empty_preset());
    assert_deterministic(&g1, &g2);
}

// --- Event log (GitHub issue #145) ---

#[test]
fn wilson_single_walk_emits_exact_event_sequence() {
    // 1x2 field: start is the only visited node, so the single walk's other node has exactly
    // one neighbor (start, already visited) — the walk finishes on its first step with no RNG
    // branching, no loop erasure, and no dead end to account for.
    let (mut graph, field, start) = build(2, 1);
    let other = field.neighbors(start)[0];
    let mut log: EventLog<WilsonEvent> = EventLog::new();
    generate_wilson(&mut graph, &field, 0, start, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let root = tape.root();
    let mut root_children = root.children();
    let start_visited = root_children.next().expect("expected StartVisited before any walk scope");
    assert!(matches!(start_visited.payload(), NodePayload::Event(WilsonEvent::StartVisited(n)) if *n == start));

    let walk = root_children.next().expect("expected at least one walk scope");
    assert!(matches!(walk.payload(), NodePayload::Scope(name) if name == "walk 1"));
    assert!(root_children.next().is_none(), "a single unvisited node must produce exactly one walk");

    let walk_children: Vec<_> = walk.children().collect();
    assert_eq!(walk_children.len(), 3, "expected WalkStartPicked, \"search\" scope, \"commit\" scope");
    assert!(matches!(walk_children[0].payload(), NodePayload::Event(WilsonEvent::WalkStartPicked(n)) if *n == other));

    let search = &walk_children[1];
    assert!(matches!(search.payload(), NodePayload::Scope(name) if name == "search"));
    let search_events: Vec<WilsonEvent> = search.children().map(|c| match c.payload() {
        NodePayload::Event(e) => e.clone(),
        NodePayload::Scope(_) => panic!("expected only events under \"search\""),
    }).collect();
    assert_eq!(search_events, vec![WilsonEvent::StepTaken { from: other, to: start }]);

    let commit = &walk_children[2];
    assert!(matches!(commit.payload(), NodePayload::Scope(name) if name == "commit"));
    let commit_events: Vec<WilsonEvent> = commit.children().map(|c| match c.payload() {
        NodePayload::Event(e) => e.clone(),
        NodePayload::Scope(_) => panic!("expected only events under \"commit\""),
    }).collect();
    assert_eq!(
        commit_events,
        vec![
            WilsonEvent::EdgeAdded { from: other, to: start, bidirectional: true },
            WilsonEvent::NodeVisited(other),
        ]
    );
}

#[test]
fn wilson_event_kinds_agree_with_is_mutating() {
    let (mut graph, field, start) = build(5, 5);
    let mut log: EventLog<WilsonEvent> = EventLog::new();
    generate_wilson(&mut graph, &field, 3, start, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    for event in tape.iter() {
        // WalkStartPicked/StepTaken/LoopErased are mutating too (issue #145's follow-up) — they
        // change the walk's `next` map, the state a replay consumer needs to reconstruct the
        // in-progress walk, even though they never touch the graph itself.
        let expected_mutating = matches!(
            event,
            WilsonEvent::StartVisited(_)
                | WilsonEvent::WalkStartPicked(_)
                | WilsonEvent::StepTaken { .. }
                | WilsonEvent::LoopErased { .. }
                | WilsonEvent::EdgeAdded { .. }
                | WilsonEvent::NodeVisited(_)
        );
        assert_eq!(event.is_mutating(), expected_mutating);
    }
}

#[test]
fn wilson_declares_the_visited_and_current_walk_debug_values() {
    assert_eq!(
        wilson_debug_value_names(),
        &[
            ("visited", DebugValueKind::Region),
            ("current_walk", DebugValueKind::Map),
            ("walk_start", DebugValueKind::Vertex),
            ("walk_head", DebugValueKind::Vertex),
        ]
    );
}

#[test]
fn wilson_debug_value_deltas_only_node_visited_inserts_into_visited() {
    assert_eq!(
        WilsonEvent::NodeVisited(7).debug_value_deltas(),
        vec![("visited", DebugValueOp::Insert, 7)]
    );
    assert_eq!(
        WilsonEvent::StartVisited(7).debug_value_deltas(),
        vec![("visited", DebugValueOp::Insert, 7)]
    );
    assert!(WilsonEvent::WalkStartPicked(1).debug_value_deltas().is_empty());
    assert!(WilsonEvent::StepTaken { from: 1, to: 2 }.debug_value_deltas().is_empty());
    assert!(WilsonEvent::LoopErased { node: 1 }.debug_value_deltas().is_empty());
    assert!(WilsonEvent::WalkDeadEnd.debug_value_deltas().is_empty());
    assert!(WilsonEvent::EdgeAdded { from: 1, to: 2, bidirectional: true }.debug_value_deltas().is_empty());
}

#[test]
fn wilson_debug_map_deltas_step_taken_sets_and_walk_start_picked_clears_current_walk() {
    assert_eq!(
        WilsonEvent::StepTaken { from: 1, to: 2 }.debug_map_deltas(),
        vec![("current_walk", DebugMapOp::Set(1, 2))]
    );
    assert_eq!(
        WilsonEvent::WalkStartPicked(5).debug_map_deltas(),
        vec![("current_walk", DebugMapOp::Clear)]
    );
    assert!(WilsonEvent::LoopErased { node: 1 }.debug_map_deltas().is_empty());
    assert!(WilsonEvent::WalkDeadEnd.debug_map_deltas().is_empty());
    assert!(WilsonEvent::NodeVisited(1).debug_map_deltas().is_empty());
    assert!(WilsonEvent::EdgeAdded { from: 1, to: 2, bidirectional: true }.debug_map_deltas().is_empty());
}

#[test]
fn wilson_debug_vertex_deltas_walk_start_picked_sets_both_slots_and_step_taken_moves_only_head() {
    assert_eq!(
        WilsonEvent::WalkStartPicked(5).debug_vertex_deltas(),
        vec![("walk_start", DebugVertexOp::Set(5)), ("walk_head", DebugVertexOp::Set(5))]
    );
    assert_eq!(
        WilsonEvent::StepTaken { from: 1, to: 2 }.debug_vertex_deltas(),
        vec![("walk_head", DebugVertexOp::Set(2))]
    );
    assert!(WilsonEvent::LoopErased { node: 1 }.debug_vertex_deltas().is_empty());
    assert!(WilsonEvent::WalkDeadEnd.debug_vertex_deltas().is_empty());
    assert!(WilsonEvent::NodeVisited(1).debug_vertex_deltas().is_empty());
    assert!(WilsonEvent::StartVisited(1).debug_vertex_deltas().is_empty());
    assert!(WilsonEvent::EdgeAdded { from: 1, to: 2, bidirectional: true }.debug_vertex_deltas().is_empty());
}

#[test]
fn wilson_event_log_mutating_events_match_graph_edges() {
    let (mut graph, field, start) = build(5, 5);
    let mut log: EventLog<WilsonEvent> = EventLog::new();
    generate_wilson(&mut graph, &field, 11, start, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let edges_from_events: Vec<(_, _)> = tape
        .mutating_events()
        .filter_map(|e| match e {
            WilsonEvent::EdgeAdded { from, to, .. } => Some((*from, *to)),
            _ => None,
        })
        .collect();

    let mut graph_edges: Vec<(_, _)> = graph.edges().map(|e| (e.from, e.to)).collect();
    let mut event_edges_both_dirs: Vec<(_, _)> = edges_from_events
        .iter()
        .flat_map(|&(a, b)| vec![(a, b), (b, a)])
        .collect();
    graph_edges.sort();
    event_edges_both_dirs.sort();
    assert_eq!(graph_edges, event_edges_both_dirs, "EdgeAdded events must match the graph's actual edges");
}

#[test]
fn wilson_tree_nesting_is_walk_scopes_containing_search_and_commit_scopes() {
    let (mut graph, field, start) = build(6, 6);
    let mut log: EventLog<WilsonEvent> = EventLog::new();
    generate_wilson(&mut graph, &field, 5, start, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let root = tape.root();
    let mut root_children = root.children();

    // `StartVisited` is the one event allowed directly under root — the algorithm's first
    // operation, emitted before any walk scope exists.
    let start_visited = root_children.next().expect("expected StartVisited before any walk scope");
    assert!(matches!(start_visited.payload(), NodePayload::Event(WilsonEvent::StartVisited(_))));

    for walk in root_children {
        match walk.payload() {
            NodePayload::Scope(name) => {
                assert!(name.starts_with("walk "), "every root-level scope must be a \"walk N\" scope, got {name}");
                let walk_children: Vec<_> = walk.children().collect();
                assert!(
                    matches!(walk_children[0].payload(), NodePayload::Event(WilsonEvent::WalkStartPicked(_))),
                    "every walk scope must start with a WalkStartPicked event"
                );
                let sub_scope_names: Vec<&str> = walk_children[1..].iter().map(|c| match c.payload() {
                    NodePayload::Scope(name) => name.as_ref(),
                    NodePayload::Event(e) => panic!("expected only \"search\"/\"commit\" scopes after WalkStartPicked, got event {e:?}"),
                }).collect();
                // "commit" is only opened when there's actually a path to commit — a walk that
                // dead-ends on its very first step has no "commit" scope at all (not an empty one).
                assert!(
                    sub_scope_names == ["search"] || sub_scope_names == ["search", "commit"],
                    "a walk scope's only nested scopes must be \"search\" alone or \"search\" then \"commit\", got {sub_scope_names:?}"
                );
                for sub_scope in &walk_children[1..] {
                    let NodePayload::Scope(_) = sub_scope.payload() else { unreachable!() };
                    for grandchild in sub_scope.children() {
                        assert!(
                            matches!(grandchild.payload(), NodePayload::Event(_)),
                            "\"search\"/\"commit\" scopes must contain only events, no further nested scopes"
                        );
                    }
                }
            }
            NodePayload::Event(_) => panic!("no events expected directly under root after StartVisited"),
        }
    }
}

#[test]
fn wilson_none_log_does_not_change_generation_output() {
    let (mut g1, f1, s1) = build(5, 5);
    let (mut g2, f2, s2) = build(5, 5);
    generate_wilson(&mut g1, &f1, 9, s1, &empty_preset(), None);
    let mut log: EventLog<WilsonEvent> = EventLog::new();
    generate_wilson(&mut g2, &f2, 9, s2, &empty_preset(), Some(&mut log));
    assert_deterministic(&g1, &g2);
}

#[test]
fn wilson_dead_end_is_always_the_last_search_event() {
    // WalkDeadEnd is unreachable on an open grid with empty_preset() (every cell always has >= 2
    // field neighbors, and can_connect never blocks any of them without preset walls) — so this
    // asserts the weaker, always-checkable invariant across several seeds/sizes instead of forcing
    // an actual dead end (which would require preset walls isolating a node's only exits, and — since
    // the algorithm has no dead-end retry limit — risks the outer loop never terminating).
    for seed in 0..20u64 {
        let (mut graph, field, start) = build(4, 4);
        let mut log: EventLog<WilsonEvent> = EventLog::new();
        generate_wilson(&mut graph, &field, seed, start, &empty_preset(), Some(&mut log));
        let tape = log.finish();

        for walk in tape.root().children() {
            for child in walk.children() {
                if let NodePayload::Scope(name) = child.payload() {
                    if name != "search" { continue; }
                    let search_events: Vec<&WilsonEvent> = child.children().filter_map(|c| match c.payload() {
                        NodePayload::Event(e) => Some(e),
                        _ => None,
                    }).collect();
                    let dead_end_positions: Vec<usize> = search_events.iter().enumerate()
                        .filter_map(|(i, e)| matches!(e, WilsonEvent::WalkDeadEnd).then_some(i))
                        .collect();
                    assert!(dead_end_positions.len() <= 1, "WalkDeadEnd must appear at most once per walk");
                    if let Some(&pos) = dead_end_positions.first() {
                        assert_eq!(pos, search_events.len() - 1, "WalkDeadEnd must be the last event in \"search\"");
                    }
                }
            }
        }
    }
}

// --- WASM boundary encoding (GitHub issue #124) ---

#[test]
fn wilson_event_type_ids_are_unique_and_nonzero() {
    let (mut graph, field, start) = build(4, 4);
    let mut log: EventLog<WilsonEvent> = EventLog::new();
    generate_wilson(&mut graph, &field, 4, start, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mut seen_by_variant = std::collections::HashMap::new();
    for event in tape.iter() {
        let variant_name = format!("{event:?}");
        let variant_name = variant_name.split(&['(', ' ', '{'][..]).next().unwrap().to_string();
        let tag = event.type_id();
        assert_ne!(tag, TAG_SCOPE, "event type_id must never collide with TAG_SCOPE (0)");
        if let Some(&existing) = seen_by_variant.get(&variant_name) {
            assert_eq!(existing, tag, "variant {variant_name} produced two different type_ids");
        } else {
            seen_by_variant.insert(variant_name, tag);
        }
    }
    let mut tags: Vec<u16> = seen_by_variant.values().copied().collect();
    tags.sort();
    tags.dedup();
    assert_eq!(tags.len(), seen_by_variant.len(), "two distinct event variants share a type_id");
}

#[test]
fn wilson_walk_dead_end_type_id_is_stable_and_distinct() {
    // WalkDeadEnd is unreachable on every open-grid fixture this test file uses (see
    // wilson_dead_end_is_always_the_last_search_event's doc comment) — so
    // wilson_event_type_ids_are_unique_and_nonzero above, which only scans a real generated
    // tape's events, never actually calls `.type_id()` on a `WalkDeadEnd` value. Constructed
    // directly here instead, mirroring how `encode_payload` is already unit-tested per variant in
    // wilson_event_payload_round_trips_for_every_variant.
    let tag = WilsonEvent::WalkDeadEnd.type_id();
    assert_ne!(tag, TAG_SCOPE, "WalkDeadEnd's type_id must never collide with TAG_SCOPE (0)");
    assert_ne!(tag, WilsonEvent::WalkStartPicked(0).type_id());
    assert_ne!(tag, WilsonEvent::StepTaken { from: 0, to: 0 }.type_id());
    assert_ne!(tag, WilsonEvent::LoopErased { node: 0 }.type_id());
    assert_ne!(tag, WilsonEvent::EdgeAdded { from: 0, to: 0, bidirectional: true }.type_id());
    assert_ne!(tag, WilsonEvent::NodeVisited(0).type_id());
    assert_ne!(tag, WilsonEvent::StartVisited(0).type_id());
}

/// Byte-level round-trip for every `WilsonEvent` variant's `encode_payload` — mirrors
/// `kruskal_event_payload_round_trips_for_every_variant`'s rationale: a tag-uniqueness check alone
/// doesn't catch a byte-offset/field-order mistake inside a payload.
#[test]
fn wilson_event_payload_round_trips_for_every_variant() {
    fn u64le(bytes: &[u8], offset: usize) -> u64 {
        u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }

    let mut buf = Vec::new();
    WilsonEvent::StartVisited(5).encode_payload(&mut buf);
    assert_eq!(buf.len(), 8);
    assert_eq!(u64le(&buf, 0), 5);

    let mut buf = Vec::new();
    WilsonEvent::WalkStartPicked(5).encode_payload(&mut buf);
    assert_eq!(buf.len(), 8);
    assert_eq!(u64le(&buf, 0), 5);

    let mut buf = Vec::new();
    WilsonEvent::StepTaken { from: 1, to: 2 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 16);
    assert_eq!(u64le(&buf, 0), 1, "byte 0..8 must be `from`");
    assert_eq!(u64le(&buf, 8), 2, "byte 8..16 must be `to`");

    let mut buf = Vec::new();
    WilsonEvent::LoopErased { node: 9 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 8);
    assert_eq!(u64le(&buf, 0), 9);

    let mut buf = Vec::new();
    WilsonEvent::WalkDeadEnd.encode_payload(&mut buf);
    assert_eq!(buf.len(), 0);

    let mut buf = Vec::new();
    WilsonEvent::EdgeAdded { from: 11, to: 12, bidirectional: true }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 17);
    assert_eq!(u64le(&buf, 0), 11);
    assert_eq!(u64le(&buf, 8), 12);
    assert_eq!(buf[16], 1);

    let mut buf = Vec::new();
    WilsonEvent::EdgeAdded { from: 11, to: 12, bidirectional: false }.encode_payload(&mut buf);
    assert_eq!(buf[16], 0, "bidirectional: false must encode as byte 0");

    let mut buf = Vec::new();
    WilsonEvent::NodeVisited(7).encode_payload(&mut buf);
    assert_eq!(buf.len(), 8);
    assert_eq!(u64le(&buf, 0), 7);
}
