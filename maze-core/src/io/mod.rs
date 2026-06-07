use crate::space::{SquareField, SquarePoint, Field};
use crate::Maze;

pub fn render_ascii(maze: &Maze<SquareField>) -> String {
    let width = maze.field.shape.width;
    let height = maze.field.shape.height;
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
    // point_a = (x, y) [north cell], point_b = (x, y-1) [south cell]
    // ab = north→south, ba = south→north
    for y in 0..=height {
        for x in 0..width {
            let (ch0, ch1, ch2) = if y == 0 || y == height {
                ('-', '-', '-')
            } else {
                let point_a = SquarePoint { x: x as i32, y: y as i32 };
                let point_b = SquarePoint { x: x as i32, y: y as i32 - 1 };
                match (maze.field.node_at(point_a), maze.field.node_at(point_b)) {
                    (Some(a), Some(b)) => {
                        let ab = maze.graph.edge_between(a, b).is_some();
                        let ba = maze.graph.edge_between(b, a).is_some();
                        match (ab, ba) {
                            (true, true)  => (' ', ' ', ' '),
                            (true, false) => (' ', 'v', ' '),
                            (false, true) => (' ', '^', ' '),
                            (false, false) => ('-', '-', '-'),
                        }
                    }
                    _ => ('-', '-', '-'),
                }
            };
            grid[2 * y][4 * x + 1] = ch0;
            grid[2 * y][4 * x + 2] = ch1;
            grid[2 * y][4 * x + 3] = ch2;
        }
    }

    // vertical walls (between col x and x-1)
    // point_a = (x, y) [east cell], point_b = (x-1, y) [west cell]
    // ab = east→west, ba = west→east
    for y in 0..height {
        for x in 0..=width {
            let ch = if x == 0 || x == width {
                '|'
            } else {
                let point_a = SquarePoint { x: x as i32, y: y as i32 };
                let point_b = SquarePoint { x: x as i32 - 1, y: y as i32 };
                match (maze.field.node_at(point_a), maze.field.node_at(point_b)) {
                    (Some(a), Some(b)) => {
                        let ab = maze.graph.edge_between(a, b).is_some();
                        let ba = maze.graph.edge_between(b, a).is_some();
                        match (ab, ba) {
                            (true, true)  => ' ',
                            (true, false) => '<',
                            (false, true) => '>',
                            (false, false) => '|',
                        }
                    }
                    _ => '|',
                }
            };
            grid[2 * y + 1][4 * x] = ch;
        }
    }

    grid.iter()
        .rev()
        .map(|row| row.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}
