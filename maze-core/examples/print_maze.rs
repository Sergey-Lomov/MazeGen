use std::collections::HashMap;
use maze_core::{IdGenerator, Graph};
use maze_core::space::{SquareField, SquarePoint, SquareSize, Field};
use maze_core::generation::{generate_maze, pipeline::build_maze};
use maze_core::validation::is_connected;
use maze_core::io::render_ascii;
use maze_core::quality_control::{QualityControlEngine, MissingStartCheck, MissingFinishCheck, MISSING_START, MISSING_FINISH};
use maze_core::repair::{RepairEngine, RepairStrategy, CreateStartStrategy, CreateFinishStrategy};

fn main() {
    let seed = 3u64;
    let mut ids = IdGenerator::new();
    let field = SquareField::new(SquareSize { width: 10, height: 10 }, &mut ids);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    generate_maze(&mut graph, &field, seed, start);
    assert!(is_connected(&graph, start));

    let qc_engine = QualityControlEngine::new(vec![
        Box::new(MissingStartCheck),
        Box::new(MissingFinishCheck),
    ]);
    let mut strategies: HashMap<_, Box<dyn RepairStrategy<SquareField>>> = HashMap::new();
    strategies.insert(MISSING_START, Box::new(CreateStartStrategy));
    strategies.insert(MISSING_FINISH, Box::new(CreateFinishStrategy));
    let repair_engine = RepairEngine::new(strategies);

    let maze = build_maze(field, graph, seed, qc_engine, repair_engine)
        .expect("pipeline failed");

    println!("{}", render_ascii(&maze));
    println!("start:  {:?}", maze.meta.start);
    println!("finish: {:?}", maze.meta.finish);
}
