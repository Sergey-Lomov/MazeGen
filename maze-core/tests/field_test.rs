use maze_core::{IdGenerator};
use maze_core::space::{SquareField, SquarePoint, SquareRect, ShapedField, Field};

fn make_field(width: usize, height: usize) -> SquareField {
    let mut ids = IdGenerator::new();
    ShapedField::new(SquareRect { width, height }, &mut ids)
}

#[test]
fn corner_node_has_two_neighbors() {
    let field = make_field(4, 4);
    let node = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    assert_eq!(field.neighbors(node).len(), 2);
}

#[test]
fn edge_node_has_three_neighbors() {
    let field = make_field(4, 4);
    let node = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
    assert_eq!(field.neighbors(node).len(), 3);
}

#[test]
fn interior_node_has_four_neighbors() {
    let field = make_field(4, 4);
    let node = field.node_at(SquarePoint { x: 1, y: 1 }).unwrap();
    assert_eq!(field.neighbors(node).len(), 4);
}

#[test]
fn node_at_unknown_point_is_none() {
    let field = make_field(4, 4);
    assert!(field.node_at(SquarePoint { x: 10, y: 10 }).is_none());
}

#[test]
fn point_of_round_trip() {
    let field = make_field(4, 4);
    let point = SquarePoint { x: 2, y: 3 };
    let node = field.node_at(point).unwrap();
    assert_eq!(field.point_of(node), Some(point));
}

#[test]
fn node_count_matches_size() {
    let field = make_field(5, 7);
    assert_eq!(field.node_count(), 35);
}
