use maze_core::generation::{generate_vertex_based, generate_maze_with_events, vertex_based_debug_value_names, VertexBasedEvent, GenerationParams, GenerationAlgorithm};
use maze_core::event_log::{DebugEvent, DebugValueDelta, DebugValueKind, DebugValueOp, EncodeEventPayload, EventLog, EventedEventKind, NodePayload, TAG_SCOPE};
use super::helpers::*;

fn no_randomness_params() -> GenerationParams {
    GenerationParams { depth_first: 0.0, corridor_chance: 1.0, branching: 0.0, directionality: 0.0, cyclicity: 0.0 }
}

/// One test asserting the exact event sequence, on the smallest deterministic input (a 1x2
/// field — a single forced neighbor, no candidate-pool branching, no RNG-driven ambiguity) —
/// mirrors CLAUDE.md's "Testing debug event logs" policy: pins down real payload values and
/// order once. Every other test below asserts an invariant instead.
#[test]
fn vertex_based_single_step_emits_exact_event_sequence() {
    let (mut graph, field, start) = build(1, 2);
    let params = no_randomness_params();
    let elements = no_one_way_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 1, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let neighbor = field.neighbors(start)[0];

    let root = tape.root();
    let mut root_children = root.children();

    // The very first event overall (root-level, before any "step N" scope opens) is the start
    // node's own StartVisited — GenState::new seeds it into visited/frontier before the main
    // loop even begins, so it must be narrated there, not silently absent from the tape.
    let first = root_children.next().expect("expected at least one root child");
    assert!(
        matches!(first.payload(), NodePayload::Event(VertexBasedEvent::StartVisited { node }) if *node == start),
        "the first root child must be the start node's StartVisited"
    );

    let mut step_scopes = root_children.filter(|c| matches!(c.payload(), NodePayload::Scope(name) if name.starts_with("step ")));

    // Step 1: start (the only frontier entry) connects to its only neighbor via the corridor
    // branch (corridor_chance = 1.0), then that neighbor is marked visited.
    let step1 = step_scopes.next().expect("expected a first \"step N\" scope");
    let events1: Vec<VertexBasedEvent> = step1.children().filter_map(|c| match c.payload() {
        NodePayload::Event(e) => Some(e.clone()),
        _ => None,
    }).collect();

    assert_eq!(events1.len(), 7, "expected exactly 7 events in step 1, got {events1:?}");
    assert!(
        matches!(events1[0], VertexBasedEvent::SrcChosenFromFrontier { src, frontier_len: 1, position: 0, .. } if src == start),
        "event 0: {:?}", events1[0]
    );
    assert!(
        matches!(events1[1], VertexBasedEvent::TeleportRolled { src, fired: false, .. } if src == start),
        "event 1: {:?}", events1[1]
    );
    assert!(
        matches!(events1[2], VertexBasedEvent::CyclicRolled { src, fired: false, .. } if src == start),
        "event 2: {:?}", events1[2]
    );
    assert!(
        matches!(events1[3], VertexBasedEvent::CorridorRolled { is_corridor: true, .. }),
        "event 3: {:?}", events1[3]
    );
    assert!(
        matches!(events1[4], VertexBasedEvent::CandidateChosen { src, dst, used_directionality: false } if src == start && dst == neighbor),
        "event 4: {:?}", events1[4]
    );
    assert!(
        matches!(events1[5], VertexBasedEvent::EdgeAdded { src, dst, bidirectional: true } if src == start && dst == neighbor),
        "event 5: {:?}", events1[5]
    );
    assert!(
        matches!(events1[6], VertexBasedEvent::NodeVisited { node, parent } if node == neighbor && parent == start),
        "event 6: {:?}", events1[6]
    );

    // Step 2: neighbor becomes src (the only node left in frontier), but its only geometric
    // neighbor (start) is already visited — free_regular is empty, so corridor fires but has
    // nothing to connect to, and no further node enters the frontier.
    let step2 = step_scopes.next().expect("expected a second \"step N\" scope");
    let events2: Vec<VertexBasedEvent> = step2.children().filter_map(|c| match c.payload() {
        NodePayload::Event(e) => Some(e.clone()),
        _ => None,
    }).collect();
    assert_eq!(events2.len(), 4, "expected exactly 4 events in step 2, got {events2:?}");
    assert!(
        matches!(events2[0], VertexBasedEvent::SrcChosenFromFrontier { src, frontier_len: 1, position: 0, .. } if src == neighbor),
        "event 0: {:?}", events2[0]
    );
    assert!(
        matches!(events2[1], VertexBasedEvent::TeleportRolled { src, fired: false, .. } if src == neighbor),
        "event 1: {:?}", events2[1]
    );
    assert!(
        matches!(events2[2], VertexBasedEvent::CyclicRolled { src, fired: false, .. } if src == neighbor),
        "event 2: {:?}", events2[2]
    );
    assert!(
        matches!(events2[3], VertexBasedEvent::CorridorRolled { is_corridor: true, .. }),
        "event 3: {:?}", events2[3]
    );

    // Step 3: frontier is now empty — handle_empty_frontier runs, teleport bridge roll fails
    // (teleport_chance = 0), reserve is empty so the scan exhausts immediately.
    let step3 = step_scopes.next().expect("expected a third \"step N\" scope");
    assert!(step_scopes.next().is_none(), "a 1x2 field must produce exactly three steps");
    let events3: Vec<VertexBasedEvent> = step3.children().filter_map(|c| match c.payload() {
        NodePayload::Event(e) => Some(e.clone()),
        _ => None,
    }).collect();
    assert_eq!(events3.len(), 1, "expected exactly 1 event directly under step 3, got {events3:?}");
    assert!(
        matches!(events3[0], VertexBasedEvent::TeleportBridgeRolled { fired: false, .. }),
        "event 0: {:?}", events3[0]
    );
    let reserve_search = step3.children().find(|c| matches!(c.payload(), NodePayload::Scope(name) if name == "reserve_search"))
        .expect("expected a \"reserve_search\" scope under step 3");
    let search_events: Vec<VertexBasedEvent> = reserve_search.children().filter_map(|c| match c.payload() {
        NodePayload::Event(e) => Some(e.clone()),
        _ => None,
    }).collect();
    assert_eq!(search_events, vec![VertexBasedEvent::ReserveExhausted]);
}

