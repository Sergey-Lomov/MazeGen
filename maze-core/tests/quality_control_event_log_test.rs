// GitHub issue #147 — narration-level debug events for the QC/repair pipeline. Per
// CLAUDE.md's `EventLog`/`DebugTape` testing policy: one exact-sequence test on the smallest
// possible deterministic input, plus invariant tests that survive narration wording changes.

use std::collections::HashMap;
use rand::SeedableRng;
use maze_core::random::MazeRng;
use maze_core::{Graph, IdGenerator, Maze, NodeId};
use maze_core::generation::PresetState;
use maze_core::generation::pipeline::RepairLimits;
use maze_core::graph::EdgeKind;
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::quality_control::{
    QualityControlEngine, Stage, Rule, RuleTrait, MissingEndpointsIssue, QcEvent,
};
use maze_core::quality_control::checks::MissingEndpointsCheck;
use maze_core::repair::RandomEndpointsStrategy;
use maze_core::event_log::{EventLog, DebugEvent, NodePayload};

fn now_ms_stub() -> f64 { 0.0 }

/// Smallest deterministic input that forces every QC event branch through input shape, not seed
/// luck: a 3-node chain with neither endpoint set. One stage, one rule (`MissingEndpointsCheck` +
/// `RandomEndpointsStrategy`) — the rule finds an issue on iteration 1, dispatches a strategy that
/// always succeeds on a connected graph (two `SetStart`/`SetFinish` commands, both applied), and
/// converges (no issue) on iteration 2.
fn connected_chain_missing_endpoints() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let mut maze = Maze::new(field, graph);
    let ordered: Vec<NodeId> = (0..3)
        .map(|x| maze.field.node_at(SquarePoint { x, y: 0 }).unwrap())
        .collect();
    for i in 0..ordered.len() - 1 {
        maze.graph.build_initial_bidirectional_edge(ordered[i], ordered[i + 1], EdgeKind::Basic);
    }
    (maze, ordered)
}

fn one_rule_engine() -> QualityControlEngine<SquareTessellation> {
    let rule: Rule<SquareTessellation, MissingEndpointsIssue> = Rule::new(
        "g1".to_string(),
        vec![("check1".to_string(), Box::new(MissingEndpointsCheck { instance_id: "check1".to_string() }))],
        Some(Box::new(RandomEndpointsStrategy)),
        HashMap::new(),
        vec![],
    );
    let boxed: Box<dyn RuleTrait<SquareTessellation>> = Box::new(rule);
    QualityControlEngine::new(vec![Stage::new("stage1".to_string(), "Stage 1".to_string(), vec![boxed])])
}

fn run_engine_with_log(
    maze: &mut Maze<SquareTessellation>,
    seed: u64,
    log: Option<&mut EventLog<QcEvent>>,
) {
    let engine = one_rule_engine();
    let mut rng = MazeRng::seed_from_u64(seed);
    engine.run_full(maze, &mut rng, &PresetState::empty(), RepairLimits::default(), now_ms_stub, log);
}

// --- exact-sequence test ---

#[test]
fn exact_sequence_on_smallest_deterministic_repair_scenario() {
    let (mut maze, _) = connected_chain_missing_endpoints();
    let mut log = EventLog::new();
    run_engine_with_log(&mut maze, 42, Some(&mut log));
    let tape = log.finish();

    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some(), "the rule must have actually fixed the maze");

    // Tree shape: root -> "stage stage1" -> "iteration 1", "iteration 2" (convergence, no 3rd
    // pass) -- "iteration 1" -> RuleChecked, "rule g1" -> RepairDispatched (+ mutating children);
    // "iteration 2" -> RuleChecked(issue: None) only (nothing to dispatch, active is empty).
    let root = tape.root();
    let root_children: Vec<_> = root.children().collect();
    assert_eq!(root_children.len(), 1, "exactly one stage scope");
    let NodePayload::Scope(stage_name) = root_children[0].payload() else { panic!("expected a scope") };
    assert_eq!(stage_name, "stage stage1");

    let stage_children: Vec<_> = root_children[0].children().collect();
    assert_eq!(stage_children.len(), 2, "two iterations: one that finds+fixes the issue, one that converges");

    let NodePayload::Scope(iter1_name) = stage_children[0].payload() else { panic!("expected a scope") };
    assert_eq!(iter1_name, "iteration 1");
    let iter1_children: Vec<_> = stage_children[0].children().collect();
    assert_eq!(iter1_children.len(), 3, "IterationStarted event, RuleChecked event, \"rule g1\" dispatch scope");

    assert!(matches!(iter1_children[0].payload(), NodePayload::Event(QcEvent::IterationStarted(0))));

    let NodePayload::Event(QcEvent::RuleChecked { rule_id, issue }) = iter1_children[1].payload() else {
        panic!("expected RuleChecked")
    };
    assert_eq!(rule_id, "g1");
    assert!(issue.is_some(), "the rule must have found the missing-endpoints issue");

    let NodePayload::Scope(rule_scope_name) = iter1_children[2].payload() else { panic!("expected a scope") };
    assert_eq!(rule_scope_name, "rule g1");
    let rule_scope_children: Vec<_> = iter1_children[2].children().collect();
    assert_eq!(rule_scope_children.len(), 3, "StartSet + FinishSet mutating events, then RepairDispatched");
    assert!(matches!(rule_scope_children[0].payload(), NodePayload::Event(QcEvent::StartSet(_))));
    assert!(matches!(rule_scope_children[1].payload(), NodePayload::Event(QcEvent::FinishSet(_))));
    let NodePayload::Event(QcEvent::RepairDispatched { rule_id, result, proposed, applied }) = rule_scope_children[2].payload() else {
        panic!("expected RepairDispatched")
    };
    assert_eq!(rule_id, "g1");
    assert_eq!(*result, maze_core::quality_control::RepairResultKind::Fixed);
    assert_eq!(*proposed, 2, "RandomEndpointsStrategy proposes SetStart + SetFinish when neither is set");
    assert_eq!(*applied, 2, "both commands apply cleanly on a connected 3-node chain");

    // Iteration 2: converges -- the rule finds nothing this time, no dispatch scope.
    let NodePayload::Scope(iter2_name) = stage_children[1].payload() else { panic!("expected a scope") };
    assert_eq!(iter2_name, "iteration 2");
    let iter2_children: Vec<_> = stage_children[1].children().collect();
    assert_eq!(iter2_children.len(), 2, "IterationStarted event + RuleChecked event, no dispatch scope");
    assert!(matches!(iter2_children[0].payload(), NodePayload::Event(QcEvent::IterationStarted(1))));
    let NodePayload::Event(QcEvent::RuleChecked { rule_id, issue }) = iter2_children[1].payload() else {
        panic!("expected RuleChecked")
    };
    assert_eq!(rule_id, "g1");
    assert!(issue.is_none(), "the maze is already fixed by iteration 2 -- no issue left to find");
}

