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
pub use graph::classify::{
    GeometricNodeClass, GeometricNodeStats, SpatialEdgeStats, RouteInfo,
    classify_node, compute_node_stats, compute_spatial_edge_stats, compute_route_info,
};
pub use space::{
    Field, FieldShape, ShapedField,
    HexField, HexPoint, HexFace, HexTessellation,
    HexParallelogram, HexHexagon,
    SquareField, SquarePoint, SquareTessellation, SquareRect,
    TriField, TriPoint, TriFace, TriTessellation, TriRect, TriTriangle, TriHexagon,
};
pub use meta::MazeMeta;
pub use generation::{generate_maze, generate_maze_steps, ElementsConfig, GenerationConfig, GenerationAlgorithm, GenerationEdge, GenerationStep};
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

    pub fn nav_graph_pinned<'a>(&'a mut self, graph: &Graph, pinned: &std::collections::HashSet<ids::NodeId>) -> &'a graph::nav::NavGraph {
        // Always rebuild when pinned nodes are specified — pinned set may differ from cached build.
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

pub struct Maze<F: Field> {
    pub field: F,
    pub graph: Graph,
    pub meta: MazeMeta,
    pub analysis: MazeAnalysis,
}

impl<F: Field> Maze<F> {
    pub fn new(field: F, graph: Graph) -> Self {
        Self {
            field,
            graph,
            meta: MazeMeta::empty(),
            analysis: MazeAnalysis::default(),
        }
    }
}
