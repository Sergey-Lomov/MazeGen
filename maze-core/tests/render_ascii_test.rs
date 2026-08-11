use maze_core::{Maze, Graph, IdGenerator};
use maze_core::graph::EdgeKind;
use maze_core::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
use maze_core::io::render_ascii;

use maze_core::NodeId;

fn make_maze(width: usize, height: usize) -> (Maze<SquareTessellation>, Vec<Vec<NodeId>>) {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(square_rect(width, height), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let nodes: Vec<Vec<NodeId>> = (0..height)
        .map(|y| (0..width)
            .map(|x| field.nodes_at(level, SquarePoint { x: x as i32, y: y as i32 }).first().copied().unwrap())
            .collect())
        .collect();
    let maze = Maze::new(field, graph);
    (maze, nodes)
}

#[test]
fn wall_rendered_when_no_edge() {
    let (maze, _) = make_maze(2, 2);
    let output = render_ascii(&maze);
    // no edges at all — every internal wall should be present
    assert!(output.contains("---"), "horizontal wall missing");
    assert!(output.contains('|'), "vertical wall missing");
}

#[test]
fn open_passage_rendered_for_bidirectional_edge() {
    let (mut maze, nodes) = make_maze(2, 1);
    let left = nodes[0][0];
    let right = nodes[0][1];
    maze.graph.build_initial_bidirectional_edge(left, right, EdgeKind::Basic);
    let output = render_ascii(&maze);
    // 2x1 maze: single content row looks like "| [passage] |"
    // with bidirectional edge the middle '|' should be ' ' not '|'
    // content row is the one without '+' characters
    let content_row = output.lines().find(|l| !l.contains('+')).unwrap();
    // strip outer border '|' chars (first and last), check no internal '|'
    let inner = &content_row[1..content_row.len() - 1];
    assert!(!inner.contains('|'), "bidirectional passage should remove internal wall, got: {content_row}");
}

#[test]
fn directed_east_edge_renders_arrow() {
    let (mut maze, nodes) = make_maze(2, 1);
    let left = nodes[0][0];
    let right = nodes[0][1];
    maze.graph.build_initial_edge(left, right, EdgeKind::Basic); // only left→right
    let output = render_ascii(&maze);
    assert!(output.contains('>'), "eastward directed edge should render '>'");
}

#[test]
fn directed_west_edge_renders_arrow() {
    let (mut maze, nodes) = make_maze(2, 1);
    let left = nodes[0][0];
    let right = nodes[0][1];
    maze.graph.build_initial_edge(right, left, EdgeKind::Basic); // only right→left
    let output = render_ascii(&maze);
    assert!(output.contains('<'), "westward directed edge should render '<'");
}

#[test]
fn directed_north_edge_renders_arrow() {
    let (mut maze, nodes) = make_maze(1, 2);
    let bottom = nodes[0][0];
    let top = nodes[1][0];
    maze.graph.build_initial_edge(bottom, top, EdgeKind::Basic); // bottom→top = northward
    let output = render_ascii(&maze);
    assert!(output.contains('^'), "northward directed edge should render '^'");
}

#[test]
fn directed_south_edge_renders_arrow() {
    let (mut maze, nodes) = make_maze(1, 2);
    let bottom = nodes[0][0];
    let top = nodes[1][0];
    maze.graph.build_initial_edge(top, bottom, EdgeKind::Basic); // top→bottom = southward
    let output = render_ascii(&maze);
    assert!(output.contains('v'), "southward directed edge should render 'v'");
}
