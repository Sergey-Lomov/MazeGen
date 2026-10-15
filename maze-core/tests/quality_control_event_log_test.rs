// GitHub issue #147 — narration-level debug events for the QC/repair pipeline. Per
// CLAUDE.md's `EventLog`/`DebugTape` testing policy: one exact-sequence test on the smallest
// possible deterministic input, plus invariant tests that survive narration wording changes.
use std::sync::Arc;

use maze_core::event_log::{DebugEvent, EventLog, NodePayload};
use maze_core::generation::PresetState;
use maze_core::generation::pipeline::RepairLimits;
use maze_core::graph::EdgeKind;
use maze_core::quality_control::check::Check;
use maze_core::quality_control::checks::MissingEndpointsCheck;
use maze_core::quality_control::{
    MissingEndpointsIssue, QcEvent, QualityControlEngine, Rule, RuleTrait, Stage,
};
use maze_core::random::MazeRng;
use maze_core::repair::RandomEndpointsStrategy;
use maze_core::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use maze_core::{Graph, IdGenerator, Maze, NodeId};
use rand::SeedableRng;
use std::collections::HashMap;

/// Like `MissingEndpointsCheck`, but attaches a `"reason"` detail — `MissingEndpointsCheck` itself
/// never calls `with_detail` (nothing to say beyond "missing"), so this is the smallest way to get
/// a real, non-empty `IssueMeta::details()` entry flowing through a real multi-check merge (see
/// `issues_merged_details_carries_each_contributing_checks_own_detail_values` below).
struct MissingEndpointsCheckWithDetail {
    instance_id: String,
    reason: &'static str,
}

impl<T: maze_core::space::Tessellation> Check<T, MissingEndpointsIssue>
    for MissingEndpointsCheckWithDetail
{
    fn check_type_id(&self) -> &'static str {
        "missing_endpoints"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingEndpointsIssue>,
        _rng: &mut dyn rand::RngCore,
        _requirement: (),
    ) {
        let missing_start = maze.meta.start.is_none();
        let missing_finish = maze.meta.finish.is_none();
        if missing_start || missing_finish {
            issues.push(
                MissingEndpointsIssue::new_from_check(
                    &self.instance_id,
                    missing_start,
                    missing_finish,
                )
                .with_detail(&self.instance_id, "reason", self.reason.to_string()),
            );
        }
    }
}

fn now_ms_stub() -> f64 {
    0.0
}

/// Smallest deterministic input that forces every QC event branch through input shape, not seed
/// luck: a 3-node chain with neither endpoint set. One stage, one rule (`MissingEndpointsCheck` +
/// `RandomEndpointsStrategy`) — the rule finds an issue on iteration 1, dispatches a strategy that
/// always succeeds on a connected graph (two `SetStart`/`SetFinish` commands, both applied), and
/// converges (no issue) on iteration 2.
fn connected_chain_missing_endpoints() -> (Maze<SquareTessellation>, Vec<NodeId>) {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let mut maze = Maze::new(field, graph);
    let level = maze.field.single_level_id();
    let ordered: Vec<NodeId> = (0..3)
        .map(|x| {
            maze.field
                .nodes_at(level, SquarePoint { x, y: 0 })
                .first()
                .copied()
                .unwrap()
        })
        .collect();
    for i in 0..ordered.len() - 1 {
        maze.graph
            .build_initial_bidirectional_edge(ordered[i], ordered[i + 1], EdgeKind::Basic);
    }
    (maze, ordered)
}

fn one_rule_engine() -> QualityControlEngine<SquareTessellation> {
    let rule: Rule<SquareTessellation, MissingEndpointsIssue> = Rule::new(
        "g1".to_string(),
        vec![(
            "check1".to_string(),
            Box::new(MissingEndpointsCheck {
                instance_id: "check1".to_string(),
            }),
        )],
        Some(Box::new(RandomEndpointsStrategy)),
        HashMap::new(),
        vec![],
    );
    let boxed: Box<dyn RuleTrait<SquareTessellation>> = Box::new(rule);
    QualityControlEngine::new(vec![Stage::new(
        "stage1".to_string(),
        "Stage 1".to_string(),
        vec![boxed],
    )])
}

