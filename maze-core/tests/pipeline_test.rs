use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use maze_core::{Graph, IdGenerator};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationAlgorithm, EdgeBasedParams, ElementsConfig, GenerationConfig, PresetState, pipeline::build_maze};
use maze_core::graph::EdgeKind;
use maze_core::quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MinLoopLengthCheck, MISSING_ENDPOINTS, MIN_LOOP_LENGTH};
use maze_core::repair::{RepairEngine, RepairStrategy, FarthestEndpointsStrategy, RandomEndpointsStrategy, MinLoopLengthRandomStrategy, StrategyParams};

fn make_engines() -> (QualityControlEngine<SquareTessellation>, RepairEngine<SquareTessellation>) {
    let qc = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck),
        Box::new(UnreachableFinishCheck),
    ]);
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareTessellation>>> = HashMap::new();
    strategies.insert(MISSING_ENDPOINTS, Box::new(FarthestEndpointsStrategy));
    let repair = RepairEngine::new(strategies, HashMap::new());
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
    let repair: RepairEngine<SquareTessellation> = RepairEngine::new(HashMap::new(), HashMap::new());
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
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareTessellation>>> = HashMap::new();
    strategies.insert(MISSING_ENDPOINTS, Box::new(AlwaysFail));
    let repair = RepairEngine::new(strategies, HashMap::new());
    let (_, warnings) = build_maze(field, graph, 1, qc, repair, &PresetState::empty());
    assert!(!warnings.is_empty());
}

#[test]
fn pipeline_deduplicates_issues_from_duplicate_checks() {
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
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareTessellation>>> = HashMap::new();
    strategies.insert(MISSING_ENDPOINTS, Box::new(CountingStrategy { count: Arc::clone(&call_count) }));
    let repair = RepairEngine::new(strategies, HashMap::new());

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
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareTessellation>>> = HashMap::new();
    strategies.insert(MISSING_ENDPOINTS, Box::new(FarthestEndpointsStrategy));
    strategies.insert(MIN_LOOP_LENGTH, Box::new(MinLoopLengthRandomStrategy));
    let repair = RepairEngine::new(strategies, HashMap::new());

    let (_, remaining) = build_maze(field, graph, 1, qc, repair, &PresetState::empty());
    assert!(!remaining.iter().any(|i| i.kind == MIN_LOOP_LENGTH),
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
        let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareTessellation>>> = HashMap::new();
        strategies.insert(MISSING_ENDPOINTS, Box::new(RandomEndpointsStrategy));
        strategies.insert(MIN_LOOP_LENGTH, Box::new(MinLoopLengthRandomStrategy));
        let repair = RepairEngine::new(strategies, HashMap::new());

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
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareTessellation>>> = HashMap::new();
    strategies.insert(MISSING_ENDPOINTS, Box::new(RandomEndpointsStrategy));
    strategies.insert(MIN_LOOP_LENGTH, Box::new(MinLoopLengthRandomStrategy));
    let repair = RepairEngine::new(strategies, HashMap::new());

    let (maze, _) = build_maze(field, graph, seed, qc, repair, &PresetState::empty());

    for node in maze.graph.nodes() {
        let degree = maze.graph.edges().filter(|e| e.from == node.id || e.to == node.id).count();
        assert!(degree > 0, "node {} was fully cut off from the graph", node.id);
    }
}
