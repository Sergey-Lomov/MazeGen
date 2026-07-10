use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use maze_core::{Graph, IdGenerator, Maze};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationAlgorithm, EdgeBasedParams, ElementsConfig, GenerationConfig, PresetState, pipeline::{build_maze, RepairLimits}};
use maze_core::graph::EdgeKind;
use maze_core::quality_control::{QualityControlEngine, Check, Issue, IssueData, IssueKind, MissingEndpointsCheck, UnreachableFinishCheck, MinLoopLengthCheck, MISSING_ENDPOINTS, INVALID_LOOP, REPAIR_LIMIT_REACHED, RepairLimitKind};
use maze_core::repair::{QcRule, RepairEngine, RepairRuleConfig, RepairStage, RepairStrategy, FarthestEndpointsStrategy, RandomEndpointsStrategy, InvalidLoopRandomStrategy, StrategyParams, SnapshotStack};

/// Builds a single-rule `RepairEngine`: one rule containing all of `checks`, sharing `kind`,
/// dispatching to `strategy`. Covers the common single-strategy-per-kind test shape without
/// repeating the `RepairRuleConfig`/`QcRule` boilerplate at every call site. Puts the rule in a
/// single default stage so it dispatches under the staged pipeline exactly like the pre-#65
/// single-loop pipeline did.
fn engine_with_rule<T: maze_core::space::Tessellation>(
    kind: IssueKind,
    checks: &[&str],
    strategy: Box<dyn RepairStrategy<T>>,
) -> RepairEngine<T> {
    let checks: Vec<String> = checks.iter().map(|s| s.to_string()).collect();
    let rule = QcRule { id: "g".to_string(), kind, checks: checks.clone() };
    RepairEngine::new(
        vec![RepairRuleConfig { rule: QcRule { id: "g".to_string(), kind, checks: checks.clone() }, strategy, param_overrides: HashMap::new(), nested: vec![] }],
        vec![rule],
        vec![RepairStage { id: "stage_1".to_string(), name: "Stage 1".to_string(), rule_ids: vec!["g".to_string()] }],
    )
}

/// Builds a `RepairEngine` with two independent single-check rules, each with its own strategy,
/// both in the same single default stage (same rationale as `engine_with_rule`).
fn two_rules<T: maze_core::space::Tessellation>(
    a: (IssueKind, &[&str], Box<dyn RepairStrategy<T>>),
    b: (IssueKind, &[&str], Box<dyn RepairStrategy<T>>),
) -> RepairEngine<T> {
    let (kind_a, checks_a, strategy_a) = a;
    let (kind_b, checks_b, strategy_b) = b;
    let checks_a: Vec<String> = checks_a.iter().map(|s| s.to_string()).collect();
    let checks_b: Vec<String> = checks_b.iter().map(|s| s.to_string()).collect();
    let rule_a = QcRule { id: "ga".to_string(), kind: kind_a, checks: checks_a.clone() };
    let rule_b = QcRule { id: "gb".to_string(), kind: kind_b, checks: checks_b.clone() };
    RepairEngine::new(
        vec![
            RepairRuleConfig { rule: QcRule { id: "ga".to_string(), kind: kind_a, checks: checks_a.clone() }, strategy: strategy_a, param_overrides: HashMap::new(), nested: vec![] },
            RepairRuleConfig { rule: QcRule { id: "gb".to_string(), kind: kind_b, checks: checks_b.clone() }, strategy: strategy_b, param_overrides: HashMap::new(), nested: vec![] },
        ],
        vec![rule_a, rule_b],
        vec![RepairStage { id: "stage_1".to_string(), name: "Stage 1".to_string(), rule_ids: vec!["ga".to_string(), "gb".to_string()] }],
    )
}

fn make_engines() -> (QualityControlEngine<SquareTessellation>, RepairEngine<SquareTessellation>) {
    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
        Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() }),
    ]);
    let repair = engine_with_rule(MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(FarthestEndpointsStrategy));
    (qc, repair)
}

fn make_generated_graph(seed: u64) -> (Field<SquareTessellation>, Graph) {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(5, 5), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    generate_maze(&mut graph, &field, seed, start, GenerationConfig::default(), &PresetState::empty());
    (field, graph)
}

