use maze_core::generation::{generate_maze, generate_maze_with_events, generate_recursive_backtracker, recursive_backtracker_debug_value_names, GenerationAlgorithm, GenerationConfig, GenerationParams, RecursiveBacktrackerEvent};
use maze_core::event_log::{DebugEvent, DebugValueDelta, DebugValueKind, DebugValueOp, EncodeEventPayload, EventLog, EventedEventKind, NodePayload, NO_NODE, TAG_SCOPE};
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
    generate_recursive_backtracker(&mut graph, &field, 11, start, &empty_preset(), Some(&mut log), None);
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
    generate_recursive_backtracker(&mut graph, &field, 3, start, &empty_preset(), Some(&mut log), None);
    let tape = log.finish();

    let mut saw_step_with_events = false;
    let mut expected_index = 1;
    for child in tape.root().children() {
        match child.payload() {
            NodePayload::Scope(name) => {
                assert_eq!(name, format!("step {expected_index}"), "step scopes must be sequentially numbered (issue #133)");
                assert!(child.children().count() > 0, "step scope must not be empty");
                saw_step_with_events = true;
                expected_index += 1;
            }
            NodePayload::Event(_) => panic!("root should only contain \"step N\" scopes"),
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
#[should_panic(expected = "checkpoint_log requires event_log")]
fn recursive_backtracker_checkpoint_log_without_event_log_panics() {
    // A checkpoint is tagged with an arena node index from event_log's emit() — checkpointing
    // without an event tree has nothing to attach a snapshot to (see GitHub issue #128's
    // CheckpointTracker::record). Passing checkpoint_log: Some with event_log: None is a caller
    // bug that must fail loudly, not silently produce an empty checkpoint log.
    let (mut graph, field, start) = build(3, 3);
    let mut checkpoint_log = maze_core::event_log::CheckpointLog::new();
    generate_recursive_backtracker(&mut graph, &field, 1, start, &empty_preset(), None, Some(&mut checkpoint_log));
}

#[test]
fn recursive_backtracker_dead_end_emits_pop_without_edge() {
    let (mut graph, field, start) = build(2, 2);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 1, start, &empty_preset(), Some(&mut log), None);
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
    generate_recursive_backtracker(&mut graph, &field, 0, start, &empty_preset(), Some(&mut log), None);
    let tape = log.finish();

    let root = tape.root();
    let mut steps = root.children();
    let step = steps.next().expect("expected at least one step scope");
    assert!(matches!(step.payload(), NodePayload::Scope("step 1")));

    let payloads: Vec<RecursiveBacktrackerEvent> = step
        .children()
        .map(|c| match c.payload() {
            NodePayload::Event(e) => e.clone(),
            NodePayload::Scope(_) => panic!("expected only events under \"step 1\""),
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
    generate_recursive_backtracker(&mut graph, &field, 2, start, &empty_preset(), Some(&mut log), None);
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
    generate_recursive_backtracker(&mut graph, &field, 9, start, &empty_preset(), Some(&mut log), None);
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
    generate_recursive_backtracker(&mut graph, &field, 6, start, &empty_preset(), Some(&mut log), None);
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
fn generate_maze_with_events_checkpoints_and_debug_values_stay_empty_for_kruskal() {
    // Every generation algorithm is now instrumented (RB, Kruskal, Wilson, EdgeBased,
    // VertexBased) — Kruskal is the one remaining case where `checkpoints`/`debug_value_names`
    // don't follow `tape`'s `Some`-ness (see `Specs/event_log.md`'s #161 section).
    let (mut graph, field, start) = build(3, 3);
    let result = generate_maze_with_events(&mut graph, &field, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::KruskalAlgorithm,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert!(result.tape.is_some(), "Kruskal must produce a tape");
    assert!(result.checkpoints.is_none(), "Kruskal checkpointing isn't wired up yet");
    assert!(result.debug_value_names.is_empty(), "Kruskal declares no debug values yet");
}

#[test]
fn generate_maze_with_events_collects_tape_for_recursive_backtracker() {
    let (mut graph, field, start) = build(3, 3);
    let result = generate_maze_with_events(&mut graph, &field, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::RecursiveBacktracker,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert!(result.tape.is_some(), "Recursive Backtracker must produce a tape");
    assert_eq!(result.event_kind, Some(EventedEventKind::RecursiveBacktracker));
    assert!(result.checkpoints.is_some(), "Recursive Backtracker must produce a checkpoint log");
    assert_eq!(
        result.debug_value_names,
        &[("recursion_stack", DebugValueKind::Sequence), ("visited", DebugValueKind::Region)],
        "Recursive Backtracker declares the recursion_stack and visited debug values"
    );
}

#[test]
fn generate_maze_with_events_collects_tape_for_kruskal() {
    let (mut graph, field, start) = build(3, 3);
    let result = generate_maze_with_events(&mut graph, &field, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::KruskalAlgorithm,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    let tape = result.tape.expect("Kruskal must produce a tape");
    assert_eq!(result.event_kind, Some(EventedEventKind::Kruskal));
    assert!(result.checkpoints.is_none(), "Kruskal checkpointing isn't wired up yet");
    assert!(result.debug_value_names.is_empty(), "Kruskal doesn't declare debug values yet");

    assert_eq!(tape.node_table.len() % maze_core::event_log::NODE_RECORD_SIZE, 0, "node table must be a whole number of NodeRecords");
    let record_count = tape.node_table.len() / maze_core::event_log::NODE_RECORD_SIZE;
    let has_event_node = (0..record_count).any(|i| {
        let base = i * maze_core::event_log::NODE_RECORD_SIZE;
        let tag = u16::from_le_bytes(tape.node_table[base + 12..base + 14].try_into().unwrap());
        tag != TAG_SCOPE
    });
    assert!(has_event_node, "a 3x3 Kruskal run must emit at least one non-scope event node");
}

#[test]
fn generate_maze_with_events_collects_tape_and_visited_debug_value_for_wilson() {
    let (mut graph, field, start) = build(3, 3);
    let result = generate_maze_with_events(&mut graph, &field, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::WilsonAlgorithm,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    let tape = result.tape.expect("Wilson must produce a tape");
    assert_eq!(result.event_kind, Some(EventedEventKind::Wilson));
    assert!(result.checkpoints.is_none(), "Wilson checkpointing isn't wired up yet");
    assert_eq!(
        result.debug_value_names,
        &[
            ("visited", DebugValueKind::Region),
            ("current_walk", DebugValueKind::Map),
            ("walk_start", DebugValueKind::Vertex),
            ("walk_head", DebugValueKind::Vertex),
        ],
        "Wilson declares the visited, current_walk, walk_start, and walk_head debug values"
    );

    assert_eq!(tape.node_table.len() % maze_core::event_log::NODE_RECORD_SIZE, 0, "node table must be a whole number of NodeRecords");
}

// --- Generic debug values (GitHub issue #131) ---

#[test]
fn debug_value_names_is_the_same_name_debug_value_deltas_actually_emits() {
    // Guards against the static declaration (debug_value_names, the source web-side toggle
    // discovery reads) drifting apart from what debug_value_deltas actually emits — both read the
    // same RECURSION_STACK/VISITED constants in recursive_backtracker.rs, so this should hold by
    // construction, but asserting it directly documents the invariant and catches a future
    // accidental second literal.
    let declared = recursive_backtracker_debug_value_names();
    assert_eq!(declared, &[("recursion_stack", DebugValueKind::Sequence), ("visited", DebugValueKind::Region)]);
    let declared_names: Vec<&str> = declared.iter().map(|(name, _)| *name).collect();

    let pushed = RecursiveBacktrackerEvent::VertexPushed(1);
    let push_deltas = pushed.debug_value_deltas();
    assert_eq!(push_deltas.len(), 1);
    assert!(declared_names.contains(&push_deltas[0].0), "the name emitted by a real delta must be one of the declared names");

    let visited = RecursiveBacktrackerEvent::VertexVisited(1);
    let visited_deltas = visited.debug_value_deltas();
    assert_eq!(visited_deltas.len(), 1);
    assert!(declared_names.contains(&visited_deltas[0].0), "the name emitted by a real delta must be one of the declared names");
}

#[test]
fn recursion_stack_deltas_reconstruct_the_actual_dfs_stack_at_every_mutating_step() {
    // Folding every VertexPushed/VertexPopped delta in emission order must reproduce the real
    // stack contents the algorithm held at that point — not just "some plausible set". `start`
    // itself is seeded onto the stack directly (`vec![start]`, see generate()) without a
    // VertexPushed event — mirrors how preset edges never emit EdgeAdded — so its own eventual
    // VertexPopped (the last mutating event of a completed run) has no matching push in the tape;
    // that one pop is tracked separately rather than folded into `recursion_stack`.
    let (mut graph, field, start_id) = build(5, 5);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 17, start_id, &empty_preset(), Some(&mut log), None);
    let tape = log.finish();

    let mut recursion_stack: Vec<u64> = Vec::new(); // mirrors the stack: push appends, pop removes the top
    let mut start_popped = false;
    for event in tape.mutating_events() {
        match event {
            RecursiveBacktrackerEvent::VertexPushed(id) => {
                for (name, op, delta_id) in event.debug_value_deltas() {
                    assert_eq!(name, "recursion_stack");
                    assert_eq!(op, DebugValueOp::Insert);
                    assert_eq!(delta_id, *id);
                }
                recursion_stack.push(*id);
            }
            RecursiveBacktrackerEvent::VertexPopped(id) => {
                for (name, op, delta_id) in event.debug_value_deltas() {
                    assert_eq!(name, "recursion_stack");
                    assert_eq!(op, DebugValueOp::Remove);
                    assert_eq!(delta_id, *id);
                }
                if recursion_stack.last() == Some(id) {
                    recursion_stack.pop();
                } else {
                    assert_eq!(*id, start_id, "only start's pop may have no matching push in the tape");
                    assert!(!start_popped, "start must only be popped once");
                    start_popped = true;
                }
            }
            RecursiveBacktrackerEvent::EdgeAdded { .. } => {
                assert!(event.debug_value_deltas().is_empty(), "EdgeAdded must not affect any debug value");
            }
            RecursiveBacktrackerEvent::VertexVisited(visited_id) => {
                let deltas = event.debug_value_deltas();
                assert_eq!(deltas.len(), 1);
                assert_eq!(deltas[0], ("visited", DebugValueOp::Insert, *visited_id));
            }
            _ => unreachable!("mutating_events() only yields the four mutating variants"),
        }
    }
    assert!(recursion_stack.is_empty(), "the stack must be fully unwound by the end of a completed run");
    assert!(start_popped, "a completed run must eventually pop start off the stack");
}

// --- Intermediate snapshot checkpointing (GitHub issue #128) ---

const EDGE_ADDED_WIRE_TAG: u16 = 5; // mirrors recursive_backtracker.rs's wire_tags::EDGE_ADDED

/// Replays `EdgeAdded` events from the start of the *encoded* tape's node table up to and
/// including arena index `up_to_node_index`, expanding each bidirectional edge into both
/// directions — mirrors what `applyRecursiveBacktracker` (`maze-web/src/debug/eventTape.ts`)
/// reconstructs, and what a checkpoint at that node index is supposed to equal. Walks the
/// encoded node table by index (like the TS replay engine's flat scan) rather than `DebugTape`'s
/// `iter()`, since `iter()` only exposes a scope-filtered sequence, not one indexable by the same
/// arena index `emit()`/checkpoints refer to.
fn replay_edges_up_to(encoded: &maze_core::event_log::EncodedTape, up_to_node_index: u32) -> Vec<(u64, u64)> {
    use maze_core::event_log::NODE_RECORD_SIZE;

    let mut edges = Vec::new();
    let node_count = encoded.node_table.len() / NODE_RECORD_SIZE;
    for i in 0..=(up_to_node_index as usize).min(node_count.saturating_sub(1)) {
        let base = i * NODE_RECORD_SIZE;
        let bytes = &encoded.node_table[base..base + NODE_RECORD_SIZE];
        let tag = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
        if tag != EDGE_ADDED_WIRE_TAG {
            continue;
        }
        let payload_offset = u32::from_le_bytes(bytes[14..18].try_into().unwrap()) as usize;
        let payload_len = u32::from_le_bytes(bytes[18..22].try_into().unwrap()) as usize;
        let payload = &encoded.payload[payload_offset..payload_offset + payload_len];
        let from = u64::from_le_bytes(payload[0..8].try_into().unwrap());
        let to = u64::from_le_bytes(payload[8..16].try_into().unwrap());
        let bidirectional = payload[16] != 0;
        edges.push((from, to));
        if bidirectional {
            edges.push((to, from));
        }
    }
    edges
}

/// Decodes a checkpoint's full payload — edges, then named debug-value sets (GitHub issue #131) —
/// mirroring `CheckpointTracker::record`'s wire format in `recursive_backtracker.rs`. Returns the
/// edges and a `(name, sorted ids)` list (sorted for order-independent comparison, since the
/// encoder itself uses a `BTreeSet` but this test shouldn't assume that detail survives unchanged).
fn decode_checkpoint_payload(payload: &[u8], offset: u32, len: u32) -> (Vec<(u64, u64)>, Vec<(String, Vec<u64>)>) {
    let bytes = &payload[offset as usize..(offset + len) as usize];
    let mut pos = 0usize;

    let edge_count = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
    pos += 4;
    let mut edges = Vec::with_capacity(edge_count);
    for _ in 0..edge_count {
        let from = u64::from_le_bytes(bytes[pos..pos + 8].try_into().unwrap());
        let to = u64::from_le_bytes(bytes[pos + 8..pos + 16].try_into().unwrap());
        edges.push((from, to));
        pos += 16;
    }

    let set_count = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
    pos += 4;
    let mut debug_values = Vec::with_capacity(set_count);
    for _ in 0..set_count {
        let name_len = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;
        let name = String::from_utf8(bytes[pos..pos + name_len].to_vec()).unwrap();
        pos += name_len;
        let id_count = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;
        let mut ids = Vec::with_capacity(id_count);
        for _ in 0..id_count {
            ids.push(u64::from_le_bytes(bytes[pos..pos + 8].try_into().unwrap()));
            pos += 8;
        }
        ids.sort();
        debug_values.push((name, ids));
    }

    (edges, debug_values)
}

/// Mirrors `replay_edges_up_to`, but also reconstructs the `"recursion_stack"` set by folding
/// every `VertexPushed`/`VertexPopped` delta up to and including `up_to_node_index` — the
/// from-scratch equivalent a checkpoint's `debug_values` section must match.
fn replay_recursion_stack_up_to(encoded: &maze_core::event_log::EncodedTape, up_to_node_index: u32) -> Vec<u64> {
    use maze_core::event_log::NODE_RECORD_SIZE;
    const VERTEX_POPPED_WIRE_TAG: u16 = 7;
    const VERTEX_PUSHED_WIRE_TAG: u16 = 8;

    let mut recursion_stack: Vec<u64> = Vec::new();
    let node_count = encoded.node_table.len() / NODE_RECORD_SIZE;
    for i in 0..=(up_to_node_index as usize).min(node_count.saturating_sub(1)) {
        let base = i * NODE_RECORD_SIZE;
        let bytes = &encoded.node_table[base..base + NODE_RECORD_SIZE];
        let tag = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
        if tag != VERTEX_PUSHED_WIRE_TAG && tag != VERTEX_POPPED_WIRE_TAG {
            continue;
        }
        let payload_offset = u32::from_le_bytes(bytes[14..18].try_into().unwrap()) as usize;
        let id = u64::from_le_bytes(encoded.payload[payload_offset..payload_offset + 8].try_into().unwrap());
        if tag == VERTEX_PUSHED_WIRE_TAG {
            recursion_stack.push(id);
        } else {
            let popped = recursion_stack.pop().expect("recursion_stack must not underflow during replay");
            assert_eq!(popped, id);
        }
    }
    recursion_stack
}

/// A 20x20 field's Recursive Backtracker run comfortably exceeds `CHECKPOINT_INTERVAL` (500)
/// mutating events (a 15x15 run alone already produces ~900), so this produces more than one
/// real checkpoint — verified empirically, not assumed from a cell-count formula.
#[test]
fn recursive_backtracker_checkpoints_match_replay_from_scratch() {
    let (mut graph, field, start) = build(20, 20);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    let mut checkpoint_log = maze_core::event_log::CheckpointLog::new();
    generate_recursive_backtracker(&mut graph, &field, 42, start, &empty_preset(), Some(&mut log), Some(&mut checkpoint_log));
    let tape = log.finish();
    let encoded_tape = tape.encode();
    let encoded_checkpoints = checkpoint_log.encode();

    assert!(
        !encoded_checkpoints.table.is_empty(),
        "a 20x20 run must exceed CHECKPOINT_INTERVAL mutating events and record at least one checkpoint"
    );
    let checkpoint_count = encoded_checkpoints.table.len() / maze_core::event_log::CHECKPOINT_RECORD_SIZE;
    assert!(checkpoint_count >= 1);

    for i in 0..checkpoint_count {
        let base = i * maze_core::event_log::CHECKPOINT_RECORD_SIZE;
        let bytes = &encoded_checkpoints.table[base..base + maze_core::event_log::CHECKPOINT_RECORD_SIZE];
        let node_index = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let offset = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        let len = u32::from_le_bytes(bytes[8..12].try_into().unwrap());

        let (mut checkpoint_edges, checkpoint_debug_values) = decode_checkpoint_payload(&encoded_checkpoints.payload, offset, len);
        let mut replayed_edges = replay_edges_up_to(&encoded_tape, node_index);
        checkpoint_edges.sort();
        replayed_edges.sort();
        assert_eq!(
            checkpoint_edges, replayed_edges,
            "checkpoint #{i} at node_index {node_index} must equal a from-scratch replay to that point"
        );

        // GitHub issue #131: the checkpoint's debug-value sets must equal a from-scratch replay
        // of the recursion stack too, same as edges above.
        assert_eq!(checkpoint_debug_values.len(), 2, "checkpoint #{i} must record exactly the recursion_stack and visited sets");
        let (name, mut checkpoint_recursion_stack) = checkpoint_debug_values
            .iter()
            .find(|(name, _)| name == "recursion_stack")
            .cloned()
            .expect("checkpoint must record a recursion_stack set");
        assert_eq!(name, "recursion_stack");
        let mut replayed_recursion_stack = replay_recursion_stack_up_to(&encoded_tape, node_index);
        checkpoint_recursion_stack.sort();
        replayed_recursion_stack.sort();
        assert_eq!(
            checkpoint_recursion_stack, replayed_recursion_stack,
            "checkpoint #{i} at node_index {node_index} must reconstruct the same recursion_stack as a from-scratch replay"
        );
    }
}

#[test]
fn recursive_backtracker_short_run_records_no_checkpoints() {
    // A 3x3 run produces far fewer than CHECKPOINT_INTERVAL (500) mutating events.
    let (mut graph, field, start) = build(3, 3);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    let mut checkpoint_log = maze_core::event_log::CheckpointLog::new();
    generate_recursive_backtracker(&mut graph, &field, 1, start, &empty_preset(), Some(&mut log), Some(&mut checkpoint_log));
    let encoded_checkpoints = checkpoint_log.encode();
    assert!(encoded_checkpoints.table.is_empty(), "a 3x3 run must not reach CHECKPOINT_INTERVAL mutating events");
}
