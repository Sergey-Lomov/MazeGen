use std::collections::HashMap;
use std::hash::Hash;
use crate::ids::{NodeId, IdGenerator};
use crate::graph::Graph;

pub mod square;
pub mod hex;
pub mod triangle;

pub use square::{SquareTessellation, SquarePoint, SquareFace, square_rect};
pub use hex::{HexTessellation, HexPoint, HexFace, hex_parallelogram, hex_hexagon};
pub use triangle::{TriTessellation, TriPoint, TriFace, tri_rect, tri_triangle, tri_hexagon};

pub trait Tessellation {
    type Point: Copy + Eq + Hash;
    type Face: Copy + PartialEq + 'static;

    fn step(point: Self::Point, face: Self::Face) -> Self::Point;
    fn faces() -> &'static [Self::Face];
    fn face_between(from: Self::Point, to: Self::Point) -> Option<Self::Face>;
}

pub struct Field<T: Tessellation> {
    point_to_node: HashMap<T::Point, NodeId>,
    node_to_point: HashMap<NodeId, T::Point>,
}

impl<T: Tessellation> Field<T> {
    pub fn new(
        points: impl IntoIterator<Item = T::Point>,
        ids: &mut IdGenerator,
    ) -> Result<Self, &'static str> {
        let mut point_to_node = HashMap::new();
        let mut node_to_point = HashMap::new();
        for point in points {
            let id = ids.next_id();
            point_to_node.insert(point, id);
            node_to_point.insert(id, point);
        }
        if point_to_node.is_empty() {
            return Err("field is empty");
        }
        Ok(Self { point_to_node, node_to_point })
    }

    pub fn node_count(&self) -> usize {
        self.point_to_node.len()
    }

    pub fn neighbors(&self, node: NodeId) -> Vec<NodeId> {
        let point = match self.node_to_point.get(&node) {
            Some(p) => *p,
            None => return Vec::new(),
        };
        T::faces()
            .iter()
            .filter_map(|&face| {
                let neighbor_point = T::step(point, face);
                self.point_to_node.get(&neighbor_point).copied()
            })
            .collect()
    }

    pub fn node_at(&self, point: T::Point) -> Option<NodeId> {
        self.point_to_node.get(&point).copied()
    }

    pub fn point_of(&self, node: NodeId) -> Option<T::Point> {
        self.node_to_point.get(&node).copied()
    }

    pub fn build_nodes(&self, graph: &mut Graph) {
        let mut ids: Vec<NodeId> = self.node_to_point.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            graph.add_node(id);
        }
    }

    pub fn is_straight(&self, from: NodeId, via: NodeId, to: NodeId) -> bool {
        let Some(fp) = self.node_to_point.get(&from) else { return false; };
        let Some(vp) = self.node_to_point.get(&via)  else { return false; };
        let Some(tp) = self.node_to_point.get(&to)   else { return false; };
        let Some(face_in)  = T::face_between(*fp, *vp) else { return false; };
        let Some(face_out) = T::face_between(*vp, *tp) else { return false; };
        face_in == face_out
    }

    /// Deterministic order: sorted by `NodeId`, not raw `HashMap` iteration order (which
    /// varies between process runs and would make any caller relying on `all_points()`'s
    /// order — tests building a graph from `nodes[i]`, generation, etc. — silently flaky).
    pub fn all_points(&self) -> impl Iterator<Item = T::Point> + '_ {
        let mut ids: Vec<NodeId> = self.node_to_point.keys().copied().collect();
        ids.sort_unstable();
        ids.into_iter().map(move |id| self.node_to_point[&id])
    }

    pub fn contains(&self, point: T::Point) -> bool {
        self.point_to_node.contains_key(&point)
    }
}