#[test]
fn pipeline_assigns_start_and_finish() {
    let (field, graph) = make_generated_graph(42);
    let (qc, repair) = make_engines();
    let (maze, warnings, _timing) = build_maze(field, graph, 42, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings);
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
    let preset_start = field.node_at(SquarePoint { x: 4, y: 4 }).unwrap();
    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
    ]);
    let repair = engine_with_rule(MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(FarthestEndpointsStrategy));

    let (maze, warnings, _timing) = build_maze(
        field, graph, 42, qc, repair, &PresetState::empty(), RepairLimits::default(),
        Some(preset_start), None,
    );

    assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings);
    assert_eq!(maze.meta.start, Some(preset_start), "preset start must survive repair unchanged");
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.finish, Some(preset_start));
}

#[test]
fn pipeline_deterministic() {
    let seed = 77u64;
    let run = || {
        let (field, graph) = make_generated_graph(seed);
        let (qc, repair) = make_engines();
        let (maze, _, _timing) = build_maze(field, graph, seed, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
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
    let qc = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() })]);
    let repair: RepairEngine<SquareTessellation> = RepairEngine::new(vec![], vec![], vec![]);
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(!warnings.is_empty());
}

#[test]
fn pipeline_warns_when_strategy_always_fails() {
    use maze_core::quality_control::Issue;
    use maze_core::repair::{RepairResult, RepairStrategy};
    use maze_core::Maze;
    use rand::RngCore;

    struct AlwaysFail;
    impl RepairStrategy<SquareTessellation> for AlwaysFail {
        fn strategy_id(&self) -> &'static str { "always_fail" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            RepairResult::Failed
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() })]);
    let repair = engine_with_rule(MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(AlwaysFail));
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(!warnings.is_empty());
}

/// A `Check` that always reports the same `MISSING_ENDPOINTS`-kind issue but with a `detail`
/// value that flips every call (via a shared counter) — so the raw `Issue` (and, after merge,
/// the `(rule_id, Issue)` pair the progress guard compares) genuinely differs iteration to
/// iteration, never triggering the no-progress break. Paired with a strategy that always
/// returns `Fixed` without resolving anything, the loop only ever stops via `RepairLimits`,
/// never convergence or no-progress — letting `pipeline_stops_at_max_iterations_cap` and
/// `pipeline_stops_at_time_budget` below exercise the cap in isolation.
struct NeverConvergingCheck {
    counter: Arc<AtomicUsize>,
}
impl maze_core::quality_control::Check<SquareTessellation> for NeverConvergingCheck {
    fn check_type_id(&self) -> &'static str { "never_converging_check" }

    fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        issues.push(
            Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints")
                .with_detail("missing_endpoints", "tick", n.to_string()),
        );
    }
}

fn never_converging_setup(
    on_apply: impl Fn() + Send + Sync + 'static,
) -> (Field<SquareTessellation>, Graph, QualityControlEngine<SquareTessellation>, RepairEngine<SquareTessellation>) {
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct NoOpFix<F> {
        on_apply: F,
    }
    impl<F: Fn() + Send + Sync> RepairStrategy<SquareTessellation> for NoOpFix<F> {
        fn strategy_id(&self) -> &'static str { "no_op_fix" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            (self.on_apply)();
            RepairResult::Fixed { score: None }
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![Box::new(NeverConvergingCheck { counter: Arc::new(AtomicUsize::new(0)) })]);
    let repair = engine_with_rule(MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(NoOpFix { on_apply }));
    (field, graph, qc, repair)
}

#[test]
fn pipeline_stops_at_max_iterations_cap() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&call_count);
    let (field, graph, qc, repair) = never_converging_setup(move || { counter.fetch_add(1, Ordering::SeqCst); });

    let limits = RepairLimits { max_iterations: Some(3), time_budget_secs: None };
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), limits, None, None);
    assert_eq!(call_count.load(Ordering::SeqCst), 3, "strategy must be called exactly max_iterations times");
    assert!(!warnings.is_empty(), "issue is still unresolved after the cap stops the loop early");
    let limit_issue = warnings.iter().find(|i| i.kind == REPAIR_LIMIT_REACHED).expect("must surface a REPAIR_LIMIT_REACHED issue");
    assert_eq!(limit_issue.data, Some(IssueData::RepairLimitReached { limit: RepairLimitKind::MaxIterations }));
}