// --- Invariants (per CLAUDE.md: mutating events reconstruct graph state, tree nesting, is_mutating split, None log is a no-op) ---

#[test]
fn vertex_based_event_log_mutating_edges_match_graph_edges() {
    let (mut graph, field, start) = build(6, 6);
    let params = GenerationParams::default();
    let elements = no_one_way_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 5, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    for event in tape.mutating_events() {
        let (src, dst, bidirectional) = match event {
            VertexBasedEvent::TeleportBridgeAdded { src, dst, bidirectional } => (*src, *dst, *bidirectional),
            VertexBasedEvent::BridgeAdded { src, dst, bidirectional } => (*src, *dst, *bidirectional),
            VertexBasedEvent::CyclicEdgeAdded { src, dst, bidirectional, .. } => (*src, *dst, *bidirectional),
            VertexBasedEvent::EdgeAdded { src, dst, bidirectional } => (*src, *dst, *bidirectional),
            VertexBasedEvent::TeleportConnectAdded { src, dst, bidirectional } => (*src, *dst, *bidirectional),
            _ => continue,
        };
        assert!(graph.edge_between(src, dst).is_some(), "edge-add event {src}->{dst} but graph has no edge in that exact direction");
        assert_eq!(
            graph.edge_between(dst, src).is_some(), bidirectional,
            "edge-add event {src}->{dst} bidirectional={bidirectional} disagrees with the graph's reverse-direction edge presence"
        );
    }
}

/// GitHub issue #226: a preset teleport's destination must be narrated via
/// `PresetNeighborVisited` (the existing-edge path), not `EdgeAdded` (which would imply a new
/// edge was just added on top of the one `build_preset_state` already planted).
#[test]
fn vertex_based_event_log_preset_teleport_dst_emits_preset_neighbor_visited_not_edge_added() {
    let (mut graph, field, start, preset_state, _node_count, _, _) = build_with_preset_teleport_bridge();
    let teleport_src = *preset_state.preset_teleports.keys().next().unwrap();
    let teleport_dst = preset_state.preset_teleports[&teleport_src][0];
    let params = GenerationParams::default();
    let elements = no_one_way_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 42, start, &params, &elements, &preset_state, Some(&mut log));
    let tape = log.finish();

    let saw_preset_neighbor_visited = tape.iter().any(|e| matches!(
        e, VertexBasedEvent::PresetNeighborVisited { src, dst } if *src == teleport_src && *dst == teleport_dst
    ));
    assert!(saw_preset_neighbor_visited, "expected PresetNeighborVisited for the preset-teleport pair");

    let saw_edge_added_for_teleport_pair = tape.iter().any(|e| matches!(
        e, VertexBasedEvent::EdgeAdded { src, dst, .. } if *src == teleport_src && *dst == teleport_dst
    ));
    assert!(!saw_edge_added_for_teleport_pair, "a preset-teleport pair's edge already exists — must not emit a duplicate EdgeAdded");
}

