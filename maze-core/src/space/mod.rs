use crate::graph::Graph;
use crate::ids::{IdGenerator, NodeId};
use std::collections::HashMap;
use std::fmt::Debug;
use std::hash::Hash;
use std::sync::Arc;

pub mod brick;
pub mod cairo;
pub mod curved_quadrilateral;
pub mod field_ops;
pub mod geometry;
pub mod hex;
pub mod multi_level;
pub mod radial;
pub mod rhombitrihexagonal;
pub mod shape;
pub mod snub_hexagonal;
pub mod square;
pub mod square_octagon;
#[cfg(test)]
pub(crate) mod test_support;
pub mod triangle;
pub mod trihexagonal;
pub mod truncated_hexagonal;
pub mod truncated_trihexagonal;

pub use brick::{BrickFace, BrickPoint, BrickTessellation};
pub use cairo::{CairoFace, CairoPoint, CairoTessellation, CairoTileKind, cairo_rect};
pub use curved_quadrilateral::{
    CurvedQuadrilateralFace, CurvedQuadrilateralPoint, CurvedQuadrilateralTessellation,
};
pub use field_ops::{
    FieldOpError, FieldOperation, FieldOps, PresetDescriptor, PresetParam, PresetParams,
    is_connected, validate_preset,
};
pub use geometry::{
    BoundaryPath, CellScope, GEOM_EPS, MAX_REGION_CANDIDATES, PathCommand, Point, RegionMode,
    RegionTooLarge, STRAIGHT_TOLERANCE, Segment, TessellationGeometry, chain_midpoint,
    is_straight_geometric,
};
pub use hex::{HexFace, HexPoint, HexTessellation, hex_hexagon, hex_parallelogram};
pub use multi_level::{LevelId, MultiLevelField};
pub use radial::{
    DEFAULT_CELL_LIMIT, MAX_CELL_LIMIT, MIN_CELL_LIMIT, RadialFace, RadialLayout, RadialParams,
    RadialPoint, RadialTessellation,
};
pub use rhombitrihexagonal::{
    RhombitrihexagonalFace, RhombitrihexagonalKind, RhombitrihexagonalPoint,
    RhombitrihexagonalTessellation,
};
pub use shape::{CellShape, ShapeDescriptor, ShapeFamily};
pub use snub_hexagonal::{
    SnubHexagonalFace, SnubHexagonalKind, SnubHexagonalPoint, SnubHexagonalTessellation,
};
pub use square::{SquareFace, SquarePoint, SquareTessellation, square_rect};
pub use square_octagon::{SquareOctagonFace, SquareOctagonPoint, SquareOctagonTessellation};
pub use triangle::{TriFace, TriPoint, TriTessellation, tri_hexagon, tri_rect, tri_triangle};
pub use trihexagonal::{
    TrihexagonalFace, TrihexagonalKind, TrihexagonalPoint, TrihexagonalTessellation,
};
pub use truncated_hexagonal::{
    TruncatedHexagonalFace, TruncatedHexagonalKind, TruncatedHexagonalPoint,
    TruncatedHexagonalTessellation,
};
pub use truncated_trihexagonal::{
    TruncatedTrihexagonalFace, TruncatedTrihexagonalKind, TruncatedTrihexagonalPoint,
    TruncatedTrihexagonalTessellation,
};

