use maze_core::IdGenerator;
use maze_core::space::{HexField, HexPoint, HexSize, Field};

fn make_field(cols: usize, rows: usize) -> HexField {
    let mut ids = IdGenerator::new();
    HexField::new(HexSize { cols, rows }, &mut ids)
}

#[test]
fn parallelogram_corner_has_three_neighbors() {
    let field = make_field(3, 3);
    // (0,2): E=(1,2)✓, NE=(1,1)✓, NW=(0,1)✓, W=(-1,2)✗, SW=(-1,3)✗, SE=(0,3)✗
    let node = field.node_at(HexPoint { q: 0, r: 2 }).unwrap();
    assert_eq!(field.neighbors(node).len(), 3);
}

#[test]
fn parallelogram_edge_has_four_neighbors() {
    let field = make_field(3, 3);
    // (1,0) on r=0 edge: E=(2,0)✓, NE=(2,-1)✗, NW=(1,-1)✗, W=(0,0)✓, SW=(0,1)✓, SE=(1,1)✓
    let node = field.node_at(HexPoint { q: 1, r: 0 }).unwrap();
    assert_eq!(field.neighbors(node).len(), 4);
}

#[test]
fn parallelogram_interior_has_six_neighbors() {
    let field = make_field(3, 3);
    let node = field.node_at(HexPoint { q: 1, r: 1 }).unwrap();
    assert_eq!(field.neighbors(node).len(), 6);
}

#[test]
fn node_at_unknown_point_is_none() {
    let field = make_field(3, 3);
    assert!(field.node_at(HexPoint { q: 10, r: 10 }).is_none());
}

#[test]
fn point_of_round_trip() {
    let field = make_field(3, 3);
    let point = HexPoint { q: 2, r: 1 };
    let node = field.node_at(point).unwrap();
    assert_eq!(field.point_of(node), Some(point));
}

#[test]
fn node_count_matches_size() {
    let field = make_field(5, 7);
    assert_eq!(field.node_count(), 35);
}
