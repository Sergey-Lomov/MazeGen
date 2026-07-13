use maze_core::generation::{generate_maze, generate_recursive_backtracker, GenerationAlgorithm, GenerationConfig, RecursiveBacktrackerEvent};
use maze_core::event_log::{DebugEvent, EventLog, NodePayload};
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
            RecursiveBacktrackerEvent::EdgeAdded { from, to } => Some((*from, *to)),
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
            RecursiveBacktrackerEvent::EdgeAdded { from: start, to: other },
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
