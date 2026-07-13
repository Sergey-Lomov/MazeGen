use maze_core::generation::{generate_maze, generate_maze_with_events, generate_recursive_backtracker, GenerationAlgorithm, GenerationConfig, RecursiveBacktrackerEvent};
use maze_core::event_log::{DebugEvent, EncodeEventPayload, EventLog, NodePayload, NO_NODE, TAG_SCOPE};
use super::helpers::*;

#[test]
fn recursive_backtracker_visits_all_nodes() {
    let (mut graph, field, start) = build(5, 5);
    let node_count = graph.nodes().count();
    generate_maze(&mut graph, &field, 42, start, GenerationConfig {
        algorithm: GenerationAlgorithm::RecursiveBacktracker,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn recursive_backtracker_is_deterministic() {
    let (mut g1, f1, s1) = build(4, 4);
    let (mut g2, f2, s2) = build(4, 4);
    let config = || GenerationConfig { algorithm: GenerationAlgorithm::RecursiveBacktracker, elements: no_one_way_elements(), ..GenerationConfig::default() };
    generate_maze(&mut g1, &f1, 7, s1, config(), &empty_preset());
    generate_maze(&mut g2, &f2, 7, s2, config(), &empty_preset());
    assert_deterministic(&g1, &g2);
}

#[test]
fn recursive_backtracker_event_log_mutating_events_match_graph_edges() {
    let (mut graph, field, start) = build(4, 4);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 11, start, &empty_preset(), None, Some(&mut log));
    let tape = log.finish();

    let edges_from_events: Vec<(_, _)> = tape
        .mutating_events()
        .filter_map(|e| match e {
            RecursiveBacktrackerEvent::EdgeAdded { from, to, .. } => Some((*from, *to)),
            _ => None,
        })
        .collect();

    assert!(
        tape.mutating_events().all(|e| !matches!(e, RecursiveBacktrackerEvent::EdgeAdded { bidirectional, .. } if !bidirectional)),
        "RB always adds edges bidirectionally"
    );

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
fn recursive_backtracker_event_tree_nests_events_under_step_scopes() {
    let (mut graph, field, start) = build(3, 3);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 3, start, &empty_preset(), None, Some(&mut log));
    let tape = log.finish();

    let mut saw_step_with_events = false;
    for child in tape.root().children() {
        match child.payload() {
            NodePayload::Scope(name) => {
                assert_eq!(name, "step");
                assert!(child.children().count() > 0, "step scope must not be empty");
                saw_step_with_events = true;
            }
            NodePayload::Event(_) => panic!("root should only contain \"step\" scopes"),
        }
    }
    assert!(saw_step_with_events, "expected at least one step scope");
}

#[test]
fn recursive_backtracker_event_log_none_is_zero_overhead_and_still_generates() {
    let (mut graph, field, start) = build(4, 4);
    let node_count = graph.nodes().count();
    generate_recursive_backtracker(&mut graph, &field, 5, start, &empty_preset(), None, None);
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn recursive_backtracker_dead_end_emits_pop_without_edge() {
    let (mut graph, field, start) = build(2, 2);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 1, start, &empty_preset(), None, Some(&mut log));
    let tape = log.finish();

    let has_dead_end = tape.iter().any(|e| matches!(e, RecursiveBacktrackerEvent::DeadEnd));
    let has_pop = tape.iter().any(|e| matches!(e, RecursiveBacktrackerEvent::VertexPopped(_)));
    assert!(has_dead_end, "a 2x2 field must hit at least one dead end");
    assert!(has_pop, "dead end must be followed by a pop");
}

#[test]
fn recursive_backtracker_single_step_emits_exact_event_sequence() {
    // 1x2 field: start has exactly one neighbor, so the single step's path is fully forced —
    // no RNG branching to account for. Pins down the exact payloads and order emitted for a
    // vertex that connects (as opposed to a dead end, covered separately).
    let (mut graph, field, start) = build(2, 1);
    let other = field.neighbors(start)[0];
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 0, start, &empty_preset(), None, Some(&mut log));
    let tape = log.finish();

    let root = tape.root();
    let mut steps = root.children();
    let step = steps.next().expect("expected at least one step scope");
    assert!(matches!(step.payload(), NodePayload::Scope("step")));

    let payloads: Vec<RecursiveBacktrackerEvent> = step
        .children()
        .map(|c| match c.payload() {
            NodePayload::Event(e) => e.clone(),
            NodePayload::Scope(_) => panic!("expected only events under \"step\""),
        })
        .collect();

    assert_eq!(
        payloads,
        vec![
            RecursiveBacktrackerEvent::VertexSelected(start),
            RecursiveBacktrackerEvent::CandidatesComputed(vec![other]),
            RecursiveBacktrackerEvent::CandidateChosen(other),
            RecursiveBacktrackerEvent::EdgeAdded { from: start, to: other, bidirectional: true },
            RecursiveBacktrackerEvent::VertexVisited(other),
            RecursiveBacktrackerEvent::VertexPushed(other),
        ]
    );
}

#[test]
fn recursive_backtracker_event_kinds_agree_with_is_mutating() {
    let (mut graph, field, start) = build(3, 3);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 2, start, &empty_preset(), None, Some(&mut log));
    let tape = log.finish();

    for event in tape.iter() {
        let expected_mutating = matches!(
            event,
            RecursiveBacktrackerEvent::EdgeAdded { .. }
                | RecursiveBacktrackerEvent::VertexVisited(_)
                | RecursiveBacktrackerEvent::VertexPopped(_)
                | RecursiveBacktrackerEvent::VertexPushed(_)
        );
        assert_eq!(event.is_mutating(), expected_mutating);
    }
}