/// Regression-style coverage for the direction-detection helper (mirrors GitHub issue #144's
/// direction-mismatch fix in `edge_based`): with `one_way_chance = 1.0`, the coin flip reverses
/// roughly half of all one-way edges — every edge-add event's `(src, dst)` must track the
/// graph's actual direction, not the algorithm's connection-attempt intent, across many seeds.
#[test]
fn vertex_based_event_log_edge_added_direction_matches_graph_even_when_one_way_reverses_it() {
    let one_way_elements = maze_core::generation::ElementsConfig { one_way_chance: 1.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 };
    let params = GenerationParams::default();
    for seed in 0..20 {
        let (mut graph, field, start) = build(6, 6);
        let mut log: EventLog<VertexBasedEvent> = EventLog::new();
        generate_vertex_based(&mut graph, &field, seed, start, &params, &one_way_elements, &empty_preset(), Some(&mut log));
        let tape = log.finish();

        let mut saw_any_edge_added = false;
        for event in tape.mutating_events() {
            if let VertexBasedEvent::EdgeAdded { src, dst, .. } = event {
                saw_any_edge_added = true;
                assert!(
                    graph.edge_between(*src, *dst).is_some(),
                    "seed {seed}: EdgeAdded {src}->{dst} but graph has no edge in that exact direction"
                );
            }
        }
        assert!(saw_any_edge_added, "seed {seed}: expected at least one EdgeAdded on a 6x6 field");
    }
}

#[test]
fn vertex_based_event_kinds_agree_with_is_mutating() {
    let (mut graph, field, start) = build(6, 6);
    let params = GenerationParams { cyclicity: 0.5, ..GenerationParams::default() };
    let elements = teleport_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 3, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    for event in tape.iter() {
        let expected_mutating = matches!(
            event,
            VertexBasedEvent::TeleportBridgeAdded { .. }
                | VertexBasedEvent::BridgeAdded { .. }
                | VertexBasedEvent::CyclicEdgeAdded { .. }
                | VertexBasedEvent::EdgeAdded { .. }
                | VertexBasedEvent::PresetNeighborVisited { .. }
                | VertexBasedEvent::TeleportConnectAdded { .. }
                | VertexBasedEvent::NodeVisited { .. }
                | VertexBasedEvent::NodeQueuedToReserve { .. }
                | VertexBasedEvent::ReserveCandidateChosen { .. }
                | VertexBasedEvent::StartVisited { .. }
                | VertexBasedEvent::SrcChosenFromFrontier { .. }
        );
        assert_eq!(event.is_mutating(), expected_mutating, "mismatch for {event:?}");
    }
}

fn teleport_elements() -> maze_core::generation::ElementsConfig {
    maze_core::generation::ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.3, teleport_one_way_chance: 0.0 }
}

#[test]
fn vertex_based_every_step_scope_is_nonempty_and_directly_under_root() {
    let (mut graph, field, start) = build(6, 6);
    let params = GenerationParams::default();
    let elements = no_one_way_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 9, start, &params, &elements, &empty_preset(), Some(&mut log));
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
fn vertex_based_reserve_search_scopes_are_nonempty_and_nested_under_a_step_scope() {
    // A field sparse/disconnected enough (via a high depth_first pop pattern and a wide field)
    // reliably drives the frontier empty mid-run at least once, forcing a "reserve_search"
    // sub-scope to open.
    let (mut graph, field, start) = build(8, 8);
    let params = GenerationParams { depth_first: 1.0, corridor_chance: 1.0, branching: 0.0, directionality: 0.0, cyclicity: 0.0 };
    let elements = no_one_way_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 2, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mut saw_any = false;
    for step in tape.root().children() {
        for child in step.children() {
            if let NodePayload::Scope(name) = child.payload() {
                assert_eq!(name, "reserve_search", "unexpected nested scope name: {name}");
                saw_any = true;
                assert!(child.children().next().is_some(), "\"reserve_search\" scope must not be empty");
            }
        }
    }
    assert!(saw_any, "expected at least one \"reserve_search\" scope on this seed/config");
}

