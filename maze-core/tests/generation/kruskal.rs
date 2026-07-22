use maze_core::generation::{generate_maze, generate_kruskal, build_preset_state, KruskalEvent, PresetConnection, PresetConnectionState, TeleportDirection};
use maze_core::event_log::{DebugEvent, EncodeEventPayload, EventLog, TAG_SCOPE};
use maze_core::graph::EdgeKind;
use maze_core::validation::is_connected;
use maze_core::space::SquarePoint;
use super::helpers::*;

#[test]
fn kruskal_visits_all_nodes() {
    let (mut graph, field, start) = build(5, 5);
    let node_count = graph.nodes().count();
    generate_maze(&mut graph, &field, 42, start, kruskal_config(), &empty_preset());
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn kruskal_is_connected() {
    for seed in [1, 42, 99, 1234, 9999] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, kruskal_config(), &empty_preset());
        assert!(is_connected(&graph, start), "seed={seed}: kruskal maze is not connected");
    }
}

#[test]
fn kruskal_edges_only_connect_field_neighbors() {
    for seed in [42, 1, 99] {
        let (mut graph, field, start) = build(10, 10);
        generate_maze(&mut graph, &field, seed, start, kruskal_config(), &empty_preset());
        for edge in graph.edges() {
            let neighbors = field.neighbors(edge.from);
            assert!(
                neighbors.contains(&edge.to),
                "seed={seed}: kruskal edge connects non-adjacent nodes: {} -> {}",
                edge.from, edge.to
            );
        }
    }
}

#[test]
fn kruskal_same_seed_same_maze() {
    let (mut g1, f1, start1) = build(8, 8);
    let (mut g2, f2, start2) = build(8, 8);
    generate_maze(&mut g1, &f1, 42, start1, kruskal_config(), &empty_preset());
    generate_maze(&mut g2, &f2, 42, start2, kruskal_config(), &empty_preset());
    assert_eq!(collect_edges(&g1), collect_edges(&g2));
}

// --- Event log (GitHub issue #146) ---

#[test]
fn kruskal_every_edge_scope_starts_with_edge_selected_matching_the_scope() {
    let (mut graph, field, _start) = build(5, 5);
    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 3, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mut saw_any = false;
    for child in tape.root().children() {
        if let maze_core::event_log::NodePayload::Scope(name) = child.payload() {
            if !name.starts_with("edge ") { continue; }
            saw_any = true;
            let first_child = child.children().next().expect("edge scope must not be empty");
            assert!(
                matches!(first_child.payload(), maze_core::event_log::NodePayload::Event(KruskalEvent::EdgeSelected { .. })),
                "the first event in an \"edge N\" scope must be EdgeSelected"
            );
        }
    }
    assert!(saw_any, "expected at least one \"edge N\" scope");
}

#[test]
fn kruskal_roots_compared_matches_edge_selected_pair_order() {
    // RootsCompared's from/to (and by extension root_of_from/root_of_to) must correspond to
    // EdgeSelected's from/to in the same scope, not an arbitrary pairing — verified by
    // construction (find(from)/find(to)) but asserted directly here since a future refactor
    // could silently swap them. EdgeAdded also echoes the same pair; EdgeRejected carries no
    // fields (its scope's RootsCompared already states the pair — see that variant's doc comment).
    let (mut graph, field, _start) = build(4, 4);
    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 11, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    for child in tape.root().children() {
        let events: Vec<KruskalEvent> = child.children().filter_map(|c| match c.payload() {
            maze_core::event_log::NodePayload::Event(e) => Some(e.clone()),
            _ => None,
        }).collect();
        if events.is_empty() { continue; }
        let (from, to) = match &events[0] {
            KruskalEvent::EdgeSelected { from, to } => (*from, *to),
            other => panic!("expected EdgeSelected first, got {other:?}"),
        };
        for event in &events[1..] {
            match event {
                KruskalEvent::RootsCompared { from: f, to: t, .. } | KruskalEvent::EdgeAdded { from: f, to: t, .. } => {
                    assert_eq!((*f, *t), (from, to), "RootsCompared/EdgeAdded must echo the same (from, to) as EdgeSelected");
                }
                _ => {}
            }
        }
    }
}

#[test]
fn kruskal_merged_root_is_the_min_of_the_two_pre_merge_roots() {
    assert_eq!(KruskalEvent::merged_root(5, 2), 2);
    assert_eq!(KruskalEvent::merged_root(2, 5), 2);
    assert_eq!(KruskalEvent::merged_root(7, 7), 7);
}

