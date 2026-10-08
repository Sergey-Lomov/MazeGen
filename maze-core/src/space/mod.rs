use crate::graph::Graph;
use crate::ids::{IdGenerator, NodeId};
use std::collections::HashMap;
use std::hash::Hash;

pub mod hex;
pub mod multi_level;
pub mod square;
#[cfg(test)]
pub(crate) mod test_support;
pub mod triangle;

pub use hex::{HexFace, HexPoint, HexTessellation, hex_hexagon, hex_parallelogram};
pub use multi_level::{LevelId, MultiLevelField};
pub use square::{SquareFace, SquarePoint, SquareTessellation, square_rect};
pub use triangle::{TriFace, TriPoint, TriTessellation, tri_hexagon, tri_rect, tri_triangle};

pub trait Tessellation {
    type Point: Copy + Eq + Hash;
    type Face: Copy + PartialEq + 'static;

    /// Moves from `point` through `face` to the adjacent point, if that face has a neighboring
    /// coordinate in this tessellation.
    ///
    /// Invariant: for a fixed `point`, `step(point, f1)` and `step(point, f2)` never coincide for
    /// `f1 != f2` — every future `Tessellation` impl must uphold this for the `Some` results (all
    /// three current ones already do). `Field::neighbors` relies on it to guarantee it never
    /// visits the same neighboring point twice while iterating `faces()`.
    fn step(point: Self::Point, face: Self::Face) -> Option<Self::Point>;
    /// Returns whether `point` represents an actual tile in this tessellation's coordinate space.
    fn is_valid_point(point: Self::Point) -> bool;
    fn faces() -> &'static [Self::Face];
    /// Returns the geometric face direction from `from` to `to`.
    ///
    /// This describes coordinate geometry only; it does not guarantee that
    /// `step(from, returned_face)` reaches `to`. Callers that need a real transition must also
    /// resolve the face through `step` (and, for a particular field, check that the resulting
    /// point belongs to that field).
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

    /// Every rotational symmetry of one tile, as a permutation of `Self::faces()` indices —
    /// `rotation_symmetries()[k][i]` is the face index that face `i` (in `Self::faces()` order)
    /// maps to under the `k`-th rotation. Element 0 is always the identity permutation
    /// (`[0, 1, ..., degree-1]`) — a `SplitPattern` face untouched by "no rotation". Every table
    /// (here and in `mirror_symmetries`) has exactly `Self::faces().len()` columns — an invariant
    /// `space::transform_face_index` relies on and `transform_face_index_tests`'s
    /// `every_rotation_and_mirror_symmetry_is_a_valid_permutation_for_every_tessellation` checks
    /// directly for every impl.
    ///
    /// **Why this exists, not arithmetic on the face index** (GitHub issue #275): `Self::faces()`
    /// order is whatever's natural to declare per tessellation — `HexFace`'s `[E, NE, NW, W, SW,
    /// SE]` happens to be angular (each step is a real 60° turn), but `SquareFace`'s `[N, S, E,
    /// W]` and `TriFace`'s `[Left, Right, Base]` aren't. A single formula like `(index +
    /// rotation) % degree` silently assumes the hex case's angular order everywhere, which is
    /// exactly the bug this fixes: applied to `[N, S, E, W]` it doesn't correspond to any real
    /// 90°-turn permutation at all. Each tessellation instead states its own rotation/mirror
    /// symmetry explicitly, in terms of its own faces — never derived from a shared arithmetic
    /// rule, and never expressed in terms of what a split pattern or a specific pair of connected
    /// tiles needs (this is pure tile geometry, reusable by any future caller, not just splits).
    fn rotation_symmetries() -> &'static [&'static [usize]];

    /// Every mirror (reflection) symmetry of one tile, same permutation-table shape as
    /// `rotation_symmetries` — empty when the tessellation's tile has no reflective symmetry at
    /// all (`TriTessellation`: a triangle's 3-fold symmetry is rotation-only, swapping any two
    /// sides while fixing the third is not realizable as a rotation of the tile itself). Unlike
    /// `rotation_symmetries`, there is no implied identity element — an empty slice here means
    /// "mirroring is not a thing for this tessellation", not "only identity".
    fn mirror_symmetries() -> &'static [&'static [usize]];

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

