use std::collections::HashMap;
use std::hash::Hash;
use crate::ids::{NodeId, IdGenerator};
use crate::graph::Graph;

pub trait Tessellation {
    type Point: Copy + Eq + Hash;
    type Face: Copy + PartialEq + 'static;

    fn step(point: Self::Point, face: Self::Face) -> Self::Point;
    fn faces() -> &'static [Self::Face];
    fn face_between(from: Self::Point, to: Self::Point) -> Option<Self::Face>;
    fn opposite_face(face: Self::Face) -> Option<Self::Face>;
}

pub trait FieldShape {
    type Point: Copy + Eq + Hash;
    fn contains(&self, point: Self::Point) -> bool;
    fn iter_points(&self) -> impl Iterator<Item = Self::Point>;
}

pub trait Field {
    type T: Tessellation;

    fn node_count(&self) -> usize;
    fn neighbors(&self, node: NodeId) -> Vec<NodeId>;
    fn node_at(&self, point: <Self::T as Tessellation>::Point) -> Option<NodeId>;
    fn point_of(&self, node: NodeId) -> Option<<Self::T as Tessellation>::Point>;
    fn build_nodes(&self, graph: &mut Graph);
    fn is_straight(&self, from: NodeId, via: NodeId, to: NodeId) -> bool;
}

pub struct ShapedField<T: Tessellation, S: FieldShape<Point = T::Point>> {
    pub shape: S,
    point_to_node: HashMap<T::Point, NodeId>,
    node_to_point: HashMap<NodeId, T::Point>,
}

impl<T: Tessellation, S: FieldShape<Point = T::Point>> ShapedField<T, S> {
    pub fn new(shape: S, ids: &mut IdGenerator) -> Self {
        let mut point_to_node = HashMap::new();
        let mut node_to_point = HashMap::new();
        for point in shape.iter_points() {
            let id = ids.next_id();
            point_to_node.insert(point, id);
            node_to_point.insert(id, point);
        }
        Self { shape, point_to_node, node_to_point }
    }
}

impl<T: Tessellation, S: FieldShape<Point = T::Point>> Field for ShapedField<T, S> {
    type T = T;

    fn node_count(&self) -> usize {
        self.point_to_node.len()
    }

    fn neighbors(&self, node: NodeId) -> Vec<NodeId> {
        let point = match self.node_to_point.get(&node) {
            Some(p) => *p,
            None => return Vec::new(),
        };
        T::faces()
            .iter()
            .filter_map(|&face| {
                let neighbor_point = T::step(point, face);
                if self.shape.contains(neighbor_point) {
                    self.point_to_node.get(&neighbor_point).copied()
                } else {
                    None
                }
            })
            .collect()
    }

    fn node_at(&self, point: T::Point) -> Option<NodeId> {
        self.point_to_node.get(&point).copied()
    }

    fn point_of(&self, node: NodeId) -> Option<T::Point> {
        self.node_to_point.get(&node).copied()
    }

    fn build_nodes(&self, graph: &mut Graph) {
        let mut ids: Vec<NodeId> = self.node_to_point.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            graph.add_node(id);
        }
    }

    fn is_straight(&self, from: NodeId, via: NodeId, to: NodeId) -> bool {
        let Some(fp) = self.node_to_point.get(&from) else { return false; };
        let Some(vp) = self.node_to_point.get(&via)  else { return false; };
        let Some(tp) = self.node_to_point.get(&to)   else { return false; };
        let Some(face_in)  = T::face_between(*fp, *vp) else { return false; };
        let Some(face_out) = T::face_between(*vp, *tp) else { return false; };
        face_in == face_out
    }
}

// Square tessellation

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct SquarePoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Copy, Clone, PartialEq)]
pub enum SquareFace {
    N,
    S,
    E,
    W,
}

pub struct SquareTessellation;

impl Tessellation for SquareTessellation {
    type Point = SquarePoint;
    type Face = SquareFace;

    fn step(point: SquarePoint, face: SquareFace) -> SquarePoint {
        match face {
            SquareFace::N => SquarePoint { x: point.x, y: point.y + 1 },
            SquareFace::S => SquarePoint { x: point.x, y: point.y - 1 },
            SquareFace::E => SquarePoint { x: point.x + 1, y: point.y },
            SquareFace::W => SquarePoint { x: point.x - 1, y: point.y },
        }
    }