#[test]
fn kruskal_no_preset_connections_emits_no_preset_unions_applied() {
    // empty_preset() has no preset edges, so the pre-union step is a no-op — PresetUnionsApplied
    // must not be emitted at all (not even with an empty pairs list), since a replay consumer
    // shouldn't have to special-case "empty" vs. "absent".
    let (mut graph, field, _start) = build(3, 3);
    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 1, &empty_preset(), Some(&mut log));
    let tape = log.finish();
    assert!(
        !tape.iter().any(|e| matches!(e, KruskalEvent::PresetUnionsApplied(_))),
        "no preset connections means no PresetUnionsApplied event"
    );
}

#[test]
fn kruskal_preset_connection_emits_preset_unions_applied_before_the_main_loop() {
    let (mut graph, field, _start) = build(3, 3);
    let presets = vec![PresetConnection { from: (0, 0), to: (1, 0), state: PresetConnectionState::Passage }];
    let preset_state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
    let a = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
    let b = field.nodes_at(SquarePoint { x: 1, y: 0 }).first().copied().unwrap();

    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 1, &preset_state, Some(&mut log));
    let tape = log.finish();

    let preset_unions: Vec<&KruskalEvent> = tape.iter().filter(|e| matches!(e, KruskalEvent::PresetUnionsApplied(_))).collect();
    assert_eq!(preset_unions.len(), 1, "exactly one PresetUnionsApplied event must be emitted");
    match preset_unions[0] {
        KruskalEvent::PresetUnionsApplied(pairs) => {
            // A Passage preset builds both directions on the graph, so both directed edges are
            // carried here (BTreeSet-sorted by `from`, ascending).
            let mut expected = vec![(a, b, EdgeKind::Basic), (b, a, EdgeKind::Basic)];
            expected.sort();
            assert_eq!(pairs, &expected, "PresetUnionsApplied must carry both directed preset edges with their EdgeKind");
        }
        _ => unreachable!(),
    }

    // Must be emitted directly under the root scope, before any "edge N" scope opens — so a
    // replay consumer can apply it before scanning for SetsMerged deltas.
    let mut saw_preset_unions = false;
    for child in tape.root().children() {
        match child.payload() {
            maze_core::event_log::NodePayload::Event(KruskalEvent::PresetUnionsApplied(_)) => saw_preset_unions = true,
            maze_core::event_log::NodePayload::Scope(_) => {
                assert!(saw_preset_unions, "PresetUnionsApplied must be emitted before any \"edge N\" scope opens");
            }
            _ => {}
        }
    }
}

#[test]
fn kruskal_preset_teleport_emits_preset_unions_applied_with_teleport_kind() {
    // GitHub issue #193: a preset teleport pre-merged before generation starts must be
    // distinguishable from a preset passage in PresetUnionsApplied's payload.
    let (mut graph, field, _start) = build(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (2, 2), state: PresetConnectionState::Teleport(TeleportDirection::TwoWay),
    }];
    let preset_state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
    let a = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
    let b = field.nodes_at(SquarePoint { x: 2, y: 2 }).first().copied().unwrap();

    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 1, &preset_state, Some(&mut log));
    let tape = log.finish();

    let preset_unions: Vec<&KruskalEvent> = tape.iter().filter(|e| matches!(e, KruskalEvent::PresetUnionsApplied(_))).collect();
    assert_eq!(preset_unions.len(), 1, "exactly one PresetUnionsApplied event must be emitted");
    match preset_unions[0] {
        KruskalEvent::PresetUnionsApplied(pairs) => {
            // TwoWay builds both directions on the graph, so both directed edges are carried here.
            let mut expected = vec![(a, b, EdgeKind::Teleport), (b, a, EdgeKind::Teleport)];
            expected.sort();
            assert_eq!(pairs, &expected, "PresetUnionsApplied must carry both directed preset teleport edges with EdgeKind::Teleport");
        }
        _ => unreachable!(),
    }
}

#[test]
fn kruskal_one_way_preset_teleport_emits_only_the_single_directed_edge() {
    // GitHub issue #193: direction must not be canonicalized away — a one-way preset teleport
    // exists as a single directed graph edge, and PresetUnionsApplied must reflect exactly that
    // direction, not fabricate a reverse edge.
    let (mut graph, field, _start) = build(3, 3);
    let presets = vec![PresetConnection {
        from: (0, 0), to: (2, 2), state: PresetConnectionState::Teleport(TeleportDirection::Forward),
    }];
    let preset_state = build_preset_state(&mut graph, &field, &presets, &[], |x, y| SquarePoint { x, y }, None);
    let a = field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
    let b = field.nodes_at(SquarePoint { x: 2, y: 2 }).first().copied().unwrap();

    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 1, &preset_state, Some(&mut log));
    let tape = log.finish();

    let preset_unions: Vec<&KruskalEvent> = tape.iter().filter(|e| matches!(e, KruskalEvent::PresetUnionsApplied(_))).collect();
    assert_eq!(preset_unions.len(), 1, "exactly one PresetUnionsApplied event must be emitted");
    match preset_unions[0] {
        KruskalEvent::PresetUnionsApplied(pairs) => {
            assert_eq!(pairs, &[(a, b, EdgeKind::Teleport)], "Forward-only preset teleport must carry exactly the a->b direction, no fabricated reverse");
        }
        _ => unreachable!(),
    }
}