#[test]
fn pipeline_stops_at_time_budget() {
    use std::thread::sleep;
    use std::time::Duration;

    let call_count = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&call_count);
    let (field, graph, qc, repair) = never_converging_setup(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        sleep(Duration::from_millis(20));
    });

    let limits = RepairLimits { max_iterations: None, time_budget_secs: Some(0.05) };
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), limits, None, None);
    let calls = call_count.load(Ordering::SeqCst);
    assert!(calls >= 1, "at least one iteration should run before the budget is exhausted");
    assert!(calls < 20, "time budget must stop the loop well before an unbounded run would (got {calls} calls)");
    assert!(!warnings.is_empty(), "issue is still unresolved after the budget stops the loop early");
    let limit_issue = warnings.iter().find(|i| i.kind == REPAIR_LIMIT_REACHED).expect("must surface a REPAIR_LIMIT_REACHED issue");
    assert_eq!(limit_issue.data, Some(IssueData::RepairLimitReached { limit: RepairLimitKind::TimeBudget }));
}

#[test]
fn pipeline_surfaces_qc_no_progress_with_stuck_rule_id() {
    use maze_core::quality_control::{Issue, QC_NO_PROGRESS};
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct AlwaysSameIssueCheck;
    impl maze_core::quality_control::Check<SquareTessellation> for AlwaysSameIssueCheck {
        fn check_type_id(&self) -> &'static str { "always_same_issue_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            issues.push(Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints"));
        }
    }
    struct NoOpFix;
    impl RepairStrategy<SquareTessellation> for NoOpFix {
        fn strategy_id(&self) -> &'static str { "no_op_fix" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            RepairResult::Fixed { score: None }
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![Box::new(AlwaysSameIssueCheck)]);
    let repair = engine_with_rule(MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(NoOpFix));
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);

    let issue = warnings.iter().find(|i| i.kind == QC_NO_PROGRESS).expect("must surface a QC_NO_PROGRESS issue");
    match &issue.data {
        Some(IssueData::QcNoProgress { rule_ids }) => assert_eq!(rule_ids, &vec!["g".to_string()]),
        other => panic!("expected QcNoProgress, got {other:?}"),
    }
}

#[test]
fn pipeline_merges_issues_from_duplicate_checks_into_one_strategy_call() {
    // Two checks producing the same (data-less) kind merge into one issue — the strategy
    // is still called exactly once. See pipeline.rs::merge_issue for the merge rule when
    // checks produce different IssueData for the same kind.
    use maze_core::quality_control::Issue;
    use maze_core::repair::{RepairResult, RepairStrategy};
    use maze_core::Maze;
    use rand::RngCore;

    let call_count = Arc::new(AtomicUsize::new(0));

    struct CountingStrategy {
        count: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation> for CountingStrategy {
        fn strategy_id(&self) -> &'static str { "counting_strategy" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, maze: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            self.count.fetch_add(1, Ordering::SeqCst);
            let mut nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
            nodes.sort_unstable();
            maze.meta.start = nodes.first().copied();
            maze.meta.finish = nodes.last().copied();
            RepairResult::Fixed { score: None }
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
    ]);
    let repair = engine_with_rule(MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(CountingStrategy { count: Arc::clone(&call_count) }));

    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings);
    assert_eq!(call_count.load(Ordering::SeqCst), 1, "strategy called more than once for duplicate issue");
}