// --- WASM boundary encoding (GitHub issue #124) ---

#[test]
fn recursive_backtracker_event_type_ids_are_unique_and_nonzero() {
    // Every variant's wire tag must be distinct and never collide with TAG_SCOPE — guards
    // against a copy-paste duplicate when a new variant is added to the registry.
    let (mut graph, field, start) = build(4, 4);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 9, start, &empty_preset(), None, Some(&mut log));
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
    // Distinct variants must map to distinct tags.
    let mut tags: Vec<u16> = seen_by_variant.values().copied().collect();
    tags.sort();
    tags.dedup();
    assert_eq!(tags.len(), seen_by_variant.len(), "two distinct event variants share a type_id");
}

#[test]
fn recursive_backtracker_encode_round_trips_tree_shape() {
    let (mut graph, field, start) = build(4, 4);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 6, start, &empty_preset(), None, Some(&mut log));
    let tape = log.finish();
    let encoded = tape.encode();

    assert_eq!(encoded.node_table.len() % maze_core::event_log::NODE_RECORD_SIZE, 0);

    // Root scope (node 0) round-trips as TAG_SCOPE with payload "root", no parent/sibling.
    let base = 0;
    let bytes = &encoded.node_table[base..base + maze_core::event_log::NODE_RECORD_SIZE];
    let parent = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
    let next_sibling = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let tag = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
    let payload_offset = u32::from_le_bytes(bytes[14..18].try_into().unwrap());
    let payload_len = u32::from_le_bytes(bytes[18..22].try_into().unwrap());
    assert_eq!(parent, NO_NODE);
    assert_eq!(next_sibling, NO_NODE);
    assert_eq!(tag, TAG_SCOPE);
    assert_eq!(&encoded.payload[payload_offset as usize..(payload_offset + payload_len) as usize], b"root");
}

#[test]
fn generate_maze_with_events_returns_none_for_non_recursive_backtracker() {
    let (mut graph, field, start) = build(3, 3);
    let (steps, tape) = generate_maze_with_events(&mut graph, &field, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::WilsonAlgorithm,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset(), false);
    assert!(tape.is_none(), "only Recursive Backtracker is instrumented so far");
    assert!(steps.is_empty());
}

#[test]
fn generate_maze_with_events_collects_steps_when_requested() {
    let (mut graph, field, start) = build(3, 3);
    let (steps, tape) = generate_maze_with_events(&mut graph, &field, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::RecursiveBacktracker,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset(), true);
    assert!(tape.is_some(), "Recursive Backtracker must produce a tape");
    assert!(!steps.is_empty(), "collect_steps=true must populate GenerationStep trace alongside the event tree");
}