/// A tessellation is an instance, not a marker type: one instance per maze, shared via `Arc` by
/// `Field`/`MultiLevelField` (every level of a maze uses the same instance). Built
/// deterministically from a `{ kind, params }` config by the `maze-wasm`/`maze-runner`
/// factories; the built-in tessellations are zero-sized instances. See `Specs/space.md`.
pub trait Tessellation: Send + Sync + 'static {
    /// Opaque cell id, valid only within the instance that produced it. `Ord` exists only for
    /// deterministic ordering and tie-breaks.
    type CellId: Copy + Eq + Ord + Hash + Debug;
    type Face: Copy + Eq + Hash + Debug + 'static;

    /// Returns whether `cell` represents an actual tile in this tessellation's coordinate space.
    fn is_valid_cell(&self, cell: Self::CellId) -> bool;

    /// The faces of `cell`, in the canonical circular order: counter-clockwise along the cell
    /// boundary from a tessellation-defined first face — allocation-free (borrowed from static or
    /// instance-owned data), and may differ per cell. A cell has at most one face toward any given
    /// neighbor, so the cells `neighbor` reaches through distinct faces are pairwise distinct
    /// (`Field::neighbors` relies on this). An invalid `cell` is a precondition violation.
    fn faces_of(&self, cell: Self::CellId) -> &[Self::Face];

    /// The cell adjacent to `cell` through `face`, together with the face of that cell that is the
    /// same boundary piece — `None` when no cell exists there in this tessellation's space. Always
    /// reciprocal: `neighbor(c, f) == Some((c', f'))` implies `neighbor(c', f') == Some((c, f))`.
    /// Field membership is separate: a `Field` neighbor is a tessellation neighbor that is also in
    /// the field. An invalid `cell`, or a `face` not in `faces_of(cell)`, is a precondition
    /// violation.
    fn neighbor(&self, cell: Self::CellId, face: Self::Face) -> Option<(Self::CellId, Self::Face)>;

    /// Whether a pass through `cell` entering by `in_face` and leaving by `out_face` is straight.
    /// Geometric semantics (`geometry::is_straight_geometric`, GitHub issue #759): the contact
    /// points of both faces and the cell's center are collinear, in that order. Answered from
    /// per-tessellation tables for speed; tests check every table against the definition. An
    /// invalid `cell`, or a face not in `faces_of(cell)`, is a precondition violation.
    fn is_straight(&self, cell: Self::CellId, in_face: Self::Face, out_face: Self::Face) -> bool;

    /// Every shape template this instance's cells use, each listed once.
    fn shape_descriptors(&self) -> &[ShapeDescriptor];

    /// `cell`'s binding to one of `shape_descriptors`: the descriptor, the local-to-canonical face
    /// map and the cell's allowed transform group (see `CellShape`). `None` means the cell has no
    /// template — it still has full topology and geometry, but split patterns never apply to it.
    /// Allocation-free. An invalid `cell` is a precondition violation.
    fn shape_of(&self, cell: Self::CellId) -> Option<CellShape<'_>>;

    /// World-unit center of `cell` (see `geometry`). Used for geometric (as opposed to
    /// logical/graph) distance and as `C` in the geometric `is_straight` definition.
    fn center(&self, cell: Self::CellId) -> Point;

    /// The segments of `face`, running counter-clockwise along `cell`'s boundary. Consumers call
    /// `TessellationGeometry::edge_segments` instead, which evaluates this on the canonical owner
    /// side only, so an implementation never has to agree with itself across a face pair.
    fn face_segments(&self, cell: Self::CellId, face: Self::Face) -> Vec<Segment>;

    /// A superset of the valid cells whose boundary may touch the axis-aligned box `min`–`max`
    /// (any order) — the candidate source for point and region queries over the whole
    /// tessellation space. Exact filtering happens in `geometry`. `None` when there would be more
    /// than `limit` candidates; an implementation counts them before allocating any.
    fn candidate_cells(&self, min: Point, max: Point, limit: usize) -> Option<Vec<Self::CellId>>;

    /// The field operations this tessellation supports (GitHub issue #760). The UI hides tools
    /// for operations not listed; `FieldOps` refuses them with `FieldOpError::Unavailable`.
    fn field_operations(&self) -> &[FieldOperation] {
        &[FieldOperation::Translate, FieldOperation::Reflect]
    }

    /// The preset field shapes this tessellation offers, each with its parameter schema.
    fn presets(&self) -> &[PresetDescriptor] {
        &[]
    }

    /// Upper bound of preset parameter `name` of preset `key` on this instance, when the
    /// tessellation is finite or otherwise limits it; `None` leaves the parameter unbounded.
    fn preset_param_max(&self, _key: &str, _name: &str) -> Option<u32> {
        None
    }

    /// The cells of preset `key` built from `params` (named per the preset's schema), centered
    /// around the tessellation's origin, sorted by `CellId`. `Unavailable` for a preset not in
    /// `presets`, `InvalidPreset` for parameters that do not match its schema.
    fn build_preset(
        &self,
        key: &str,
        params: PresetParams<'_>,
    ) -> Result<Vec<Self::CellId>, FieldOpError> {
        validate_preset(self.presets(), key, params)?;
        Err(FieldOpError::Unavailable)
    }

    /// Area of `cell`. Defaults to the signed area of its boundary path; a tessellation with a
    /// known constant area overrides it (tests check the override against the boundary).
    fn area(&self, cell: Self::CellId) -> f64 {
        self.boundary_path(cell).signed_area()
    }
}