#[test]
fn vertex_based_junction_count_scopes_open_with_setup_then_slot_rolls_matching_max() {
    // corridor_chance = 0.0 forces every step into the junction branch; a params.branching in
    // (0, 1) and a reasonably connected field guarantee virtual_max >= 2 on at least one step, so
    // junction_count's roll series actually runs.
    let (mut graph, field, start) = build(6, 6);
    let params = GenerationParams { corridor_chance: 0.0, branching: 0.5, depth_first: 0.5, directionality: 0.0, cyclicity: 0.0 };
    let elements = no_one_way_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 8, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mut saw_any = false;
    for step in tape.root().children() {
        for child in step.children() {
            if let NodePayload::Scope(name) = child.payload() {
                if name != "junction_count" {
                    assert_eq!(name, "reserve_search", "unexpected nested scope name: {name}");
                    continue;
                }
                let mut grandchildren = child.children();

                let first = grandchildren.next().expect("\"junction_count\" scope must not be empty");
                let max = match first.payload() {
                    NodePayload::Event(VertexBasedEvent::JunctionRollSetup { max }) => *max,
                    _ => panic!("expected JunctionRollSetup as the first child"),
                };

                let slot_events: Vec<usize> = grandchildren
                    .map(|g| match g.payload() {
                        NodePayload::Event(VertexBasedEvent::JunctionSlotRolled { slot, .. }) => *slot,
                        _ => panic!("expected only JunctionSlotRolled after JunctionRollSetup"),
                    })
                    .collect();
                assert_eq!(slot_events.len(), max - 2, "expected max-2 slot rolls for max={max}");
                assert_eq!(slot_events, (1..=max - 2).collect::<Vec<_>>(), "slot numbering must be 1-based and sequential");

                saw_any = true;
            }
        }
    }
    assert!(saw_any, "expected at least one \"junction_count\" scope on this seed/config");
}

#[test]
fn vertex_based_none_log_does_not_change_generation_output() {
    let (mut g1, f1, s1) = build(6, 6);
    let (mut g2, f2, s2) = build(6, 6);
    let params = GenerationParams::default();
    let elements = no_one_way_elements();

    generate_vertex_based(&mut g1, &f1, 17, s1, &params, &elements, &empty_preset(), None);
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut g2, &f2, 17, s2, &params, &elements, &empty_preset(), Some(&mut log));

    assert_deterministic(&g1, &g2);
}

#[test]
fn vertex_based_debug_values_declares_visited_frontier_reserve_as_region() {
    let names = vertex_based_debug_value_names();
    assert_eq!(
        names,
        &[
            ("visited", DebugValueKind::Region),
            ("frontier", DebugValueKind::Region),
            ("reserve", DebugValueKind::Region),
        ]
    );
}

#[test]
fn vertex_based_debug_value_deltas_keep_visited_frontier_reserve_disjoint_and_consistent() {
    let (mut graph, field, start) = build(6, 6);
    let params = GenerationParams { cyclicity: 0.3, ..GenerationParams::default() };
    let elements = teleport_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 4, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mut visited: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut frontier: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut reserve: std::collections::HashSet<u64> = std::collections::HashSet::new();
    for event in tape.mutating_events() {
        // Apply every delta this single event carries before checking the invariant — e.g.
        // `NodeVisited` reports `[Insert visited, Insert frontier, Remove reserve]` together, and
        // checking after only the first sub-delta would see a stale, not-yet-updated `reserve`.
        for (name, op, id) in event.debug_value_deltas() {
            match (name, op) {
                ("visited", DebugValueOp::Insert) => { visited.insert(id); }
                ("visited", DebugValueOp::Remove) => { visited.remove(&id); }
                ("frontier", DebugValueOp::Insert) => { frontier.insert(id); }
                ("frontier", DebugValueOp::Remove) => { frontier.remove(&id); }
                ("reserve", DebugValueOp::Insert) => { reserve.insert(id); }
                ("reserve", DebugValueOp::Remove) => { reserve.remove(&id); }
                _ => panic!("unexpected debug value name: {name}"),
            }
        }
        for (_, _, id) in event.debug_value_deltas() {
            assert!(!(visited.contains(&id) && reserve.contains(&id)), "node {id} is both visited and in reserve after {event:?}");
        }
    }
    // `start` itself is seeded into `GenState.visited` before generation begins — covered by its
    // own `StartVisited` event (mirroring Wilson's), so the replayed `visited` set does reach the
    // graph's full node count; the run otherwise terminates with `reserve` empty (nothing left
    // unclaimed).
    assert_eq!(visited.len(), graph.nodes().count(), "every node must end visited via NodeVisited or StartVisited");
    assert!(reserve.is_empty(), "reserve must end empty when generation completes");
}

