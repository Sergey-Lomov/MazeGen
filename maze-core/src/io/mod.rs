use crate::Maze;
use crate::space::{SquarePoint, SquareTessellation};

pub fn render_ascii(maze: &Maze<SquareTessellation>) -> String {
    let level = maze.field.single_level_id();
    let field = maze
        .field
        .field_of(level)
        .expect("single_level_id always resolves");
    let (width, height) = {
        let mut max_x = 0i32;
        let mut max_y = 0i32;
        for p in field.all_cells() {
            if p.x > max_x {
                max_x = p.x;
            }
            if p.y > max_y {
                max_y = p.y;
            }
        }
        ((max_x + 1) as usize, (max_y + 1) as usize)
    };

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
            let (ch0, ch1, ch2) = if y == 0 || y == height {
                ('-', '-', '-')
            } else {
                let point_a = SquarePoint {
                    x: x as i32,
                    y: y as i32,
                };
                let point_b = SquarePoint {
                    x: x as i32,
                    y: y as i32 - 1,
                };
                match (
                    field.nodes_at(point_a).first().copied(),
                    field.nodes_at(point_b).first().copied(),
                ) {
                    (Some(a), Some(b)) => {
                        let ab = maze.graph.edge_between(a, b).is_some();
                        let ba = maze.graph.edge_between(b, a).is_some();
                        match (ab, ba) {
                            (true, true) => (' ', ' ', ' '),
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
    for y in 0..height {
        for x in 0..=width {
            let ch = if x == 0 || x == width {
                '|'
            } else {
                let point_a = SquarePoint {
                    x: x as i32,
                    y: y as i32,
                };
                let point_b = SquarePoint {
                    x: x as i32 - 1,
                    y: y as i32,
                };
                match (
                    field.nodes_at(point_a).first().copied(),
                    field.nodes_at(point_b).first().copied(),
                ) {
                    (Some(a), Some(b)) => {
                        let ab = maze.graph.edge_between(a, b).is_some();
                        let ba = maze.graph.edge_between(b, a).is_some();
                        match (ab, ba) {
                            (true, true) => ' ',
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
