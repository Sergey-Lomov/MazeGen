use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use maze_core::{Graph, IdGenerator, Maze};
use maze_core::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationAlgorithm, ElementsConfig, GenerationConfig, PresetState, pipeline::{build_maze, RepairLimits}};
use maze_core::graph::EdgeKind;
use maze_core::quality_control::{
    QualityControlEngine, Rule, RuleTrait, Stage, Check,
    MissingEndpointsCheck, LoopLengthCheck, Comparison, CycleKind,
    MissingEndpointsIssue, InvalidLoopIssue, InvalidLoopRequirement, RepairLimitReachedIssue,
    RepairLimitKind,
};
use maze_core::repair::{RepairStrategy, FarthestEndpointsStrategy, RandomEndpointsStrategy, InvalidLoopRandomStrategy, StrategyParams, MutationCommand};

#[path = "pipeline_common/mod.rs"]
mod pipeline_common;
use pipeline_common::*;

#[test]
fn pipeline_assigns_start_and_finish() {
    let (field, graph) = make_generated_graph(42);
    let qc = make_engines();
    let (maze, warnings, _timing) = build_maze(field, graph, 42, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings.iter().map(|i| i.kind()).collect::<Vec<_>>());
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.start, maze.meta.finish);
}

/// Issue #86 regression at the `build_maze` level: a preset start must be seeded onto
/// `maze.meta` *before* the repair loop runs, so `FarthestEndpointsStrategy` sees it as already
/// resolved (its `(Some(start), None)` branch) instead of running its `(None, None)` branch and
/// picking its own random start — which would then get silently overwritten by the preset start
/// after the fact, leaving a finish that was never actually farthest from it.
#[test]
fn preset_start_is_honored_by_farthest_endpoints_before_repair_runs() {
    let (field, graph) = make_generated_graph(42);
    let preset_start = field.nodes_at(field.single_level_id(), SquarePoint { x: 4, y: 4 }).first().copied().unwrap();
    let qc = engine_with_rule(
        vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }))],
        Box::new(FarthestEndpointsStrategy),
    );

    let (maze, warnings, _timing) = build_maze(
        field, graph, 42, qc, &PresetState::empty(), RepairLimits::default(),
        Some(preset_start), None, None, None,
    );

    assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings.iter().map(|i| i.kind()).collect::<Vec<_>>());
    assert_eq!(maze.meta.start, Some(preset_start), "preset start must survive repair unchanged");
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.finish, Some(preset_start));
}

#[test]
fn pipeline_deterministic() {
    let seed = 77u64;
    let run = || {
        let (field, graph) = make_generated_graph(seed);
        let qc = make_engines();
        let (maze, _, _timing) = build_maze(field, graph, seed, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
        (maze.meta.start, maze.meta.finish)
    };
    let (s1, f1) = run();
    let (s2, f2) = run();
    assert_eq!(s1, s2);
    assert_eq!(f1, f2);
}

#[test]
fn pipeline_warns_when_no_strategy_for_issue() {
    let (field, graph) = make_generated_graph(1);
    let rule = Rule::new(
        "g".to_string(),
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        None, HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![Box::new(rule) as Box<dyn RuleTrait<SquareTessellation>>])]);
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(!warnings.is_empty());
}

/// Regression: a no-strategy ("no_fix") rule whose check keeps finding an issue every iteration
/// must not keep the stage's fixpoint loop spinning — `check_and_dispatch`'s `NoStrategy` outcome
/// must not count toward convergence, since a rule with no strategy can never make progress no
/// matter how many more iterations run (matches the pre-#170 behavior, where such a rule was
/// filtered out of `active` before the convergence check ran at all). Without this, the loop only
/// stops via `RepairLimits`, silently degrading performance and misreporting a spurious
/// `RepairLimitReachedIssue` for a stage that should have converged immediately.
#[test]
fn no_strategy_rule_with_always_found_issue_does_not_block_convergence() {
    struct AlwaysIssueNoOpCheck {
        calls: Arc<AtomicUsize>,
    }
    impl Check<SquareTessellation, MissingEndpointsIssue> for AlwaysIssueNoOpCheck {
        fn check_type_id(&self) -> &'static str { "always_issue_logging_only" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<MissingEndpointsIssue>, _rng: &mut dyn rand::RngCore, _requirement: ()) {
            self.calls.fetch_add(1, Ordering::SeqCst);
            issues.push(MissingEndpointsIssue::new_from_check("always_issue_logging_only", true, true));
        }
    }

    let (field, graph) = make_generated_graph(1);
    let calls = Arc::new(AtomicUsize::new(0));
    let logging_rule = Rule::new(
        "g_logging".to_string(),
        vec![("always_issue_logging_only".to_string(), Box::new(AlwaysIssueNoOpCheck { calls: Arc::clone(&calls) }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
        None, HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![Box::new(logging_rule) as Box<dyn RuleTrait<SquareTessellation>>])]);

    let (_, _warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);

    // 2, not 1: one fixpoint-loop pass (which must converge immediately) plus the unconditional
    // final report pass every `run_full` call makes regardless of how the stage sequence ended
    // (`collect_final_report`, `RuleTrait::report_checks`) — see GitHub issue #102. If the
    // no-strategy rule's ever-present issue kept the fixpoint loop spinning, this would instead
    // read `RepairLimits::default()`'s `MAX_REPAIR_ITERATIONS` (100) plus 1.
    assert_eq!(calls.load(Ordering::SeqCst), 2,
        "stage must converge after a single fixpoint iteration — a no-strategy rule's ever-present issue must not keep the loop running until RepairLimits' cap");
}

