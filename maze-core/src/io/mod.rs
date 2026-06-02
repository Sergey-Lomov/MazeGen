use crate::space::{SquareField, SquarePoint, Field};
use crate::Maze;

pub fn render_ascii(maze: &Maze<SquareField>) -> String {
    let width = maze.field.size.width;
    let height = maze.field.size.height;
    let cols = 4 * width + 1;
    let rows = 2 * height + 1;

    let mut grid: Vec<Vec<char>> = vec![vec![' '; cols]; rows];

    // corners
    for y in 0..=height {
        for x in 0..=width {
            grid[2 * y][4 * x] = '+';
        }
    }

    // horizontal walls (between row y and y-1)
    for y in 0..=height {
        for x in 0..width {
            let wall = if y == 0 || y == height {
                true
            } else {
                let point_a = SquarePoint { x: x as i32, y: y as i32 };
                let point_b = SquarePoint { x: x as i32, y: y as i32 - 1 };
                match (maze.field.node_at(point_a), maze.field.node_at(point_b)) {
                    (Some(a), Some(b)) => maze.graph.edge_between(a, b).is_none(),
                    _ => true,
                }
            };
            let ch = if wall { '-' } else { ' ' };
            grid[2 * y][4 * x + 1] = ch;
            grid[2 * y][4 * x + 2] = ch;
            grid[2 * y][4 * x + 3] = ch;
        }
    }

    // vertical walls (between col x and x-1)
    for y in 0..height {
        for x in 0..=width {
            let wall = if x == 0 || x == width {
                true
            } else {
                let point_a = SquarePoint { x: x as i32, y: y as i32 };
                let point_b = SquarePoint { x: x as i32 - 1, y: y as i32 };
                match (maze.field.node_at(point_a), maze.field.node_at(point_b)) {
                    (Some(a), Some(b)) => maze.graph.edge_between(a, b).is_none(),
                    _ => true,
                }
            };
            grid[2 * y + 1][4 * x] = if wall { '|' } else { ' ' };
        }
    }

    grid.iter()
        .rev()
        .map(|row| row.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}