#[test]
fn vertex_based_event_type_ids_are_unique_and_nonzero() {
    let (mut graph, field, start) = build(6, 6);
    let params = GenerationParams { cyclicity: 0.3, ..GenerationParams::default() };
    let elements = teleport_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 21, start, &params, &elements, &empty_preset(), Some(&mut log));
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
fn vertex_based_event_payload_round_trips_for_representative_variants() {
    fn u64le(bytes: &[u8], offset: usize) -> u64 {
        u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }
    fn f64le(bytes: &[u8], offset: usize) -> f64 {
        f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }

    // EdgeAdded: src, dst, bidirectional flag (17 bytes).
    let mut buf = Vec::new();
    VertexBasedEvent::EdgeAdded { src: 11, dst: 12, bidirectional: false }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 17);
    assert_eq!(u64le(&buf, 0), 11);
    assert_eq!(u64le(&buf, 8), 12);
    assert_eq!(buf[16], 0);

    // NodeVisited: node, parent (16 bytes, parent is always present unlike EdgeBased's NodeActivated).
    let mut buf = Vec::new();
    VertexBasedEvent::NodeVisited { node: 5, parent: 3 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 16);
    assert_eq!(u64le(&buf, 0), 5);
    assert_eq!(u64le(&buf, 8), 3);

    // CorridorRolled: roll, corridor_chance, is_corridor flag (17 bytes).
    let mut buf = Vec::new();
    VertexBasedEvent::CorridorRolled { roll: 0.2, corridor_chance: 0.3, is_corridor: true }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 17);
    assert_eq!(f64le(&buf, 0), 0.2);
    assert_eq!(f64le(&buf, 8), 0.3);
    assert_eq!(buf[16], 1);

    // CyclicCandidatesComputed: src, geometric flag, u32 count + that many NodeIds.
    let mut buf = Vec::new();
    VertexBasedEvent::CyclicCandidatesComputed { src: 1, geometric: true, candidates: vec![2, 3] }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 8 + 1 + 4 + 2 * 8);
    assert_eq!(u64le(&buf, 0), 1);
    assert_eq!(buf[8], 1);
    assert_eq!(u32::from_le_bytes(buf[9..13].try_into().unwrap()), 2);
    assert_eq!(u64le(&buf, 13), 2);
    assert_eq!(u64le(&buf, 21), 3);

    // ReserveExhausted / ReserveCandidateChosen round trip smoke (0-byte and 8-byte payloads).
    let mut buf = Vec::new();
    VertexBasedEvent::ReserveExhausted.encode_payload(&mut buf);
    assert_eq!(buf.len(), 0);

    let mut buf = Vec::new();
    VertexBasedEvent::ReserveCandidateChosen { node: 42 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 8);
    assert_eq!(u64le(&buf, 0), 42);

    // JunctionSlotRolled: slot (u32), roll, branching (f64 each), taken flag (21 bytes).
    let mut buf = Vec::new();
    VertexBasedEvent::JunctionSlotRolled { slot: 2, roll: 0.3, branching: 0.5, taken: true }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 21);
    assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 2);
    assert_eq!(f64::from_le_bytes(buf[4..12].try_into().unwrap()), 0.3);
    assert_eq!(f64::from_le_bytes(buf[12..20].try_into().unwrap()), 0.5);
    assert_eq!(buf[20], 1);

    // StartVisited: node (8 bytes).
    let mut buf = Vec::new();
    VertexBasedEvent::StartVisited { node: 9 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 8);
    assert_eq!(u64le(&buf, 0), 9);

    // JunctionRollSetup: max (4 bytes).
    let mut buf = Vec::new();
    VertexBasedEvent::JunctionRollSetup { max: 4 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 4);
    assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 4);

    // SingleCandidateSkipsDirectionality: node (8 bytes).
    let mut buf = Vec::new();
    VertexBasedEvent::SingleCandidateSkipsDirectionality { node: 7 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 8);
    assert_eq!(u64le(&buf, 0), 7);

    // NoParentSkipsDirectionality: node (8 bytes).
    let mut buf = Vec::new();
    VertexBasedEvent::NoParentSkipsDirectionality { node: 8 }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 8);
    assert_eq!(u64le(&buf, 0), 8);

    // DirectionalityRolled: roll, directionality (f64 each), fired flag, straight_found flag (18 bytes).
    let mut buf = Vec::new();
    VertexBasedEvent::DirectionalityRolled { roll: 0.1, directionality: 0.4, fired: true, straight_found: false }.encode_payload(&mut buf);
    assert_eq!(buf.len(), 18);
    assert_eq!(f64le(&buf, 0), 0.1);
    assert_eq!(f64le(&buf, 8), 0.4);
    assert_eq!(buf[16], 1);
    assert_eq!(buf[17], 0);
}

