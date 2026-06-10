use super::Tessellation;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct TriPoint {
    pub col: i32,
    pub row: i32,
}

#[derive(Copy, Clone, PartialEq)]
pub enum TriFace {
    Left,
    Right,
    Base,
}

pub struct TriTessellation;

impl Tessellation for TriTessellation {
    type Point = TriPoint;
    type Face = TriFace;

    fn step(point: TriPoint, face: TriFace) -> TriPoint {
        let pointing_up = (point.col + point.row).rem_euclid(2) == 0;
        match face {
            TriFace::Left  => TriPoint { col: point.col - 1, row: point.row },
            TriFace::Right => TriPoint { col: point.col + 1, row: point.row },
            TriFace::Base  => if pointing_up {
                TriPoint { col: point.col, row: point.row - 1 }
            } else {
                TriPoint { col: point.col, row: point.row + 1 }
            },
        }
    }

    fn faces() -> &'static [TriFace] {
        &[TriFace::Left, TriFace::Right, TriFace::Base]
    }

    fn face_between(from: TriPoint, to: TriPoint) -> Option<TriFace> {
        let pointing_up = (from.col + from.row).rem_euclid(2) == 0;
        match (to.col - from.col, to.row - from.row) {
            (-1, 0) => Some(TriFace::Left),
            (1, 0)  => Some(TriFace::Right),
            (0, dy) if (pointing_up && dy == -1) || (!pointing_up && dy == 1) => Some(TriFace::Base),
            _ => None,
        }
    }

    fn opposite_face(_: TriFace) -> Option<TriFace> {
        None
    }
}

pub fn tri_rect(cols: usize, rows: usize) -> Vec<TriPoint> {
    (0..rows)
        .flat_map(|row| (0..cols).map(move |col| TriPoint { col: col as i32, row: row as i32 }))
        .collect()
}

pub fn tri_triangle(side: usize) -> Vec<TriPoint> {
    // Equilateral triangle: apex at row 0 (1 tile), base at row N-1 (2N-1 tiles).
    // indent = N - 1 - row + (N % 2) ensures the apex tile is pointing-down so it has
    // a Base neighbour in row 1 (pointing-down.Base = row+1). Without the parity shift,
    // an odd N produces a pointing-up apex with no downward neighbour, disconnecting the field.
    let n = side as i32;
    let shift = n % 2;
    (0..side)
        .flat_map(move |row| {
            let indent = n - 1 - row as i32 + shift;
            (indent..=indent + 2 * row as i32).map(move |col| TriPoint { col, row: row as i32 })
        })
        .collect()
}

pub fn tri_hexagon(radius: usize) -> Vec<TriPoint> {
    // Equilateral hexagonal boundary: all 6 sides have R triangle-edges.
    // Rows: 0..2R (total 2R rows). Top row starts with pointing-down → smooth top boundary.
    // Bottom row ends with pointing-up → smooth bottom boundary.
    // odd_base = R-1 if R even, R if R odd (top row indent is odd = pointing-down first).
    // Row r: k = min(r, 2R-1-r), indent = odd_base - k, width = 2*(k+R) + 1.
    let r = radius as i32;
    let odd_base = if r % 2 == 0 { r - 1 } else { r };
    (0..2 * r)
        .flat_map(move |row| {
            let k = row.min(2 * r - 1 - row);
            let indent = odd_base - k;
            let width = 2 * (k + r) + 1;
            (indent..indent + width).map(move |col| TriPoint { col, row })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::IdGenerator;
    use crate::space::Field;

    fn make_rect_field(cols: usize, rows: usize) -> Field<TriTessellation> {
        let mut ids = IdGenerator::new();
        Field::new(tri_rect(cols, rows), &mut ids).unwrap()
    }

    fn make_triangle_field(side: usize) -> Field<TriTessellation> {
        let mut ids = IdGenerator::new();
        Field::new(tri_triangle(side), &mut ids).unwrap()
    }

    fn make_hexagon_field(radius: usize) -> Field<TriTessellation> {
        let mut ids = IdGenerator::new();
        Field::new(tri_hexagon(radius), &mut ids).unwrap()
    }

    #[test]
    fn tri_rect_node_count() {
        let field = make_rect_field(4, 3);
        assert_eq!(field.node_count(), 12);
    }

    #[test]
    fn interior_triangle_has_three_neighbors() {
        let field = make_rect_field(4, 3);
        let node = field.node_at(TriPoint { col: 2, row: 1 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 3);
    }

    #[test]
    fn corner_triangle_has_correct_neighbor_count() {
        let field = make_rect_field(4, 3);
        let node = field.node_at(TriPoint { col: 0, row: 0 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 1);
        let node = field.node_at(TriPoint { col: 1, row: 0 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 3);
        let node = field.node_at(TriPoint { col: 0, row: 1 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 2);
    }

    #[test]
    fn tri_neighbor_relation_is_symmetric() {
        let field = make_rect_field(5, 4);
        let mut graph = crate::graph::Graph::new();
        field.build_nodes(&mut graph);
        for node in graph.nodes().map(|n| n.id) {
            for neighbor in field.neighbors(node) {
                assert!(
                    field.neighbors(neighbor).contains(&node),
                    "neighbor relation not symmetric for node {:?}",
                    field.point_of(node)
                );
            }
        }
    }

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
        let node = field.node_at(TriPoint { col: 1, row: 0 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 0);
    }

    #[test]
    fn tri_triangle_interior_has_three_neighbors() {
        // N=4: shift=0, indent(2)=1, cols [1..5]. Point (3,2): parity=1 → down.
        let field = make_triangle_field(4);
        let node = field.node_at(TriPoint { col: 3, row: 2 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 3);
    }

    #[test]
    fn tri_triangle_neighbor_relation_is_symmetric() {
        let field = make_triangle_field(4);
        let mut graph = crate::graph::Graph::new();
        field.build_nodes(&mut graph);
        for node in graph.nodes().map(|n| n.id) {
            for neighbor in field.neighbors(node) {
                assert!(
                    field.neighbors(neighbor).contains(&node),
                    "tri_triangle neighbor relation not symmetric for node {:?}",
                    field.point_of(node)
                );
            }
        }
    }

    #[test]
    fn tri_triangle_odd_side_is_connected() {
        for side in [1usize, 3, 5] {
            let field = make_triangle_field(side);
            if field.node_count() == 1 { continue; }
            let mut graph = crate::graph::Graph::new();
            field.build_nodes(&mut graph);
            let isolated: Vec<_> = graph.nodes()
                .filter(|n| field.neighbors(n.id).is_empty())
                .collect();
            assert!(isolated.is_empty(), "isolated nodes in triangle side={side}: {isolated:?}");
        }
    }

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
        let field = make_hexagon_field(3);
        let mut graph = crate::graph::Graph::new();
        field.build_nodes(&mut graph);
        for node in graph.nodes().map(|n| n.id) {
            for neighbor in field.neighbors(node) {
                assert!(
                    field.neighbors(neighbor).contains(&node),
                    "tri_hexagon neighbor relation not symmetric for node {:?}",
                    field.point_of(node)
                );
            }
        }
    }
}
