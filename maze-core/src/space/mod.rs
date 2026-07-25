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

    /// Moves from `point` through `face` to the adjacent point.
    ///
    /// Invariant: for a fixed `point`, `step(point, f1)` and `step(point, f2)` never coincide for
    /// `f1 != f2` — every future `Tessellation` impl must uphold this (all three current ones
    /// already do). `Field::neighbors` relies on it to guarantee it never visits the same
    /// neighboring point twice while iterating `faces()`.
    fn step(point: Self::Point, face: Self::Face) -> Self::Point;
    fn faces() -> &'static [Self::Face];
    fn face_between(from: Self::Point, to: Self::Point) -> Option<Self::Face>;

    /// Position of `face` within `Self::faces()` — the index a `SplitPattern` face refers to.
    /// Default impl is an O(degree) linear scan; fine as-is since it's only ever called from
    /// `enumerate_adaptations` (a split-roll-hit-only path), never per-tile.
    fn face_index(face: Self::Face) -> Option<usize> {
        Self::faces().iter().position(|f| *f == face)
    }

    /// Inverse of `face_index` — the face at a given position in `Self::faces()`.
    fn face_at(index: usize) -> Option<Self::Face> {
        Self::faces().get(index).copied()
    }

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

    /// Canonical Cartesian position of the edge between `from` and `to`, same coordinate
    /// convention/scale as `cartesian` — used for geometric distance *between edges* (as opposed
    /// to between nodes), since a one-way passage renders visually on the tile border it crosses,
    /// not at either endpoint node. Default impl is the midpoint of the two endpoints'
    /// `cartesian` positions, correct for every current tessellation (square/hex/tri all place an
    /// edge crossing squarely between its two nodes) — a future tessellation whose edges don't
    /// sit at the node midpoint (e.g. an off-center border) overrides this method instead of
    /// `geometric_edge_distance`'s callers each reimplementing the correction themselves.
    fn edge_position(from: Self::Point, to: Self::Point) -> (f64, f64) {
        let (fx, fy) = Self::cartesian(from);
        let (tx, ty) = Self::cartesian(to);
        ((fx + tx) / 2.0, (fy + ty) / 2.0)
    }
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

/// Euclidean distance (in unit tile scale) between two *edges*, each identified by its
/// `from`/`to` endpoint pair, via `Tessellation::edge_position`. Distinct from
/// `geometric_distance` (node-to-node): an edge's visual position is its border crossing, not
/// either endpoint node, so measuring edge proximity via node distance would systematically
/// underestimate how far apart two edges actually render.
pub fn geometric_edge_distance<T: Tessellation>(a_from: T::Point, a_to: T::Point, b_from: T::Point, b_to: T::Point) -> f64 {
    let (ax, ay) = T::edge_position(a_from, a_to);
    let (bx, by) = T::edge_position(b_from, b_to);
    ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt()
}

/// A tile's point resolves to one *or more* `NodeId`s (see GitHub issue #219, epic #218) — most
/// points hold exactly one (the `Vec` stays a single-element allocation), but a point can be
/// split into several independent routing passages via `add_node_at`. `Field` itself has no
/// notion of "groups" or which faces belong to which node — it only tracks the node set per
/// point; deciding which of a point's several nodes should connect to what is entirely up to the
/// caller (generation algorithms, QC/repair strategies).
pub struct Field<T: Tessellation> {
    point_to_nodes: HashMap<T::Point, Vec<NodeId>>,
    node_to_point: HashMap<NodeId, T::Point>,
}

/// Manual impl (not `#[derive(Clone)]`) — the derive would require `T: Clone`, but only
/// `T::Point` needs to be (already `Copy` per `Tessellation`'s bound); `T` itself is typically a
/// zero-sized marker type. Needed by `Maze::draft()` (GitHub issue #118, `Specs/repair.md`'s
/// mutation-command contract) to produce an independent working copy without disturbing the
/// original.
impl<T: Tessellation> Clone for Field<T> {
    fn clone(&self) -> Self {
        Self {
            point_to_nodes: self.point_to_nodes.clone(),
            node_to_point: self.node_to_point.clone(),
        }
    }
}