#[test]
fn pipeline_breaks_short_loop_via_min_loop_length() {
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(3, 1), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    graph.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    graph.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
    graph.build_initial_edge(nodes[2], nodes[0], EdgeKind::Basic);

    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
        Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() }),
        Box::new(MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 }),
    ]);
    let repair = two_rules(
        (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(FarthestEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
        (INVALID_LOOP, &["min_loop_length"], Box::new(InvalidLoopRandomStrategy)),
    );

    let (_, remaining, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(!remaining.iter().any(|i| i.kind == INVALID_LOOP),
        "short loop must be resolved by the pipeline: {:?}", remaining);
}

#[test]
fn full_pipeline_with_min_loop_length_never_isolates_a_node() {
    // Exact repro config from issue #23's attached maze-project.json: 11x11 square,
    // custom_edge_based generation, cyclicity=0.8, one_way_chance=0.04, min_loop_length=10
    // repaired by the random strategy, missing_endpoints repaired by RANDOM (not farthest)
    // endpoints, no presets, debugMode=false (this is the non-debug path). Across many seeds,
    // no repair iteration should ever leave a node with zero edges.
    for seed in 0..200u64 {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(11, 11), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let start = field.node_at(SquarePoint { x: 5, y: 5 }).unwrap();

        let gen_config = GenerationConfig {
            algorithm: GenerationAlgorithm::CustomEdgeBased(EdgeBasedParams {
                corridor_length: 0.5,
                branching: 0.5,
                depth_first: 0.5,
                directionality: 0.0,
                cyclicity: 0.8,
            }),
            elements: ElementsConfig { one_way_chance: 0.04, teleport_chance: 0.0, teleport_one_way_chance: 0.0 },
            preset_connections: vec![],
            locked_nodes: vec![],
        };
        generate_maze(&mut graph, &field, seed, start, gen_config, &PresetState::empty());

        let qc = QualityControlEngine::new(vec![
            Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
            Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() }),
            Box::new(MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 }),
        ]);
        let repair = two_rules(
            (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(RandomEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
            (INVALID_LOOP, &["min_loop_length"], Box::new(InvalidLoopRandomStrategy)),
        );

        let (maze, _, _timing) = build_maze(field, graph, seed, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);

        for node in maze.graph.nodes() {
            let degree = maze.graph.edges().filter(|e| e.from == node.id || e.to == node.id).count();
            assert!(degree > 0, "seed {seed}: node {} was fully cut off from the graph", node.id);
        }
    }
}

#[test]
fn exact_issue_23_seed_never_isolates_a_node() {
    let seed = 292118u64;
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(11, 11), &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    // UI picks the field's centroid as generation start (see tessellation_dispatch::pick_start),
    // not (0,0) — for an 11x11 square field (coords 0..10) that's (5,5).
    let start = field.node_at(SquarePoint { x: 5, y: 5 }).unwrap();

    let gen_config = GenerationConfig {
        algorithm: GenerationAlgorithm::CustomEdgeBased(EdgeBasedParams {
            corridor_length: 0.5,
            branching: 0.5,
            depth_first: 0.5,
            directionality: 0.0,
            cyclicity: 0.8,
        }),
        elements: ElementsConfig { one_way_chance: 0.04, teleport_chance: 0.0, teleport_one_way_chance: 0.0 },
        preset_connections: vec![],
        locked_nodes: vec![],
    };
    generate_maze(&mut graph, &field, seed, start, gen_config, &PresetState::empty());

    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
        Box::new(UnreachableFinishCheck { instance_id: "unreachable_finish".to_string() }),
        Box::new(MinLoopLengthCheck { instance_id: "min_loop_length".to_string(), min_loop_length: 10 }),
    ]);
    let repair = two_rules(
        (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(RandomEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
        (INVALID_LOOP, &["min_loop_length"], Box::new(InvalidLoopRandomStrategy)),
    );

    let (maze, _, _timing) = build_maze(field, graph, seed, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);

    for node in maze.graph.nodes() {
        let degree = maze.graph.edges().filter(|e| e.from == node.id || e.to == node.id).count();
        assert!(degree > 0, "node {} was fully cut off from the graph", node.id);
    }
}

#[test]
fn pipeline_merges_invalid_loop_from_two_independent_checks_and_breaks_both_cycles() {
    // Two checks unrelated to MinLoopLengthCheck's real cycle search — each hardcodes its own
    // cycle into IssueData::InvalidLoops, simulating "two different reasons a cycle can be
    // flagged invalid" (the scenario this whole pipeline-merge change exists for) without
    // needing a real second check (e.g. max-loop-length) or touching the cycles/scoring layer.
    // Two disjoint triangles sharing no edge, so each check's cycle is independently verifiable
    // as broken afterward.
    let mut ids = IdGenerator::new();
    let field = Field::new(square_rect(6, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
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
    impl<T: maze_core::space::Tessellation> Check<T> for FakeInvalidLoopCheck {
        fn check_type_id(&self) -> &'static str { "fake_invalid_loop_check" }

        fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
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
                issues.push(Issue::with_data_from_check(
                    INVALID_LOOP,
                    IssueData::InvalidLoops { all: vec![self.cycle.clone()], invalid: vec![0], invalid_sources },
                    self.source_check,
                ));
            }
        }
    }

    let qc = QualityControlEngine::new(vec![
        Box::new(FakeInvalidLoopCheck { cycle: vec![e0, e1, e2], source_check: "missing_endpoints" }),
        Box::new(FakeInvalidLoopCheck { cycle: vec![e3, e4, e5], source_check: "unreachable_finish" }),
    ]);
    let repair = engine_with_rule(INVALID_LOOP, &["missing_endpoints", "unreachable_finish"], Box::new(InvalidLoopRandomStrategy));

    let (maze, remaining, _timing) = build_maze(field, g, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);

    assert!(!remaining.iter().any(|i| i.kind == INVALID_LOOP),
        "both checks' issues must be merged into one and resolved in a single repair call: {:?}", remaining);
    // Both triangles must have lost exactly one edge each — proof the strategy received both
    // checks' cycles via the merged IssueData, not just the first one's.
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
    // Regression for #27: a check that produces the same rule (same IssueKind, same source
    // check id) on two consecutive iterations, but with genuinely different cycle data each
    // time (cycle A is gone after iteration 1, only cycle B remains). The old rule-id-only
    // fingerprint saw "INVALID_LOOP active" both times and falsely declared no progress,
    // stopping before cycle B was ever repaired. The content-aware guard must tell these
    // apart and keep going.
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(6, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    // Triangle A: 0->1->2->0
    let e0 = g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e1 = g.build_initial_edge(nodes[1], nodes[2], EdgeKind::Basic);
    let e2 = g.build_initial_edge(nodes[2], nodes[0], EdgeKind::Basic);
    // Triangle B: 3->4->5->3
    let e3 = g.build_initial_edge(nodes[3], nodes[4], EdgeKind::Basic);
    let e4 = g.build_initial_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let e5 = g.build_initial_edge(nodes[5], nodes[3], EdgeKind::Basic);

    // Reports triangle A while it's intact; once A is broken, reports triangle B instead —
    // same IssueKind/source check both times, different IssueData::InvalidLoops content.
    struct AlternatingInvalidLoopCheck {
        triangle_a: Vec<usize>,
        triangle_b: Vec<usize>,
    }
    impl<T: maze_core::space::Tessellation> Check<T> for AlternatingInvalidLoopCheck {
        fn check_type_id(&self) -> &'static str { "alternating_invalid_loop_check" }

        fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
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
            issues.push(Issue::with_data_from_check(
                INVALID_LOOP,
                IssueData::InvalidLoops { all: vec![cycle.clone()], invalid: vec![0], invalid_sources },
                "missing_endpoints",
            ));
        }
    }

    let qc = QualityControlEngine::new(vec![
        Box::new(AlternatingInvalidLoopCheck { triangle_a: vec![e0, e1, e2], triangle_b: vec![e3, e4, e5] }),
    ]);
    let repair = engine_with_rule(INVALID_LOOP, &["missing_endpoints"], Box::new(InvalidLoopRandomStrategy));

    let (maze, remaining, _timing) = build_maze(field, g, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);

    assert!(!remaining.iter().any(|i| i.kind == INVALID_LOOP),
        "both triangles must be resolved across iterations, not falsely stopped after the first: {:?}", remaining);
    let triangle_a_intact = maze.graph.edge(e0).is_some() && maze.graph.edge(e1).is_some() && maze.graph.edge(e2).is_some();
    let triangle_b_intact = maze.graph.edge(e3).is_some() && maze.graph.edge(e4).is_some() && maze.graph.edge(e5).is_some();
    assert!(!triangle_a_intact, "triangle A must have been broken on iteration 1");
    assert!(!triangle_b_intact, "triangle B must have been broken on a later iteration, not skipped by a false oscillation stop");
}

// --- Stages (issue #65) ---

/// Builds a two-stage `RepairEngine`: stage 1 has `rule_a` (strategy `strategy_a`), stage 2 has
/// `rule_b` (strategy `strategy_b`) — same `RepairRuleConfig`/`QcRule` shape `two_rules` uses,
/// but split across two `RepairStage`s instead of one.
fn two_stages<T: maze_core::space::Tessellation>(
    a: (IssueKind, &[&str], Box<dyn RepairStrategy<T>>),
    b: (IssueKind, &[&str], Box<dyn RepairStrategy<T>>),
) -> RepairEngine<T> {
    let (kind_a, checks_a, strategy_a) = a;
    let (kind_b, checks_b, strategy_b) = b;
    let checks_a: Vec<String> = checks_a.iter().map(|s| s.to_string()).collect();
    let checks_b: Vec<String> = checks_b.iter().map(|s| s.to_string()).collect();
    let rule_a = QcRule { id: "ga".to_string(), kind: kind_a, checks: checks_a.clone() };
    let rule_b = QcRule { id: "gb".to_string(), kind: kind_b, checks: checks_b.clone() };
    RepairEngine::new(
        vec![
            RepairRuleConfig { rule: QcRule { id: "ga".to_string(), kind: kind_a, checks: checks_a.clone() }, strategy: strategy_a, param_overrides: HashMap::new(), nested: vec![] },
            RepairRuleConfig { rule: QcRule { id: "gb".to_string(), kind: kind_b, checks: checks_b.clone() }, strategy: strategy_b, param_overrides: HashMap::new(), nested: vec![] },
        ],
        vec![rule_a, rule_b],
        vec![
            RepairStage { id: "stage_1".to_string(), name: "Stage 1".to_string(), rule_ids: vec!["ga".to_string()] },
            RepairStage { id: "stage_2".to_string(), name: "Stage 2".to_string(), rule_ids: vec!["gb".to_string()] },
        ],
    )
}

#[test]
fn stage_2_rule_does_not_dispatch_until_stage_1_resolves() {
    // Stage 1: MissingEndpointsCheck/farthest_endpoints, sets start/finish.
    // Stage 2: a strategy that only succeeds once start/finish are both set — records every
    // call so the test can assert it was never invoked before stage 1 finished.
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct RequiresEndpoints {
        calls_before_endpoints_set: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation> for RequiresEndpoints {
        fn strategy_id(&self) -> &'static str { "requires_endpoints" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, maze: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            if maze.meta.start.is_none() || maze.meta.finish.is_none() {
                self.calls_before_endpoints_set.fetch_add(1, Ordering::SeqCst);
            }
            RepairResult::Fixed { score: None }
        }
    }

    struct AlwaysUnreachableFinishIssueCheck;
    impl maze_core::quality_control::Check<SquareTessellation> for AlwaysUnreachableFinishIssueCheck {
        fn check_type_id(&self) -> &'static str { "always_unreachable_finish_check" }

        fn repair_check(&self, maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            // Stand-in "stage 2" issue: fires every QC pass regardless of maze state, so the
            // test can observe whether stage 2 ever dispatches before stage 1 is done — the
            // real gate is `calls_before_endpoints_set` above, not this check's own logic.
            if maze.meta.start.is_none() || maze.meta.finish.is_none() {
                issues.push(Issue::new_from_check(MISSING_ENDPOINTS, "stage2_check"));
            }
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
        Box::new(AlwaysUnreachableFinishIssueCheck),
    ]);
    let calls_before_endpoints_set = Arc::new(AtomicUsize::new(0));
    let repair = two_stages(
        (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(FarthestEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
        (MISSING_ENDPOINTS, &["stage2_check"], Box::new(RequiresEndpoints { calls_before_endpoints_set: Arc::clone(&calls_before_endpoints_set) })),
    );

    let (maze, _, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some(), "stage 1 must have resolved endpoints");
    assert_eq!(calls_before_endpoints_set.load(Ordering::SeqCst), 0,
        "stage 2's strategy must never be dispatched before stage 1 finished resolving endpoints");
}

#[test]
fn failed_rule_in_stage_1_does_not_block_stage_2() {
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct AlwaysFail;
    impl RepairStrategy<SquareTessellation> for AlwaysFail {
        fn strategy_id(&self) -> &'static str { "always_fail" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            RepairResult::Failed
        }
    }

    let call_count = Arc::new(AtomicUsize::new(0));
    struct CountingFix {
        count: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation> for CountingFix {
        fn strategy_id(&self) -> &'static str { "counting_fix" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            self.count.fetch_add(1, Ordering::SeqCst);
            RepairResult::Fixed { score: None }
        }
    }

    // Unconditional issue, independent of maze state — stage 1's rule (`missing_endpoints`)
    // never resolves (AlwaysFail), so a check gated on start/finish being set (like the real
    // UnreachableFinishCheck) would never fire at all; this check fires regardless, isolating
    // the thing under test (does stage 2 dispatch despite stage 1's failure) from whether stage
    // 1's failure incidentally also starves stage 2's own check of its precondition.
    struct AlwaysFinishUnreachableIssueCheck;
    impl maze_core::quality_control::Check<SquareTessellation> for AlwaysFinishUnreachableIssueCheck {
        fn check_type_id(&self) -> &'static str { "always_finish_unreachable_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            issues.push(Issue::new_from_check(MISSING_ENDPOINTS, "unreachable_finish"));
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
        Box::new(AlwaysFinishUnreachableIssueCheck),
    ]);
    let repair = two_stages(
        (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(AlwaysFail) as Box<dyn RepairStrategy<SquareTessellation>>),
        (MISSING_ENDPOINTS, &["unreachable_finish"], Box::new(CountingFix { count: Arc::clone(&call_count) })),
    );

    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(warnings.iter().any(|i| i.kind == MISSING_ENDPOINTS), "stage 1's rule must remain unresolved (Failed)");
    assert!(call_count.load(Ordering::SeqCst) > 0, "stage 2 must still have been dispatched despite stage 1's failure");
}