#[test]
fn vertex_based_single_candidate_skips_directionality_is_trace_only_and_precedes_candidate_chosen() {
    // A field where every non-start node has exactly one free neighbor forces
    // choose_candidate's single-candidate short-circuit on every corridor step after the first.
    let (mut graph, field, start) = build(1, 3);
    let params = no_randomness_params();
    let elements = no_one_way_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 1, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mut saw_skip = false;
    for event in tape.iter() {
        if let VertexBasedEvent::SingleCandidateSkipsDirectionality { .. } = event {
            saw_skip = true;
            assert!(!event.is_mutating(), "SingleCandidateSkipsDirectionality must be trace-only");
        }
    }
    assert!(saw_skip, "a 1x3 field's middle node has exactly one free neighbor and a parent, expected the skip event");
}

#[test]
fn vertex_based_directionality_rolled_emitted_whenever_multiple_candidates_and_a_parent_exist() {
    // A 4x4 grid gives interior nodes multiple free neighbors; corridor_chance = 1.0 forces every
    // step through the single-candidate-pick branch of choose_candidate.
    let (mut graph, field, start) = build(4, 4);
    let params = GenerationParams { corridor_chance: 1.0, directionality: 0.5, ..no_randomness_params() };
    let elements = no_one_way_elements();
    let mut log: EventLog<VertexBasedEvent> = EventLog::new();
    generate_vertex_based(&mut graph, &field, 2, start, &params, &elements, &empty_preset(), Some(&mut log));
    let tape = log.finish();

    let mut saw_rolled = false;
    let mut saw_no_parent = false;
    for event in tape.iter() {
        match event {
            VertexBasedEvent::DirectionalityRolled { .. } => {
                saw_rolled = true;
                assert!(!event.is_mutating(), "DirectionalityRolled must be trace-only");
            }
            VertexBasedEvent::NoParentSkipsDirectionality { .. } => {
                saw_no_parent = true;
                assert!(!event.is_mutating(), "NoParentSkipsDirectionality must be trace-only");
            }
            _ => {}
        }
    }
    assert!(saw_rolled, "expected at least one DirectionalityRolled on a 4x4 grid with multiple candidates and a parent");
    assert!(saw_no_parent, "start's own first step has no parent, expected NoParentSkipsDirectionality");
}

#[test]
fn vertex_based_wired_into_generate_maze_with_events() {
    let (mut graph, field, start) = build(5, 5);
    let config = GenerationAlgorithm::CustomVertexBased(GenerationParams::default());
    let result = generate_maze_with_events(
        &mut graph, &field, 6, start,
        maze_core::generation::GenerationConfig { algorithm: config, elements: no_one_way_elements(), ..maze_core::generation::GenerationConfig::default() },
        &empty_preset(),
    );
    assert_eq!(result.event_kind, EventedEventKind::VertexBased);
    assert_eq!(
        result.debug_value_names,
        vec![
            ("visited".to_string(), DebugValueKind::Region),
            ("frontier".to_string(), DebugValueKind::Region),
            ("reserve".to_string(), DebugValueKind::Region),
        ]
    );
}
