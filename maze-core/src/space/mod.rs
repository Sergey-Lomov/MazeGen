use std::collections::HashMap;
use std::hash::Hash;
use crate::ids::{NodeId, IdGenerator};
use crate::graph::Graph;

pub trait Tessellation {
    type Point: Copy + Eq + Hash;
    type Face: Copy + 'static;

    fn step(point: Self::Point, face: Self::Face) -> Self::Point;
    fn faces() -> &'static [Self::Face];
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
}

// Square tessellation

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct SquarePoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Copy, Clone)]
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

#[derive(Copy, Clone)]
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