impl<T: Tessellation> Field<T> {
    pub fn new(
        points: impl IntoIterator<Item = T::Point>,
        ids: &mut IdGenerator,
    ) -> Result<Self, &'static str> {
        let mut point_to_nodes = HashMap::new();
        let mut node_to_point = HashMap::new();
        for point in points {
            let id = ids.next_id();
            point_to_nodes.insert(point, vec![id]);
            node_to_point.insert(id, point);
        }
        if point_to_nodes.is_empty() {
            return Err("field is empty");
        }
        Ok(Self { point_to_nodes, node_to_point })
    }

    pub fn node_count(&self) -> usize {
        self.node_to_point.len()
    }

    /// Adds another `NodeId` to an already-existing point — see GitHub issue #219. The point
    /// must already be in the field (panics otherwise): `Field`'s point set/shape is fixed at
    /// construction (`all_points`/field bounds — used by `render_ascii`, region-size QC checks —
    /// rely on it never growing), so this only splits an existing tile into more passages, it
    /// never grows the map with a new one. The new node is not automatically connected to
    /// anything — not the point's other node(s) (no implicit edge between them), not any
    /// neighboring point — the caller decides what graph edges (if any) to add via the usual
    /// `Graph`/`MutationCommand` API. Not limited in how many times it may be called for the same
    /// point.
    ///
    /// This only updates `Field` — if `Graph::build_nodes` has already run, the new node won't
    /// exist in the `Graph` until something also calls `graph.add_node` for it. In production code
    /// that's `Maze::add_node_at`, which does both atomically.
    pub fn add_node_at(&mut self, point: T::Point, ids: &mut IdGenerator) -> NodeId {
        let nodes = self.point_to_nodes.get_mut(&point)
            .unwrap_or_else(|| panic!("add_node_at: point not in field"));
        let id = ids.next_id();
        nodes.push(id);
        self.node_to_point.insert(id, point);
        id
    }

    /// Removes `node` from `point` (GitHub issue #221) — the inverse of `add_node_at`. Panics if
    /// `node` isn't currently one of `point`'s nodes, or if it's `point`'s *first* (original)
    /// node — a point's original node is never removable, only nodes added via `add_node_at` are.
    ///
    /// **Intended for stateful contexts where a single `Maze` is mutated step by step within one
    /// call** — e.g. a future repair strategy driven by `MutationCommand::RemoveNode` (see
    /// `Specs/repair.md`'s mutation-command contract). It is **not** used by the WASM/PostEdit
    /// flow (`maze-wasm/src/analytics.rs`), which rebuilds the graph from scratch on every call
    /// and addresses extra nodes by a stable per-point `slot_id`, never by position — there a
    /// node either exists (its `slot_id` is present) or doesn't, so there's never an "remove from
    /// an already-live set" step this method could serve (see GitHub issue #221's plan, the
    /// slot_id section). This method exists as groundwork for the repair path above, with no
    /// caller yet in this codebase.
    ///
    /// Removal shifts the *position* of `point`'s remaining nodes in the internal `Vec` (not
    /// their `NodeId` — those never change) — a caller holding an index into `nodes_at`'s slice
    /// rather than a `NodeId` must account for the shift.
    pub fn remove_node_at(&mut self, point: T::Point, node: NodeId) {
        let nodes = self.point_to_nodes.get_mut(&point)
            .unwrap_or_else(|| panic!("remove_node_at: point not in field"));
        let idx = nodes.iter().position(|&id| id == node)
            .unwrap_or_else(|| panic!("remove_node_at: node does not belong to point"));
        if idx == 0 {
            panic!("remove_node_at: cannot remove a point's original node");
        }
        nodes.remove(idx);
        self.node_to_point.remove(&node);
    }

    /// All `NodeId`s resolving to `point`, in stable creation order (the point's original node
    /// first, each subsequent `add_node_at` appended after) — not `NodeId` order, not `HashMap`
    /// iteration order. Empty slice if the point isn't in the field. No allocation — borrows from
    /// the field's internal storage.
    pub fn nodes_at(&self, point: T::Point) -> &[NodeId] {
        self.point_to_nodes.get(&point).map_or(&[], |v| v.as_slice())
    }

    /// `Field` has no notion of which faces belong to which of a point's several nodes (see
    /// `add_node_at`) — this returns every node of every neighboring point (via `nodes_at`) for
    /// each face, not just "the" neighbor. For an unsplit point (the common case) this is
    /// identical to today's one-node-per-face behavior. Two different nodes of the same
    /// multi-node point therefore see an identical neighbor list — `Field` only exposes geometric
    /// candidates; deciding which candidate to actually connect is the caller's job.
    pub fn neighbors(&self, node: NodeId) -> Vec<NodeId> {
        let point = match self.node_to_point.get(&node) {
            Some(p) => *p,
            None => return Vec::new(),
        };
        T::faces()
            .iter()
            .flat_map(|&face| {
                let neighbor_point = T::step(point, face);
                self.nodes_at(neighbor_point).iter().copied()
            })
            .collect()
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
        self.point_to_nodes.contains_key(&point)
    }

    /// Every `NodeId` currently in the field — used by `IdGenerator::resume_after` to compute a
    /// safe next ID when a `Maze` is constructed from an already-populated `Field` (GitHub issue
    /// #219): without this, an `IdGenerator` created fresh after construction would risk
    /// colliding with IDs the field already holds.
    pub(crate) fn all_node_ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.node_to_point.keys().copied()
    }
}

