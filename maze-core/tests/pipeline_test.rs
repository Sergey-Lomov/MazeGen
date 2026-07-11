use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use maze_core::{Graph, IdGenerator, Maze};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationAlgorithm, EdgeBasedParams, ElementsConfig, GenerationConfig, PresetState, pipeline::{build_maze, RepairLimits}};
use maze_core::graph::EdgeKind;
use maze_core::quality_control::{QualityControlEngine, Rule, Stage, Check, Issue, IssueData, IssueKind, MissingEndpointsCheck, UnreachableFinishCheck, MinLoopLengthCheck, MISSING_ENDPOINTS, INVALID_LOOP, REPAIR_LIMIT_REACHED, RepairLimitKind};
use maze_core::repair::{RepairStrategy, FarthestEndpointsStrategy, RandomEndpointsStrategy, InvalidLoopRandomStrategy, StrategyParams, SnapshotStack};

type BoxedCheck<T> = Box<dyn Check<T>>;

/// Builds a single-rule, single-stage `QualityControlEngine`: one rule owning all of `checks`
/// (paired with their own `local_id`), sharing `kind`, dispatching to `strategy`. Covers the
/// common single-strategy-per-kind test shape without repeating the `Rule`/`Stage` boilerplate at
/// every call site — replaces the pre-#106 `engine_with_rule` (which built a separate
/// `QualityControlEngine`+`RepairEngine` pair; checks now live physically inside the `Rule`).
fn engine_with_rule<T: maze_core::space::Tessellation>(
    kind: IssueKind,
    checks: Vec<(&str, BoxedCheck<T>)>,
    strategy: Box<dyn RepairStrategy<T>>,
) -> QualityControlEngine<T> {
    let checks: Vec<(String, BoxedCheck<T>)> = checks.into_iter().map(|(id, c)| (id.to_string(), c)).collect();
    let rule = Rule::new("g".to_string(), kind, checks, Some(strategy), HashMap::new(), vec![]);
    QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![rule])])
}

/// Builds a `QualityControlEngine` with two independent single-check rules, each with its own
/// strategy, both in the same single stage (same rationale as `engine_with_rule`).
fn two_rules<T: maze_core::space::Tessellation>(
    a: (IssueKind, Vec<(&str, BoxedCheck<T>)>, Box<dyn RepairStrategy<T>>),
    b: (IssueKind, Vec<(&str, BoxedCheck<T>)>, Box<dyn RepairStrategy<T>>),
) -> QualityControlEngine<T> {
    let (kind_a, checks_a, strategy_a) = a;
    let (kind_b, checks_b, strategy_b) = b;
    let checks_a: Vec<(String, BoxedCheck<T>)> = checks_a.into_iter().map(|(id, c)| (id.to_string(), c)).collect();
    let checks_b: Vec<(String, BoxedCheck<T>)> = checks_b.into_iter().map(|(id, c)| (id.to_string(), c)).collect();
    let rule_a = Rule::new("ga".to_string(), kind_a, checks_a, Some(strategy_a), HashMap::new(), vec![]);
    let rule_b = Rule::new("gb".to_string(), kind_b, checks_b, Some(strategy_b), HashMap::new(), vec![]);
    QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![rule_a, rule_b])])
}

/// Mirrors the pre-#106 `make_engines`: a `missing_endpoints` rule dispatching
/// `FarthestEndpointsStrategy`, plus an `unreachable_finish` check that runs (and can surface via
/// the final report) but has no strategy of its own — the old flat `qc`/`repair` split let a
/// check run unrouted; here that's a `Rule` with `strategy: None`.
fn make_engines() -> QualityControlEngine<SquareTessellation> {
    let missing_endpoints_rule = Rule::new(
        "g".to_string(), MISSING_ENDPOINTS,
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
        Some(Box::new(FarthestEndpointsStrategy)), HashMap::new(), vec![],
    );
    let unreachable_finish_rule = Rule::new(
        "u".to_string(), maze_core::quality_control::UNREACHABLE_FINISH,
        vec![("unreachable_finish".to_string(), Box::new(UnreachableFinishCheck { instance_id: "u:unreachable_finish".to_string() }) as BoxedCheck<SquareTessellation>)],
        None, HashMap::new(), vec![],
    );
    QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![missing_endpoints_rule, unreachable_finish_rule])])
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
    let qc = make_engines();
    let (maze, warnings, _timing) = build_maze(field, graph, 42, qc, &PresetState::empty(), RepairLimits::default(), None, None);
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
    let qc = engine_with_rule(
        MISSING_ENDPOINTS,
        vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }))],
        Box::new(FarthestEndpointsStrategy),
    );

    let (maze, warnings, _timing) = build_maze(
        field, graph, 42, qc, &PresetState::empty(), RepairLimits::default(),
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
        let qc = make_engines();
        let (maze, _, _timing) = build_maze(field, graph, seed, qc, &PresetState::empty(), RepairLimits::default(), None, None);
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
        "g".to_string(), MISSING_ENDPOINTS,
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
        None, HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![rule])]);
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
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
    let qc = engine_with_rule(
        MISSING_ENDPOINTS,
        vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }))],
        Box::new(AlwaysFail),
    );
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
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
) -> (Field<SquareTessellation>, Graph, QualityControlEngine<SquareTessellation>) {
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
    let qc = engine_with_rule(
        MISSING_ENDPOINTS,
        vec![("missing_endpoints", Box::new(NeverConvergingCheck { counter: Arc::new(AtomicUsize::new(0)) }))],
        Box::new(NoOpFix { on_apply }),
    );
    (field, graph, qc)
}

