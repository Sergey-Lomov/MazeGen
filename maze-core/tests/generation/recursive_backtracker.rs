use maze_core::generation::{generate_maze, generate_maze_with_events, generate_recursive_backtracker, recursive_backtracker_debug_value_names, GenerationAlgorithm, GenerationConfig, RecursiveBacktrackerEvent};
use maze_core::event_log::{DebugEvent, DebugValueDelta, DebugValueKind, DebugValueOp, EncodeEventPayload, EventLog, EventedEventKind, NodePayload, NO_NODE, TAG_SCOPE};
use maze_core::validation::is_connected;
use super::helpers::*;

#[test]
fn recursive_backtracker_visits_all_nodes() {
    let (mut graph, mut field, start, mut ids) = build_with_ids(5, 5);
    let node_count = graph.nodes().count();
    generate_maze(&mut graph, &mut field, &mut ids, 42, start, GenerationConfig {
        algorithm: GenerationAlgorithm::RecursiveBacktracker,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn recursive_backtracker_traverses_preset_teleport_into_visited() {
    // GitHub issue #226: a preset teleport bridging two otherwise-disconnected halves must be
    // followed by the algorithm, not treated as a dead end.
    let (mut graph, field, start, preset_state, node_count, _, _, _ids) = build_with_preset_teleport_bridge();
    generate_recursive_backtracker(&mut graph, &field, 42, start, &preset_state, None);
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn recursive_backtracker_traverses_one_way_preset_teleport_into_visited() {
    // GitHub issue #226: a one-way preset teleport must also be traversed, not just the two-way
    // case. Only a single directed teleport edge exists (not two), so the resulting graph isn't a
    // plain 2*(n-1) perfect maze — checking connectivity is the right level of assertion here.
    let (mut graph, field, start, preset_state, _node_count, _ids) = build_with_one_way_preset_teleport_bridge();
    generate_recursive_backtracker(&mut graph, &field, 42, start, &preset_state, None);
    assert!(is_connected(&graph, start));
}

#[test]
fn recursive_backtracker_does_not_bridge_split_siblings_through_a_claimed_neighbor() {
    // GitHub issue #242: `(0,0)` is claimed by the split point's original node via a preset
    // passage. Starting the walk from the *slot* node (the other split node), RB must never wire
    // it to `(0,0)` too — that would merge the two independent split passages through one shared
    // neighbor, defeating the point of the split.
    let (mut graph, field, preset_state, original, slot, left, right) = build_with_split_point_preset_claim();
    generate_recursive_backtracker(&mut graph, &field, 42, slot, &preset_state, None);

    assert!(graph.edge_between(original, left).is_some(), "the preset passage to `left` must still exist");
    assert!(
        graph.edge_between(slot, left).is_none() && graph.edge_between(left, slot).is_none(),
        "slot node must never connect to `left` — that face is already claimed by `original`"
    );
    // The slot node must still reach the rest of the maze through its own free neighbor.
    assert!(graph.edge_between(slot, right).is_some() || graph.edge_between(right, slot).is_some());
}

#[test]
fn recursive_backtracker_respects_wall_between_a_preset_connected_split_node_and_a_preset_connected_neighbor() {
    // GitHub issue #242's second bug: `slot` and `left` are each `preset_connected` via their own,
    // unrelated presets (slot->right is Passage, left->(0,1) is Passage) — but `slot` has an
    // explicit Wall specifically against `left`. The candidate filter used to short-circuit
    // `can_connect` whenever *both* nodes were anywhere in the flat `preset_connected` set, which
    // made this Wall a no-op: `left` still showed up in `slot`'s `CandidatesComputed` and could be
    // picked, even though `try_add_bidirectional_edge` then silently refused to add the edge
    // (respecting `blocked` itself) — leaving `slot` marked visited/pushed onto a neighbor it was
    // never actually wired to. Asserted via the event log, not just final graph edges, since a
    // silently-refused edge leaves no trace in the graph at all — the visible bug is `left`
    // appearing as a live candidate/visit in the first place.
    let (mut graph, field, preset_state, _original, slot, left, right) = build_with_split_point_preset_connected_false_positive();
    let mut log: maze_core::event_log::EventLog<RecursiveBacktrackerEvent> = maze_core::event_log::EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 42, slot, &preset_state, Some(&mut log));
    let tape = log.finish();

    assert!(graph.edge_between(slot, right).is_some(), "the preset passage slot->right must still exist");
    // `left` is legitimately reachable through the rest of the maze via its own ordinary geometric
    // neighbors — the bug is specifically `left` showing up as a candidate for `slot`, right after
    // `slot` was selected (`VertexSelected(slot)`'s immediately-following `CandidatesComputed`).
    let mut events = tape.iter();
    while let Some(event) = events.next() {
        if matches!(event, RecursiveBacktrackerEvent::VertexSelected(n) if *n == slot) {
            let next = events.next().expect("VertexSelected must be followed by CandidatesComputed");
            assert!(
                matches!(next, RecursiveBacktrackerEvent::CandidatesComputed(cands) if !cands.contains(&left)),
                "`left` must never appear as a candidate for `slot` — the explicit Wall between them must be respected, got {next:?}"
            );
        }
    }
    assert!(
        graph.edge_between(slot, left).is_none() && graph.edge_between(left, slot).is_none(),
        "the explicit Wall between slot and left must be respected, not bypassed by preset_connected membership"
    );
}

#[test]
fn recursive_backtracker_never_narrates_an_edge_add_when_bidirectional_add_would_be_refused() {
    // `a`/`b` are geometric neighbors with only one direction blocked: `can_connect` allows the
    // pair (either direction free suffices), but RB always commits a full bidirectional passage
    // via `try_add_bidirectional_edge`, which requires *both* directions free and therefore
    // silently refuses. Before this fix, the candidate filter used `can_connect`, letting `b` pass
    // as a candidate, get chosen, and have `EdgeAdded`/`VertexVisited` emitted even though no edge
    // was actually added to the graph.
    let (mut graph, field, preset_state, a, b) = build_with_one_directionally_blocked_pair();
    let mut log: maze_core::event_log::EventLog<RecursiveBacktrackerEvent> = maze_core::event_log::EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 0, a, &preset_state, Some(&mut log));
    let tape = log.finish();

    assert!(
        graph.edge_between(a, b).is_none() && graph.edge_between(b, a).is_none(),
        "the one-directional block must prevent any edge between a and b"
    );
    assert!(
        !tape.iter().any(|e| matches!(e, RecursiveBacktrackerEvent::EdgeAdded { from, to, .. } if *from == a && *to == b)),
        "must never narrate EdgeAdded for a pair the bidirectional add refused"
    );
}

#[test]
fn recursive_backtracker_is_deterministic() {
    let (mut g1, mut f1, s1, mut ids1) = build_with_ids(4, 4);
    let (mut g2, mut f2, s2, mut ids2) = build_with_ids(4, 4);
    let config = || GenerationConfig { algorithm: GenerationAlgorithm::RecursiveBacktracker, elements: no_one_way_elements(), ..GenerationConfig::default() };
    generate_maze(&mut g1, &mut f1, &mut ids1, 7, s1, config(), &empty_preset());
    generate_maze(&mut g2, &mut f2, &mut ids2, 7, s2, config(), &empty_preset());
    assert_deterministic(&g1, &g2);
}

#[test]
fn recursive_backtracker_event_log_mutating_events_match_graph_edges() {
    let (mut graph, field, start) = build(4, 4);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 11, start, &empty_preset(), Some(&mut log));
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
    generate_recursive_backtracker(&mut graph, &field, 3, start, &empty_preset(), Some(&mut log));
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
    generate_recursive_backtracker(&mut graph, &field, 5, start, &empty_preset(), None);
    assert_perfect_maze(&graph, node_count);
}

#[test]
fn recursive_backtracker_dead_end_emits_pop_without_edge() {
    let (mut graph, field, start) = build(2, 2);
    let mut log: EventLog<RecursiveBacktrackerEvent> = EventLog::new();
    generate_recursive_backtracker(&mut graph, &field, 1, start, &empty_preset(), Some(&mut log));
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
    generate_recursive_backtracker(&mut graph, &field, 0, start, &empty_preset(), Some(&mut log));
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
    generate_recursive_backtracker(&mut graph, &field, 2, start, &empty_preset(), Some(&mut log));
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
    generate_recursive_backtracker(&mut graph, &field, 9, start, &empty_preset(), Some(&mut log));
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
    generate_recursive_backtracker(&mut graph, &field, 6, start, &empty_preset(), Some(&mut log));
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
fn generate_maze_with_events_debug_values_stay_empty_for_kruskal() {
    // Every generation algorithm is now instrumented (RB, Kruskal, Wilson, EdgeBased,
    // VertexBased) — Kruskal is the one remaining case where `debug_value_names` doesn't follow
    // `tape`'s `Some`-ness (see `Specs/event_log.md`'s #161 section).
    let (mut graph, mut field, start, mut ids) = build_with_ids(3, 3);
    let result = generate_maze_with_events(&mut graph, &mut field, &mut ids, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::KruskalAlgorithm,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert!(result.debug_value_names.is_empty(), "Kruskal declares no debug values yet");
}

#[test]
fn generate_maze_with_events_collects_tape_for_recursive_backtracker() {
    let (mut graph, mut field, start, mut ids) = build_with_ids(3, 3);
    let result = generate_maze_with_events(&mut graph, &mut field, &mut ids, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::RecursiveBacktracker,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert_eq!(result.event_kind, EventedEventKind::RecursiveBacktracker);
    assert_eq!(
        result.debug_value_names,
        vec![("recursion_stack".to_string(), DebugValueKind::Sequence), ("visited".to_string(), DebugValueKind::Region)],
        "Recursive Backtracker declares the recursion_stack and visited debug values"
    );
}

#[test]
fn generate_maze_with_events_collects_tape_for_kruskal() {
    let (mut graph, mut field, start, mut ids) = build_with_ids(3, 3);
    let result = generate_maze_with_events(&mut graph, &mut field, &mut ids, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::KruskalAlgorithm,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert_eq!(result.event_kind, EventedEventKind::Kruskal);
    assert!(result.debug_value_names.is_empty(), "Kruskal doesn't declare debug values yet");

    // generate_maze_with_events no longer merges its own source (GitHub issue #147) — reproduce
    // what it used to do by merging the lone raw_source here, matching how run_generate merges it
    // for real once a QC source may also be present.
    let tape = maze_core::event_log::merge_tapes(vec![result.raw_source]);
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
    let (mut graph, mut field, start, mut ids) = build_with_ids(3, 3);
    let result = generate_maze_with_events(&mut graph, &mut field, &mut ids, 1, start, GenerationConfig {
        algorithm: GenerationAlgorithm::WilsonAlgorithm,
        elements: no_one_way_elements(),
        ..GenerationConfig::default()
    }, &empty_preset());
    assert_eq!(result.event_kind, EventedEventKind::Wilson);
    assert_eq!(
        result.debug_value_names,
        vec![
            ("visited".to_string(), DebugValueKind::Region),
            ("current_walk".to_string(), DebugValueKind::Map),
            ("walk_start".to_string(), DebugValueKind::Vertex),
            ("walk_head".to_string(), DebugValueKind::Vertex),
        ],
        "Wilson declares the visited, current_walk, walk_start, and walk_head debug values"
    );

    let tape = maze_core::event_log::merge_tapes(vec![result.raw_source]);
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
    generate_recursive_backtracker(&mut graph, &field, 17, start_id, &empty_preset(), Some(&mut log));
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