    fn faces() -> &'static [SquareFace] {
        &[SquareFace::N, SquareFace::S, SquareFace::E, SquareFace::W]
    }

    fn face_between(from: SquarePoint, to: SquarePoint) -> Option<SquareFace> {
        match (to.x - from.x, to.y - from.y) {
            (0, 1)  => Some(SquareFace::N),
            (0, -1) => Some(SquareFace::S),
            (1, 0)  => Some(SquareFace::E),
            (-1, 0) => Some(SquareFace::W),
            _       => None,
        }
    }

    fn opposite_face(face: SquareFace) -> Option<SquareFace> {
        Some(match face {
            SquareFace::N => SquareFace::S,
            SquareFace::S => SquareFace::N,
            SquareFace::E => SquareFace::W,
            SquareFace::W => SquareFace::E,
        })
    }
}

pub struct SquareRect {
    pub width: usize,
    pub height: usize,
}

impl FieldShape for SquareRect {
    type Point = SquarePoint;

    fn contains(&self, p: SquarePoint) -> bool {
        p.x >= 0 && p.y >= 0
            && (p.x as usize) < self.width
            && (p.y as usize) < self.height
    }

    fn iter_points(&self) -> impl Iterator<Item = SquarePoint> {
        let w = self.width;
        (0..self.height).flat_map(move |y|
            (0..w).map(move |x| SquarePoint { x: x as i32, y: y as i32 })
        )
    }
}

pub type SquareField = ShapedField<SquareTessellation, SquareRect>;

// Hex tessellation

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct HexPoint {
    pub q: i32,
    pub r: i32,
}

#[derive(Copy, Clone, PartialEq)]
pub enum HexFace {
    E,
    NE,
    NW,
    W,
    SW,
    SE,
}

pub struct HexTessellation;

impl Tessellation for HexTessellation {
    type Point = HexPoint;
    type Face = HexFace;

    fn step(point: HexPoint, face: HexFace) -> HexPoint {
        match face {
            HexFace::E  => HexPoint { q: point.q + 1, r: point.r },
            HexFace::NE => HexPoint { q: point.q + 1, r: point.r - 1 },
            HexFace::NW => HexPoint { q: point.q,     r: point.r - 1 },
            HexFace::W  => HexPoint { q: point.q - 1, r: point.r },
            HexFace::SW => HexPoint { q: point.q - 1, r: point.r + 1 },
            HexFace::SE => HexPoint { q: point.q,     r: point.r + 1 },
        }
    }

    fn faces() -> &'static [HexFace] {
        &[HexFace::E, HexFace::NE, HexFace::NW, HexFace::W, HexFace::SW, HexFace::SE]
    }

    fn face_between(from: HexPoint, to: HexPoint) -> Option<HexFace> {
        match (to.q - from.q, to.r - from.r) {
            (1, 0)   => Some(HexFace::E),
            (1, -1)  => Some(HexFace::NE),
            (0, -1)  => Some(HexFace::NW),
            (-1, 0)  => Some(HexFace::W),
            (-1, 1)  => Some(HexFace::SW),
            (0, 1)   => Some(HexFace::SE),
            _        => None,
        }
    }

    fn opposite_face(face: HexFace) -> Option<HexFace> {
        Some(match face {
            HexFace::E  => HexFace::W,
            HexFace::NE => HexFace::SW,
            HexFace::NW => HexFace::SE,
            HexFace::W  => HexFace::E,
            HexFace::SW => HexFace::NE,
            HexFace::SE => HexFace::NW,
        })
    }
}

pub struct HexParallelogram {
    pub cols: usize,
    pub rows: usize,
}

impl FieldShape for HexParallelogram {
    type Point = HexPoint;

    fn contains(&self, p: HexPoint) -> bool {
        p.q >= 0 && p.r >= 0
            && (p.q as usize) < self.cols
            && (p.r as usize) < self.rows
    }

    fn iter_points(&self) -> impl Iterator<Item = HexPoint> {
        let cols = self.cols;
        (0..self.rows).flat_map(move |r|
            (0..cols).map(move |q| HexPoint { q: q as i32, r: r as i32 })
        )
    }
}

