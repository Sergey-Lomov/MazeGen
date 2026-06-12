use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use maze_core::{Graph, IdGenerator};
use maze_core::space::{Field, SquareTessellation, SquarePoint, square_rect};
use maze_core::generation::{generate_maze, GenerationConfig, PresetState, pipeline::build_maze};
use maze_core::quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MISSING_ENDPOINTS};
use maze_core::repair::{RepairEngine, RepairStrategy, FarthestEndpointsStrategy, StrategyParams};

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
    let (maze, warnings) = build_maze(field, graph, 42, qc, repair);
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
        let (maze, _) = build_maze(field, graph, seed, qc, repair);
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
    let (_, warnings) = build_maze(field, graph, 1, qc, repair);
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
        fn apply(&self, _: &Issue, _: &mut Maze<SquareTessellation>, _: &mut dyn RngCore, _: &StrategyParams) -> RepairResult {
            RepairResult::Failed
        }
    }

    let (field, graph) = make_generated_graph(1);
    let qc = QualityControlEngine::new(vec![Box::new(MissingEndpointsCheck)]);
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareTessellation>>> = HashMap::new();
    strategies.insert(MISSING_ENDPOINTS, Box::new(AlwaysFail));
    let repair = RepairEngine::new(strategies, HashMap::new());
    let (_, warnings) = build_maze(field, graph, 1, qc, repair);
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
        fn apply(&self, _: &Issue, maze: &mut Maze<SquareTessellation>, _: &mut dyn RngCore, _: &StrategyParams) -> RepairResult {
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

    let (_, warnings) = build_maze(field, graph, 1, qc, repair);
    assert!(warnings.is_empty(), "unexpected warnings: {:?}", warnings);
    assert_eq!(call_count.load(Ordering::SeqCst), 1, "strategy called more than once for duplicate issue");
}
