use maze_core::IdGenerator;
use maze_core::space::{Field, TriPoint, TriTessellation, tri_hexagon, tri_rect, tri_triangle};
use std::sync::Arc;

fn make_rect_field(cols: usize, rows: usize) -> Field<TriTessellation> {
    let mut ids = IdGenerator::new();
    Field::new(Arc::default(), tri_rect(cols, rows), &mut ids).unwrap()
}

fn make_triangle_field(side: usize) -> Field<TriTessellation> {
    let mut ids = IdGenerator::new();
    Field::new(Arc::default(), tri_triangle(side), &mut ids).unwrap()
}

fn make_hexagon_field(radius: usize) -> Field<TriTessellation> {
    let mut ids = IdGenerator::new();
    Field::new(Arc::default(), tri_hexagon(radius), &mut ids).unwrap()
}

fn assert_neighbors_symmetric(field: &Field<TriTessellation>) {
    let mut graph = maze_core::Graph::new();
    field.build_nodes(&mut graph);
    for node in graph.nodes().map(|n| n.id) {
        for neighbor in field.neighbors(node) {
            assert!(
                field.neighbors(neighbor).contains(&node),
                "neighbor relation not symmetric for node {:?}",
                field.cell_of(node)
            );
        }
    }
}

// --- TriRect ---

#[test]
fn tri_rect_node_count() {
    let field = make_rect_field(4, 3);
    assert_eq!(field.node_count(), 12);
}

#[test]
fn interior_triangle_has_three_neighbors() {
    let field = make_rect_field(4, 3);
    let node = field
        .nodes_at(TriPoint { col: 2, row: 1 })
        .first()
        .copied()
        .unwrap();
    assert_eq!(field.neighbors(node).len(), 3);
}

#[test]
fn corner_triangle_has_correct_neighbor_count() {
    let field = make_rect_field(4, 3);
    let node = field
        .nodes_at(TriPoint { col: 0, row: 0 })
        .first()
        .copied()
        .unwrap();
    assert_eq!(field.neighbors(node).len(), 1);
    let node = field
        .nodes_at(TriPoint { col: 1, row: 0 })
        .first()
        .copied()
        .unwrap();
    assert_eq!(field.neighbors(node).len(), 3);
    let node = field
        .nodes_at(TriPoint { col: 0, row: 1 })
        .first()
        .copied()
        .unwrap();
    assert_eq!(field.neighbors(node).len(), 2);
}

#[test]
fn tri_rect_neighbor_relation_is_symmetric() {
    assert_neighbors_symmetric(&make_rect_field(5, 4));
}

// --- TriTriangle ---

#[test]
fn tri_triangle_node_count() {
    let field = make_triangle_field(3);
    assert_eq!(field.node_count(), 9);
}

#[test]
fn tri_triangle_node_count_n1() {
    let field = make_triangle_field(1);
    assert_eq!(field.node_count(), 1);
}

#[test]
fn tri_triangle_apex_has_no_neighbors() {
    // N=1: shift=1, apex at (1,0). All neighbours out of bounds.
    let field = make_triangle_field(1);
    let node = field
        .nodes_at(TriPoint { col: 1, row: 0 })
        .first()
        .copied()
        .unwrap();
    assert_eq!(field.neighbors(node).len(), 0);
}

#[test]
fn tri_triangle_interior_has_three_neighbors() {
    // N=4: shift=0, indent(2)=1, cols [1..5]. Point (3,2): parity=1 → down.
    let field = make_triangle_field(4);
    let node = field
        .nodes_at(TriPoint { col: 3, row: 2 })
        .first()
        .copied()
        .unwrap();
    assert_eq!(field.neighbors(node).len(), 3);
}

#[test]
fn tri_triangle_neighbor_relation_is_symmetric() {
    assert_neighbors_symmetric(&make_triangle_field(4));
}

#[test]
fn tri_triangle_odd_side_is_connected() {
    for side in [1usize, 3, 5] {
        let field = make_triangle_field(side);
        if field.node_count() == 1 {
            continue;
        }
        let mut graph = maze_core::Graph::new();
        field.build_nodes(&mut graph);
        let isolated: Vec<_> = graph
            .nodes()
            .filter(|n| field.neighbors(n.id).is_empty())
            .collect();
        assert!(
            isolated.is_empty(),
            "isolated nodes in triangle side={side}: {isolated:?}"
        );
    }
}

// --- TriHexagon ---

#[test]
fn tri_hexagon_node_count() {
    let field = make_hexagon_field(2);
    assert_eq!(field.node_count(), 24);
}

#[test]
fn tri_hexagon_node_count_r1() {
    let field = make_hexagon_field(1);
    assert_eq!(field.node_count(), 6);
}

#[test]
fn tri_hexagon_neighbor_relation_is_symmetric() {
    assert_neighbors_symmetric(&make_hexagon_field(3));
}