pub struct HexHexagon {
    pub radius: usize,
}

impl FieldShape for HexHexagon {
    type Point = HexPoint;

    fn contains(&self, p: HexPoint) -> bool {
        let n = self.radius as i32;
        p.q.abs() <= n && p.r.abs() <= n && (p.q + p.r).abs() <= n
    }

    fn iter_points(&self) -> impl Iterator<Item = HexPoint> {
        let n = self.radius as i32;
        (-n..=n).flat_map(move |q|
            ((-n).max(-q - n)..=n.min(-q + n)).map(move |r| HexPoint { q, r })
        )
    }
}

pub type HexField<S> = ShapedField<HexTessellation, S>;

// Triangle tessellation

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

pub struct TriRect {
    pub cols: usize,
    pub rows: usize,
}

impl FieldShape for TriRect {
    type Point = TriPoint;

    fn contains(&self, p: TriPoint) -> bool {
        p.col >= 0 && p.row >= 0
            && (p.col as usize) < self.cols
            && (p.row as usize) < self.rows
    }

    fn iter_points(&self) -> impl Iterator<Item = TriPoint> {
        let cols = self.cols;
        (0..self.rows).flat_map(move |row|
            (0..cols).map(move |col| TriPoint { col: col as i32, row: row as i32 })
        )
    }
}

pub type TriField<S> = ShapedField<TriTessellation, S>;

pub struct TriTriangle {
    pub side: usize,
}

impl FieldShape for TriTriangle {
    type Point = TriPoint;

    // Equilateral triangle: apex at row 0 (1 tile), base at row N-1 (2N-1 tiles).
    // indent = N - 1 - row + (N % 2) ensures the apex tile is pointing-down so it has
    // a Base neighbour in row 1 (pointing-down.Base = row+1). Without the parity shift,
    // an odd N produces a pointing-up apex with no downward neighbour, disconnecting the field.
    // Apex col = N-1 + (N%2); pointing-down when N is odd, pointing-down when N is even too.
    fn contains(&self, p: TriPoint) -> bool {
        let n = self.side as i32;
        let shift = n % 2;
        let indent = n - 1 - p.row + shift;
        p.row >= 0 && p.row < n && p.col >= indent && p.col <= indent + 2 * p.row
    }

    fn iter_points(&self) -> impl Iterator<Item = TriPoint> {
        let side = self.side;
        (0..side).flat_map(move |row| {
            let n = side as i32;
            let shift = n % 2;
            let indent = n - 1 - row as i32 + shift;
            (indent..=indent + 2 * row as i32).map(move |col| TriPoint { col, row: row as i32 })
        })
    }
}

pub struct TriHexagon {
    pub radius: usize,
}

impl FieldShape for TriHexagon {
    type Point = TriPoint;

    // Equilateral hexagonal boundary: all 6 sides have R triangle-edges.
    // Rows: 0..2R (total 2R rows). Top row starts with pointing-down → smooth top boundary.
    // Bottom row ends with pointing-up → smooth bottom boundary.
    // odd_base = R-1 if R even, R if R odd (top row indent is odd = pointing-down first).
    // Row r: k = min(r, 2R-1-r), indent = odd_base - k, width = 2*(k+R) + 1.
    fn contains(&self, p: TriPoint) -> bool {
        let r = self.radius as i32;
        if p.row < 0 || p.row >= 2 * r { return false; }
        let odd_base = if r % 2 == 0 { r - 1 } else { r };
        let k = p.row.min(2 * r - 1 - p.row);
        let indent = odd_base - k;
        let width = 2 * (k + r) + 1;
        p.col >= indent && p.col < indent + width
    }

    fn iter_points(&self) -> impl Iterator<Item = TriPoint> {
        let r = self.radius as i32;
        (0..2 * r).flat_map(move |row| {
            let odd_base = if r % 2 == 0 { r - 1 } else { r };
            let k = row.min(2 * r - 1 - row);
            let indent = odd_base - k;
            let width = 2 * (k + r) + 1;
            (indent..indent + width).map(move |col| TriPoint { col, row })
        })
    }
}

#[cfg(test)]
mod tri_tests {
    use super::*;
    use crate::ids::IdGenerator;

