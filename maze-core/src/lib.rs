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
    nav_graph: std::cell::OnceCell<graph::nav::NavGraph>,
    scc: std::cell::OnceCell<graph::scc::ConnectedComponents>,
    route_info: std::cell::RefCell<Option<(ids::NodeId, ids::NodeId, Option<graph::routing::RouteInfo>)>>,
}

impl Default for MazeAnalysis {
    fn default() -> Self {
        Self {
            nav_graph: std::cell::OnceCell::new(),
            scc: std::cell::OnceCell::new(),
            route_info: std::cell::RefCell::new(None),
        }
    }
}

impl MazeAnalysis {
    /// Builds (once) and caches the nav graph, pinning `meta.start`/`meta.finish` if set so
    /// those maze nodes are always nav nodes, never compressed into a passage's interior —
    /// every consumer (cycle search, SCC, repair strategies) then sees endpoints consistently
    /// as junctions, regardless of their local passage-like degree.
    pub fn nav_graph(&self, graph: &Graph, meta: &MazeMeta) -> &graph::nav::NavGraph {
        self.nav_graph.get_or_init(|| {
            let mut pinned = std::collections::HashSet::new();
            if let Some(s) = meta.start { pinned.insert(s); }
            if let Some(f) = meta.finish { pinned.insert(f); }
            graph::nav::build_nav_graph_pinned(graph, &pinned)
        })
    }

    pub fn scc(&self, graph: &Graph) -> &graph::scc::ConnectedComponents {
        self.scc.get_or_init(|| graph::scc::build_scc(graph))
    }

    /// Computes (and caches per `(start, finish)` pair) the route between two maze nodes,
    /// pinning exactly those two nodes — independent of `nav_graph()`'s own pinned cache,
    /// since the route's pinned set may differ from `meta.start`/`meta.finish` (e.g. a
    /// strategy probing a candidate pair before committing it to `meta`).
    ///
    /// Single-slot cache: only the most recently requested `(start, finish)` pair is kept.
    /// Calling this with alternating pairs (e.g. probing several candidates in a loop) defeats
    /// the cache entirely — every call rebuilds. Fine for the current single-pair use (route
    /// display), but a caller comparing many candidate pairs should build its own nav graph
    /// once rather than calling this in a loop.
    pub fn route_info(&self, graph: &Graph, start: ids::NodeId, finish: ids::NodeId) -> Option<graph::routing::RouteInfo> {
        let mut cache = self.route_info.borrow_mut();
        if !matches!(&*cache, Some((s, f, _)) if *s == start && *f == finish) {
            let mut pinned = std::collections::HashSet::new();
            pinned.insert(start);
            pinned.insert(finish);
            let nav = graph::nav::build_nav_graph_pinned(graph, &pinned);
            let info = graph::routing::compute_route_info(&nav, start, finish);
            *cache = Some((start, finish, info));
        }
        cache.as_ref().unwrap().2.clone()
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