fn run_engine_with_log(
    maze: &mut Maze<SquareTessellation>,
    seed: u64,
    log: Option<&mut EventLog<QcEvent>>,
) {
    let engine = one_rule_engine();
    let mut rng = MazeRng::seed_from_u64(seed);
    engine.run_full(
        maze,
        &mut rng,
        &PresetState::empty(),
        RepairLimits::default(),
        now_ms_stub,
        log,
        None,
    );
}

// --- exact-sequence test ---

#[test]
fn exact_sequence_on_smallest_deterministic_repair_scenario() {
    let (mut maze, _) = connected_chain_missing_endpoints();
    let mut log = EventLog::new();
    run_engine_with_log(&mut maze, 42, Some(&mut log));
    let tape = log.finish();

    assert!(
        maze.meta.start.is_some() && maze.meta.finish.is_some(),
        "the rule must have actually fixed the maze"
    );

    // Tree shape: root -> "stage stage1" -> "iteration 1", "iteration 2" (convergence, no 3rd
    // pass) -- "iteration 1" -> IterationStarted, "rule g1" -> CheckRan, "strategy
    // random_endpoints" (StartSetProposed + FinishSetProposed), "apply requests" (mutating
    // children only — no dedicated summary event, see check_and_repair_typed's doc comment);
    // "iteration 2" -> IterationStarted, "rule g1" -> CheckRan(issue: None) only (nothing to
    // dispatch, active is empty).
    let root = tape.root();
    let root_children: Vec<_> = root.children().collect();
    assert_eq!(root_children.len(), 1, "exactly one stage scope");
    let NodePayload::Scope(stage_name) = root_children[0].payload() else {
        panic!("expected a scope")
    };
    assert_eq!(stage_name, "stage stage1");

    let stage_children: Vec<_> = root_children[0].children().collect();
    assert_eq!(
        stage_children.len(),
        2,
        "two iterations: one that finds+fixes the issue, one that converges"
    );

    let NodePayload::Scope(iter1_name) = stage_children[0].payload() else {
        panic!("expected a scope")
    };
    assert_eq!(iter1_name, "iteration 1");
    let iter1_children: Vec<_> = stage_children[0].children().collect();
    assert_eq!(
        iter1_children.len(),
        2,
        "IterationStarted event, \"rule g1\" scope"
    );

    assert!(matches!(
        iter1_children[0].payload(),
        NodePayload::Event(QcEvent::IterationStarted(0))
    ));

    let NodePayload::Scope(rule_scope_name) = iter1_children[1].payload() else {
        panic!("expected a scope")
    };
    assert_eq!(rule_scope_name, "rule g1");
    let rule_scope_children: Vec<_> = iter1_children[1].children().collect();
    assert_eq!(
        rule_scope_children.len(),
        3,
        "CheckRan event, \"strategy random_endpoints\" scope, \"apply requests\" scope"
    );

    let NodePayload::Event(QcEvent::CheckRan { check_id, issue }) =
        rule_scope_children[0].payload()
    else {
        panic!("expected CheckRan")
    };
    assert_eq!(
        *check_id, "g1:check1",
        "check_id is the check's composite instance id (GitHub issue #171), not its type id"
    );
    assert!(
        issue.is_some(),
        "the check must have found the missing-endpoints issue"
    );

    let NodePayload::Scope(strategy_scope_name) = rule_scope_children[1].payload() else {
        panic!("expected a scope")
    };
    assert_eq!(strategy_scope_name, "strategy random_endpoints");
    let strategy_scope_children: Vec<_> = rule_scope_children[1].children().collect();
    assert_eq!(
        strategy_scope_children.len(),
        2,
        "StartSetProposed + FinishSetProposed, narrating what the strategy asked for"
    );
    assert!(matches!(
        strategy_scope_children[0].payload(),
        NodePayload::Event(QcEvent::StartSetProposed(_))
    ));
    assert!(matches!(
        strategy_scope_children[1].payload(),
        NodePayload::Event(QcEvent::FinishSetProposed(_))
    ));

    let NodePayload::Scope(apply_scope_name) = rule_scope_children[2].payload() else {
        panic!("expected a scope")
    };
    assert_eq!(apply_scope_name, "apply requests");
    let apply_scope_children: Vec<_> = rule_scope_children[2].children().collect();
    assert_eq!(
        apply_scope_children.len(),
        2,
        "StartSet + FinishSet mutating events, both applied cleanly"
    );
    assert!(matches!(
        apply_scope_children[0].payload(),
        NodePayload::Event(QcEvent::StartSet(_))
    ));
    assert!(matches!(
        apply_scope_children[1].payload(),
        NodePayload::Event(QcEvent::FinishSet(_))
    ));

    // Iteration 2: converges -- the rule finds nothing this time, no strategy scope.
    let NodePayload::Scope(iter2_name) = stage_children[1].payload() else {
        panic!("expected a scope")
    };
    assert_eq!(iter2_name, "iteration 2");
    let iter2_children: Vec<_> = stage_children[1].children().collect();
    assert_eq!(
        iter2_children.len(),
        2,
        "IterationStarted event, \"rule g1\" scope"
    );
    assert!(matches!(
        iter2_children[0].payload(),
        NodePayload::Event(QcEvent::IterationStarted(1))
    ));

    let NodePayload::Scope(rule2_scope_name) = iter2_children[1].payload() else {
        panic!("expected a scope")
    };
    assert_eq!(rule2_scope_name, "rule g1");
    let rule2_scope_children: Vec<_> = iter2_children[1].children().collect();
    assert_eq!(
        rule2_scope_children.len(),
        1,
        "CheckRan event only, no dispatch scope"
    );
    let NodePayload::Event(QcEvent::CheckRan { check_id, issue }) =
        rule2_scope_children[0].payload()
    else {
        panic!("expected CheckRan")
    };
    assert_eq!(
        *check_id, "g1:check1",
        "check_id is the check's composite instance id (GitHub issue #171), not its type id"
    );
    assert!(
        issue.is_none(),
        "the maze is already fixed by iteration 2 -- no issue left to find"
    );
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
    assert_eq!(
        maze_with_log.graph.edges().count(),
        maze_without_log.graph.edges().count()
    );
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
    assert_eq!(
        start_from_events, maze.meta.start,
        "StartSet event must carry the same node id the maze actually ended up with"
    );
    assert_eq!(
        finish_from_events, maze.meta.finish,
        "FinishSet event must carry the same node id the maze actually ended up with"
    );
}