#[test]
fn pipeline_warns_when_strategy_always_fails() {
    use maze_core::repair::{RepairResult, RepairStrategy};
    use maze_core::Maze;
    use rand::RngCore;

    struct AlwaysFail;
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for AlwaysFail {
        fn strategy_id(&self) -> &'static str { "always_fail" }

        fn apply(&self, _: &MissingEndpointsIssue, _: &Maze<SquareTessellation>, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            (RepairResult::Failed, vec![])
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = engine_with_rule(
        vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }))],
        Box::new(AlwaysFail),
    );
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(!warnings.is_empty());
}

#[test]
fn pipeline_stops_at_max_iterations_cap() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&call_count);
    let (field, graph, qc) = never_converging_setup(move || { counter.fetch_add(1, Ordering::SeqCst); });

    let limits = RepairLimits::new(Some(3), None).unwrap();
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None, None, None);
    assert_eq!(call_count.load(Ordering::SeqCst), 3, "strategy must be called exactly max_iterations times");
    assert!(!warnings.is_empty(), "issue is still unresolved after the cap stops the loop early");
    let limit_issue = warnings.iter().find_map(|i| as_issue::<RepairLimitReachedIssue>(i.as_ref())).expect("must surface a RepairLimitReachedIssue");
    assert_eq!(limit_issue.limit, RepairLimitKind::MaxIterations);
}

#[test]
fn pipeline_stops_at_time_budget() {
    use std::thread::sleep;
    use std::time::Duration;

    let call_count = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&call_count);
    let (field, graph, qc) = never_converging_setup(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        sleep(Duration::from_millis(20));
    });

    let limits = RepairLimits::new(None, Some(0.05)).unwrap();
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None, None, None);
    let calls = call_count.load(Ordering::SeqCst);
    assert!(calls >= 1, "at least one iteration should run before the budget is exhausted");
    assert!(calls < 20, "time budget must stop the loop well before an unbounded run would (got {calls} calls)");
    assert!(!warnings.is_empty(), "issue is still unresolved after the budget stops the loop early");
    let limit_issue = warnings.iter().find_map(|i| as_issue::<RepairLimitReachedIssue>(i.as_ref())).expect("must surface a RepairLimitReachedIssue");
    assert_eq!(limit_issue.limit, RepairLimitKind::TimeBudget);
}

