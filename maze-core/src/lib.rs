pub mod diag;
pub mod math;
pub mod random;
pub mod dsu;
pub mod ids;
pub mod graph;
pub mod space;
pub mod generation;
pub mod validation;
pub mod io;
pub mod meta;
pub mod quality_control;
pub mod repair;
pub mod event_log;
pub mod analysis;

pub use ids::{NodeId, IdGenerator};
pub use graph::Graph;
pub use graph::classify::{GeometricNodeClass, classify_node};
pub use graph::stats::{GeometricNodeStats, SpatialEdgeStats, TeleportEdgeStats, compute_node_stats, compute_spatial_edge_stats, compute_teleport_edge_stats};
pub use graph::routing::{RouteInfo, compute_route_info};
pub use graph::graph_analytics::{GraphAnalytics, compute_graph_analytics};
pub use graph::split_topology::{SplitTopology, canonical_split_topology, split_totals};
pub use graph::region_class::{RegionClass, classify_regions};
pub use space::{
    Tessellation, Field, LevelId, MultiLevelField, geometric_distance,
    HexPoint, HexFace, HexTessellation, hex_parallelogram, hex_hexagon,
    SquarePoint, SquareTessellation, SquareFace, square_rect,
    TriPoint, TriFace, TriTessellation, tri_rect, tri_triangle, tri_hexagon,
};
pub use meta::MazeMeta;
pub use generation::{generate_maze, build_preset_state, ElementsConfig, GenerationConfig, GenerationAlgorithm, PresetConnection, PresetConnectionState, TeleportDirection, NodeLockKind, LockedNode, PresetState};
pub use generation::pipeline::{build_maze, MAX_REPAIR_ITERATIONS, RepairLimits, GenerationTiming, TimingEntry, TimingNode};
pub use analysis::MazeAnalysis;

pub struct Maze<T: Tessellation> {
    pub field: MultiLevelField<T>,
    pub graph: Graph,
    pub meta: MazeMeta,
    pub analysis: MazeAnalysis,
    /// Sole source of new `NodeId`s for this maze's lifetime — see GitHub issue #219. Built via
    /// `IdGenerator::resume_after` in `new`, never accepted as a parameter: a caller can't
    /// accidentally supply a fresh, incompatible generator that would collide with IDs `field`
    /// already holds. `pub(crate)` (not private) so `quality_control::rule::apply_commands`
    /// (GitHub issue #247) can pass it straight into `generation::try_add_split_node`, the only
    /// mutating helper needing a fresh id at repair-apply time — every other `try_*` helper only
    /// ever touches `field`/`graph`.
    pub(crate) ids: IdGenerator,
}

impl<T: Tessellation> Maze<T> {
    pub fn new(field: MultiLevelField<T>, graph: Graph) -> Self {
        let ids = IdGenerator::resume_after(&field);
        Self {
            field,
            graph,
            meta: MazeMeta::empty(),
            analysis: MazeAnalysis::default(),
            ids,
        }
    }

    /// Adds another `NodeId` to `point` on the maze's single level and registers it in `graph` in
    /// the same call (GitHub issue #219) — the only correct way to add a node to an already-built
    /// maze; a raw `field.add_node_at` without a paired `graph.add_node` would leave `Graph`
    /// unaware of the new node. Uses `field.single_level_id()` — single-level mazes only until a
    /// level-aware caller exists (GitHub issue #334/#337).
    pub fn add_node_at(&mut self, point: T::Point) -> NodeId {
        let level = self.field.single_level_id();
        self.add_node_at_on_level(level, point)
    }

    /// Level-aware counterpart of `add_node_at` (GitHub issue #359) — same atomic field+graph
    /// registration, but against a caller-chosen `level` instead of always `single_level_id()`.
    /// The only correct way to add a node to a specific level of an already-built multi-level
    /// maze; `field.add_node_at` alone would leave `Graph` unaware of the new node, same reasoning
    /// as `add_node_at`.
    pub fn add_node_at_on_level(&mut self, level: crate::space::LevelId, point: T::Point) -> NodeId {
        let node = self.field.add_node_at(level, point, &mut self.ids);
        self.graph.add_node(node);
        node
    }

    /// Removes `node`, clearing every edge incident to it (both directions) first — the atomic
    /// graph+field counterpart of `add_node_at` (GitHub issue #221). No caller in this codebase
    /// yet — see `MultiLevelField::remove_node_at`'s doc comment for why (groundwork for a
    /// future repair `MutationCommand::RemoveNode`, not used by the WASM/PostEdit flow).
    ///
    /// `Graph` itself gains no `remove_node` here — whether a "dead" `Node` entry should linger
    /// in `graph.nodes` after its edges are gone, or whether `Graph` needs a real removal API
    /// mirroring its existing `Vec<Option<Edge>>` tombstone pattern, is a real question but one
    /// deliberately left open for whichever issue introduces the first actual caller of this
    /// method (`MutationCommand::RemoveNode` or similar) to decide with a concrete use case in
    /// hand.
    pub fn remove_node_at(&mut self, node: NodeId) {
        let incident: Vec<ids::EdgeId> = self.graph.outgoing_edges(node).map(|e| e.id)
            .chain(self.graph.edges().filter(|e| e.to == node).map(|e| e.id))
            .collect();
        for id in incident {
            self.graph.remove_initial_edge(id);
        }
        self.field.remove_node_at(node);
    }

    /// An independent working copy for a `RepairStrategy` that needs to mutate-and-inspect
    /// intermediate state before committing to a final `MutationCommand` list (GitHub issue #118,
    /// `Specs/repair.md`) — currently only `MissingRegionsStrategy`'s reuse/growth attempts. Fresh
    /// `MazeAnalysis` cache (never cloned — it would otherwise carry stale cache entries keyed
    /// against a graph version this copy has already diverged from); `field`/`graph`/`meta`/`ids`
    /// are cloned so mutating the draft never touches `self`. `ids` is cloned directly (not
    /// rebuilt via `resume_after`) so a draft's `add_node_at` can never collide with an ID `self`
    /// has already handed out but that isn't reflected in `field` yet. Never applied automatically
    /// — a strategy that mutates a draft must go through `DraftMaze` (see `repair::draft`) to get
    /// a `Vec<MutationCommand>` back out of it.
    pub fn draft(&self) -> Maze<T> {
        Maze {
            field: self.field.clone(),
            graph: self.graph.clone(),
            meta: self.meta.clone(),
            analysis: MazeAnalysis::default(),
            ids: self.ids.clone(),
        }
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod lib_tests;