/// Position in `faces_of(cell)` of the face through which `cell` reaches `other`, or `None` when
/// `other` is not a tessellation neighbor of `cell`. Allocation-free, O(degree).
pub fn face_index_toward<T: Tessellation>(
    tessellation: &T,
    cell: T::CellId,
    other: T::CellId,
) -> Option<usize> {
    tessellation.faces_of(cell).iter().position(|&face| {
        tessellation
            .neighbor(cell, face)
            .is_some_and(|(c, _)| c == other)
    })
}

/// A world position together with the `cell_scale` distances to it are measured in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScaledPoint {
    pub point: Point,
    pub scale: f64,
}

/// `cell`'s center, measured in its own `cell_scale`.
pub fn cell_position<T: Tessellation>(tessellation: &T, cell: T::CellId) -> ScaledPoint {
    ScaledPoint {
        point: tessellation.center(cell),
        scale: tessellation.cell_scale(cell),
    }
}

/// Position of the edge `from -> to`: the contact point of the face between the two cells (where
/// a passage renders), measured in the mean `cell_scale` of both. Two cells that are not
/// tessellation neighbors (no shared face) fall back to the midpoint of their centers.
pub fn edge_position<T: Tessellation>(
    tessellation: &T,
    from: T::CellId,
    to: T::CellId,
) -> ScaledPoint {
    let scale = (tessellation.cell_scale(from) + tessellation.cell_scale(to)) / 2.0;
    let point = match face_index_toward(tessellation, from, to) {
        Some(index) => tessellation.contact_point(from, tessellation.faces_of(from)[index]),
        None => (tessellation.center(from) + tessellation.center(to)) * 0.5,
    };
    ScaledPoint { point, scale }
}

/// Euclidean distance between two cells' centers, in `cell_scale` units. Edge-to-edge distance is
/// `floor_aware_xy_distance` over two `edge_position`s, each resolved once per edge by the caller. Purely geometric —
/// unrelated to graph/nav distance (`MazeAnalysis::distance_from_start`/`distance_from_finish`),
/// which counts tile-hops along actual edges instead.
pub fn geometric_distance<T: Tessellation>(tessellation: &T, a: T::CellId, b: T::CellId) -> f64 {
    floor_aware_xy_distance(
        0,
        cell_position(tessellation, a),
        0,
        cell_position(tessellation, b),
        false,
    )
}

/// Distance between two nodes' cells, each on its own floor (`MultiLevelField::level_index_of`
/// position) — see GitHub issue #342. `include_height` folds the floor difference in as a third
/// coordinate, one `cell_scale` unit per floor apart; `false` reproduces `geometric_distance`
/// exactly. Callers wanting "cross-floor pairs never count" skip calling this for a mismatched
/// pair — this function only ever computes a distance.
pub fn floor_aware_distance<T: Tessellation>(
    tessellation: &T,
    a_level: usize,
    a: T::CellId,
    b_level: usize,
    b: T::CellId,
    include_height: bool,
) -> f64 {
    floor_aware_xy_distance(
        a_level,
        cell_position(tessellation, a),
        b_level,
        cell_position(tessellation, b),
        include_height,
    )
}