#[test]
fn no_progress_in_stage_1_aborts_stage_2_entirely() {
    use maze_core::quality_control::QC_NO_PROGRESS;
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct AlwaysSameIssueCheck;
    impl maze_core::quality_control::Check<SquareTessellation> for AlwaysSameIssueCheck {
        fn check_type_id(&self) -> &'static str { "always_same_issue_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            issues.push(Issue::new_from_check(MISSING_ENDPOINTS, "missing_endpoints"));
        }
    }
    struct NoOpFix;
    impl RepairStrategy<SquareTessellation> for NoOpFix {
        fn strategy_id(&self) -> &'static str { "no_op_fix" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            RepairResult::Fixed { score: None }
        }
    }

    let call_count = Arc::new(AtomicUsize::new(0));
    struct CountingFix {
        count: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation> for CountingFix {
        fn strategy_id(&self) -> &'static str { "counting_fix" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            self.count.fetch_add(1, Ordering::SeqCst);
            RepairResult::Fixed { score: None }
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![Box::new(AlwaysSameIssueCheck)]);
    let repair = two_stages(
        (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(NoOpFix) as Box<dyn RepairStrategy<SquareTessellation>>),
        (MISSING_ENDPOINTS, &["unreachable_finish"], Box::new(CountingFix { count: Arc::clone(&call_count) })),
    );

    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(warnings.iter().any(|i| i.kind == QC_NO_PROGRESS), "must surface QC_NO_PROGRESS for stuck stage 1");
    assert_eq!(call_count.load(Ordering::SeqCst), 0, "stage 2 must never be reached once stage 1 no-progresses");
}