#[test]
fn tree_nesting_only_produces_stage_iteration_rule_and_strategy_scopes() {
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
            name.starts_with("stage ")
                || name.starts_with("iteration ")
                || name.starts_with("rule ")
                || name.starts_with("strategy ")
                || *name == "apply requests",
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
    assert!(
        mutating_count > 0,
        "this scenario must produce at least one mutating event (StartSet/FinishSet)"
    );
}

#[test]
fn issues_merged_is_emitted_when_two_checks_in_the_same_rule_both_contribute() {
    // Two MissingEndpointsCheck instances in the same rule -- both fire on this scenario's
    // unset start/finish, so run_checks_typed must fold them into one merged issue and emit
    // IssuesMerged once. No other test in this file has more than one check per rule (the
    // "known gap" this scenario closes -- see review-tests finding on this file).
    let (mut maze, _) = connected_chain_missing_endpoints();
    let rule: Rule<SquareTessellation, MissingEndpointsIssue> = Rule::new(
        "g1".to_string(),
        vec![
            (
                "check1".to_string(),
                Box::new(MissingEndpointsCheck {
                    instance_id: "check1".to_string(),
                }),
            ),
            (
                "check2".to_string(),
                Box::new(MissingEndpointsCheck {
                    instance_id: "check2".to_string(),
                }),
            ),
        ],
        Some(Box::new(RandomEndpointsStrategy)),
        HashMap::new(),
        vec![],
    );
    let boxed: Box<dyn RuleTrait<SquareTessellation>> = Box::new(rule);
    let engine = QualityControlEngine::new(vec![Stage::new(
        "stage1".to_string(),
        "Stage 1".to_string(),
        vec![boxed],
    )]);

    let mut log = EventLog::new();
    let mut rng = MazeRng::seed_from_u64(42);
    engine.run_full(
        &mut maze,
        &mut rng,
        &PresetState::empty(),
        RepairLimits::default(),
        now_ms_stub,
        Some(&mut log),
        None,
    );
    let tape = log.finish();

    let merged_count = tape
        .iter()
        .filter(|e| matches!(e, QcEvent::IssuesMerged { .. }))
        .count();
    assert_eq!(
        merged_count, 1,
        "exactly one IssuesMerged: both checks contribute on iteration 1, neither does on iteration 2's convergence check"
    );

    let check_ran_count = tape
        .iter()
        .filter(|e| matches!(e, QcEvent::CheckRan { .. }))
        .count();
    assert_eq!(
        check_ran_count, 4,
        "2 checks x 2 iterations (1 that finds+fixes, 1 that converges)"
    );
}

