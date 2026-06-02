use maze_core::{Maze, IdGenerator, Graph};
use maze_core::space::{SquareField, SquarePoint, SquareSize, Field};
use maze_core::generation::generate_maze;
use maze_core::validation::is_connected;
use maze_core::io::render_ascii;

fn main() {
    let mut ids = IdGenerator::new();
    let field = SquareField::new(SquareSize { width: 10, height: 10 }, &mut ids);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let mut maze = Maze { field, graph };
    {
        let Maze { ref mut graph, ref field } = maze;
        generate_maze(graph, field, 3, start);
    }
    assert!(is_connected(&maze.graph, start));
    println!("{}", render_ascii(&maze));
}