// --- invariant tests ---

#[test]
fn none_log_does_not_change_generation_output() {
    let (mut maze_with_log, _) = connected_chain_missing_endpoints();
    let (mut maze_without_log, _) = connected_chain_missing_endpoints();

    let mut log = EventLog::new();
    run_engine_with_log(&mut maze_with_log, 7, Some(&mut log));
    run_engine_with_log(&mut maze_without_log, 7, None);

    assert_eq!(maze_with_log.meta.start, maze_without_log.meta.start);
    assert_eq!(maze_with_log.meta.finish, maze_without_log.meta.finish);
    assert_eq!(maze_with_log.graph.edges().count(), maze_without_log.graph.edges().count());
}

#[test]
fn mutating_events_match_the_resulting_graph_state() {
    let (mut maze, _) = connected_chain_missing_endpoints();
    let mut log = EventLog::new();
    run_engine_with_log(&mut maze, 42, Some(&mut log));
    let tape = log.finish();

    let mut start_from_events = None;
    let mut finish_from_events = None;
    for event in tape.mutating_events() {
        match event {
            QcEvent::StartSet(id) => start_from_events = Some(*id),
            QcEvent::FinishSet(id) => finish_from_events = Some(*id),
            other => panic!("unexpected mutating event for this scenario: {other:?}"),
        }
    }
    assert_eq!(start_from_events, maze.meta.start, "StartSet event must carry the same node id the maze actually ended up with");
    assert_eq!(finish_from_events, maze.meta.finish, "FinishSet event must carry the same node id the maze actually ended up with");
}

#[test]
fn tree_nesting_only_produces_stage_iteration_and_rule_scopes() {
    let (mut maze, _) = connected_chain_missing_endpoints();
    let mut log = EventLog::new();
    run_engine_with_log(&mut maze, 42, Some(&mut log));
    let tape = log.finish();

    fn walk_scopes<'a>(node: maze_core::event_log::NodeView<'a, QcEvent>, out: &mut Vec<&'a str>) {
        if let NodePayload::Scope(name) = node.payload() {
            out.push(name);
        }
        for child in node.children() {
            walk_scopes(child, out);
        }
    }

    let mut scope_names = Vec::new();
    walk_scopes(tape.root(), &mut scope_names);
    scope_names.retain(|n| *n != "root");

    for name in &scope_names {
        assert!(
            name.starts_with("stage ") || name.starts_with("iteration ") || name.starts_with("rule "),
            "unexpected scope kind: {name}"
        );
    }
}

#[test]
fn is_mutating_agrees_with_the_mutating_trace_split() {
    let (mut maze, _) = connected_chain_missing_endpoints();
    let mut log = EventLog::new();
    run_engine_with_log(&mut maze, 42, Some(&mut log));
    let tape = log.finish();

    let mutating_count = tape.mutating_events().count();
    let all_events_count = tape.iter().count();
    let trace_count = tape.iter().filter(|e| !e.is_mutating()).count();
    assert_eq!(mutating_count + trace_count, all_events_count);
    assert!(mutating_count > 0, "this scenario must produce at least one mutating event (StartSet/FinishSet)");
}

#[test]
fn rule_checked_payload_is_resolved_before_this_rules_own_dispatch_in_the_same_iteration() {
    // MissingEndpointsIssue always resolves to IssuePayload::None (no structural edge/node data —
    // see issue_payload.rs), so this test only asserts the ordering invariant itself: RuleChecked
    // for a given rule always appears before that same rule's RepairDispatched within one
    // iteration scope, never after.
    let (mut maze, _) = connected_chain_missing_endpoints();
    let mut log = EventLog::new();
    run_engine_with_log(&mut maze, 42, Some(&mut log));
    let tape = log.finish();

    // Flatten in emission order via iter(), which is DFS pre-order == emission order.
    let ordered_tags: Vec<&str> = tape.iter().map(|e| match e {
        QcEvent::RuleChecked { .. } => "RuleChecked",
        QcEvent::RepairDispatched { .. } => "RepairDispatched",
        _ => "other",
    }).filter(|t| *t != "other").collect();

    // Iteration 1: RuleChecked (finds the issue) then RepairDispatched (fixes it). Iteration 2: one
    // more RuleChecked (convergence check, finds nothing, never dispatched).
    assert_eq!(ordered_tags, vec!["RuleChecked", "RepairDispatched", "RuleChecked"], "RuleChecked must precede this rule's own RepairDispatched, never follow it");
}