#[test]
fn shared_repair_limit_stops_mid_stage_2_and_final_qc_still_runs() {
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct OneShotFix;
    impl RepairStrategy<SquareTessellation> for OneShotFix {
        fn strategy_id(&self) -> &'static str { "one_shot_fix" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, maze: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            let mut nodes: Vec<_> = maze.graph.nodes().map(|n| n.id).collect();
            nodes.sort_unstable();
            maze.meta.start = nodes.first().copied();
            maze.meta.finish = nodes.last().copied();
            RepairResult::Fixed { score: None }
        }
    }

    struct NeverConvergingCheck2 {
        counter: Arc<AtomicUsize>,
    }
    impl maze_core::quality_control::Check<SquareTessellation> for NeverConvergingCheck2 {
        fn check_type_id(&self) -> &'static str { "never_converging_check_2" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            let n = self.counter.fetch_add(1, Ordering::SeqCst);
            issues.push(
                Issue::new_from_check(MISSING_ENDPOINTS, "unreachable_finish")
                    .with_detail("unreachable_finish", "tick", n.to_string()),
            );
        }
    }
    struct NoOpFix2;
    impl RepairStrategy<SquareTessellation> for NoOpFix2 {
        fn strategy_id(&self) -> &'static str { "no_op_fix_2" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            RepairResult::Fixed { score: None }
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
        Box::new(NeverConvergingCheck2 { counter: Arc::new(AtomicUsize::new(0)) }),
    ]);
    let repair = two_stages(
        (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(OneShotFix) as Box<dyn RepairStrategy<SquareTessellation>>),
        (MISSING_ENDPOINTS, &["unreachable_finish"], Box::new(NoOpFix2)),
    );

    let limits = RepairLimits { max_iterations: Some(3), time_budget_secs: None };
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), limits, None, None);
    let limit_issue = warnings.iter().find(|i| i.kind == REPAIR_LIMIT_REACHED).expect("must surface REPAIR_LIMIT_REACHED once budget exhausts mid stage 2");
    assert_eq!(limit_issue.data, Some(IssueData::RepairLimitReached { limit: RepairLimitKind::MaxIterations }));
    // Final QC pass still ran (it's unconditional) — endpoints resolved by stage 1 remain
    // visible in the maze even though stage 2 never converged.
    assert!(warnings.iter().any(|i| i.kind == MISSING_ENDPOINTS), "final QC must still surface stage 2's unresolved issue");
}

