pub mod math;
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

pub use ids::{NodeId, IdGenerator};
pub use graph::Graph;
pub use graph::classify::{GeometricNodeClass, classify_node};
pub use graph::stats::{GeometricNodeStats, SpatialEdgeStats, compute_node_stats, compute_spatial_edge_stats};
pub use graph::routing::{RouteInfo, compute_route_info};
pub use graph::graph_analytics::{GraphAnalytics, compute_graph_analytics};
pub use space::{
    Tessellation, Field,
    HexPoint, HexFace, HexTessellation, hex_parallelogram, hex_hexagon,
    SquarePoint, SquareTessellation, SquareFace, square_rect,
    TriPoint, TriFace, TriTessellation, tri_rect, tri_triangle, tri_hexagon,
};
pub use meta::MazeMeta;
pub use generation::{generate_maze, generate_maze_steps, build_preset_state, ElementsConfig, GenerationConfig, GenerationAlgorithm, GenerationEdge, GenerationStep, PresetConnection, PresetConnectionState, NodeLockKind, LockedNode, PresetState};
pub use generation::pipeline::{build_maze, MAX_REPAIR_ITERATIONS};

pub struct MazeAnalysis {
    nav_graph: std::cell::RefCell<Option<(u64, Option<ids::NodeId>, Option<ids::NodeId>, graph::nav::NavGraph)>>,
    scc: std::cell::RefCell<Option<(u64, graph::scc::ConnectedComponents)>>,
    route_info: std::cell::RefCell<Option<(u64, ids::NodeId, ids::NodeId, Option<graph::routing::RouteInfo>)>>,
    graph_analytics: std::cell::RefCell<Option<(u64, Option<ids::NodeId>, Option<ids::NodeId>, GraphAnalytics)>>,
}

impl Default for MazeAnalysis {
    fn default() -> Self {
        Self {
            nav_graph: std::cell::RefCell::new(None),
            scc: std::cell::RefCell::new(None),
            route_info: std::cell::RefCell::new(None),
            graph_analytics: std::cell::RefCell::new(None),
        }
    }
}

impl MazeAnalysis {
    /// Builds and caches the nav graph, pinning `meta.start`/`meta.finish` if set so those maze
    /// nodes are always nav nodes, never compressed into a passage's interior — every consumer
    /// (cycle search, SCC, repair strategies) then sees endpoints consistently as junctions,
    /// regardless of their local passage-like degree.
    ///
    /// Keyed on `(graph.version(), meta.start, meta.finish)` — a repair strategy mutating the
    /// graph (or changing which nodes are pinned) after this was first cached invalidates the
    /// entry and triggers a rebuild on the next call, instead of silently returning stale data
    /// (see issue #20).
    pub fn nav_graph(&self, graph: &Graph, meta: &MazeMeta) -> graph::nav::NavGraph {
        let key = (graph.version(), meta.start, meta.finish);
        let mut cache = self.nav_graph.borrow_mut();
        if !matches!(&*cache, Some((v, s, f, _)) if (*v, *s, *f) == key) {
            let mut pinned = std::collections::HashSet::new();
            if let Some(s) = meta.start { pinned.insert(s); }
            if let Some(f) = meta.finish { pinned.insert(f); }
            let nav = graph::nav::build_nav_graph_pinned(graph, &pinned);
            *cache = Some((key.0, key.1, key.2, nav));
        }
        cache.as_ref().unwrap().3.clone()
    }

    /// Keyed on `graph.version()` — see `nav_graph` for why.
    pub fn scc(&self, graph: &Graph) -> graph::scc::ConnectedComponents {
        let version = graph.version();
        let mut cache = self.scc.borrow_mut();
        if !matches!(&*cache, Some((v, _)) if *v == version) {
            *cache = Some((version, graph::scc::build_scc(graph)));
        }
        cache.as_ref().unwrap().1.clone()
    }

    /// Computes (and caches per `(graph.version(), start, finish)` key) the route between two
    /// maze nodes, pinning exactly those two nodes — independent of `nav_graph()`'s own pinned
    /// cache, since the route's pinned set may differ from `meta.start`/`meta.finish` (e.g. a
    /// strategy probing a candidate pair before committing it to `meta`).
    ///
    /// Single-slot cache: only the most recently requested key is kept. Calling this with
    /// alternating pairs (e.g. probing several candidates in a loop) defeats the cache entirely
    /// — every call rebuilds. Fine for the current single-pair use (route display), but a caller
    /// comparing many candidate pairs should build its own nav graph once rather than calling
    /// this in a loop.
    pub fn route_info(&self, graph: &Graph, start: ids::NodeId, finish: ids::NodeId) -> Option<graph::routing::RouteInfo> {
        let version = graph.version();
        let mut cache = self.route_info.borrow_mut();
        if !matches!(&*cache, Some((v, s, f, _)) if *v == version && *s == start && *f == finish) {
            let mut pinned = std::collections::HashSet::new();
            pinned.insert(start);
            pinned.insert(finish);
            let nav = graph::nav::build_nav_graph_pinned(graph, &pinned);
            let info = graph::routing::compute_route_info(&nav, start, finish);
            *cache = Some((version, start, finish, info));
        }
        cache.as_ref().unwrap().3.clone()
    }

    /// Builds and caches graph analytics (cycle structure, component counts) on the pinned nav
    /// graph for `(graph.version(), meta.start, meta.finish)` — same key as `nav_graph`, since
    /// analytics is computed directly on that nav graph.
    ///
    /// `compute_graph_analytics` has no toggle and is called on every analytics snapshot
    /// (`maze-wasm/src/analytics.rs`) — caching it avoids recomputing cycle structure from
    /// scratch on every call within the same graph version (e.g. repeated UI refreshes), on
    /// top of the `MAX_SIMPLE_CYCLES` bound in `find_all_simple_cycles` that keeps any single
    /// computation from hanging (see issue #22).
    pub fn graph_analytics(&self, graph: &Graph, meta: &MazeMeta) -> GraphAnalytics {
        let key = (graph.version(), meta.start, meta.finish);
        let mut cache = self.graph_analytics.borrow_mut();
        if !matches!(&*cache, Some((v, s, f, _)) if (*v, *s, *f) == key) {
            let nav = self.nav_graph(graph, meta);
            let analytics = graph::graph_analytics::compute_graph_analytics(&nav);
            *cache = Some((key.0, key.1, key.2, analytics));
        }
        cache.as_ref().unwrap().3.clone()
    }
}

pub struct Maze<T: Tessellation> {
    pub field: Field<T>,
    pub graph: Graph,
    pub meta: MazeMeta,
    pub analysis: MazeAnalysis,
}

impl<T: Tessellation> Maze<T> {
    pub fn new(field: Field<T>, graph: Graph) -> Self {
        Self {
            field,
            graph,
            meta: MazeMeta::empty(),
            analysis: MazeAnalysis::default(),
        }
    }
}
