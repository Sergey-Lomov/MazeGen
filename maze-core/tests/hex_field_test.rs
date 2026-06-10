use maze_core::IdGenerator;
use maze_core::space::{Field, HexTessellation, HexPoint, hex_parallelogram, hex_hexagon};

fn make_parallelogram(cols: usize, rows: usize) -> Field<HexTessellation> {
    let mut ids = IdGenerator::new();
    Field::new(hex_parallelogram(cols, rows), &mut ids).unwrap()
}

fn make_hexagon(radius: usize) -> Field<HexTessellation> {
    let mut ids = IdGenerator::new();
    Field::new(hex_hexagon(radius), &mut ids).unwrap()
}

// --- HexParallelogram ---

#[test]
fn parallelogram_corner_has_three_neighbors() {
    let field = make_parallelogram(3, 3);
    let node = field.node_at(HexPoint { q: 0, r: 2 }).unwrap();
    assert_eq!(field.neighbors(node).len(), 3);
}

#[test]
fn parallelogram_edge_has_four_neighbors() {
    let field = make_parallelogram(3, 3);
    let node = field.node_at(HexPoint { q: 1, r: 0 }).unwrap();
    assert_eq!(field.neighbors(node).len(), 4);
}

#[test]
fn parallelogram_interior_has_six_neighbors() {
    let field = make_parallelogram(3, 3);
    let node = field.node_at(HexPoint { q: 1, r: 1 }).unwrap();
    assert_eq!(field.neighbors(node).len(), 6);
}

#[test]
fn parallelogram_node_at_unknown_point_is_none() {
    let field = make_parallelogram(3, 3);
    assert!(field.node_at(HexPoint { q: 10, r: 10 }).is_none());
}

#[test]
fn parallelogram_point_of_round_trip() {
    let field = make_parallelogram(3, 3);
    let point = HexPoint { q: 2, r: 1 };
    let node = field.node_at(point).unwrap();
    assert_eq!(field.point_of(node), Some(point));
}

#[test]
fn parallelogram_node_count_matches_size() {
    let field = make_parallelogram(5, 7);
    assert_eq!(field.node_count(), 35);
}

// --- HexHexagon ---

#[test]
fn hexagon_radius0_has_one_node() {
    let field = make_hexagon(0);
    assert_eq!(field.node_count(), 1);
    assert!(field.node_at(HexPoint { q: 0, r: 0 }).is_some());
}

#[test]
fn hexagon_radius1_has_seven_nodes() {
    let field = make_hexagon(1);
    assert_eq!(field.node_count(), 7);
}

#[test]
fn hexagon_radius2_has_nineteen_nodes() {
    let field = make_hexagon(2);
    assert_eq!(field.node_count(), 19);
}

#[test]
fn hexagon_radius3_has_thirtyseven_nodes() {
    let field = make_hexagon(3);
    assert_eq!(field.node_count(), 37);
}

#[test]
fn hexagon_center_has_six_neighbors() {
    let field = make_hexagon(2);
    let center = field.node_at(HexPoint { q: 0, r: 0 }).unwrap();
    assert_eq!(field.neighbors(center).len(), 6);
}

#[test]
fn hexagon_edge_node_has_fewer_neighbors() {
    let field = make_hexagon(2);
    let corner = field.node_at(HexPoint { q: 2, r: 0 }).unwrap();
    assert!(field.neighbors(corner).len() < 6);
}

#[test]
fn hexagon_contains_boundary_points() {
    let field = make_hexagon(2);
    assert!(field.contains(HexPoint { q: 2, r: 0 }));
    assert!(field.contains(HexPoint { q: -2, r: 0 }));
    assert!(field.contains(HexPoint { q: 0, r: 2 }));
    assert!(field.contains(HexPoint { q: 0, r: -2 }));
}

#[test]
fn hexagon_excludes_outside_points() {
    let field = make_hexagon(2);
    assert!(!field.contains(HexPoint { q: 3, r: 0 }));
    assert!(!field.contains(HexPoint { q: 2, r: 1 }));
    assert!(!field.contains(HexPoint { q: -2, r: -1 }));
}

#[test]
fn hexagon_point_of_round_trip() {
    let field = make_hexagon(2);
    let point = HexPoint { q: 1, r: -1 };
    let node = field.node_at(point).unwrap();
    assert_eq!(field.point_of(node), Some(point));
}