    fn make_rect(cols: usize, rows: usize) -> TriField<TriRect> {
        let mut ids = IdGenerator::new();
        ShapedField::new(TriRect { cols, rows }, &mut ids)
    }

    #[test]
    fn tri_rect_node_count() {
        let field = make_rect(4, 3);
        assert_eq!(field.node_count(), 12);
    }

    #[test]
    fn interior_triangle_has_three_neighbors() {
        // In a 4x3 grid, col=2,row=1 is interior for both parity types.
        let field = make_rect(4, 3);
        let node = field.node_at(TriPoint { col: 2, row: 1 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 3);
    }

    #[test]
    fn corner_triangle_has_correct_neighbor_count() {
        let field = make_rect(4, 3);
        // col=0,row=0: pointing-up (parity=0). Base=(0,-1) out of bounds, Left=(-1,0) out of bounds. Only Right=(1,0).
        let node = field.node_at(TriPoint { col: 0, row: 0 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 1);
        // col=1,row=0: pointing-down (parity=1). Base=(1,1) in bounds, Left=(0,0) in bounds, Right=(2,0) in bounds.
        let node = field.node_at(TriPoint { col: 1, row: 0 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 3);
        // col=0,row=1: pointing-down (parity=1). Base=(0,2) in bounds, Left=(-1,1) out of bounds, Right=(1,1) in bounds.
        let node = field.node_at(TriPoint { col: 0, row: 1 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 2);
    }

    #[test]
    fn tri_neighbor_relation_is_symmetric() {
        let field = make_rect(5, 4);
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

    fn make_triangle(side: usize) -> TriField<TriTriangle> {
        let mut ids = IdGenerator::new();
        ShapedField::new(TriTriangle { side }, &mut ids)
    }

    fn make_hexagon(radius: usize) -> TriField<TriHexagon> {
        let mut ids = IdGenerator::new();
        ShapedField::new(TriHexagon { radius }, &mut ids)
    }

    #[test]
    fn tri_triangle_node_count() {
        // N=3: 3^2 = 9 nodes
        let field = make_triangle(3);
        assert_eq!(field.node_count(), 9);
    }

    #[test]
    fn tri_triangle_node_count_n1() {
        // N=1: only apex triangle
        let field = make_triangle(1);
        assert_eq!(field.node_count(), 1);
    }

    #[test]
    fn tri_triangle_apex_has_no_neighbors() {
        // N=1: shift=1, apex at (1,0). All neighbours out of bounds.
        let field = make_triangle(1);
        let node = field.node_at(TriPoint { col: 1, row: 0 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 0);
    }

    #[test]
    fn tri_triangle_interior_has_three_neighbors() {
        // N=4: shift=0, indent(2)=1, cols [1..5]. Point (3,2): parity=1 → down.
        // Base=(3,3): indent(3)=0, cols [0..6] → ok. Left=(2,2) ok. Right=(4,2) ok.
        let field = make_triangle(4);
        let node = field.node_at(TriPoint { col: 3, row: 2 }).unwrap();
        assert_eq!(field.neighbors(node).len(), 3);
    }

    #[test]
    fn tri_triangle_neighbor_relation_is_symmetric() {
        let field = make_triangle(4);
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
        // Odd N used to produce a disconnected field (apex pointing-up had no downward neighbour).
        for side in [1usize, 3, 5] {
            let field = make_triangle(side);
            if field.node_count() == 1 { continue; }
            let mut graph = crate::graph::Graph::new();
            field.build_nodes(&mut graph);
            // Every non-apex node must have at least one neighbour.
            let isolated: Vec<_> = graph.nodes()
                .filter(|n| field.neighbors(n.id).is_empty())
                .collect();
            assert!(isolated.is_empty(), "isolated nodes in triangle side={side}: {isolated:?}");
        }
    }

    #[test]
    fn tri_hexagon_node_count() {
        // R=2: total=24 nodes
        let field = make_hexagon(2);
        assert_eq!(field.node_count(), 24);
    }

    #[test]
    fn tri_hexagon_node_count_r1() {
        // R=1: total=6 nodes
        let field = make_hexagon(1);
        assert_eq!(field.node_count(), 6);
    }

    #[test]
    fn tri_hexagon_neighbor_relation_is_symmetric() {
        let field = make_hexagon(3);
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