/// Shared core of every geometric distance: the planar world distance divided by the mean
/// `cell_scale` of both positions (so thresholds are in `cell_scale` units), with the floor
/// difference folded in as a third coordinate when `include_height` is set. Also used directly by
/// `cross_element_geometric_proximity`, whose occurrences carry pre-resolved positions (a one-way's
/// occurrence is its edge's contact point, which is not any cell's center).
pub fn floor_aware_xy_distance(
    a_level: usize,
    a: ScaledPoint,
    b_level: usize,
    b: ScaledPoint,
    include_height: bool,
) -> f64 {
    let planar = a.point.distance(b.point) / ((a.scale + b.scale) / 2.0);
    let dz = if include_height {
        b_level as f64 - a_level as f64
    } else {
        0.0
    };
    (planar.powi(2) + dz.powi(2)).sqrt()
}

/// A tile's cell resolves to one *or more* `NodeId`s (see GitHub issue #219, epic #218) — most
/// cells hold exactly one (the `Vec` stays a single-element allocation), but a cell can be
/// split into several independent routing passages via `add_node_at`. `Field` itself has no
/// notion of "groups" or which faces belong to which node — it only tracks the node set per
/// cell; deciding which of a cell's several nodes should connect to what is entirely up to the
/// caller (generation algorithms, QC/repair strategies).
pub struct Field<T: Tessellation> {
    tessellation: Arc<T>,
    cell_to_nodes: HashMap<T::CellId, Vec<NodeId>>,
    node_to_cell: HashMap<NodeId, T::CellId>,
}

/// Manual impl (not `#[derive(Clone)]`) — the derive would require `T: Clone`, but the
/// tessellation instance is shared via `Arc`, never copied. Needed by `Maze::draft()` (GitHub issue #118, `Specs/repair.md`'s
/// mutation-command contract) to produce an independent working copy without disturbing the
/// original.
impl<T: Tessellation> Clone for Field<T> {
    fn clone(&self) -> Self {
        Self {
            tessellation: Arc::clone(&self.tessellation),
            cell_to_nodes: self.cell_to_nodes.clone(),
            node_to_cell: self.node_to_cell.clone(),
        }
    }
}

