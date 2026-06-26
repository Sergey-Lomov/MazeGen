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
    distance_from_start: std::cell::RefCell<Option<(u64, ids::NodeId, std::collections::HashMap<graph::nav::NavNodeId, usize>)>>,
    distance_from_finish: std::cell::RefCell<Option<(u64, ids::NodeId, std::collections::HashMap<graph::nav::NavNodeId, usize>)>>,
}

impl Default for MazeAnalysis {
    fn default() -> Self {
        Self {
            nav_graph: std::cell::RefCell::new(None),
            scc: std::cell::RefCell::new(None),
            route_info: std::cell::RefCell::new(None),
            graph_analytics: std::cell::RefCell::new(None),
            distance_from_start: std::cell::RefCell::new(None),
            distance_from_finish: std::cell::RefCell::new(None),
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

    /// Builds and caches the per-nav-node shortest-path distance (in tiles) FROM `meta.start`,
    /// keyed on `(graph.version(), meta.start)` — invalidated whenever the graph changes or
    /// `start` is moved. Returns `None` if `meta.start` isn't set. Unreachable nav-nodes are
    /// absent from the returned map.
    ///
    /// Nav-domain (`NavNodeId`), not maze `NodeId` — junction/start/finish nodes only, since
    /// every consumer (QC checks operating on cycles, which are themselves nav-edge lists)
    /// works in that domain already. Distance is still tile count, not nav-edge hop count:
    /// each nav-edge already carries its own tile length (`path.len() - 1`).
    ///
    /// Distance is computed via directed graph traversal (`compute_distance_map`) on the
    /// pinned nav graph, never geometric/coordinate distance — see `graph-analytics.md`.
    pub fn distance_from_start(&self, graph: &Graph, meta: &MazeMeta) -> Option<std::collections::HashMap<graph::nav::NavNodeId, usize>> {
        let start = meta.start?;
        let version = graph.version();
        let mut cache = self.distance_from_start.borrow_mut();
        if !matches!(&*cache, Some((v, s, _)) if *v == version && *s == start) {
            let nav = self.nav_graph(graph, meta);
            let source = nav.nav_node_for(start)
                .expect("nav_graph always pins meta.start as a NavNode when meta.start is Some");
            let dist = graph::distance_map::compute_distance_map(&nav, source, graph::distance_map::DistanceDirection::Forward);
            *cache = Some((version, start, dist));
        }
        Some(cache.as_ref().unwrap().2.clone())
    }

    /// Builds and caches the per-nav-node shortest-path distance (in tiles) TO `meta.finish`,
    /// keyed on `(graph.version(), meta.finish)` — same invalidation contract and nav-domain
    /// rationale as `distance_from_start`. Returns `None` if `meta.finish` isn't set.
    pub fn distance_from_finish(&self, graph: &Graph, meta: &MazeMeta) -> Option<std::collections::HashMap<graph::nav::NavNodeId, usize>> {
        let finish = meta.finish?;
        let version = graph.version();
        let mut cache = self.distance_from_finish.borrow_mut();
        if !matches!(&*cache, Some((v, f, _)) if *v == version && *f == finish) {
            let nav = self.nav_graph(graph, meta);
            let source = nav.nav_node_for(finish)
                .expect("nav_graph always pins meta.finish as a NavNode when meta.finish is Some");
            let dist = graph::distance_map::compute_distance_map(&nav, source, graph::distance_map::DistanceDirection::Reverse);
            *cache = Some((version, finish, dist));
        }
        Some(cache.as_ref().unwrap().2.clone())
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

#[cfg(test)]
mod distance_cache_tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    fn line_maze(len: usize) -> (Maze<SquareTessellation>, Vec<ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<ids::NodeId> = (0..len)
            .map(|x| field.node_at(SquarePoint { x: x as i32, y: 0 }).unwrap())
            .collect();
        for i in 0..len - 1 {
            g.add_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let maze = Maze::new(field, g);
        (maze, nodes)
    }

    #[test]
    fn distance_from_start_repeated_call_returns_same_result_without_graph_change() {
        let (mut maze, nodes) = line_maze(4);
        maze.meta.start = Some(nodes[0]);
        let first = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
        let second = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
        assert_eq!(first, second, "repeated call with unchanged graph/start must return identical map");
    }

    #[test]
    fn distance_from_start_invalidates_on_graph_mutation() {
        let (mut maze, nodes) = line_maze(4);
        maze.meta.start = Some(nodes[0]);
        let last_nav = maze.analysis.nav_graph(&maze.graph, &maze.meta).nav_node_for(nodes[3]).unwrap();
        let before = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
        assert_eq!(before.get(&last_nav), Some(&3));

        // Add a shortcut directly from start to the last node — cached entry for `nodes[3]`
        // must reflect the new shorter path, not the stale pre-mutation value.
        maze.graph.add_edge(nodes[0], nodes[3], EdgeKind::Basic);
        let after = maze.analysis.distance_from_start(&maze.graph, &maze.meta).unwrap();
        assert_eq!(after.get(&last_nav), Some(&1), "cache must invalidate after graph.version() changes");
    }

    #[test]
    fn distance_from_finish_invalidates_when_finish_moves() {
        let (mut maze, nodes) = line_maze(4);
        maze.meta.finish = Some(nodes[3]);
        let first_nav = maze.analysis.nav_graph(&maze.graph, &maze.meta).nav_node_for(nodes[0]).unwrap();
        let before = maze.analysis.distance_from_finish(&maze.graph, &maze.meta).unwrap();
        assert_eq!(before.get(&first_nav), Some(&3));

        // Moving finish to nodes[1] without touching the graph itself (same version) must
        // still bust the cache — keyed on finish, not just graph.version().
        maze.meta.finish = Some(nodes[1]);
        let after = maze.analysis.distance_from_finish(&maze.graph, &maze.meta).unwrap();
        assert_eq!(after.get(&first_nav), Some(&1));
    }
}