#[test]
fn pipeline_merges_issues_from_duplicate_checks_into_one_strategy_call() {
    // Two checks producing the same (data-less) kind merge into one issue — the strategy
    // is still called exactly once.
    use maze_core::repair::{RepairResult, RepairStrategy};
    use maze_core::Maze;
    use rand::RngCore;

    let call_count = Arc::new(AtomicUsize::new(0));

    struct CountingStrategy {
        count: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation, MissingEndpointsIssue> for CountingStrategy {
        fn strategy_id(&self) -> &'static str { "counting_strategy" }

        fn apply(&self, _: &MissingEndpointsIssue, maze: &Maze<SquareTessellation>, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> (RepairResult, Vec<MutationCommand>) {
            self.count.fetch_add(1, Ordering::SeqCst);
            let mut nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
            nodes.sort_unstable();
            let mut commands = Vec::new();
            if let Some(&first) = nodes.first() { commands.push(MutationCommand::SetStart(first)); }
            if let Some(&last) = nodes.last() { commands.push(MutationCommand::SetFinish(last)); }
            (RepairResult::Fixed { score: None }, commands)
        }
    }

    let (field, graph) = make_generated_graph(1);
    let checks: Vec<(&str, BoxedCheck<SquareTessellation, MissingEndpointsIssue>)> = vec![
        ("a", Box::new(MissingEndpointsCheck { instance_id: "g:a".to_string() })),
        ("b", Box::new(MissingEndpointsCheck { instance_id: "g:b".to_string() })),
    ];
    let qc = engine_with_rule(checks, Box::new(CountingStrategy { count: Arc::clone(&call_count) }));

    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings.iter().map(|i| i.kind()).collect::<Vec<_>>());
    assert_eq!(call_count.load(Ordering::SeqCst), 1, "strategy called more than once for duplicate issue");
}

#[test]
fn pipeline_breaks_short_loop_via_min_loop_length() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let nodes: Vec<_> = field.field_of(field.single_level_id()).unwrap().all_points().map(|p| field.nodes_at(field.single_level_id(), p).first().copied().unwrap()).collect();
    graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    graph.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
    graph.build_initial_edge(nodes[2], nodes[0], EdgeKind::Basic);

    let qc = two_rules(
        (vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation, MissingEndpointsIssue>)],
         Box::new(FarthestEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation, MissingEndpointsIssue>>),
        (vec![("min_loop_length", Box::new(LoopLengthCheck { instance_id: "gb:min_loop_length".to_string(), comparison: Comparison::Lt, length: 10, cycle_kind: CycleKind::Any }))],
         Box::new(InvalidLoopRandomStrategy) as Box<dyn RepairStrategy<SquareTessellation, InvalidLoopIssue>>),
    );

    let (_, remaining, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);
    assert!(!remaining.iter().any(|i| as_issue::<InvalidLoopIssue>(i.as_ref()).is_some()),
        "short loop must be resolved by the pipeline: {:?}", remaining.iter().map(|i| i.kind()).collect::<Vec<_>>());
}

#[test]
fn pipeline_merges_invalid_loop_from_two_independent_checks_and_breaks_both_cycles() {
    // Two checks unrelated to MinLoopLengthCheck's real cycle search — each hardcodes its own
    // cycle into an InvalidLoopIssue, simulating "two different reasons a cycle can be flagged
    // invalid" (the scenario this whole pipeline-merge change exists for) without needing a real
    // second check (e.g. max-loop-length) or touching the cycles/scoring layer. Two disjoint
    // triangles sharing no edge, so each check's cycle is independently verifiable as broken
    // afterward.
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field.single_level_id()).unwrap().all_points().map(|p| field.nodes_at(field.single_level_id(), p).first().copied().unwrap()).collect();
    // Triangle A: 0->1->2->0
    let e0 = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e1 = g.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
    let e2 = g.build_initial_edge(nodes[2], nodes[0], EdgeKind::Basic);
    // Triangle B: 3->4->5->3
    let e3 = g.build_initial_edge(nodes[3], nodes[4], EdgeKind::Basic);
    let e4 = g.build_initial_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let e5 = g.build_initial_edge(nodes[5], nodes[3], EdgeKind::Basic);

    struct FakeInvalidLoopCheck {
        cycle: Vec<usize>,
        source_check: &'static str,
    }
    impl Check<SquareTessellation, InvalidLoopIssue> for FakeInvalidLoopCheck {
        fn check_type_id(&self) -> &'static str { "fake_invalid_loop_check" }

        fn repair_check(&self, maze: &Maze<SquareTessellation>, issues: &mut Vec<InvalidLoopIssue>, _rng: &mut dyn rand::RngCore, _requirement: InvalidLoopRequirement) {
            // Real checks recompute from current graph state — this fake one must too, or it
            // would keep reporting an already-broken cycle as invalid forever, masking real
            // pipeline behavior (fixpoint exit) behind a check that never reflects the repair.
            if self.cycle.iter().all(|&eid| maze.graph.edge(eid).is_some()) {
                let mut invalid_sources = HashMap::new();
                invalid_sources.insert({
                    let mut key = self.cycle.clone();
                    key.sort_unstable();
                    key
                }, vec![self.source_check.to_string()]);
                issues.push(InvalidLoopIssue::new_from_check(
                    self.source_check,
                    vec![self.cycle.clone()], vec![0], invalid_sources,
                ));
            }
        }
    }

    let checks: Vec<(&str, BoxedCheck<SquareTessellation, InvalidLoopIssue>)> = vec![
        ("missing_endpoints", Box::new(FakeInvalidLoopCheck { cycle: vec![e0, e1, e2], source_check: "missing_endpoints" })),
        ("unreachable_finish", Box::new(FakeInvalidLoopCheck { cycle: vec![e3, e4, e5], source_check: "unreachable_finish" })),
    ];
    let qc = engine_with_rule(checks, Box::new(InvalidLoopRandomStrategy));

    let (maze, remaining, _timing) = build_maze(field, g, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);

    assert!(!remaining.iter().any(|i| as_issue::<InvalidLoopIssue>(i.as_ref()).is_some()),
        "both checks' issues must be merged into one and resolved in a single repair call: {:?}", remaining.iter().map(|i| i.kind()).collect::<Vec<_>>());
    // Both triangles must have lost exactly one edge each — proof the strategy received both
    // checks' cycles via the merged issue, not just the first one's.
    let triangle_a_intact = g_edge_present(&maze, e0) && g_edge_present(&maze, e1) && g_edge_present(&maze, e2);
    let triangle_b_intact = g_edge_present(&maze, e3) && g_edge_present(&maze, e4) && g_edge_present(&maze, e5);
    assert!(!triangle_a_intact, "triangle A (from fake_a) must have been broken");
    assert!(!triangle_b_intact, "triangle B (from fake_b) must have been broken");

    fn g_edge_present(maze: &Maze<SquareTessellation>, id: usize) -> bool {
        maze.graph.edge(id).is_some()
    }
}

