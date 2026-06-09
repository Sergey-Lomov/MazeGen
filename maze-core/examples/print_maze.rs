use std::collections::HashMap;
use maze_core::{IdGenerator, Graph};
use maze_core::space::{SquareField, SquarePoint, SquareRect, ShapedField, Field};
use maze_core::generation::{generate_maze, GenerationConfig, pipeline::build_maze};
use maze_core::validation::is_connected;
use maze_core::io::render_ascii;
use maze_core::quality_control::{QualityControlEngine, MissingEndpointsCheck, UnreachableFinishCheck, MISSING_ENDPOINTS};
use maze_core::repair::{RepairEngine, RepairStrategy, FarthestEndpointsStrategy};

fn main() {
    let seed = 3u64;
    let mut ids = IdGenerator::new();
    let field = ShapedField::new(SquareRect { width: 10, height: 10 }, &mut ids);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    generate_maze(&mut graph, &field, seed, start, GenerationConfig::default());
    assert!(is_connected(&graph, start));

    let qc_engine = QualityControlEngine::new(vec![
        Box::new(MissingEndpointsCheck),
        Box::new(UnreachableFinishCheck),
    ]);
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareField>>> = HashMap::new();
    strategies.insert(MISSING_ENDPOINTS, Box::new(FarthestEndpointsStrategy));
    let repair_engine = RepairEngine::new(strategies, HashMap::new());

    let (maze, warnings) = build_maze(field, graph, seed, qc_engine, repair_engine);
    if !warnings.is_empty() {
        eprintln!("warnings: {:?}", warnings.iter().map(|i| i.kind).collect::<Vec<_>>());
    }

    println!("{}", render_ascii(&maze));
    println!("start:  {:?}", maze.meta.start);
    println!("finish: {:?}", maze.meta.finish);
}
