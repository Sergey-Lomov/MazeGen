use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use maze_core::{Graph, IdGenerator, Maze};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationAlgorithm, EdgeBasedParams, ElementsConfig, GenerationConfig, PresetState, pipeline::build_maze};
use maze_core::graph::EdgeKind;
use maze_core::quality_control::{QualityControlEngine, Check, Issue, IssueData, IssueKind, MissingEndpointsCheck, UnreachableFinishCheck, MinLoopLengthCheck, MISSING_ENDPOINTS, INVALID_LOOP};
use maze_core::repair::{QcRule, CheckId, RepairEngine, RepairRuleConfig, RepairStrategy, FarthestEndpointsStrategy, RandomEndpointsStrategy, InvalidLoopRandomStrategy, StrategyParams};

/// Builds a single-rule `RepairEngine`: one rule containing all of `checks`, sharing `kind`,
/// dispatching to `strategy`. Covers the common single-strategy-per-kind test shape without
/// repeating the `RepairRuleConfig`/`QcRule` boilerplate at every call site.
fn engine_with_rule<T: maze_core::space::Tessellation>(
    kind: IssueKind,
    checks: &[&'static str],
    strategy: Box<dyn RepairStrategy<T>>,
) -> RepairEngine<T> {
    let rule = QcRule { id: "g".to_string(), kind, checks: checks.iter().map(|&c| CheckId(c)).collect() };
    RepairEngine::new(
        vec![RepairRuleConfig { rule: QcRule { id: "g".to_string(), kind, checks: checks.iter().map(|&c| CheckId(c)).collect() }, strategy, param_overrides: HashMap::new() }],
        vec![rule],
    )
}

/// Builds a `RepairEngine` with two independent single-check rules, each with its own strategy.
fn two_rules<T: maze_core::space::Tessellation>(
    a: (IssueKind, &[&'static str], Box<dyn RepairStrategy<T>>),
    b: (IssueKind, &[&'static str], Box<dyn RepairStrategy<T>>),
) -> RepairEngine<T> {
    let (kind_a, checks_a, strategy_a) = a;
    let (kind_b, checks_b, strategy_b) = b;
    let rule_a = QcRule { id: "ga".to_string(), kind: kind_a, checks: checks_a.iter().map(|&c| CheckId(c)).collect() };
    let rule_b = QcRule { id: "gb".to_string(), kind: kind_b, checks: checks_b.iter().map(|&c| CheckId(c)).collect() };
    RepairEngine::new(
        vec![
            RepairRuleConfig { rule: QcRule { id: "ga".to_string(), kind: kind_a, checks: checks_a.iter().map(|&c| CheckId(c)).collect() }, strategy: strategy_a, param_overrides: HashMap::new() },
            RepairRuleConfig { rule: QcRule { id: "gb".to_string(), kind: kind_b, checks: checks_b.iter().map(|&c| CheckId(c)).collect() }, strategy: strategy_b, param_overrides: HashMap::new() },
        ],
        vec![rule_a, rule_b],
    )
}

fn make_engines() -> (QualityControlEngine<SquareTessellation>, RepairEngine<SquareTessellation>) {
    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck),
        Box::new(UnreachableFinishCheck),
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
    let (maze, warnings) = build_maze(field, graph, 42, qc, repair, &PresetState::empty());
    assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings);
    assert!(maze.meta.start.is_some());
    assert!(maze.meta.finish.is_some());
    assert_ne!(maze.meta.start, maze.meta.finish);
}

#[test]
fn pipeline_deterministic() {
    let seed = 77u64;
    let run = || {
        let (field, graph) = make_generated_graph(seed);
        let (qc, repair) = make_engines();
        let (maze, _) = build_maze(field, graph, seed, qc, repair, &PresetState::empty());
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
    let qc = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck)]);
    let repair: RepairEngine<SquareTessellation> = RepairEngine::new(vec![], vec![]);
    let (_, warnings) = build_maze(field, graph, 1, qc, repair, &PresetState::empty());
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
        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState) -> RepairResult {
            RepairResult::Failed
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck)]);
    let repair = engine_with_rule(MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(AlwaysFail));
    let (_, warnings) = build_maze(field, graph, 1, qc, repair, &PresetState::empty());
    assert!(!warnings.is_empty());
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
        fn apply(&self, _: &Issue, maze: &mut Maze<SquareTessellation>, _: &mut dyn RngCore, _: &StrategyParams, _: &PresetState) -> RepairResult {
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
        Box::new(MissingEndpointsCheck),
        Box::new(MissingEndpointsCheck),
    ]);
    let repair = engine_with_rule(MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(CountingStrategy { count: Arc::clone(&call_count) }));

    let (_, warnings) = build_maze(field, graph, 1, qc, repair, &PresetState::empty());
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
    graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    graph.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
    graph.add_edge(nodes[2], nodes[0], EdgeKind::Basic);

    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck),
        Box::new(UnreachableFinishCheck),
        Box::new(MinLoopLengthCheck { min_loop_length: 10 }),
    ]);
    let repair = two_rules(
        (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(FarthestEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
        (INVALID_LOOP, &["min_loop_length"], Box::new(InvalidLoopRandomStrategy)),
    );

    let (_, remaining) = build_maze(field, graph, 1, qc, repair, &PresetState::empty());
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
            elements: ElementsConfig { one_way_chance: 0.04 },
            preset_connections: vec![],
            locked_nodes: vec![],
        };
        generate_maze(&mut graph, &field, seed, start, gen_config, &PresetState::empty());

        let qc = QualityControlEngine::new(vec![
            Box::new(MissingEndpointsCheck),
            Box::new(UnreachableFinishCheck),
            Box::new(MinLoopLengthCheck { min_loop_length: 10 }),
        ]);
        let repair = two_rules(
            (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(RandomEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
            (INVALID_LOOP, &["min_loop_length"], Box::new(InvalidLoopRandomStrategy)),
        );

        let (maze, _) = build_maze(field, graph, seed, qc, repair, &PresetState::empty());

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
        elements: ElementsConfig { one_way_chance: 0.04 },
        preset_connections: vec![],
        locked_nodes: vec![],
    };
    generate_maze(&mut graph, &field, seed, start, gen_config, &PresetState::empty());

    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck),
        Box::new(UnreachableFinishCheck),
        Box::new(MinLoopLengthCheck { min_loop_length: 10 }),
    ]);
    let repair = two_rules(
        (MISSING_ENDPOINTS, &["missing_endpoints"], Box::new(RandomEndpointsStrategy) as Box<dyn RepairStrategy<SquareTessellation>>),
        (INVALID_LOOP, &["min_loop_length"], Box::new(InvalidLoopRandomStrategy)),
    );

    let (maze, _) = build_maze(field, graph, seed, qc, repair, &PresetState::empty());

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
    let e0 = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e1 = g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
    let e2 = g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
    // Triangle B: 3->4->5->3
    let e3 = g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
    let e4 = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let e5 = g.add_edge(nodes[5], nodes[3], EdgeKind::Basic);

    struct FakeInvalidLoopCheck {
        cycle: Vec<usize>,
        source_check: &'static str,
    }
    impl<T: maze_core::space::Tessellation> Check<T> for FakeInvalidLoopCheck {
        fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>) {
            // Real checks recompute from current graph state — this fake one must too, or it
            // would keep reporting an already-broken cycle as invalid forever, masking real
            // pipeline behavior (fixpoint exit) behind a check that never reflects the repair.
            if self.cycle.iter().all(|&eid| maze.graph.edge(eid).is_some()) {
                let mut invalid_sources = HashMap::new();
                invalid_sources.insert({
                    let mut key = self.cycle.clone();
                    key.sort_unstable();
                    key
                }, vec![self.source_check]);
                issues.push(Issue::with_data_from_check(
                    INVALID_LOOP,
                    IssueData::InvalidLoops { all: vec![self.cycle.clone()], invalid: vec![0], invalid_sources },
                    self.source_check,
                ));
            }
        }
    }

    let qc = QualityControlEngine::new(vec![
        Box::new(FakeInvalidLoopCheck { cycle: vec![e0, e1, e2], source_check: "fake_a" }),
        Box::new(FakeInvalidLoopCheck { cycle: vec![e3, e4, e5], source_check: "fake_b" }),
    ]);
    let repair = engine_with_rule(INVALID_LOOP, &["fake_a", "fake_b"], Box::new(InvalidLoopRandomStrategy));

    let (maze, remaining) = build_maze(field, g, 1, qc, repair, &PresetState::empty());

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
    let e0 = g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let e1 = g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
    let e2 = g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
    // Triangle B: 3->4->5->3
    let e3 = g.add_edge(nodes[3], nodes[4], EdgeKind::Basic);
    let e4 = g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
    let e5 = g.add_edge(nodes[5], nodes[3], EdgeKind::Basic);

    // Reports triangle A while it's intact; once A is broken, reports triangle B instead —
    // same IssueKind/source check both times, different IssueData::InvalidLoops content.
    struct AlternatingInvalidLoopCheck {
        triangle_a: Vec<usize>,
        triangle_b: Vec<usize>,
    }
    impl<T: maze_core::space::Tessellation> Check<T> for AlternatingInvalidLoopCheck {
        fn check(&self, maze: &Maze<T>, issues: &mut Vec<Issue>) {
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
            invalid_sources.insert(key, vec!["alternating"]);
            issues.push(Issue::with_data_from_check(
                INVALID_LOOP,
                IssueData::InvalidLoops { all: vec![cycle.clone()], invalid: vec![0], invalid_sources },
                "alternating",
            ));
        }
    }

    let qc = QualityControlEngine::new(vec![
        Box::new(AlternatingInvalidLoopCheck { triangle_a: vec![e0, e1, e2], triangle_b: vec![e3, e4, e5] }),
    ]);
    let repair = engine_with_rule(INVALID_LOOP, &["alternating"], Box::new(InvalidLoopRandomStrategy));

    let (maze, remaining) = build_maze(field, g, 1, qc, repair, &PresetState::empty());

    assert!(!remaining.iter().any(|i| i.kind == INVALID_LOOP),
        "both triangles must be resolved across iterations, not falsely stopped after the first: {:?}", remaining);
    let triangle_a_intact = maze.graph.edge(e0).is_some() && maze.graph.edge(e1).is_some() && maze.graph.edge(e2).is_some();
    let triangle_b_intact = maze.graph.edge(e3).is_some() && maze.graph.edge(e4).is_some() && maze.graph.edge(e5).is_some();
    assert!(!triangle_a_intact, "triangle A must have been broken on iteration 1");
    assert!(!triangle_b_intact, "triangle B must have been broken on a later iteration, not skipped by a false oscillation stop");
}