#[test]
fn pipeline_does_not_false_stop_when_same_rule_reports_different_content_each_iteration() {
    // Regression for #27: a check that produces the same rule (same Issue kind, same source
    // check id) on two consecutive iterations, but with genuinely different cycle data each
    // time (cycle A is gone after iteration 1, only cycle B remains). The old rule-id-only
    // fingerprint saw "InvalidLoopIssue active" both times and falsely declared no progress,
    // stopping before cycle B was ever repaired. The content-aware guard must tell these
    // apart and keep going.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(6, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() { g.add_node(node); }
    let nodes: Vec<_> = field.field_of(field.single_level_id()).unwrap().all_points().map(|p| field.nodes_at(field.single_level_id(), p).first().copied().unwrap()).collect();
    // Triangle A: 0->1->2->0
    let e0 = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e1 = g.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
    let e2 = g.build_initial_edge(nodes[2], nodes[0], EdgeKind::Basic);
    // Triangle B: 3->4->5->3
    let e3 = g.build_initial_edge(nodes[3], nodes[4], EdgeKind::Basic);
    let e4 = g.build_initial_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let e5 = g.build_initial_edge(nodes[5], nodes[3], EdgeKind::Basic);

    // Reports triangle A while it's intact; once A is broken, reports triangle B instead —
    // same source check both times, different cycle content.
    struct AlternatingInvalidLoopCheck {
        triangle_a: Vec<usize>,
        triangle_b: Vec<usize>,
    }
    impl Check<SquareTessellation, InvalidLoopIssue> for AlternatingInvalidLoopCheck {
        fn check_type_id(&self) -> &'static str { "alternating_invalid_loop_check" }

        fn repair_check(&self, maze: &Maze<SquareTessellation>, issues: &mut Vec<InvalidLoopIssue>, _rng: &mut dyn rand::RngCore, _requirement: InvalidLoopRequirement) {
            let cycle = if self.triangle_a.iter().all(|&eid| maze.graph.edge(eid).is_some()) {
                &self.triangle_a
            } else if self.triangle_b.iter().all(|&eid| maze.graph.edge(eid).is_some()) {
                &self.triangle_b
            } else {
                return;
            };
            let mut invalid_sources = HashMap::new();
            let mut key = cycle.clone();
            key.sort_unstable();
            invalid_sources.insert(key, vec!["missing_endpoints".to_string()]);
            issues.push(InvalidLoopIssue::new_from_check(
                "missing_endpoints",
                vec![cycle.clone()], vec![0], invalid_sources,
            ));
        }
    }

    let qc = engine_with_rule(
        vec![("missing_endpoints", Box::new(AlternatingInvalidLoopCheck { triangle_a: vec![e0, e1, e2], triangle_b: vec![e3, e4, e5] }) as BoxedCheck<SquareTessellation, InvalidLoopIssue>)],
        Box::new(InvalidLoopRandomStrategy),
    );

    let (maze, remaining, _timing) = build_maze(field, g, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None, None, None);

    assert!(!remaining.iter().any(|i| as_issue::<InvalidLoopIssue>(i.as_ref()).is_some()),
        "both triangles must be resolved across iterations, not falsely stopped after the first: {:?}", remaining.iter().map(|i| i.kind()).collect::<Vec<_>>());
    let triangle_a_intact = maze.graph.edge(e0).is_some() && maze.graph.edge(e1).is_some() && maze.graph.edge(e2).is_some();
    let triangle_b_intact = maze.graph.edge(e3).is_some() && maze.graph.edge(e4).is_some() && maze.graph.edge(e5).is_some();
    assert!(!triangle_a_intact, "triangle A must have been broken on iteration 1");
    assert!(!triangle_b_intact, "triangle B must have been broken on a later iteration, not skipped by a false oscillation stop");
}
