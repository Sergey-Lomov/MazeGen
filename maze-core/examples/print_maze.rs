use rand::SeedableRng;
use rand::rngs::SmallRng;
use maze_core::{Maze, IdGenerator, Graph, MazeMeta, RuleEngine, AssignStartRule, AssignFinishRule};
use maze_core::space::{SquareField, SquarePoint, SquareSize, Field};
use maze_core::generation::generate_maze;
use maze_core::validation::is_connected;
use maze_core::io::render_ascii;

fn main() {
    let seed = 3u64;
    let mut ids = IdGenerator::new();
    let field = SquareField::new(SquareSize { width: 10, height: 10 }, &mut ids);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    generate_maze(&mut graph, &field, seed, start);
    assert!(is_connected(&graph, start));

    let mut meta = MazeMeta::empty();
    let mut rng = SmallRng::seed_from_u64(seed);
    let engine = RuleEngine::new(vec![
        Box::new(AssignStartRule),
        Box::new(AssignFinishRule),
    ]);
    engine.run(&mut graph, &mut meta, &mut rng);

    let maze = Maze { field, graph, meta };
    println!("{}", render_ascii(&maze));
    println!("start:  {:?}", maze.meta.start);
    println!("finish: {:?}", maze.meta.finish);
}