#[test]
fn empty_stage_list_skips_repair_and_goes_straight_to_final_qc() {
    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() })]);
    let repair: RepairEngine<SquareTessellation> = RepairEngine::new(vec![], vec![], vec![]);
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(warnings.iter().any(|i| i.kind == MISSING_ENDPOINTS), "no stages means no repair, issue surfaces via the final QC pass");
}

#[test]
fn stage_with_only_no_strategy_rules_is_skipped_instantly_between_dispatchable_stages() {
    // Stage 1 resolves endpoints; stage 2 is entirely no-strategy rules (logging-only); stage 3
    // has a real strategy that requires endpoints to already be set. Stage 2 must not block or
    // delay stage 3.
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct RequiresEndpoints {
        called_with_endpoints_set: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation> for RequiresEndpoints {
        fn strategy_id(&self) -> &'static str { "requires_endpoints" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, maze: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            if maze.meta.start.is_some() && maze.meta.finish.is_some() {
                self.called_with_endpoints_set.fetch_add(1, Ordering::SeqCst);
            }
            RepairResult::Fixed { score: None }
        }
    }
    struct AlwaysIssueCheck;
    impl maze_core::quality_control::Check<SquareTessellation> for AlwaysIssueCheck {
        fn check_type_id(&self) -> &'static str { "stage3_check" }

        fn repair_check(&self, maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            if maze.meta.start.is_some() && maze.meta.finish.is_some() {
                issues.push(Issue::new_from_check(MISSING_ENDPOINTS, "stage3_check"));
            }
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck { instance_id: "missing_endpoints".to_string() }),
        Box::new(AlwaysIssueCheck),
    ]);
    let checks_1: Vec<String> = vec!["missing_endpoints".to_string()];
    let rule_1 = QcRule { id: "g1".to_string(), kind: MISSING_ENDPOINTS, checks: checks_1.clone() };
    let no_strategy_rule = QcRule { id: "g_logging".to_string(), kind: MISSING_ENDPOINTS, checks: vec!["some_other_check".to_string()] };
    let called_with_endpoints_set = Arc::new(AtomicUsize::new(0));
    let checks_3: Vec<String> = vec!["stage3_check".to_string()];
    let rule_3 = QcRule { id: "g3".to_string(), kind: MISSING_ENDPOINTS, checks: checks_3.clone() };
    let repair: RepairEngine<SquareTessellation> = RepairEngine::new(
        vec![
            RepairRuleConfig { rule: QcRule { id: "g1".to_string(), kind: MISSING_ENDPOINTS, checks: checks_1 }, strategy: Box::new(FarthestEndpointsStrategy), param_overrides: HashMap::new(), nested: vec![] },
            RepairRuleConfig { rule: QcRule { id: "g3".to_string(), kind: MISSING_ENDPOINTS, checks: checks_3 }, strategy: Box::new(RequiresEndpoints { called_with_endpoints_set: Arc::clone(&called_with_endpoints_set) }), param_overrides: HashMap::new(), nested: vec![] },
        ],
        vec![rule_1, no_strategy_rule, rule_3],
        vec![
            RepairStage { id: "stage_1".to_string(), name: "Stage 1".to_string(), rule_ids: vec!["g1".to_string()] },
            RepairStage { id: "stage_2".to_string(), name: "Stage 2".to_string(), rule_ids: vec!["g_logging".to_string()] },
            RepairStage { id: "stage_3".to_string(), name: "Stage 3".to_string(), rule_ids: vec!["g3".to_string()] },
        ],
    );

    let (maze, _, _timing) = build_maze(field, graph, 1, qc, repair, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some());
    assert!(called_with_endpoints_set.load(Ordering::SeqCst) > 0, "stage 3 must dispatch after stage 1, unaffected by no-strategy stage 2");
}
