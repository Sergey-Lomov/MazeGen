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

    /// Canonical Cartesian projection of `point`, in unit tile scale (one tile = 1.0), with no
    /// rendering-specific orientation/rotation applied — a display-only concept (e.g. hex
    /// flat_top/pointy_top, tri r0/r90/r180/r270 in `maze-web`) that stays entirely on the web
    /// side, since core has no notion of it. Never a pixel coordinate — callers needing pixels
    /// scale and (for hex/tri) rotate this themselves. Used for geometric (as opposed to
    /// logical/graph) distance between two points — see `geometric_distance` below.
    ///
    /// **Not required to agree on a shared sign/offset convention across tessellations** — each
    /// impl only has to be internally consistent (same point always maps to the same coordinate,
    /// distances behave as expected for that tessellation's own geometry). `SquarePoint`'s impl
    /// returns the raw `(x, y)` grid coordinate (the tile's corner, no Y flip); `HexPoint`'s and
    /// `TriPoint`'s impls happen to bake in a screen-style Y flip (and, for `TriPoint`, a
    /// half-tile centering offset) because their formulas were ported directly from
    /// `maze-web`'s pre-existing pixel-space `hexCenter`/`triCenter` — not because `cartesian` as
    /// a concept requires it. `geometric_distance` is unaffected either way (translation/
    /// reflection are isometries, so distances come out identical regardless of which convention
    /// an impl picked); callers doing anything convention-sensitive (e.g. `maze-web`'s
    /// `squareCenter`/`hexCenter`/`triCenter`, which each apply their own scale/offset/rotation on
    /// top) must check the specific impl's doc comment rather than assume one is like another.
    fn cartesian(point: Self::Point) -> (f64, f64);
}

/// Euclidean distance (in unit tile scale) between two points of the same tessellation, via
/// `Tessellation::cartesian`. Purely geometric — unrelated to graph/nav distance
/// (`MazeAnalysis::distance_from_start`/`distance_from_finish`), which counts tile-hops along
/// actual edges instead.
pub fn geometric_distance<T: Tessellation>(a: T::Point, b: T::Point) -> f64 {
    let (ax, ay) = T::cartesian(a);
    let (bx, by) = T::cartesian(b);
    ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt()
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

#[cfg(test)]
mod geometric_distance_tests {
    use super::*;
    use crate::space::{SquarePoint, HexPoint, TriPoint};

    #[test]
    fn square_adjacent_cells_are_one_tile_apart() {
        let d = geometric_distance::<SquareTessellation>(
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 0 },
        );
        assert!((d - 1.0).abs() < 1e-9);
    }

    #[test]
    fn square_diagonal_neighbors_use_pythagorean_distance() {
        let d = geometric_distance::<SquareTessellation>(
            SquarePoint { x: 0, y: 0 },
            SquarePoint { x: 1, y: 1 },
        );
        assert!((d - 2f64.sqrt()).abs() < 1e-9);
    }

    #[test]
    fn geometric_distance_is_symmetric() {
        let a = SquarePoint { x: 2, y: 5 };
        let b = SquarePoint { x: -3, y: 1 };
        let ab = geometric_distance::<SquareTessellation>(a, b);
        let ba = geometric_distance::<SquareTessellation>(b, a);
        assert!((ab - ba).abs() < 1e-9);
    }

    #[test]
    fn distance_to_self_is_zero() {
        let p = SquarePoint { x: 7, y: -3 };
        assert_eq!(geometric_distance::<SquareTessellation>(p, p), 0.0);
    }

    #[test]
    fn hex_adjacent_cells_are_at_center_to_center_distance() {
        // (0,0) -E-> (1,0) is a direct neighbor (HexFace::E). Center-to-center distance for a
        // flat_top hex at unit tile scale (circumradius 1.0) is TILE_SIZE * sqrt(3) — same
        // geometric relationship `maze-web`'s hexCenter formula produces at pixel scale.
        let d = geometric_distance::<HexTessellation>(
            HexPoint { q: 0, r: 0 },
            HexPoint { q: 1, r: 0 },
        );
        assert!((d - 3f64.sqrt()).abs() < 1e-9, "distance was {d}");
    }

    #[test]
    fn hex_all_six_neighbors_are_equidistant() {
        let center = HexPoint { q: 0, r: 0 };
        let neighbors = [
            HexPoint { q: 1, r: 0 }, HexPoint { q: 1, r: -1 }, HexPoint { q: 0, r: -1 },
            HexPoint { q: -1, r: 0 }, HexPoint { q: -1, r: 1 }, HexPoint { q: 0, r: 1 },
        ];
        let expected = 3f64.sqrt();
        for n in neighbors {
            let d = geometric_distance::<HexTessellation>(center, n);
            assert!((d - expected).abs() < 1e-9, "neighbor {n:?} at distance {d}, expected {expected}");
        }
    }

    #[test]
    fn tri_adjacent_cells_via_left_right_face_are_at_center_to_center_distance() {
        // (0,0) pointing-up, (1,0) pointing-down (Left/Right neighbors share a vertical edge).
        // Center-to-center distance for adjacent up/down triangles sharing a vertical edge is
        // S / sqrt(3) (S = triangle side length = 2.0 at unit tile scale).
        let d = geometric_distance::<TriTessellation>(
            TriPoint { col: 0, row: 0 },
            TriPoint { col: 1, row: 0 },
        );
        let expected = 2.0 / 3f64.sqrt();
        assert!((d - expected).abs() < 1e-9, "distance was {d}, expected {expected}");
    }

    #[test]
    fn tri_non_adjacent_cell_is_farther_than_adjacent() {
        let origin = TriPoint { col: 0, row: 0 };
        let adjacent = geometric_distance::<TriTessellation>(origin, TriPoint { col: 1, row: 0 });
        let farther = geometric_distance::<TriTessellation>(origin, TriPoint { col: 5, row: 5 });
        assert!(farther > adjacent);
    }
}