#[test]
fn pipeline_stops_at_max_iterations_cap() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&call_count);
    let (field, graph, qc) = never_converging_setup(move || { counter.fetch_add(1, Ordering::SeqCst); });

    let limits = RepairLimits { max_iterations: Some(3), time_budget_secs: None };
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None);
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
    let (field, graph, qc) = never_converging_setup(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        sleep(Duration::from_millis(20));
    });

    let limits = RepairLimits { max_iterations: None, time_budget_secs: Some(0.05) };
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None);
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
    let qc = engine_with_rule(
        MISSING_ENDPOINTS,
        vec![("missing_endpoints", Box::new(AlwaysSameIssueCheck) as BoxedCheck<SquareTessellation>)],
        Box::new(NoOpFix),
    );
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);

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
    let checks: Vec<(&str, BoxedCheck<SquareTessellation>)> = vec![
        ("a", Box::new(MissingEndpointsCheck { instance_id: "g:a".to_string() })),
        ("b", Box::new(MissingEndpointsCheck { instance_id: "g:b".to_string() })),
    ];
    let qc = engine_with_rule(MISSING_ENDPOINTS, checks, Box::new(CountingStrategy { count: Arc::clone(&call_count) }));

    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
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

    let qc = two_rules(
        (MISSING_ENDPOINTS,
         vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
         Box::new(FarthestEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
        (INVALID_LOOP,
         vec![("min_loop_length", Box::new(MinLoopLengthCheck { instance_id: "gb:min_loop_length".to_string(), min_loop_length: 10 }))],
         Box::new(InvalidLoopRandomStrategy)),
    );

    let (_, remaining, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
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

        let qc = two_rules(
            (MISSING_ENDPOINTS,
             vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
             Box::new(RandomEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
            (INVALID_LOOP,
             vec![("min_loop_length", Box::new(MinLoopLengthCheck { instance_id: "gb:min_loop_length".to_string(), min_loop_length: 10 }))],
             Box::new(InvalidLoopRandomStrategy)),
        );

        let (maze, _, _timing) = build_maze(field, graph, seed, qc, &PresetState::empty(), RepairLimits::default(), None, None);

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

    let qc = two_rules(
        (MISSING_ENDPOINTS,
         vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
         Box::new(RandomEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
        (INVALID_LOOP,
         vec![("min_loop_length", Box::new(MinLoopLengthCheck { instance_id: "gb:min_loop_length".to_string(), min_loop_length: 10 }))],
         Box::new(InvalidLoopRandomStrategy)),
    );

    let (maze, _, _timing) = build_maze(field, graph, seed, qc, &PresetState::empty(), RepairLimits::default(), None, None);

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

    let checks: Vec<(&str, BoxedCheck<SquareTessellation>)> = vec![
        ("missing_endpoints", Box::new(FakeInvalidLoopCheck { cycle: vec![e0, e1, e2], source_check: "missing_endpoints" })),
        ("unreachable_finish", Box::new(FakeInvalidLoopCheck { cycle: vec![e3, e4, e5], source_check: "unreachable_finish" })),
    ];
    let qc = engine_with_rule(INVALID_LOOP, checks, Box::new(InvalidLoopRandomStrategy));

    let (maze, remaining, _timing) = build_maze(field, g, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);

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

    let qc = engine_with_rule(
        INVALID_LOOP,
        vec![("missing_endpoints", Box::new(AlternatingInvalidLoopCheck { triangle_a: vec![e0, e1, e2], triangle_b: vec![e3, e4, e5] }) as BoxedCheck<SquareTessellation>)],
        Box::new(InvalidLoopRandomStrategy),
    );

    let (maze, remaining, _timing) = build_maze(field, g, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);

    assert!(!remaining.iter().any(|i| i.kind == INVALID_LOOP),
        "both triangles must be resolved across iterations, not falsely stopped after the first: {:?}", remaining);
    let triangle_a_intact = maze.graph.edge(e0).is_some() && maze.graph.edge(e1).is_some() && maze.graph.edge(e2).is_some();
    let triangle_b_intact = maze.graph.edge(e3).is_some() && maze.graph.edge(e4).is_some() && maze.graph.edge(e5).is_some();
    assert!(!triangle_a_intact, "triangle A must have been broken on iteration 1");
    assert!(!triangle_b_intact, "triangle B must have been broken on a later iteration, not skipped by a false oscillation stop");
}

// --- Stages (issue #65) ---

/// Builds a two-stage `QualityControlEngine`: stage 1 has `rule_a` (strategy `strategy_a`),
/// stage 2 has `rule_b` (strategy `strategy_b`) — same shape `two_rules` uses, but split across
/// two `Stage`s instead of one.
fn two_stages<T: maze_core::space::Tessellation>(
    a: (IssueKind, Vec<(&str, BoxedCheck<T>)>, Box<dyn RepairStrategy<T>>),
    b: (IssueKind, Vec<(&str, BoxedCheck<T>)>, Box<dyn RepairStrategy<T>>),
) -> QualityControlEngine<T> {
    let (kind_a, checks_a, strategy_a) = a;
    let (kind_b, checks_b, strategy_b) = b;
    let checks_a: Vec<(String, BoxedCheck<T>)> = checks_a.into_iter().map(|(id, c)| (id.to_string(), c)).collect();
    let checks_b: Vec<(String, BoxedCheck<T>)> = checks_b.into_iter().map(|(id, c)| (id.to_string(), c)).collect();
    let rule_a = Rule::new("ga".to_string(), kind_a, checks_a, Some(strategy_a), HashMap::new(), vec![]);
    let rule_b = Rule::new("gb".to_string(), kind_b, checks_b, Some(strategy_b), HashMap::new(), vec![]);
    QualityControlEngine::new(vec![
        Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![rule_a]),
        Stage::new("stage_2".to_string(), "Stage 2".to_string(), vec![rule_b]),
    ])
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
    let calls_before_endpoints_set = Arc::new(AtomicUsize::new(0));
    let qc = two_stages(
        (MISSING_ENDPOINTS,
         vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
         Box::new(FarthestEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
        (MISSING_ENDPOINTS,
         vec![("stage2_check", Box::new(AlwaysUnreachableFinishIssueCheck))],
         Box::new(RequiresEndpoints { calls_before_endpoints_set: Arc::clone(&calls_before_endpoints_set) })),
    );

    let (maze, _, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
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
    let qc = two_stages(
        (MISSING_ENDPOINTS,
         vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
         Box::new(AlwaysFail) as Box<dyn RepairStrategy<SquareTessellation>>),
        (MISSING_ENDPOINTS,
         vec![("unreachable_finish", Box::new(AlwaysFinishUnreachableIssueCheck))],
         Box::new(CountingFix { count: Arc::clone(&call_count) })),
    );

    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(warnings.iter().any(|i| i.kind == MISSING_ENDPOINTS), "stage 1's rule must remain unresolved (Failed)");
    assert!(call_count.load(Ordering::SeqCst) > 0, "stage 2 must still have been dispatched despite stage 1's failure");
}

#[test]
fn failed_rule_in_middle_stage_does_not_block_last_stage() {
    // Unlike no-progress (which aborts every later stage — see
    // no_progress_in_middle_stage_aborts_last_stage_too above), a Failed rule only excludes
    // itself from further dispatch within its own stage's loop; it does not stop the stage
    // sequence. 3 stages: stage 1 resolves, stage 2's rule always Failed, stage 3 must still
    // dispatch. failed_rule_in_stage_1_does_not_block_stage_2 above only proves this one stage
    // ahead; this proves it propagates past an intermediate failed stage too.
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct AlwaysFail;
    impl RepairStrategy<SquareTessellation> for AlwaysFail {
        fn strategy_id(&self) -> &'static str { "always_fail" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            RepairResult::Failed
        }
    }
    struct AlwaysStage2IssueCheck;
    impl maze_core::quality_control::Check<SquareTessellation> for AlwaysStage2IssueCheck {
        fn check_type_id(&self) -> &'static str { "always_stage2_issue_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            issues.push(Issue::new_from_check(MISSING_ENDPOINTS, "stage2_check"));
        }
    }
    struct AlwaysStage3IssueCheck;
    impl maze_core::quality_control::Check<SquareTessellation> for AlwaysStage3IssueCheck {
        fn check_type_id(&self) -> &'static str { "always_stage3_issue_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            issues.push(Issue::new_from_check(MISSING_ENDPOINTS, "stage3_check"));
        }
    }
    let stage_3_calls = Arc::new(AtomicUsize::new(0));
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
    let rule_1 = Rule::new(
        "g1".to_string(), MISSING_ENDPOINTS,
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g1:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
        Some(Box::new(FarthestEndpointsStrategy)), HashMap::new(), vec![],
    );
    let rule_2 = Rule::new(
        "g2".to_string(), MISSING_ENDPOINTS,
        vec![("stage2_check".to_string(), Box::new(AlwaysStage2IssueCheck) as BoxedCheck<SquareTessellation>)],
        Some(Box::new(AlwaysFail)), HashMap::new(), vec![],
    );
    let rule_3 = Rule::new(
        "g3".to_string(), MISSING_ENDPOINTS,
        vec![("stage3_check".to_string(), Box::new(AlwaysStage3IssueCheck) as BoxedCheck<SquareTessellation>)],
        Some(Box::new(CountingFix { count: Arc::clone(&stage_3_calls) })), HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![
        Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![rule_1]),
        Stage::new("stage_2".to_string(), "Stage 2".to_string(), vec![rule_2]),
        Stage::new("stage_3".to_string(), "Stage 3".to_string(), vec![rule_3]),
    ]);

    let (maze, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some(), "stage 1 must have resolved cleanly");
    assert!(warnings.iter().any(|i| i.kind == MISSING_ENDPOINTS), "stage 2's rule must remain unresolved (Failed)");
    assert!(stage_3_calls.load(Ordering::SeqCst) > 0, "stage 3 must still be dispatched despite stage 2's failure");
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
    let qc = two_stages(
        (MISSING_ENDPOINTS,
         vec![("missing_endpoints", Box::new(AlwaysSameIssueCheck) as BoxedCheck<SquareTessellation>)],
         Box::new(NoOpFix) as Box<dyn RepairStrategy<SquareTessellation>>),
        (MISSING_ENDPOINTS,
         vec![],
         Box::new(CountingFix { count: Arc::clone(&call_count) })),
    );

    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(warnings.iter().any(|i| i.kind == QC_NO_PROGRESS), "must surface QC_NO_PROGRESS for stuck stage 1");
    assert_eq!(call_count.load(Ordering::SeqCst), 0, "stage 2 must never be reached once stage 1 no-progresses");
}

#[test]
fn no_progress_in_middle_stage_aborts_last_stage_too() {
    // 3 stages: stage 1 resolves cleanly, stage 2 no-progresses, stage 3 must never be reached
    // either — not just "the very next stage after the failing one", but every later stage,
    // however many there are. no_progress_in_stage_1_aborts_stage_2_entirely above only proves
    // this for the immediately-following stage; this proves the abort propagates past it.
    use maze_core::quality_control::QC_NO_PROGRESS;
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct AlwaysSameIssueCheck;
    impl maze_core::quality_control::Check<SquareTessellation> for AlwaysSameIssueCheck {
        fn check_type_id(&self) -> &'static str { "always_same_issue_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            issues.push(Issue::new_from_check(MISSING_ENDPOINTS, "stage2_check"));
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
    let stage_3_calls = Arc::new(AtomicUsize::new(0));
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
    let rule_1 = Rule::new(
        "g1".to_string(), MISSING_ENDPOINTS,
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g1:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
        Some(Box::new(FarthestEndpointsStrategy)), HashMap::new(), vec![],
    );
    let rule_2 = Rule::new(
        "g2".to_string(), MISSING_ENDPOINTS,
        vec![("stage2_check".to_string(), Box::new(AlwaysSameIssueCheck) as BoxedCheck<SquareTessellation>)],
        Some(Box::new(NoOpFix)), HashMap::new(), vec![],
    );
    let rule_3 = Rule::new(
        "g3".to_string(), MISSING_ENDPOINTS, vec![],
        Some(Box::new(CountingFix { count: Arc::clone(&stage_3_calls) })), HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![
        Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![rule_1]),
        Stage::new("stage_2".to_string(), "Stage 2".to_string(), vec![rule_2]),
        Stage::new("stage_3".to_string(), "Stage 3".to_string(), vec![rule_3]),
    ]);

    let (maze, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some(), "stage 1 must have resolved cleanly");
    assert!(warnings.iter().any(|i| i.kind == QC_NO_PROGRESS), "must surface QC_NO_PROGRESS for stuck stage 2");
    assert_eq!(stage_3_calls.load(Ordering::SeqCst), 0, "stage 3 must never be reached once stage 2 no-progresses");
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
    let qc = two_stages(
        (MISSING_ENDPOINTS,
         vec![("missing_endpoints", Box::new(MissingEndpointsCheck { instance_id: "ga:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
         Box::new(OneShotFix) as Box<dyn RepairStrategy<SquareTessellation>>),
        (MISSING_ENDPOINTS,
         vec![("unreachable_finish", Box::new(NeverConvergingCheck2 { counter: Arc::new(AtomicUsize::new(0)) }))],
         Box::new(NoOpFix2)),
    );

    let limits = RepairLimits { max_iterations: Some(3), time_budget_secs: None };
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None);
    let limit_issue = warnings.iter().find(|i| i.kind == REPAIR_LIMIT_REACHED).expect("must surface REPAIR_LIMIT_REACHED once budget exhausts mid stage 2");
    assert_eq!(limit_issue.data, Some(IssueData::RepairLimitReached { limit: RepairLimitKind::MaxIterations }));
    // Final QC pass still ran (it's unconditional) — endpoints resolved by stage 1 remain
    // visible in the maze even though stage 2 never converged.
    assert!(warnings.iter().any(|i| i.kind == MISSING_ENDPOINTS), "final QC must still surface stage 2's unresolved issue");
}

#[test]
fn empty_stage_list_skips_repair_and_goes_straight_to_final_qc() {
    let (field, graph) = make_generated_graph(1);
    let rule = Rule::new(
        "g".to_string(), MISSING_ENDPOINTS,
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
        None, HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![rule])]);
    let (_, warnings, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
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
    let called_with_endpoints_set = Arc::new(AtomicUsize::new(0));
    let rule_1 = Rule::new(
        "g1".to_string(), MISSING_ENDPOINTS,
        vec![("missing_endpoints".to_string(), Box::new(MissingEndpointsCheck { instance_id: "g1:missing_endpoints".to_string() }) as BoxedCheck<SquareTessellation>)],
        Some(Box::new(FarthestEndpointsStrategy)), HashMap::new(), vec![],
    );
    let no_strategy_rule: Rule<SquareTessellation> = Rule::new("g_logging".to_string(), MISSING_ENDPOINTS, vec![], None, HashMap::new(), vec![]);
    let rule_3 = Rule::new(
        "g3".to_string(), MISSING_ENDPOINTS,
        vec![("stage3_check".to_string(), Box::new(AlwaysIssueCheck) as BoxedCheck<SquareTessellation>)],
        Some(Box::new(RequiresEndpoints { called_with_endpoints_set: Arc::clone(&called_with_endpoints_set) })), HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![
        Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![rule_1]),
        Stage::new("stage_2".to_string(), "Stage 2".to_string(), vec![no_strategy_rule]),
        Stage::new("stage_3".to_string(), "Stage 3".to_string(), vec![rule_3]),
    ]);

    let (maze, _, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), RepairLimits::default(), None, None);
    assert!(maze.meta.start.is_some() && maze.meta.finish.is_some());
    // stage_with_only_no_strategy_rules test above proves no_strategy_rule doesn't BLOCK later
    // stages; it uses an empty checks vec so it can't tell whether the rule's own checks ran mid-loop
    // at all vs. were skipped by a filter-order bug. See no_strategy_rule_checks_run_every_iteration
    // below for that.
    assert!(called_with_endpoints_set.load(Ordering::SeqCst) > 0, "stage 3 must dispatch after stage 1, unaffected by no-strategy stage 2");
}

#[test]
fn no_strategy_rule_checks_run_every_iteration_not_just_final_report() {
    // Regression: Stage::collect_active used to filter out no-strategy rules BEFORE calling
    // run_checks, so a no-strategy rule's checks never ran during the repair fixpoint loop —
    // only once, in the final unconditional report pass. This rule's check has a real,
    // non-empty checks vec with a call counter, so it can distinguish "ran every iteration" from
    // "only ran once at the end".
    use maze_core::repair::{RepairResult, RepairStrategy};

    struct CountingCheck {
        calls: Arc<AtomicUsize>,
    }
    impl maze_core::quality_control::Check<SquareTessellation> for CountingCheck {
        fn check_type_id(&self) -> &'static str { "counting_check" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, _issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            self.calls.fetch_add(1, Ordering::SeqCst);
        }
    }
    struct MultiIterationFix {
        counter: Arc<AtomicUsize>,
    }
    impl RepairStrategy<SquareTessellation> for MultiIterationFix {
        fn strategy_id(&self) -> &'static str { "multi_iteration_fix" }
        fn handles(&self) -> IssueKind { MISSING_ENDPOINTS }

        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut SnapshotStack, _: &mut dyn rand::RngCore, _: &StrategyParams, _: &PresetState, _: &[maze_core::repair::NestedStrategyConfig<SquareTessellation>]) -> RepairResult {
            self.counter.fetch_add(1, Ordering::SeqCst);
            RepairResult::Fixed { score: None }
        }
    }
    // Ticks a shared counter into each issue's detail, same technique as `NeverConvergingCheck`
    // above — so the raw issue genuinely differs iteration to iteration, never tripping the
    // no-progress guard, letting the loop run all the way to `max_iterations`.
    struct AlwaysMissingEndpointsCheck {
        counter: Arc<AtomicUsize>,
    }
    impl maze_core::quality_control::Check<SquareTessellation> for AlwaysMissingEndpointsCheck {
        fn check_type_id(&self) -> &'static str { "always_missing_endpoints" }

        fn repair_check(&self, _maze: &Maze<SquareTessellation>, issues: &mut Vec<Issue>, _rng: &mut dyn rand::RngCore) {
            let n = self.counter.fetch_add(1, Ordering::SeqCst);
            issues.push(
                Issue::new_from_check(MISSING_ENDPOINTS, "always_missing_endpoints")
                    .with_detail("always_missing_endpoints", "tick", n.to_string()),
            );
        }
    }

    let (field, graph) = make_generated_graph(1);
    let no_strategy_check_calls = Arc::new(AtomicUsize::new(0));
    let strategy_calls = Arc::new(AtomicUsize::new(0));

    let dispatchable_rule = Rule::new(
        "g_dispatch".to_string(), MISSING_ENDPOINTS,
        vec![("always_missing_endpoints".to_string(), Box::new(AlwaysMissingEndpointsCheck { counter: Arc::new(AtomicUsize::new(0)) }) as BoxedCheck<SquareTessellation>)],
        Some(Box::new(MultiIterationFix { counter: Arc::clone(&strategy_calls) })), HashMap::new(), vec![],
    );
    let no_strategy_rule = Rule::new(
        "g_logging".to_string(), MISSING_ENDPOINTS,
        vec![("counting_check".to_string(), Box::new(CountingCheck { calls: Arc::clone(&no_strategy_check_calls) }) as BoxedCheck<SquareTessellation>)],
        None, HashMap::new(), vec![],
    );
    let qc = QualityControlEngine::new(vec![
        Stage::new("stage_1".to_string(), "Stage 1".to_string(), vec![dispatchable_rule, no_strategy_rule]),
    ]);

    let limits = RepairLimits { max_iterations: Some(3), time_budget_secs: None };
    let (_, _, _timing) = build_maze(field, graph, 1, qc, &PresetState::empty(), limits, None, None);

    // MultiIterationFix always returns Fixed but never actually resolves MISSING_ENDPOINTS
    // (it never sets maze.meta.start/finish), so the check fires again every iteration until
    // the 3-iteration cap — 3 strategy calls means 3 loop iterations ran.
    assert_eq!(strategy_calls.load(Ordering::SeqCst), 3, "loop must run exactly max_iterations times");
    // The no-strategy rule's check must have run once per loop iteration too, not just once in
    // the final report pass — before the fix this asserted 1 (final report only).
    assert_eq!(no_strategy_check_calls.load(Ordering::SeqCst), 4,
        "no-strategy rule's check must run every fixpoint iteration (3) plus the final report pass (1), not just the final report");
}