/// Applies a rotation (index into `T::rotation_symmetries()`) then, optionally, a mirror (index
/// into `T::mirror_symmetries()`) to `face_index`, returning the resulting face index —
/// `None` if `face_index`/`rotation`/the mirror index is out of range for `T`. Shared by every
/// split-pattern consumer that needs to reorient a `SplitPattern`'s stored face indices onto a
/// specific point's real faces: `generation::split_logic` (adaptation search during generation),
/// `repair::strategies::add_split` (post-generation pattern-mode repair), and
/// `quality_control::split_pattern_match` (checking whether a built tile matches any configured
/// pattern) — GitHub issue #275 replaced 3 copies of an arithmetic formula that silently assumed
/// every tessellation's `faces()` order was angular (true for hex, false for square/tri) with this
/// single implementation built on each tessellation's own explicit symmetry tables.
///
/// No `degree` parameter — `T::faces().len()` is the single source of truth (every caller used to
/// compute and pass it separately, a redundant value that could in principle drift from `T`'s own
/// tables; `rotation_symmetries`'s doc comment states the invariant this relies on).
pub fn transform_face_index<T: Tessellation>(
    face_index: usize,
    rotation: usize,
    mirror: Option<usize>,
) -> Option<usize> {
    if face_index >= T::faces().len() {
        return None;
    }
    let rotated = *T::rotation_symmetries().get(rotation)?.get(face_index)?;
    match mirror {
        None => Some(rotated),
        Some(m) => T::mirror_symmetries().get(m)?.get(rotated).copied(),
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
pub fn geometric_edge_distance<T: Tessellation>(
    a_from: T::Point,
    a_to: T::Point,
    b_from: T::Point,
    b_to: T::Point,
) -> f64 {
    let (ax, ay) = T::edge_position(a_from, a_to);
    let (bx, by) = T::edge_position(b_from, b_to);
    ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt()
}

/// Euclidean distance between two nodes' points, each on its own floor (`MultiLevelField::
/// level_index_of` position) — see GitHub issue #342. `include_height` folds the floor
/// difference in as a third coordinate, one unit per floor apart, on top of the ordinary x-y
/// distance `geometric_distance` computes; `false` reproduces `geometric_distance` exactly
/// (floor ignored, same as a single-floor maze). Callers wanting "cross-floor pairs never count"
/// instead of a height-aware metric skip calling this entirely for a mismatched pair rather than
/// passing a mode here — this function only ever computes a distance, it never decides whether a
/// pair should be evaluated at all.
pub fn floor_aware_distance<T: Tessellation>(
    a_level: usize,
    a: T::Point,
    b_level: usize,
    b: T::Point,
    include_height: bool,
) -> f64 {
    floor_aware_xy_distance(
        a_level,
        T::cartesian(a),
        b_level,
        T::cartesian(b),
        include_height,
    )
}

/// Euclidean distance between two edges' `Tessellation::edge_position`s, each on its own floor —
/// the edge-based counterpart of `floor_aware_distance`, mirroring how `geometric_edge_distance`
/// relates to `geometric_distance`. See GitHub issue #342.
pub fn floor_aware_edge_distance<T: Tessellation>(
    a_level: usize,
    a_from: T::Point,
    a_to: T::Point,
    b_level: usize,
    b_from: T::Point,
    b_to: T::Point,
    include_height: bool,
) -> f64 {
    floor_aware_xy_distance(
        a_level,
        T::edge_position(a_from, a_to),
        b_level,
        T::edge_position(b_from, b_to),
        include_height,
    )
}

/// Shared core of `floor_aware_distance`/`floor_aware_edge_distance` — both ultimately compare two
/// already-resolved cartesian `(x, y)` positions (a node's `cartesian`, or an edge's
/// `edge_position`), so this is the one place the actual formula lives. Also used directly by
/// `cross_element_geometric_proximity`'s occurrence scan (GitHub issue #376's one-way-distance
/// follow-up), whose occurrences carry a pre-resolved cartesian position rather than a `T::Point`
/// (a one-way's occurrence is its edge's midpoint, which is not any tile's own point).
pub fn floor_aware_xy_distance(
    a_level: usize,
    a_xy: (f64, f64),
    b_level: usize,
    b_xy: (f64, f64),
    include_height: bool,
) -> f64 {
    let dz = if include_height {
        b_level as f64 - a_level as f64
    } else {
        0.0
    };
    ((b_xy.0 - a_xy.0).powi(2) + (b_xy.1 - a_xy.1).powi(2) + dz.powi(2)).sqrt()
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
        let points: Vec<T::Point> = points.into_iter().collect();
        if points.is_empty() {
            return Err("field is empty");
        }
        if points.iter().any(|&point| !T::is_valid_point(point)) {
            return Err("field contains an invalid point");
        }
        let mut point_to_nodes = HashMap::new();
        let mut node_to_point = HashMap::new();
        for point in points {
            let id = ids.next_id();
            point_to_nodes.insert(point, vec![id]);
            node_to_point.insert(id, point);
        }
        Ok(Self {
            point_to_nodes,
            node_to_point,
        })
    }

    pub fn node_count(&self) -> usize {
        self.node_to_point.len()
    }

    /// Number of distinct field cells (points) — **not** `node_count()`, which counts nodes and
    /// is inflated by any point carrying a split tile (multiple nodes per point). Density/ratio
    /// checks normalizing "per 100 field cells" must use this, not `node_count()` — see GitHub
    /// issue #267.
    pub fn point_count(&self) -> usize {
        self.point_to_nodes.len()
    }

    /// Builds a `Field` directly from caller-supplied `(NodeId, Point)` pairs, bypassing
    /// `IdGenerator` entirely — GitHub issue #236. Unlike `new` (which always mints fresh
    /// sequential ids), this preserves whatever ids the caller already has, so a rebuild from a
    /// previously-generated snapshot reproduces the exact same ids instead of re-deriving a
    /// different (if deterministic) assignment.
    ///
    /// Entries are grouped by point in the order given — a point's *first* entry becomes its
    /// original node (`nodes_at(point)[0]`), each subsequent entry for the same point an extra
    /// slot, in that order — mirroring `add_node_at`'s "original first, then creation order"
    /// contract (see its doc comment) so a caller (`build_analytics_snapshot`'s `nodes` list, and
    /// therefore `apply_split_points`) can rely on nodes flowing back through this constructor to
    /// preserve which node was the original.
    ///
    /// Empty `entries` remains valid, since this is only reachable from
    /// `run_compute_analytics` with a caller-controlled snapshot, not user-facing tessellation
    /// setup like `new`. Invalid points are rejected before they can become phantom field cells.
    ///
    /// Invalid points return an error. A duplicate `NodeId` across two different points is still
    /// debug-asserted — such an entry would silently let the later one win in `node_to_point`
    /// while both survive in `point_to_nodes`, leaving `point_of`/`nodes_at` disagreeing about
    /// where that id lives. That remains a `debug_assert!` rather than a returned error because it
    /// is an internal-consistency bug in the caller-supplied snapshot, not a recoverable runtime
    /// condition a caller could reasonably handle — mirroring `Graph::add_edge`'s existing
    /// convention for the same kind of "this should be structurally impossible" invariant.
    pub fn from_id_points(
        entries: impl IntoIterator<Item = (NodeId, T::Point)>,
    ) -> Result<Self, &'static str> {
        let mut point_to_nodes: HashMap<T::Point, Vec<NodeId>> = HashMap::new();
        let mut node_to_point = HashMap::new();
        for (id, point) in entries {
            if !T::is_valid_point(point) {
                return Err("field contains an invalid point");
            }
            debug_assert!(
                node_to_point
                    .get(&id)
                    .is_none_or(|&existing| existing == point),
                "from_id_points: duplicate NodeId {id:?} across two different points",
            );
            point_to_nodes.entry(point).or_default().push(id);
            node_to_point.insert(id, point);
        }
        Ok(Self {
            point_to_nodes,
            node_to_point,
        })
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
        let nodes = self
            .point_to_nodes
            .get_mut(&point)
            .unwrap_or_else(|| panic!("add_node_at: point not in field"));
        let id = ids.next_id();
        nodes.push(id);
        self.node_to_point.insert(id, point);
        id
    }

    /// Removes `node` from `point` (GitHub issue #221) — the inverse of `add_node_at`. Panics if
    /// `node` isn't currently one of `point`'s nodes, or if it's the *only* node left at `point` —
    /// a point must always keep at least one node, regardless of which one it is.
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
        let nodes = self
            .point_to_nodes
            .get_mut(&point)
            .unwrap_or_else(|| panic!("remove_node_at: point not in field"));
        let idx = nodes
            .iter()
            .position(|&id| id == node)
            .unwrap_or_else(|| panic!("remove_node_at: node does not belong to point"));
        if nodes.len() == 1 {
            panic!("remove_node_at: cannot remove a point's last remaining node");
        }
        nodes.remove(idx);
        self.node_to_point.remove(&node);
    }

    /// All `NodeId`s resolving to `point`, in stable creation order (the point's original node
    /// first, each subsequent `add_node_at` appended after) — not `NodeId` order, not `HashMap`
    /// iteration order. Empty slice if the point isn't in the field. No allocation — borrows from
    /// the field's internal storage.
    pub fn nodes_at(&self, point: T::Point) -> &[NodeId] {
        self.point_to_nodes
            .get(&point)
            .map_or(&[], |v| v.as_slice())
    }

    /// Replaces every node at `point` with `new_ids`, wholesale — unlike `remove_node_at`, this has
    /// no "keep the last node" restriction, since the whole point's node list is being replaced
    /// at once, not shrunk by one. `new_ids[0]` becomes the point's new slot-0 (`nodes_at`'s own
    /// "original node first" ordering). Panics if `point` isn't in the field (mirrors
    /// `add_node_at`/`remove_node_at`'s own panic-on-bad-point convention) or if `new_ids` is empty
    /// (a point must always have at least one node — this method replaces, it does not delete a
    /// point's presence in the field).
    pub fn replace_nodes_at(&mut self, point: T::Point, new_ids: Vec<NodeId>) {
        assert!(
            !new_ids.is_empty(),
            "replace_nodes_at: new_ids must not be empty"
        );
        let old_nodes = self
            .point_to_nodes
            .get(&point)
            .unwrap_or_else(|| panic!("replace_nodes_at: point not in field"))
            .clone();
        for old in &old_nodes {
            self.node_to_point.remove(old);
        }
        for &new in &new_ids {
            self.node_to_point.insert(new, point);
        }
        self.point_to_nodes.insert(point, new_ids);
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
                T::step(point, face)
                    .into_iter()
                    .flat_map(|neighbor_point| self.nodes_at(neighbor_point).iter().copied())
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

    /// Returns whether the two geometric directions through `via` are equal.
    ///
    /// This is intentionally a geometric check and does not verify that either direction is a
    /// traversable `step`; graph callers are expected to pass actual field neighbors.
    pub fn is_straight(&self, from: NodeId, via: NodeId, to: NodeId) -> bool {
        let Some(fp) = self.node_to_point.get(&from) else {
            return false;
        };
        let Some(vp) = self.node_to_point.get(&via) else {
            return false;
        };
        let Some(tp) = self.node_to_point.get(&to) else {
            return false;
        };
        let Some(face_in) = T::face_between(*fp, *vp) else {
            return false;
        };
        let Some(face_out) = T::face_between(*vp, *tp) else {
            return false;
        };
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

    /// Every `NodeId` in the field, one entry each, sorted order — the id-pool counterpart to
    /// `all_points()` (see GitHub issue #232). Prefer this over
    /// `all_points().flat_map(|p| nodes_at(p))`: that pattern repeats a split point (N nodes) N
    /// times via `all_points()` and then re-expands each repeat via `nodes_at`, yielding a point's
    /// nodes N² times instead of N — skewing any random pick built from the result toward split
    /// points (`maze-wasm/src/analytics.rs`'s `build_analytics_snapshot` hit the visible form of
    /// this bug directly, GitHub issue #223; several `maze-core` repair strategies' node-pool
    /// builders had the same pattern with the milder "skewed probability" symptom). Also used by
    /// `IdGenerator::resume_after` to compute a safe next ID when a `Maze` is constructed from an
    /// already-populated `Field` (GitHub issue #219).
    pub fn all_node_ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        let mut ids: Vec<NodeId> = self.node_to_point.keys().copied().collect();
        ids.sort_unstable();
        ids.into_iter()
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
#[path = "space_tests.rs"]
mod space_tests;