impl<T: Tessellation> Field<T> {
    pub fn new(
        tessellation: Arc<T>,
        cells: impl IntoIterator<Item = T::CellId>,
        ids: &mut IdGenerator,
    ) -> Result<Self, &'static str> {
        let cells: Vec<T::CellId> = cells.into_iter().collect();
        if cells.is_empty() {
            return Err("field is empty");
        }
        if cells.iter().any(|&cell| !tessellation.is_valid_cell(cell)) {
            return Err("field contains an invalid cell");
        }
        let mut cell_to_nodes = HashMap::new();
        let mut node_to_cell = HashMap::new();
        for cell in cells {
            let id = ids.next_id();
            cell_to_nodes.insert(cell, vec![id]);
            node_to_cell.insert(id, cell);
        }
        Ok(Self {
            tessellation,
            cell_to_nodes,
            node_to_cell,
        })
    }

    /// The tessellation instance this field's cells belong to.
    pub fn tessellation(&self) -> &T {
        &self.tessellation
    }

    /// The shared handle of `tessellation()`, for building another field on the same instance.
    pub fn shared_tessellation(&self) -> &Arc<T> {
        &self.tessellation
    }

    pub fn node_count(&self) -> usize {
        self.node_to_cell.len()
    }

    /// Number of distinct field cells (cells) — **not** `node_count()`, which counts nodes and
    /// is inflated by any cell carrying a split tile (multiple nodes per cell). Density/ratio
    /// checks normalizing "per 100 field cells" must use this, not `node_count()` — see GitHub
    /// issue #267.
    pub fn cell_count(&self) -> usize {
        self.cell_to_nodes.len()
    }

    /// Builds a `Field` directly from caller-supplied `(NodeId, Cell)` pairs, bypassing
    /// `IdGenerator` entirely — GitHub issue #236. Unlike `new` (which always mints fresh
    /// sequential ids), this preserves whatever ids the caller already has, so a rebuild from a
    /// previously-generated snapshot reproduces the exact same ids instead of re-deriving a
    /// different (if deterministic) assignment.
    ///
    /// Entries are grouped by cell in the order given — a cell's *first* entry becomes its
    /// original node (`nodes_at(cell)[0]`), each subsequent entry for the same cell an extra
    /// slot, in that order — mirroring `add_node_at`'s "original first, then creation order"
    /// contract (see its doc comment) so a caller (`build_analytics_snapshot`'s `nodes` list, and
    /// therefore `apply_split_points`) can rely on nodes flowing back through this constructor to
    /// preserve which node was the original.
    ///
    /// Empty `entries` remains valid, since this is only reachable from
    /// `run_compute_analytics` with a caller-controlled snapshot, not user-facing tessellation
    /// setup like `new`. Invalid cells are rejected before they can become phantom field cells.
    ///
    /// Invalid cells return an error. A duplicate `NodeId` across two different cells is still
    /// debug-asserted — such an entry would silently let the later one win in `node_to_cell`
    /// while both survive in `cell_to_nodes`, leaving `cell_of`/`nodes_at` disagreeing about
    /// where that id lives. That remains a `debug_assert!` rather than a returned error because it
    /// is an internal-consistency bug in the caller-supplied snapshot, not a recoverable runtime
    /// condition a caller could reasonably handle — mirroring `Graph::add_edge`'s existing
    /// convention for the same kind of "this should be structurally impossible" invariant.
    pub fn from_id_cells(
        tessellation: Arc<T>,
        entries: impl IntoIterator<Item = (NodeId, T::CellId)>,
    ) -> Result<Self, &'static str> {
        let mut cell_to_nodes: HashMap<T::CellId, Vec<NodeId>> = HashMap::new();
        let mut node_to_cell = HashMap::new();
        for (id, cell) in entries {
            if !tessellation.is_valid_cell(cell) {
                return Err("field contains an invalid cell");
            }
            debug_assert!(
                node_to_cell
                    .get(&id)
                    .is_none_or(|&existing| existing == cell),
                "from_id_cells: duplicate NodeId {id:?} across two different cells",
            );
            cell_to_nodes.entry(cell).or_default().push(id);
            node_to_cell.insert(id, cell);
        }
        Ok(Self {
            tessellation,
            cell_to_nodes,
            node_to_cell,
        })
    }

    /// Adds another `NodeId` to an already-existing cell — see GitHub issue #219. The cell
    /// must already be in the field (panics otherwise): `Field`'s cell set/shape is fixed at
    /// construction (`all_cells`/field bounds — used by `render_ascii`, region-size QC checks —
    /// rely on it never growing), so this only splits an existing tile into more passages, it
    /// never grows the map with a new one. The new node is not automatically connected to
    /// anything — not the cell's other node(s) (no implicit edge between them), not any
    /// neighboring cell — the caller decides what graph edges (if any) to add via the usual
    /// `Graph`/`MutationCommand` API. Not limited in how many times it may be called for the same
    /// cell.
    ///
    /// This only updates `Field` — if `Graph::build_nodes` has already run, the new node won't
    /// exist in the `Graph` until something also calls `graph.add_node` for it. In production code
    /// that's `Maze::add_node_at`, which does both atomically.
    pub fn add_node_at(&mut self, cell: T::CellId, ids: &mut IdGenerator) -> NodeId {
        let nodes = self
            .cell_to_nodes
            .get_mut(&cell)
            .unwrap_or_else(|| panic!("add_node_at: cell not in field"));
        let id = ids.next_id();
        nodes.push(id);
        self.node_to_cell.insert(id, cell);
        id
    }

    /// Removes `node` from `cell` (GitHub issue #221) — the inverse of `add_node_at`. Panics if
    /// `node` isn't currently one of `cell`'s nodes, or if it's the *only* node left at `cell` —
    /// a cell must always keep at least one node, regardless of which one it is.
    ///
    /// **Intended for stateful contexts where a single `Maze` is mutated step by step within one
    /// call** — e.g. a future repair strategy driven by `MutationCommand::RemoveNode` (see
    /// `Specs/repair.md`'s mutation-command contract). It is **not** used by the WASM/PostEdit
    /// flow (`maze-wasm/src/analytics.rs`), which rebuilds the graph from scratch on every call
    /// and addresses extra nodes by a stable per-cell `slot_id`, never by position — there a
    /// node either exists (its `slot_id` is present) or doesn't, so there's never an "remove from
    /// an already-live set" step this method could serve (see GitHub issue #221's plan, the
    /// slot_id section). This method exists as groundwork for the repair path above, with no
    /// caller yet in this codebase.
    ///
    /// Removal shifts the *position* of `cell`'s remaining nodes in the internal `Vec` (not
    /// their `NodeId` — those never change) — a caller holding an index into `nodes_at`'s slice
    /// rather than a `NodeId` must account for the shift.
    pub fn remove_node_at(&mut self, cell: T::CellId, node: NodeId) {
        let nodes = self
            .cell_to_nodes
            .get_mut(&cell)
            .unwrap_or_else(|| panic!("remove_node_at: cell not in field"));
        let idx = nodes
            .iter()
            .position(|&id| id == node)
            .unwrap_or_else(|| panic!("remove_node_at: node does not belong to cell"));
        if nodes.len() == 1 {
            panic!("remove_node_at: cannot remove a cell's last remaining node");
        }
        nodes.remove(idx);
        self.node_to_cell.remove(&node);
    }

    /// All `NodeId`s resolving to `cell`, in stable creation order (the cell's original node
    /// first, each subsequent `add_node_at` appended after) — not `NodeId` order, not `HashMap`
    /// iteration order. Empty slice if the cell isn't in the field. No allocation — borrows from
    /// the field's internal storage.
    pub fn nodes_at(&self, cell: T::CellId) -> &[NodeId] {
        self.cell_to_nodes.get(&cell).map_or(&[], |v| v.as_slice())
    }

    /// Replaces every node at `cell` with `new_ids`, wholesale — unlike `remove_node_at`, this has
    /// no "keep the last node" restriction, since the whole cell's node list is being replaced
    /// at once, not shrunk by one. `new_ids[0]` becomes the cell's new slot-0 (`nodes_at`'s own
    /// "original node first" ordering). Panics if `cell` isn't in the field (mirrors
    /// `add_node_at`/`remove_node_at`'s own panic-on-bad-cell convention) or if `new_ids` is empty
    /// (a cell must always have at least one node — this method replaces, it does not delete a
    /// cell's presence in the field).
    pub fn replace_nodes_at(&mut self, cell: T::CellId, new_ids: Vec<NodeId>) {
        assert!(
            !new_ids.is_empty(),
            "replace_nodes_at: new_ids must not be empty"
        );
        let old_nodes = self
            .cell_to_nodes
            .get(&cell)
            .unwrap_or_else(|| panic!("replace_nodes_at: cell not in field"))
            .clone();
        for old in &old_nodes {
            self.node_to_cell.remove(old);
        }
        for &new in &new_ids {
            self.node_to_cell.insert(new, cell);
        }
        self.cell_to_nodes.insert(cell, new_ids);
    }

    /// `Field` has no notion of which faces belong to which of a cell's several nodes (see
    /// `add_node_at`) — this returns every node of every neighboring cell (via `nodes_at`) for
    /// each face, not just "the" neighbor. For an unsplit cell (the common case) this is
    /// identical to today's one-node-per-face behavior. Two different nodes of the same
    /// multi-node cell therefore see an identical neighbor list — `Field` only exposes geometric
    /// candidates; deciding which candidate to actually connect is the caller's job.
    pub fn neighbors(&self, node: NodeId) -> Vec<NodeId> {
        let cell = match self.node_to_cell.get(&node) {
            Some(p) => *p,
            None => return Vec::new(),
        };
        let tessellation = &*self.tessellation;
        tessellation
            .faces_of(cell)
            .iter()
            .flat_map(|&face| {
                tessellation
                    .neighbor(cell, face)
                    .into_iter()
                    .flat_map(|(neighbor_cell, _)| self.nodes_at(neighbor_cell).iter().copied())
            })
            .collect()
    }

    pub fn cell_of(&self, node: NodeId) -> Option<T::CellId> {
        self.node_to_cell.get(&node).copied()
    }

    pub fn build_nodes(&self, graph: &mut Graph) {
        let mut ids: Vec<NodeId> = self.node_to_cell.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            graph.add_node(id);
        }
    }

    /// Whether the pass `from -> via -> to` is straight: resolves the faces of `via`'s cell toward
    /// `from`'s and `to`'s cells and asks `Tessellation::is_straight`. `false` when any node is
    /// unknown or either cell is not a tessellation neighbor of `via`'s cell.
    pub fn is_straight(&self, from: NodeId, via: NodeId, to: NodeId) -> bool {
        let Some(&fp) = self.node_to_cell.get(&from) else {
            return false;
        };
        let Some(&vp) = self.node_to_cell.get(&via) else {
            return false;
        };
        let Some(&tp) = self.node_to_cell.get(&to) else {
            return false;
        };
        let tessellation = &*self.tessellation;
        let (mut in_face, mut out_face) = (None, None);
        for &face in tessellation.faces_of(vp) {
            let Some((cell, _)) = tessellation.neighbor(vp, face) else {
                continue;
            };
            if cell == fp {
                in_face = Some(face);
            }
            if cell == tp {
                out_face = Some(face);
            }
        }
        match (in_face, out_face) {
            (Some(in_face), Some(out_face)) => tessellation.is_straight(vp, in_face, out_face),
            _ => false,
        }
    }

    /// Deterministic order: sorted by `NodeId`, not raw `HashMap` iteration order (which
    /// varies between process runs and would make any caller relying on `all_cells()`'s
    /// order — tests building a graph from `nodes[i]`, generation, etc. — silently flaky).
    pub fn all_cells(&self) -> impl Iterator<Item = T::CellId> + '_ {
        let mut ids: Vec<NodeId> = self.node_to_cell.keys().copied().collect();
        ids.sort_unstable();
        ids.into_iter().map(move |id| self.node_to_cell[&id])
    }

    pub fn contains(&self, cell: T::CellId) -> bool {
        self.cell_to_nodes.contains_key(&cell)
    }

    /// Every `NodeId` in the field, one entry each, sorted order — the id-pool counterpart to
    /// `all_cells()` (see GitHub issue #232). Prefer this over
    /// `all_cells().flat_map(|p| nodes_at(p))`: that pattern repeats a split cell (N nodes) N
    /// times via `all_cells()` and then re-expands each repeat via `nodes_at`, yielding a cell's
    /// nodes N² times instead of N — skewing any random pick built from the result toward split
    /// cells (`maze-wasm/src/analytics.rs`'s `build_analytics_snapshot` hit the visible form of
    /// this bug directly, GitHub issue #223; several `maze-core` repair strategies' node-pool
    /// builders had the same pattern with the milder "skewed probability" symptom). Also used by
    /// `IdGenerator::resume_after` to compute a safe next ID when a `Maze` is constructed from an
    /// already-populated `Field` (GitHub issue #219).
    pub fn all_node_ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        let mut ids: Vec<NodeId> = self.node_to_cell.keys().copied().collect();
        ids.sort_unstable();
        ids.into_iter()
    }
}

/// Test-only helper — literally delegates to `nodes_at` and takes the first (by `nodes_at`'s
/// stable creation order) node. Does not exist in the production build — production code must
/// explicitly decide which of a cell's nodes it wants, via `nodes_at`. Kept so the ~400+ existing
/// `node_at`-based unit tests (all built before split cells existed, so they only ever exercise
/// unsplit cells) don't need mechanical rewrites.
#[cfg(test)]
impl<T: Tessellation> Field<T> {
    pub fn node_at(&self, cell: T::CellId) -> Option<NodeId> {
        self.nodes_at(cell).first().copied()
    }
}

#[cfg(test)]
#[path = "space_tests.rs"]
mod space_tests;

#[cfg(test)]
#[path = "field_ops_tests.rs"]
mod field_ops_tests;