#[test]
fn issues_merged_details_carries_each_contributing_checks_own_detail_values() {
    // Same two-checks-in-one-rule shape as
    // issues_merged_is_emitted_when_two_checks_in_the_same_rule_both_contribute, but each check
    // attaches its own "reason" detail — proves run_checks_typed's merged-issue path
    // (`merged.as_ref().map(|issue| issue.details().clone())`) actually carries real per-check
    // detail values into QcEvent::IssuesMerged, not just that the event fires (GitHub issue #171
    // review finding: this was previously untested at the rule/engine level).
    let (mut maze, _) = connected_chain_missing_endpoints();
    let rule: Rule<SquareTessellation, MissingEndpointsIssue> = Rule::new(
        "g1".to_string(),
        vec![
            (
                "check1".to_string(),
                Box::new(MissingEndpointsCheckWithDetail {
                    instance_id: "g1:check1".to_string(),
                    reason: "no start",
                }),
            ),
            (
                "check2".to_string(),
                Box::new(MissingEndpointsCheckWithDetail {
                    instance_id: "g1:check2".to_string(),
                    reason: "no finish",
                }),
            ),
        ],
        Some(Box::new(RandomEndpointsStrategy)),
        HashMap::new(),
        vec![],
    );
    let boxed: Box<dyn RuleTrait<SquareTessellation>> = Box::new(rule);
    let engine = QualityControlEngine::new(vec![Stage::new(
        "stage1".to_string(),
        "Stage 1".to_string(),
        vec![boxed],
    )]);

    let mut log = EventLog::new();
    let mut rng = MazeRng::seed_from_u64(42);
    engine.run_full(
        &mut maze,
        &mut rng,
        &PresetState::empty(),
        RepairLimits::default(),
        now_ms_stub,
        Some(&mut log),
        None,
    );
    let tape = log.finish();

    let merged: Vec<&QcEvent> = tape
        .iter()
        .filter(|e| matches!(e, QcEvent::IssuesMerged { .. }))
        .collect();
    assert_eq!(merged.len(), 1);
    let QcEvent::IssuesMerged { details, .. } = merged[0] else {
        panic!("filtered to IssuesMerged above")
    };

    assert_eq!(
        details.get("g1:check1").and_then(|kv| kv.get("reason")),
        Some(&"no start".to_string()),
        "check1's own detail must survive the merge, keyed by its own instance id",
    );
    assert_eq!(
        details.get("g1:check2").and_then(|kv| kv.get("reason")),
        Some(&"no finish".to_string()),
        "check2's own detail must survive the merge too, not be overwritten by check1's",
    );
}

#[test]
fn check_ran_payload_is_resolved_before_this_rules_own_dispatch_in_the_same_iteration() {
    // MissingEndpointsIssue always resolves to IssuePayload::None (no structural edge/node data —
    // see issue_payload.rs), so this test only asserts the ordering invariant itself: CheckRan
    // for a given rule always appears before that same rule's own dispatch (StartSet/FinishSet,
    // this scenario's only mutating events) within one iteration scope, never after.
    let (mut maze, _) = connected_chain_missing_endpoints();
    let mut log = EventLog::new();
    run_engine_with_log(&mut maze, 42, Some(&mut log));
    let tape = log.finish();

    // Flatten in emission order via iter(), which is DFS pre-order == emission order.
    let ordered_tags: Vec<&str> = tape
        .iter()
        .map(|e| match e {
            QcEvent::CheckRan { .. } => "CheckRan",
            QcEvent::StartSet(_) | QcEvent::FinishSet(_) => "Dispatched",
            _ => "other",
        })
        .filter(|t| *t != "other")
        .collect();

    // Iteration 1: CheckRan (finds the issue) then the dispatch's own mutating events (fixes it).
    // Iteration 2: one more CheckRan (convergence check, finds nothing, never dispatched).
    assert_eq!(
        ordered_tags,
        vec!["CheckRan", "Dispatched", "Dispatched", "CheckRan"],
        "CheckRan must precede this rule's own dispatch, never follow it",
    );
}
