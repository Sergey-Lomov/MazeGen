use std::collections::HashMap;
use std::hash::Hash;
use crate::ids::{NodeId, IdGenerator};
use crate::graph::Graph;

pub trait Tessellation {
    type Point: Copy + Eq + Hash;
    type Face: Copy + 'static;
    type Size;

    fn step(point: Self::Point, face: Self::Face) -> Self::Point;
    fn contains(size: &Self::Size, point: Self::Point) -> bool;
    fn faces() -> &'static [Self::Face];
    fn all_points(size: &Self::Size) -> Vec<Self::Point>;
}

pub trait Field {
    type T: Tessellation;

    fn node_count(&self) -> usize;
    fn neighbors(&self, node: NodeId) -> Vec<NodeId>;
    fn node_at(&self, point: <Self::T as Tessellation>::Point) -> Option<NodeId>;
    fn point_of(&self, node: NodeId) -> Option<<Self::T as Tessellation>::Point>;
    fn build_nodes(&self, graph: &mut Graph);
}

pub struct StandardField<T: Tessellation> {
    pub size: T::Size,
    point_to_node: HashMap<T::Point, NodeId>,
    node_to_point: HashMap<NodeId, T::Point>,
}

impl<T: Tessellation> StandardField<T> {
    pub fn new(size: T::Size, ids: &mut IdGenerator) -> Self {
        let mut point_to_node = HashMap::new();
        let mut node_to_point = HashMap::new();
        for point in T::all_points(&size) {
            let id = ids.next_id();
            point_to_node.insert(point, id);
            node_to_point.insert(id, point);
        }
        Self { size, point_to_node, node_to_point }
    }
}

impl<T: Tessellation> Field for StandardField<T> {
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
                if T::contains(&self.size, neighbor_point) {
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
        for id in self.node_to_point.keys().copied() {
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

pub struct SquareSize {
    pub width: usize,
    pub height: usize,
}

pub struct SquareTessellation;

impl Tessellation for SquareTessellation {
    type Point = SquarePoint;
    type Face = SquareFace;
    type Size = SquareSize;

    fn step(point: SquarePoint, face: SquareFace) -> SquarePoint {
        match face {
            SquareFace::N => SquarePoint { x: point.x, y: point.y + 1 },
            SquareFace::S => SquarePoint { x: point.x, y: point.y - 1 },
            SquareFace::E => SquarePoint { x: point.x + 1, y: point.y },
            SquareFace::W => SquarePoint { x: point.x - 1, y: point.y },
        }
    }

    fn contains(size: &SquareSize, point: SquarePoint) -> bool {
        point.x >= 0
            && point.y >= 0
            && (point.x as usize) < size.width
            && (point.y as usize) < size.height
    }

    fn faces() -> &'static [SquareFace] {
        &[SquareFace::N, SquareFace::S, SquareFace::E, SquareFace::W]
    }

    fn all_points(size: &SquareSize) -> Vec<SquarePoint> {
        let mut points = Vec::with_capacity(size.width * size.height);
        for y in 0..size.height {
            for x in 0..size.width {
                points.push(SquarePoint { x: x as i32, y: y as i32 });
            }
        }
        points
    }
}

pub type SquareField = StandardField<SquareTessellation>;
