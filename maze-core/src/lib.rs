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
    nav_graph: Option<graph::nav::NavGraph>,
    scc: Option<graph::scc::ConnectedComponents>,
}

impl Default for MazeAnalysis {
    fn default() -> Self {
        Self { nav_graph: None, scc: None }
    }
}

impl MazeAnalysis {
    pub fn nav_graph<'a>(&'a mut self, graph: &Graph) -> &'a graph::nav::NavGraph {
        if self.nav_graph.is_none() {
            self.nav_graph = Some(graph::nav::build_nav_graph(graph));
        }
        self.nav_graph.as_ref().unwrap()
    }

    /// Always rebuilds and overwrites the cache `nav_graph()` memoizes into, even if already
    /// populated — pinned set may differ from whatever built the cached graph. Call this last
    /// if a pass also needs the plain `nav_graph()` result; calling `nav_graph()` afterward
    /// returns the pinned graph, not a fresh plain one.
    pub fn nav_graph_pinned<'a>(&'a mut self, graph: &Graph, pinned: &std::collections::HashSet<ids::NodeId>) -> &'a graph::nav::NavGraph {
        self.nav_graph = Some(graph::nav::build_nav_graph_pinned(graph, pinned));
        self.nav_graph.as_ref().unwrap()
    }

    pub fn scc<'a>(&'a mut self, graph: &Graph) -> &'a graph::scc::ConnectedComponents {
        if self.scc.is_none() {
            self.scc = Some(graph::scc::build_scc(graph));
        }
        self.scc.as_ref().unwrap()
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