#[test]
fn kruskal_event_log_mutating_events_match_graph_edges() {
    let (mut graph, field, _start) = build(5, 5);
    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 7, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let edges_from_events: Vec<(_, _)> = tape
        .mutating_events()
        .filter_map(|e| match e {
            KruskalEvent::EdgeAdded { from, to, .. } => Some((*from, *to)),
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
fn kruskal_event_kinds_agree_with_is_mutating() {
    let (mut graph, field, _start) = build(5, 5);
    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 3, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    for event in tape.iter() {
        let expected_mutating = matches!(event, KruskalEvent::EdgeAdded { .. } | KruskalEvent::SetsMerged { .. });
        assert_eq!(event.is_mutating(), expected_mutating);
    }
    assert!(
        tape.iter().all(|e| !matches!(e, KruskalEvent::PresetUnionsApplied(_)) || !e.is_mutating()),
        "PresetUnionsApplied must be trace-only"
    );
}

#[test]
fn kruskal_every_edge_addition_is_immediately_followed_by_sets_merged() {
    let (mut graph, field, _start) = build(5, 5);
    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 5, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mutating: Vec<&KruskalEvent> = tape.mutating_events().collect();
    assert!(!mutating.is_empty(), "a 5x5 field must add at least one edge");
    for pair in mutating.chunks(2) {
        assert!(matches!(pair[0], KruskalEvent::EdgeAdded { .. }), "expected EdgeAdded, got {:?}", pair[0]);
        assert!(matches!(pair[1], KruskalEvent::SetsMerged { .. }), "expected SetsMerged, got {:?}", pair[1]);
    }
}

#[test]
fn kruskal_rejected_edge_emits_no_edge_added_or_sets_merged() {
    // A 2x1 field has exactly one candidate edge, so a second seed producing the same field
    // shape never rejects — instead, force a rejection by using a field with a cycle-inducing
    // edge set: a 2x2 square has 4 edges but only 3 are needed for a spanning tree, so at least
    // one edge must be rejected as a cycle.
    let (mut graph, field, _start) = build(2, 2);
    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 1, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let has_rejection = tape.iter().any(|e| matches!(e, KruskalEvent::EdgeRejected { .. }));
    assert!(has_rejection, "a 2x2 field has a cycle among its 4 candidate edges — at least one must be rejected");

    // Every "edge N" scope containing an EdgeRejected must not also contain EdgeAdded/SetsMerged.
    for child in tape.root().children() {
        let events: Vec<&KruskalEvent> = child.children().filter_map(|c| match c.payload() {
            maze_core::event_log::NodePayload::Event(e) => Some(e),
            _ => None,
        }).collect();
        let rejected = events.iter().any(|e| matches!(e, KruskalEvent::EdgeRejected { .. }));
        let added = events.iter().any(|e| matches!(e, KruskalEvent::EdgeAdded { .. }));
        if rejected {
            assert!(!added, "a rejected edge's scope must not also contain EdgeAdded");
        }
    }
}

// --- WASM boundary encoding (GitHub issue #124) ---

#[test]
fn kruskal_event_type_ids_are_unique_and_nonzero() {
    // Every variant's wire tag must be distinct and never collide with TAG_SCOPE — guards
    // against a copy-paste duplicate when a new variant is added to the registry. Mirrors
    // recursive_backtracker_event_type_ids_are_unique_and_nonzero.
    let (mut graph, field, _start) = build(4, 4);
    let mut log: EventLog<KruskalEvent> = EventLog::new();
    generate_kruskal(&mut graph, &field, 9, &empty_preset(), Some(&mut log));
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

/// Byte-level round-trip for every `KruskalEvent` variant's `encode_payload` — decodes each
/// encoded payload back by hand (mirroring the wire format documented on `EncodeEventPayload for
/// KruskalEvent`) and asserts the bytes land at the exact offsets the doc comment promises. This
/// is what actually catches an offset/field-order mistake (e.g. `RootsCompared`'s four `NodeId`s
/// written out of order) — `kruskal_event_type_ids_are_unique_and_nonzero` above only checks tags,
/// never payload bytes, so it would not have caught the bug this test guards against (an earlier
/// version of `RootsCompared`'s narration silently read the wrong field before this test existed).
#[test]
fn kruskal_event_payload_round_trips_for_every_variant() {
    fn u64le(bytes: &[u8], offset: usize) -> u64 {
        u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }

    // EdgesShuffled: u32 LE count + that many (NodeId, NodeId) pairs.
    let mut buf = Vec::new();
    KruskalEvent::EdgesShuffled(vec![(5, 9), (1, 2)]).encode_payload(&mut buf);
    assert_eq!(buf.len(), 4 + 2 * 16);
    assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 2);
    assert_eq!(u64le(&buf, 4), 5);
    assert_eq!(u64le(&buf, 12), 9);
    assert_eq!(u64le(&buf, 20), 1);
    assert_eq!(u64le(&buf, 28), 2);

    // EdgeSelected: from, to (16 bytes).
    let mut buf = Vec::new();
    KruskalEvent::EdgeSelected { from: 7, to: 8 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 16);
    assert_eq!(u64le(&buf, 0), 7);
    assert_eq!(u64le(&buf, 8), 8);

    // RootsCompared: from, to, root_of_from, root_of_to (32 bytes) — the variant this test was
    // added to specifically guard, since a prior version had from/to and the roots swapped.
    let mut buf = Vec::new();
    KruskalEvent::RootsCompared { from: 1, to: 2, root_of_from: 3, root_of_to: 4 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 32);
    assert_eq!(u64le(&buf, 0), 1, "byte 0..8 must be `from`");
    assert_eq!(u64le(&buf, 8), 2, "byte 8..16 must be `to`");
    assert_eq!(u64le(&buf, 16), 3, "byte 16..24 must be `root_of_from`");
    assert_eq!(u64le(&buf, 24), 4, "byte 24..32 must be `root_of_to`");

    // EdgeRejected: no payload.
    let mut buf = Vec::new();
    KruskalEvent::EdgeRejected.encode_payload(&mut buf);
    assert_eq!(buf.len(), 0);

    // EdgeAdded: from, to, bidirectional flag (17 bytes).
    let mut buf = Vec::new();
    KruskalEvent::EdgeAdded { from: 11, to: 12, bidirectional: true }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 17);
    assert_eq!(u64le(&buf, 0), 11);
    assert_eq!(u64le(&buf, 8), 12);
    assert_eq!(buf[16], 1);

    let mut buf = Vec::new();
    KruskalEvent::EdgeAdded { from: 11, to: 12, bidirectional: false }.encode_payload(&mut buf);
    assert_eq!(buf[16], 0, "bidirectional: false must encode as byte 0");

    // SetsMerged: root_a, root_b (16 bytes).
    let mut buf = Vec::new();
    KruskalEvent::SetsMerged { root_a: 13, root_b: 14 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 16);
    assert_eq!(u64le(&buf, 0), 13);
    assert_eq!(u64le(&buf, 8), 14);

    // PresetUnionsApplied: u32 LE count + that many (NodeId, NodeId, EdgeKind) triples, the
    // trailing byte being the teleport flag (GitHub issue #193). `.type_id()` is asserted here
    // specifically (unlike every other variant, whose tag is already exercised via
    // kruskal_event_type_ids_are_unique_and_nonzero's real generation run) because that test uses
    // empty_preset() — PresetUnionsApplied is never emitted by a preset-free run (see
    // kruskal_no_preset_connections_emits_no_preset_unions_applied), so its `type_id()` arm would
    // otherwise never execute under any test.
    let event = KruskalEvent::PresetUnionsApplied(vec![(15, 16, EdgeKind::Basic), (17, 18, EdgeKind::Teleport)]);
    assert_eq!(event.type_id(), 6, "PresetUnionsApplied's wire tag must be PRESET_UNIONS_APPLIED (6)");
    let mut buf = Vec::new();
    event.encode_payload(&mut buf);
    assert_eq!(buf.len(), 4 + 2 * 17);
    assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 2);
    assert_eq!(u64le(&buf, 4), 15);
    assert_eq!(u64le(&buf, 12), 16);
    assert_eq!(buf[20], 0, "Basic must encode as byte 0");
    assert_eq!(u64le(&buf, 21), 17);
    assert_eq!(u64le(&buf, 29), 18);
    assert_eq!(buf[37], 1, "Teleport must encode as byte 1");
}
