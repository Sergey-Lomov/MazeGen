// GitHub issue #219 — a point can resolve to more than one NodeId via Field::add_node_at.
use std::sync::Arc;

use maze_core::IdGenerator;
use maze_core::space::{Field, SquarePoint, SquareTessellation, Tessellation, square_rect};
use maze_core::space::{HexPoint, HexTessellation, hex_parallelogram};
use maze_core::space::{TriPoint, TriTessellation, tri_rect};

fn make_square_field(width: usize, height: usize) -> (Field<SquareTessellation>, IdGenerator) {
    let mut ids = IdGenerator::new();
    let field = Field::new(Arc::default(), square_rect(width, height), &mut ids).unwrap();
    (field, ids)
}

#[test]
fn add_node_at_creates_a_second_node_and_nodes_at_returns_both_in_creation_order() {
    let (mut field, mut ids) = make_square_field(3, 3);
    let point = SquarePoint { x: 1, y: 1 };
    let original = field.nodes_at(point)[0];

    let added = field.add_node_at(point, &mut ids);

    assert_ne!(original, added);
    assert_eq!(field.nodes_at(point), &[original, added]);
}

#[test]
fn add_node_at_can_be_called_repeatedly_on_the_same_point() {
    let (mut field, mut ids) = make_square_field(3, 3);
    let point = SquarePoint { x: 1, y: 1 };
    let original = field.nodes_at(point)[0];

    let second = field.add_node_at(point, &mut ids);
    let third = field.add_node_at(point, &mut ids);

    assert_eq!(field.nodes_at(point), &[original, second, third]);
}

#[test]
#[should_panic]
fn add_node_at_panics_on_a_point_not_in_the_field() {
    let (mut field, mut ids) = make_square_field(3, 3);
    field.add_node_at(SquarePoint { x: 99, y: 99 }, &mut ids);
}

#[test]
fn neighbors_of_a_neighboring_point_sees_all_nodes_of_a_multi_node_point() {
    let (mut field, mut ids) = make_square_field(3, 3);
    let split_point = SquarePoint { x: 1, y: 1 };
    let original = field.nodes_at(split_point)[0];
    let added = field.add_node_at(split_point, &mut ids);

    let neighbor_of_split = field.nodes_at(SquarePoint { x: 0, y: 1 })[0];
    let neighbors = field.neighbors(neighbor_of_split);

    assert!(neighbors.contains(&original));
    assert!(neighbors.contains(&added));
}

#[test]
fn neighbors_of_two_nodes_at_the_same_point_are_identical() {
    // Not a bug — see GitHub issue #219's design notes: Field has no notion of which faces
    // belong to which of a point's several nodes, so both resolve to the exact same geometric
    // candidate list. Pinned here so a future change doesn't silently break this in one
    // direction only.
    let (mut field, mut ids) = make_square_field(3, 3);
    let split_point = SquarePoint { x: 1, y: 1 };
    let original = field.nodes_at(split_point)[0];
    let added = field.add_node_at(split_point, &mut ids);

    assert_eq!(field.neighbors(original), field.neighbors(added));
}

#[test]
fn added_node_is_not_a_neighbor_of_the_other_node_at_the_same_point() {
    let (mut field, mut ids) = make_square_field(3, 3);
    let split_point = SquarePoint { x: 1, y: 1 };
    let original = field.nodes_at(split_point)[0];
    let added = field.add_node_at(split_point, &mut ids);

    assert!(!field.neighbors(original).contains(&added));
    assert!(!field.neighbors(added).contains(&original));
}

#[test]
fn build_nodes_registers_added_nodes_in_the_graph() {
    let (mut field, mut ids) = make_square_field(2, 2);
    let point = SquarePoint { x: 0, y: 0 };
    let added = field.add_node_at(point, &mut ids);

    let mut graph = maze_core::Graph::new();
    field.build_nodes(&mut graph);

    assert!(graph.nodes().any(|n| n.id == added));
}

fn assert_multi_node_behaves_the_same<T: Tessellation>(
    mut field: Field<T>,
    mut ids: IdGenerator,
    point: T::CellId,
) {
    let original = field.nodes_at(point)[0];
    let added = field.add_node_at(point, &mut ids);
    assert_ne!(original, added);
    assert_eq!(field.neighbors(original), field.neighbors(added));
    assert!(!field.neighbors(original).contains(&added));
}

#[test]
fn hex_tessellation_supports_multi_node_points_the_same_way() {
    let mut ids = IdGenerator::new();
    let field: Field<HexTessellation> =
        Field::new(Arc::default(), hex_parallelogram(3, 3), &mut ids).unwrap();
    assert_multi_node_behaves_the_same(field, ids, HexPoint { q: 1, r: 1 });
}

#[test]
fn tri_tessellation_supports_multi_node_points_the_same_way() {
    let mut ids = IdGenerator::new();
    let field: Field<TriTessellation> =
        Field::new(Arc::default(), tri_rect(4, 3), &mut ids).unwrap();
    assert_multi_node_behaves_the_same(field, ids, TriPoint { col: 2, row: 1 });
}
