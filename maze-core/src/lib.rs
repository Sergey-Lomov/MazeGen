pub mod analysis;
pub mod diag;
pub mod dsu;
pub mod event_log;
pub mod generation;
pub mod graph;
pub mod ids;
pub mod io;
pub mod math;
pub mod meta;
pub mod quality_control;
pub mod random;
pub mod repair;
pub mod space;
pub mod validation;

pub use analysis::MazeAnalysis;
pub use generation::pipeline::{
    GenerationTiming, MAX_REPAIR_ITERATIONS, RepairLimits, TimingEntry, TimingNode, build_maze,
};
pub use generation::{
    ElementsConfig, GenerationAlgorithm, GenerationConfig, LockedNode, NodeLockKind,
    PresetConnection, PresetConnectionState, PresetState, TeleportDirection, build_preset_state,
    generate_maze,
};
pub use graph::Graph;
pub use graph::classify::{GeometricNodeClass, classify_node};
pub use graph::graph_analytics::{GraphAnalytics, compute_graph_analytics};
pub use graph::region_class::{RegionClass, classify_regions};
pub use graph::routing::{RouteInfo, compute_route_info};
pub use graph::split_topology::{SplitTopology, canonical_split_topology, split_totals};
pub use graph::stats::{
    GeometricNodeStats, SpatialEdgeStats, TeleportEdgeStats, compute_node_stats,
    compute_spatial_edge_stats, compute_teleport_edge_stats,
};
pub use ids::{IdGenerator, NodeId};
pub use meta::MazeMeta;
pub use space::{
    BrickFace, BrickPoint, BrickTessellation, CairoFace, CairoPoint, CairoTessellation,
    CairoTileKind, CurvedQuadrilateralFace, CurvedQuadrilateralPoint,
    CurvedQuadrilateralTessellation, ElongatedTriangularFace, ElongatedTriangularKind,
    ElongatedTriangularPoint, ElongatedTriangularTessellation, Field, HexFace, HexPoint,
    HexTessellation, LevelId, MultiLevelField, RadialFace, RadialLayout, RadialParams, RadialPoint,
    RadialTessellation, RhombitrihexagonalFace, RhombitrihexagonalKind, RhombitrihexagonalPoint,
    RhombitrihexagonalTessellation, SnubHexagonalFace, SnubHexagonalKind, SnubHexagonalPoint,
    SnubHexagonalTessellation, SnubSquareFace, SnubSquareKind, SnubSquarePoint,
    SnubSquareTessellation, SquareFace, SquareOctagonFace, SquareOctagonPoint,
    SquareOctagonTessellation, SquarePoint, SquareTessellation, Tessellation, TriFace, TriPoint,
    TriTessellation, TrihexagonalFace, TrihexagonalKind, TrihexagonalPoint,
    TrihexagonalTessellation, TruncatedHexagonalFace, TruncatedHexagonalKind,
    TruncatedHexagonalPoint, TruncatedHexagonalTessellation, TruncatedTrihexagonalFace,
    TruncatedTrihexagonalKind, TruncatedTrihexagonalPoint, TruncatedTrihexagonalTessellation,
    VoronoiFace, VoronoiParams, VoronoiPoint, VoronoiTessellation, cairo_rect, geometric_distance,
    hex_hexagon, hex_parallelogram, square_rect, tri_hexagon, tri_rect, tri_triangle,
};

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

    /// Adds another `NodeId` to `point` on `level` and registers it in `graph` in the same call
    /// (GitHub issue #219) — the only correct way to add a node to an already-built maze; a raw
    /// `field.add_node_at` without a paired `graph.add_node` would leave `Graph` unaware of the
    /// new node.
    pub fn add_node_at_on_level(
        &mut self,
        level: crate::space::LevelId,
        point: T::CellId,
    ) -> NodeId {
        let node = self.field.add_node_at(level, point, &mut self.ids);
        self.graph.add_node(node);
        node
    }

    /// Removes `node` from both the graph (with every edge incident to it, both directions) and
    /// the field — the atomic graph+field counterpart of `add_node_at` (GitHub issue #221). No
    /// caller in this codebase yet — repair goes through the preset-aware
    /// `generation::try_remove_node`, which removes the node from `Graph` the same way, so no
    /// dead `Node` entry lingers in `graph.nodes` (it would otherwise count as its own SCC).
    pub fn remove_node_at(&mut self, node: NodeId) {
        self.graph.remove_node(node);
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