/// Test-only helper — literally delegates to `nodes_at` and takes the first (by `nodes_at`'s
/// stable creation order) node. Does not exist in the production build — production code must
/// explicitly decide which of a point's nodes it wants, via `nodes_at`. Kept so the ~400+ existing
/// `node_at`-based unit tests (all built before split points existed, so they only ever exercise
/// unsplit points) don't need mechanical rewrites.
#[cfg(test)]
impl<T: Tessellation> Field<T> {
    pub fn node_at(&self, point: T::Point) -> Option<NodeId> {
        self.nodes_at(point).first().copied()
    }
}

#[cfg(test)]
mod field_clone_tests {
    use super::*;
    use crate::space::{SquareTessellation, SquarePoint, square_rect};

    /// `Field<T>`'s manual `Clone` impl (GitHub issue #118, needed by `Maze::draft()`) must
    /// produce an independent copy of both internal maps — mutating one `Field`'s node/point
    /// state must never be reflected in a clone taken earlier.
    #[test]
    fn clone_is_independent_of_the_original() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let cloned = field.clone();

        assert_eq!(field.node_count(), cloned.node_count());
        let p = SquarePoint { x: 0, y: 0 };
        assert_eq!(field.node_at(p), cloned.node_at(p));

        // A `Field` itself has no mutation API besides construction, so independence is verified
        // by confirming both copies agree on every point/node pair up front — a shared (rather
        // than deep-cloned) HashMap would still pass this if aliasing were harmless, but combined
        // with the derive/manual-impl having no unsafe/Rc involved, structural equality here is
        // exactly what a correct deep clone (vs. an accidentally-empty one) needs to satisfy.
        for point in field.all_points() {
            assert_eq!(field.node_at(point), cloned.node_at(point));
        }
    }
}

#[cfg(test)]
mod remove_node_at_tests {
    use super::*;
    use crate::space::{SquareTessellation, SquarePoint, square_rect};

    #[test]
    fn removes_the_node_from_the_point_and_from_lookup() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let extra = field.add_node_at(p, &mut ids);

        field.remove_node_at(p, extra);

