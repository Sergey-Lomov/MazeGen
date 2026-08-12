use maze_core::generation::{generate_edge_based, generate_maze_with_events, edge_based_debug_value_names, EdgeBasedEvent, EdgeBasedParams, GenerationAlgorithm};
use maze_core::event_log::{DebugEvent, DebugValueDelta, DebugValueKind, DebugValueOp, EncodeEventPayload, EventLog, EventedEventKind, NodePayload, TAG_SCOPE};
use super::helpers::*;

fn no_teleport_no_cyclic_params() -> EdgeBasedParams {
    EdgeBasedParams { corridor_length: 0.0, branching: 0.0, depth_first: 0.0, directionality: 0.0, cyclicity: 0.0 }
}

/// One test asserting the exact event sequence, on the smallest deterministic input (a 1x2
/// field — a single forced neighbor, no candidate-pool branching, no RNG-driven ambiguity)
/// — mirrors CLAUDE.md's "Testing debug event logs" policy: pins down real payload values and
/// order once. Every other test below asserts an invariant instead.
#[test]
fn edge_based_single_step_emits_exact_event_sequence() {
    let (mut graph, field, start) = build(1, 2);
    let params = no_teleport_no_cyclic_params();
    let elements = no_one_way_elements();
    let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
    generate_edge_based(&mut graph, &field, 1, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let neighbor = field.neighbors(start)[0];

    // The very first event overall (root-level, before any "step N" scope opens) is the start
    // node's own NodeActivated — it has no src/dst step of its own.
    let root = tape.root();
    let mut root_children = root.children();
    let first = root_children.next().expect("expected at least one root child");
    assert!(
        matches!(first.payload(), NodePayload::Event(EdgeBasedEvent::NodeActivated { node, parent: None, tree_depth: 0 }) if *node == start),
        "the first root child must be the start node's NodeActivated with parent=None"
    );

    let mut step_scopes = root_children.filter(|c| matches!(c.payload(), NodePayload::Scope(name) if name.starts_with("step ")));

    // Step 1: start connects to its only neighbor, then is immediately exhausted (its one
    // geometric slot is now claimed).
    let step1 = step_scopes.next().expect("expected a first \"step N\" scope");
    let events1: Vec<EdgeBasedEvent> = step1.children().filter_map(|c| match c.payload() {
        NodePayload::Event(e) => Some(e.clone()),
        _ => None,
    }).collect();

    assert_eq!(events1.len(), 10, "expected exactly 10 events in step 1, got {events1:?}");
    assert!(matches!(events1[0], EdgeBasedEvent::CorridorRollSkipped), "event 0: {:?}", events1[0]);
    assert!(
        matches!(events1[1], EdgeBasedEvent::SrcChosenByDepthFirst { src, active_len: 1, position: 0, .. } if src == start),
        "event 1: {:?}", events1[1]
    );
    assert!(
        matches!(events1[2], EdgeBasedEvent::TeleportRolled { src, fired: false, .. } if src == start),
        "event 2: {:?}", events1[2]
    );
    assert!(
        matches!(events1[3], EdgeBasedEvent::CyclicRolled { src, fired: false, .. } if src == start),
        "event 3: {:?}", events1[3]
    );
    assert!(
        matches!(&events1[4], EdgeBasedEvent::CandidatePoolBuilt { src, geometric: true, candidates } if *src == start && candidates == &[neighbor]),
        "event 4: {:?}", events1[4]
    );
    assert!(
        matches!(&events1[5], EdgeBasedEvent::DstWeightsComputed { candidates, .. } if candidates == &[neighbor]),
        "event 5: {:?}", events1[5]
    );
    assert!(
        matches!(events1[6], EdgeBasedEvent::DstChosen { dst, .. } if dst == neighbor),
        "event 6: {:?}", events1[6]
    );
    assert!(
        matches!(events1[7], EdgeBasedEvent::EdgeAdded { src, dst, teleport: false, bidirectional: true } if src == start && dst == neighbor),
        "event 7: {:?}", events1[7]
    );
    assert!(
        matches!(events1[8], EdgeBasedEvent::NodeActivated { node, parent: Some(p), tree_depth: 1 } if node == neighbor && p == start),
        "event 8: {:?}", events1[8]
    );
    assert!(
        matches!(events1[9], EdgeBasedEvent::SrcExhausted { src } if src == start),
        "event 9: {:?}", events1[9]
    );

    // Step 2: neighbor becomes src (the only node left in active), but its only geometric
    // neighbor (start) is already visited — empty pool, exhausted immediately.
    let step2 = step_scopes.next().expect("expected a second \"step N\" scope");
    assert!(step_scopes.next().is_none(), "a 1x2 field must produce exactly two steps");
    let events2: Vec<EdgeBasedEvent> = step2.children().filter_map(|c| match c.payload() {
        NodePayload::Event(e) => Some(e.clone()),
        _ => None,
    }).collect();
    // last_dst = Some(neighbor) after step 1 — a corridor roll IS attempted this time (it fails,
    // since corridor_length=0.0), so this step's src choice is CorridorRolled (continued: false)
    // + SrcChosenByDepthFirst, not CorridorRollSkipped.
    assert_eq!(events2.len(), 6, "expected exactly 6 events in step 2, got {events2:?}");
    assert!(
        matches!(events2[0], EdgeBasedEvent::CorridorRolled { prev, corridor_length: 0.0, continued: false, .. } if prev == neighbor),
        "event 0: {:?}", events2[0]
    );
    assert!(
        matches!(events2[1], EdgeBasedEvent::SrcChosenByDepthFirst { src, active_len: 1, position: 0, .. } if src == neighbor),
        "event 1: {:?}", events2[1]
    );
    assert!(
        matches!(events2[2], EdgeBasedEvent::TeleportRolled { src, fired: false, .. } if src == neighbor),
        "event 2: {:?}", events2[2]
    );
    assert!(
        matches!(events2[3], EdgeBasedEvent::CyclicRolled { src, fired: false, .. } if src == neighbor),
        "event 3: {:?}", events2[3]
    );
    assert!(
        matches!(&events2[4], EdgeBasedEvent::CandidatePoolBuilt { src, geometric: true, candidates } if *src == neighbor && candidates.is_empty()),
        "event 4: {:?}", events2[4]
    );
    assert!(
        matches!(&events2[5], EdgeBasedEvent::SrcExhaustedEmptyPool { src } if *src == neighbor),
        "event 5: {:?}", events2[5]
    );
}

// --- Invariants (per CLAUDE.md: mutating events reconstruct graph state, tree nesting, is_mutating split, None log is a no-op) ---

#[test]
fn edge_based_event_log_mutating_edges_match_graph_edges() {
    let (mut graph, field, start) = build(6, 6);
    let params = EdgeBasedParams::default();
    let elements = no_one_way_elements();
    let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
    generate_edge_based(&mut graph, &field, 5, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    // `EdgeAdded { src, dst, .. }` must report the graph's *actual* edge direction — `src`/`dst`
    // are set from which side `graph.edge_between` actually gained an edge, not from the
    // algorithm's connection-attempt arguments (see `EdgeAdded`'s doc comment: `add_edge_kind`'s
    // own one_way_chance coin flip can reverse a one-way edge, GitHub issue #144's
    // direction-mismatch fix). A bidirectional EdgeAdded must have both directions in the graph;
    // a one-way EdgeAdded's exact `(src, dst)` direction must be the one the graph actually has.
    for event in tape.mutating_events() {
        if let EdgeBasedEvent::EdgeAdded { src, dst, bidirectional, .. } = event {
            assert!(graph.edge_between(*src, *dst).is_some(), "EdgeAdded {src}->{dst} but graph has no edge in that exact direction");
            assert_eq!(
                graph.edge_between(*dst, *src).is_some(), *bidirectional,
                "EdgeAdded {src}->{dst} bidirectional={bidirectional} disagrees with the graph's reverse-direction edge presence"
            );
        }
    }
}

/// GitHub issue #226: a preset teleport's destination must be narrated via `PresetSkipped` (the
/// existing-edge path), not `EdgeAdded` (which would imply a new edge was just added on top of
/// the one `build_preset_state` already planted).
#[test]
fn edge_based_event_log_preset_teleport_dst_emits_preset_skipped_not_edge_added() {
    let (mut graph, field, start, preset_state, _node_count, teleport_src, teleport_dst, _ids) = build_with_preset_teleport_bridge();
    let params = EdgeBasedParams::default();
    let elements = no_one_way_elements();
    let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
    generate_edge_based(&mut graph, &field, 42, start, &params, &elements, &preset_state, Some(&mut log));
    let tape = log.finish();

    let saw_preset_skipped = tape.iter().any(|e| matches!(
        e, EdgeBasedEvent::PresetSkipped { src, dst } if *src == teleport_src && *dst == teleport_dst
    ));
    assert!(saw_preset_skipped, "expected PresetSkipped for the preset-teleport pair");

    let saw_edge_added_for_teleport_pair = tape.iter().any(|e| matches!(
        e, EdgeBasedEvent::EdgeAdded { src, dst, .. } if *src == teleport_src && *dst == teleport_dst
    ));
    assert!(!saw_edge_added_for_teleport_pair, "a preset-teleport pair's edge already exists — must not emit a duplicate EdgeAdded");
}

/// Regression test for GitHub issue #144's direction-mismatch bug: with `one_way_chance = 1.0`,
/// `add_edge_kind`'s coin flip reverses roughly half of all one-way edges (adds `dst->src` instead
/// of `src->dst`) — `EdgeAdded`'s `(src, dst)` must track that actual direction on every event,
/// across many seeds, not just the algorithm's connection-attempt intent.
#[test]
fn edge_based_event_log_edge_added_direction_matches_graph_even_when_one_way_reverses_it() {
    let one_way_elements = maze_core::generation::ElementsConfig { one_way_chance: 1.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0, ..Default::default() };
    let params = EdgeBasedParams::default();
    for seed in 0..20 {
        let (mut graph, field, start) = build(6, 6);
        let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
        generate_edge_based(&mut graph, &field, seed, start, &params, &one_way_elements, &empty_preset(), Some(&mut log));
        let tape = log.finish();

        let mut saw_any_edge_added = false;
        for event in tape.mutating_events() {
            if let EdgeBasedEvent::EdgeAdded { src, dst, .. } = event {
                saw_any_edge_added = true;
                assert!(
                    graph.edge_between(*src, *dst).is_some(),
                    "seed {seed}: EdgeAdded {src}->{dst} but graph has no edge in that exact direction (event direction doesn't match graph)"
                );
            }
        }
        assert!(saw_any_edge_added, "seed {seed}: expected at least one EdgeAdded on a 6x6 field");
    }
}

#[test]
fn edge_based_event_kinds_agree_with_is_mutating() {
    let (mut graph, field, start) = build(6, 6);
    let params = EdgeBasedParams { cyclicity: 0.5, ..EdgeBasedParams::default() };
    let elements = teleport_elements();
    let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
    generate_edge_based(&mut graph, &field, 3, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    for event in tape.iter() {
        let expected_mutating = matches!(
            event,
            EdgeBasedEvent::SrcExhaustedEmptyPool { .. }
                | EdgeBasedEvent::CyclicEdgeAdded { .. }
                | EdgeBasedEvent::CyclicEdgeRejected { .. }
                | EdgeBasedEvent::EdgeAdded { .. }
                | EdgeBasedEvent::EdgeRejected { .. }
                | EdgeBasedEvent::NodeActivated { .. }
                | EdgeBasedEvent::SrcExhausted { .. }
        );
        assert_eq!(event.is_mutating(), expected_mutating, "mismatch for {event:?}");
    }
}

fn teleport_elements() -> maze_core::generation::ElementsConfig {
    maze_core::generation::ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.3, teleport_one_way_chance: 0.0, split_chance: 0.0, ..Default::default() }
}

#[test]
fn edge_based_cyclic_rolled_at_most_once_per_node() {
    // Mirrors TeleportRolled's once-per-node guard (GitHub issue #165): a node that becomes
    // `src` multiple times before exhausting its geometric neighbors must only get a fresh
    // CyclicRolled once — every subsequent pass as `src` must emit CyclicAlreadyRolled instead,
    // never another CyclicRolled for the same node.
    let (mut graph, field, start) = build(6, 6);
    let params = EdgeBasedParams { corridor_length: 0.0, branching: 1.0, depth_first: 0.5, directionality: 0.0, cyclicity: 0.5 };
    let elements = no_one_way_elements();
    let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
    generate_edge_based(&mut graph, &field, 3, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mut fresh_rolls: std::collections::HashMap<maze_core::ids::NodeId, usize> = std::collections::HashMap::new();
    for child in tape.root().children() {
        if let NodePayload::Scope(_) = child.payload() {
            for step_child in child.children() {
                if let NodePayload::Event(EdgeBasedEvent::CyclicRolled { src, .. }) = step_child.payload() {
                    *fresh_rolls.entry(*src).or_insert(0) += 1;
                }
            }
        }
    }

    for (src, count) in &fresh_rolls {
        assert_eq!(*count, 1, "node {src:?} got a fresh CyclicRolled {count} times, expected at most once");
    }
}

#[test]
fn edge_based_every_step_scope_is_nonempty_and_directly_under_root() {
    let (mut graph, field, start) = build(6, 6);
    let params = EdgeBasedParams::default();
    let elements = no_one_way_elements();
    let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
    generate_edge_based(&mut graph, &field, 9, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mut saw_any = false;
    for child in tape.root().children() {
        if let NodePayload::Scope(name) = child.payload() {
            assert!(name.starts_with("step "), "unexpected non-\"step N\" scope directly under root: {name}");
            saw_any = true;
            assert!(child.children().next().is_some(), "\"{name}\" scope must not be empty");
        }
    }
    assert!(saw_any, "expected at least one \"step N\" scope");
}

#[test]
fn edge_based_none_log_does_not_change_generation_output() {
    let (mut g1, f1, s1) = build(6, 6);
    let (mut g2, f2, s2) = build(6, 6);
    let params = EdgeBasedParams::default();
    let elements = no_one_way_elements();

    generate_edge_based(&mut g1, &f1, 17, s1, &params, &elements, &empty_preset(), None);
    let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
    generate_edge_based(&mut g2, &f2, 17, s2, &params, &elements, &empty_preset(), Some(&mut log));

    assert_deterministic(&g1, &g2);
}

#[test]
fn edge_based_debug_values_declares_active_and_visited_as_region() {
    let names = edge_based_debug_value_names();
    assert_eq!(names, &[("active", DebugValueKind::Region), ("visited", DebugValueKind::Region)]);
}

#[test]
fn edge_based_node_activated_and_src_exhausted_drive_active_visited_deltas() {
    let (mut graph, field, start) = build(5, 5);
    let params = EdgeBasedParams::default();
    let elements = no_one_way_elements();
    let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
    generate_edge_based(&mut graph, &field, 4, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    // Replay active/visited from deltas and check invariants hold throughout: a node is never
    // both active and visited, and every SrcExhausted/SrcExhaustedEmptyPool moves its node from
    // active to visited (never the reverse).
    let mut active: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut visited: std::collections::HashSet<u64> = std::collections::HashSet::new();
    for event in tape.mutating_events() {
        for (name, op, id) in event.debug_value_deltas() {
            match (name, op) {
                ("active", DebugValueOp::Insert) => { active.insert(id); }
                ("active", DebugValueOp::Remove) => { active.remove(&id); }
                ("visited", DebugValueOp::Insert) => { visited.insert(id); }
                ("visited", DebugValueOp::Remove) => { visited.remove(&id); }
                _ => panic!("unexpected debug value name: {name}"),
            }
            assert!(!(active.contains(&id) && visited.contains(&id)), "node {id} is both active and visited after {event:?}");
        }
    }
    // Every node the algorithm ever activates ends up visited (the run terminates with active
    // empty) — assert against the actual node count on this field.
    assert!(active.is_empty(), "active must end empty when generation completes");
    assert_eq!(visited.len(), graph.nodes().count(), "every node must end visited");
}

#[test]
fn edge_based_event_type_ids_are_unique_and_nonzero() {
    let (mut graph, field, start) = build(6, 6);
    let params = EdgeBasedParams { cyclicity: 0.3, ..EdgeBasedParams::default() };
    let elements = teleport_elements();
    let mut log: EventLog<EdgeBasedEvent> = EventLog::new();
    generate_edge_based(&mut graph, &field, 21, start, &params, &elements, &empty_preset(), Some(&mut log));
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
fn edge_based_event_payload_round_trips_for_representative_variants() {
    fn u64le(bytes: &[u8], offset: usize) -> u64 {
        u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }
    fn f64le(bytes: &[u8], offset: usize) -> f64 {
        f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }

    // EdgeAdded: src, dst, teleport flag, bidirectional flag (18 bytes).
    let mut buf = Vec::new();
    EdgeBasedEvent::EdgeAdded { src: 11, dst: 12, teleport: true, bidirectional: false }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 18);
    assert_eq!(u64le(&buf, 0), 11);
    assert_eq!(u64le(&buf, 8), 12);
    assert_eq!(buf[16], 1);
    assert_eq!(buf[17], 0);

    // NodeActivated with parent=None: node, presence flag 0, 8 zero bytes, tree_depth.
    let mut buf = Vec::new();
    EdgeBasedEvent::NodeActivated { node: 5, parent: None, tree_depth: 0 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 8 + 1 + 8 + 4);
    assert_eq!(u64le(&buf, 0), 5);
    assert_eq!(buf[8], 0, "presence flag must be 0 for parent=None");
    assert_eq!(u64le(&buf, 9), 0, "placeholder parent bytes must be 0 when absent");
    assert_eq!(u32::from_le_bytes(buf[17..21].try_into().unwrap()), 0);

    // NodeActivated with parent=Some: presence flag 1, real parent id.
    let mut buf = Vec::new();
    EdgeBasedEvent::NodeActivated { node: 5, parent: Some(3), tree_depth: 2 }.encode_payload(&mut buf);
    assert_eq!(buf[8], 1, "presence flag must be 1 for parent=Some");
    assert_eq!(u64le(&buf, 9), 3);
    assert_eq!(u32::from_le_bytes(buf[17..21].try_into().unwrap()), 2);

    // CorridorRolled: prev, roll, corridor_length, continued flag (25 bytes).
    let mut buf = Vec::new();
    EdgeBasedEvent::CorridorRolled { prev: 7, roll: 0.2, corridor_length: 0.3, continued: true }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 25);
    assert_eq!(u64le(&buf, 0), 7);
    assert_eq!(f64le(&buf, 8), 0.2);
    assert_eq!(f64le(&buf, 16), 0.3);
    assert_eq!(buf[24], 1);

    // CandidatePoolBuilt: src, geometric flag, u32 count + that many NodeIds.
    let mut buf = Vec::new();
    EdgeBasedEvent::CandidatePoolBuilt { src: 1, geometric: true, candidates: vec![2, 3] }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 8 + 1 + 4 + 2 * 8);
    assert_eq!(u64le(&buf, 0), 1);
    assert_eq!(buf[8], 1);
    assert_eq!(u32::from_le_bytes(buf[9..13].try_into().unwrap()), 2);
    assert_eq!(u64le(&buf, 13), 2);
    assert_eq!(u64le(&buf, 21), 3);

    // CorridorRollSkipped / SrcExhausted round trip smoke (0-byte and 8-byte payloads).
    let mut buf = Vec::new();
    EdgeBasedEvent::CorridorRollSkipped.encode_payload(&mut buf);
    assert_eq!(buf.len(), 0);

    let mut buf = Vec::new();
    EdgeBasedEvent::SrcExhausted { src: 42 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 8);
    assert_eq!(u64le(&buf, 0), 42);
}

#[test]
fn edge_based_wired_into_generate_maze_with_events() {
    let (mut graph, mut field, start, mut ids) = build_with_ids(5, 5);
    let config = GenerationAlgorithm::CustomEdgeBased(EdgeBasedParams::default());
    let result = generate_maze_with_events(
        &mut graph, &mut field, &mut ids, 6, start,
        maze_core::generation::GenerationConfig { algorithm: config, elements: no_one_way_elements(), ..maze_core::generation::GenerationConfig::default() },
        &empty_preset(),
    );
    assert_eq!(result.event_kind, EventedEventKind::EdgeBased);
    assert_eq!(result.debug_value_names, vec![("active".to_string(), DebugValueKind::Region), ("visited".to_string(), DebugValueKind::Region)]);
}