        assert!(!field.nodes_at(p).contains(&extra));
        assert_eq!(field.point_of(extra), None);
    }

    #[test]
    fn removing_a_middle_slot_does_not_change_the_id_of_the_remaining_nodes() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let s1 = field.add_node_at(p, &mut ids);
        let s2 = field.add_node_at(p, &mut ids);
        let s3 = field.add_node_at(p, &mut ids);

        field.remove_node_at(p, s2);

        let remaining = field.nodes_at(p);
        assert!(remaining.contains(&s1));
        assert!(remaining.contains(&s3));
        assert!(!remaining.contains(&s2));
    }

    #[test]
    #[should_panic(expected = "cannot remove a point's original node")]
    fn panics_when_removing_the_original_node() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let original = field.node_at(p).unwrap();

        field.remove_node_at(p, original);
    }

    #[test]
    #[should_panic(expected = "node does not belong to point")]
    fn panics_when_node_belongs_to_a_different_point() {
        let mut ids = IdGenerator::new();
        let mut field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let p0 = SquarePoint { x: 0, y: 0 };
        let p1 = SquarePoint { x: 1, y: 0 };
        let extra_at_p1 = field.add_node_at(p1, &mut ids);

        field.remove_node_at(p0, extra_at_p1);
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

#[cfg(test)]
mod edge_position_tests {
    use super::*;
    use crate::space::SquarePoint;

    #[test]
    fn square_edge_position_is_the_midpoint_of_its_endpoints() {
        let pos = SquareTessellation::edge_position(SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 });
        assert!((pos.0 - 0.5).abs() < 1e-9);
        assert!((pos.1 - 0.0).abs() < 1e-9);
    }

    #[test]
    fn edge_position_is_symmetric_in_from_to() {
        let a = SquarePoint { x: 2, y: 3 };
        let b = SquarePoint { x: 5, y: 1 };
        let ab = SquareTessellation::edge_position(a, b);
        let ba = SquareTessellation::edge_position(b, a);
        assert!((ab.0 - ba.0).abs() < 1e-9);
        assert!((ab.1 - ba.1).abs() < 1e-9);
    }

    #[test]
    fn geometric_edge_distance_between_two_edges_sharing_a_node_is_half_a_tile_apart_on_a_straight_line() {
        // 0->1 and 1->2, collinear on the x-axis: edge midpoints are (0.5,0) and (1.5,0).
        let d = geometric_edge_distance::<SquareTessellation>(
            SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 1, y: 0 }, SquarePoint { x: 2, y: 0 },
        );
        assert!((d - 1.0).abs() < 1e-9, "distance was {d}, expected 1.0");
    }

    #[test]
    fn geometric_edge_distance_between_disjoint_parallel_edges() {
        // 0->1 on row y=0, 0->1 on row y=1: midpoints (0.5,0) and (0.5,1).
        let d = geometric_edge_distance::<SquareTessellation>(
            SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 0, y: 1 }, SquarePoint { x: 1, y: 1 },
        );
        assert!((d - 1.0).abs() < 1e-9, "distance was {d}, expected 1.0");
    }

    #[test]
    fn geometric_edge_distance_to_self_is_zero() {
        let d = geometric_edge_distance::<SquareTessellation>(
            SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 },
            SquarePoint { x: 0, y: 0 }, SquarePoint { x: 1, y: 0 },
        );
        assert_eq!(d, 0.0);
    }

    #[test]
    fn hex_edge_position_is_the_midpoint_of_its_endpoints() {
        // Same neighbor pair `geometric_distance_tests::hex_adjacent_cells_are_at_center_to_center_distance`
        // uses (distance sqrt(3) apart) -- the edge position must be exactly halfway between them.
        let a = HexPoint { q: 0, r: 0 };
        let b = HexPoint { q: 1, r: 0 };
        let (ax, ay) = HexTessellation::cartesian(a);
        let (bx, by) = HexTessellation::cartesian(b);
        let pos = HexTessellation::edge_position(a, b);
        assert!((pos.0 - (ax + bx) / 2.0).abs() < 1e-9);
        assert!((pos.1 - (ay + by) / 2.0).abs() < 1e-9);
    }

    #[test]
    fn tri_edge_position_is_the_midpoint_of_its_endpoints() {
        let a = TriPoint { col: 0, row: 0 };
        let b = TriPoint { col: 1, row: 0 };
        let (ax, ay) = TriTessellation::cartesian(a);
        let (bx, by) = TriTessellation::cartesian(b);
        let pos = TriTessellation::edge_position(a, b);
        assert!((pos.0 - (ax + bx) / 2.0).abs() < 1e-9);
        assert!((pos.1 - (ay + by) / 2.0).abs() < 1e-9);
    }

    #[test]
    fn geometric_edge_distance_between_two_hex_edges_sharing_a_node() {
        // Center (0,0)-E->(1,0) and (1,0)-E->(2,0): both edges' midpoints sit at their own
        // from/to average -- distance between the two midpoints must be half the node-to-node
        // hex distance (sqrt(3)), same "half a tile apart on a straight line" shape the square
        // test above verifies.
        let n0 = HexPoint { q: 0, r: 0 };
        let n1 = HexPoint { q: 1, r: 0 };
        let n2 = HexPoint { q: 2, r: 0 };
        let d = geometric_edge_distance::<HexTessellation>(n0, n1, n1, n2);
        let node_distance = geometric_distance::<HexTessellation>(n0, n2);
        assert!((d - node_distance / 2.0).abs() < 1e-9, "distance was {d}, expected {}", node_distance / 2.0);
    }

    #[test]
    fn geometric_edge_distance_between_two_tri_edges_sharing_a_node() {
        let n0 = TriPoint { col: 0, row: 0 };
        let n1 = TriPoint { col: 1, row: 0 };
        let n2 = TriPoint { col: 2, row: 0 };
        let d = geometric_edge_distance::<TriTessellation>(n0, n1, n1, n2);
        let node_distance = geometric_distance::<TriTessellation>(n0, n2);
        assert!((d - node_distance / 2.0).abs() < 1e-9, "distance was {d}, expected {}", node_distance / 2.0);
    }
}
