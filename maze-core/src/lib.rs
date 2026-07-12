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

pub use ids::{NodeId, IdGenerator};
pub use graph::Graph;
pub use graph::classify::{GeometricNodeClass, classify_node};
pub use graph::stats::{GeometricNodeStats, SpatialEdgeStats, TeleportEdgeStats, compute_node_stats, compute_spatial_edge_stats, compute_teleport_edge_stats};
pub use graph::routing::{RouteInfo, compute_route_info};
pub use graph::graph_analytics::{GraphAnalytics, compute_graph_analytics};
pub use graph::region_class::{RegionClass, classify_regions};
pub use space::{
    Tessellation, Field, geometric_distance,
    HexPoint, HexFace, HexTessellation, hex_parallelogram, hex_hexagon,
    SquarePoint, SquareTessellation, SquareFace, square_rect,
    TriPoint, TriFace, TriTessellation, tri_rect, tri_triangle, tri_hexagon,
};
pub use meta::MazeMeta;
pub use generation::{generate_maze, generate_maze_steps, build_preset_state, ElementsConfig, GenerationConfig, GenerationAlgorithm, GenerationEdge, GenerationStep, PresetConnection, PresetConnectionState, TeleportDirection, NodeLockKind, LockedNode, PresetState};
pub use generation::pipeline::{build_maze, MAX_REPAIR_ITERATIONS, RepairLimits, GenerationTiming, TimingEntry};

pub struct MazeAnalysis {
    nav_graph: std::cell::RefCell<Option<(u64, Option<ids::NodeId>, Option<ids::NodeId>, graph::nav::NavGraph)>>,
    scc: std::cell::RefCell<Option<(u64, graph::scc::ConnectedComponents)>>,
    route_info: std::cell::RefCell<Option<(u64, Option<ids::NodeId>, Option<ids::NodeId>, Option<graph::routing::RouteInfo>)>>,
    graph_analytics: std::cell::RefCell<Option<(u64, Option<ids::NodeId>, Option<ids::NodeId>, GraphAnalytics)>>,
    distance_from_start: std::cell::RefCell<Option<(u64, ids::NodeId, std::collections::HashMap<graph::nav::NavNodeId, usize>)>>,
    distance_from_finish: std::cell::RefCell<Option<(u64, ids::NodeId, std::collections::HashMap<graph::nav::NavNodeId, usize>)>>,
    region_classes: std::cell::RefCell<Option<(u64, Option<ids::NodeId>, Option<ids::NodeId>, std::collections::HashMap<graph::scc::ComponentId, RegionClass>)>>,
    reachable_from_start: std::cell::RefCell<Option<(u64, ids::NodeId, std::collections::HashSet<ids::NodeId>)>>,
    reachable_to_finish: std::cell::RefCell<Option<(u64, ids::NodeId, std::collections::HashSet<ids::NodeId>)>>,
    cycles: std::cell::RefCell<Option<(u64, Option<ids::NodeId>, Option<ids::NodeId>, Option<Vec<Vec<usize>>>)>>,
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
            region_classes: std::cell::RefCell::new(None),
            reachable_from_start: std::cell::RefCell::new(None),
            reachable_to_finish: std::cell::RefCell::new(None),
            cycles: std::cell::RefCell::new(None),
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

    /// Computes (and caches per `(graph.version(), meta.start, meta.finish)` key) the route
    /// between `meta.start` and `meta.finish`, pinning exactly those two nodes — independent of
    /// `nav_graph()`'s own pinned cache, since callers may want the route without pinning every
    /// other consumer's nav graph to this specific pair.
    ///
    /// Returns `None` if either `meta.start` or `meta.finish` is unset, or if no route exists
    /// between them.
    pub fn route_info(&self, graph: &Graph, meta: &MazeMeta) -> Option<graph::routing::RouteInfo> {
        let (start, finish) = (meta.start?, meta.finish?);
        let version = graph.version();
        let mut cache = self.route_info.borrow_mut();
        if !matches!(&*cache, Some((v, s, f, _)) if *v == version && *s == Some(start) && *f == Some(finish)) {
            let mut pinned = std::collections::HashSet::new();
            pinned.insert(start);
            pinned.insert(finish);
            let nav = graph::nav::build_nav_graph_pinned(graph, &pinned);
            let info = graph::routing::compute_route_info(&nav, start, finish);
            *cache = Some((version, Some(start), Some(finish), info));
        }
        cache.as_ref().unwrap().3.clone()
    }

    /// Classifies every SCC region relative to `meta.start`/`meta.finish` (see
    /// `graph::region_class`). Keyed on `(graph.version(), meta.start, meta.finish)` — same
    /// invalidation shape as `route_info`/`scc`, since classification depends on both. Reuses
    /// `scc()` and `route_info()`, both independently cached, so repeated calls within the same
    /// key are cheap.
    ///
    /// Returns an empty map if either `meta.start` or `meta.finish` is unset — there is no
    /// start/finish to classify regions relative to.
    pub fn region_classes(&self, graph: &Graph, meta: &MazeMeta) -> std::collections::HashMap<graph::scc::ComponentId, RegionClass> {
        let Some(start) = meta.start else { return std::collections::HashMap::new(); };
        let Some(finish) = meta.finish else { return std::collections::HashMap::new(); };
        let key = (graph.version(), Some(start), Some(finish));
        let mut cache = self.region_classes.borrow_mut();
        if !matches!(&*cache, Some((v, s, f, _)) if (*v, *s, *f) == key) {
            let scc = self.scc(graph);
            let route = self.route_info(graph, meta);
            let classes = graph::region_class::classify_regions(graph, &scc, route.as_ref(), start, finish);
            *cache = Some((key.0, key.1, key.2, classes));
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

    /// Builds and caches the set of maze nodes reachable FROM `meta.start` (graph-domain
    /// `NodeId`, directed forward traversal via `Graph::reachable_from`) — keyed on
    /// `(graph.version(), meta.start)`, invalidated whenever the graph changes or `start` is
    /// moved. Returns `None` if `meta.start` isn't set.
    ///
    /// Independent of `meta.finish` — unlike `route_info`/`region_classes`, which need both
    /// endpoints, this is single-node reachability and stays useful with only `start` set (e.g.
    /// `RandomEndpointsStrategy` searching for a `finish` candidate before one is chosen).
    pub fn reachable_from_start(&self, graph: &Graph, meta: &MazeMeta) -> Option<std::collections::HashSet<ids::NodeId>> {
        let start = meta.start?;
        let version = graph.version();
        let mut cache = self.reachable_from_start.borrow_mut();
        if !matches!(&*cache, Some((v, s, _)) if *v == version && *s == start) {
            let reachable: std::collections::HashSet<ids::NodeId> = graph.reachable_from(start).into_iter().collect();
            *cache = Some((version, start, reachable));
        }
        Some(cache.as_ref().unwrap().2.clone())
    }

    /// Builds and caches the set of maze nodes that can reach `meta.finish` (graph-domain
    /// `NodeId`, directed reverse traversal via `Graph::reachable_to`) — keyed on
    /// `(graph.version(), meta.finish)`, same invalidation contract as `reachable_from_start`.
    /// Returns `None` if `meta.finish` isn't set. Independent of `meta.start`, for the same
    /// reason as `reachable_from_start`.
    pub fn reachable_to_finish(&self, graph: &Graph, meta: &MazeMeta) -> Option<std::collections::HashSet<ids::NodeId>> {
        let finish = meta.finish?;
        let version = graph.version();
        let mut cache = self.reachable_to_finish.borrow_mut();
        if !matches!(&*cache, Some((v, f, _)) if *v == version && *f == finish) {
            let reachable: std::collections::HashSet<ids::NodeId> = graph.reachable_to(finish).into_iter().collect();
            *cache = Some((version, finish, reachable));
        }
        Some(cache.as_ref().unwrap().2.clone())
    }

    /// Deduped simple nav-cycles (`find_all_simple_cycles` + `dedup_bidirectional_pairs`), as
    /// nav-edge index lists — the pre-resolve level every loop-based QC check's own predicate
    /// (tile length, distinct exit count, min distance from a waypoint) needs, since
    /// `graph::cycles::resolve_to_edge_ids` collapses nav-edge structure (tile paths) into a
    /// flat base-`Graph` `EdgeId` set and can't be un-resolved back into it.
    ///
    /// `None` on `graph::cycles::CycleSearchResult::TooManyCycles` overflow (see
    /// `MAX_SIMPLE_CYCLES`) — callers silently skip, same rationale as `find_deduped_simple_cycles`.
    /// Keyed on `(graph.version(), meta.start, meta.finish)` — same key as `nav_graph`/
    /// `graph_analytics`, since cycle enumeration runs on that same pinned nav graph. The index
    /// into the returned `Vec` is stable for every caller reading this cache entry within one
    /// key (one graph version) — this is the "cycle id" `InvalidLoopIssue` stores instead of
    /// re-deriving identity via `canonical_cycle_key`.
    pub fn cycles(&self, graph: &Graph, meta: &MazeMeta) -> Option<Vec<Vec<usize>>> {
        let key = (graph.version(), meta.start, meta.finish);
        let mut cache = self.cycles.borrow_mut();
        if !matches!(&*cache, Some((v, s, f, _)) if (*v, *s, *f) == key) {
            let nav = self.nav_graph(graph, meta);
            let cycles = graph::cycles::find_deduped_simple_cycles(&nav);
            *cache = Some((key.0, key.1, key.2, cycles));
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

    #[test]
    fn region_classes_repeated_call_returns_same_result_without_graph_change() {
        let (mut maze, nodes) = line_maze(4);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[3]);
        let first = maze.analysis.region_classes(&maze.graph, &maze.meta);
        let second = maze.analysis.region_classes(&maze.graph, &maze.meta);
        assert_eq!(first, second, "repeated call with unchanged graph/start/finish must return identical map");
    }

    /// Directed line start(0) -> 1 -> 2 -> finish(3), each node its own SCC (one-way edges
    /// never merge into a single component the way `line_maze`'s bidirectional ones would).
    fn directed_line_maze(len: usize) -> (Maze<SquareTessellation>, Vec<ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<ids::NodeId> = (0..len)
            .map(|x| field.node_at(SquarePoint { x: x as i32, y: 0 }).unwrap())
            .collect();
        for i in 0..len - 1 {
            g.add_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let maze = Maze::new(field, g);
        (maze, nodes)
    }

    #[test]
    fn region_classes_invalidates_on_graph_mutation() {
        let (mut maze, nodes) = directed_line_maze(4);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[3]);

        // Remove the one-way link into nodes[2] — nodes[2]/nodes[3] become unreachable from
        // start. nodes[3] is finish itself (always Path by definition), so check nodes[2].
        let cut = maze.graph.edge_between(nodes[1], nodes[2]).unwrap();
        maze.graph.remove_edge(cut);

        let scc = maze.analysis.scc(&maze.graph);
        let before = maze.analysis.region_classes(&maze.graph, &maze.meta);
        assert_eq!(before[&scc.component_of(nodes[2]).unwrap()], RegionClass::Unreachable);

        // Reconnect — cached entry for nodes[2]'s region must reflect the new reachability
        // (now on the start->finish route), not the stale pre-mutation value, since
        // graph.version() bumped.
        maze.graph.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        let scc_after = maze.analysis.scc(&maze.graph);
        let after = maze.analysis.region_classes(&maze.graph, &maze.meta);
        assert_eq!(after[&scc_after.component_of(nodes[2]).unwrap()], RegionClass::Path, "cache must invalidate after graph.version() changes");
    }

    #[test]
    fn region_classes_invalidates_when_start_or_finish_changes() {
        let (mut maze, nodes) = directed_line_maze(4);
        maze.meta.start = Some(nodes[0]);
        maze.meta.finish = Some(nodes[3]);
        // Extra one-way branch off nodes[1] into a dead end — its own region, reachable from
        // start but never on the start->finish path regardless of which node is start.
        maze.graph.add_edge(nodes[1], nodes[3], EdgeKind::Basic);
        let scc = maze.analysis.scc(&maze.graph);

        // nodes[0] is start here, so its own region is Path by definition.
        let with_node0_as_start = maze.analysis.region_classes(&maze.graph, &maze.meta);
        assert_eq!(with_node0_as_start[&scc.component_of(nodes[0]).unwrap()], RegionClass::Path);

        // Same graph.version(), nodes[0] is no longer start — with no incoming edge into
        // nodes[0], it's unreachable from nodes[1]. Confirms the cache key includes start.
        let meta_with_node1_as_start = MazeMeta { start: Some(nodes[1]), finish: Some(nodes[3]), route_score: None };
        let with_node1_as_start = maze.analysis.region_classes(&maze.graph, &meta_with_node1_as_start);
        assert_eq!(with_node1_as_start[&scc.component_of(nodes[0]).unwrap()], RegionClass::Unreachable);
    }
}

#[cfg(test)]
mod cycles_cache_tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    fn triangle_maze() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[2], nodes[0], EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn repeated_call_returns_same_result_without_graph_change() {
        let maze = triangle_maze();
        let first = maze.analysis.cycles(&maze.graph, &maze.meta);
        let second = maze.analysis.cycles(&maze.graph, &maze.meta);
        assert_eq!(first, second, "repeated call with unchanged graph must return identical result");
        assert_eq!(first.unwrap().len(), 1, "the triangle is exactly one simple cycle");
    }

    #[test]
    fn invalidates_on_graph_mutation() {
        let mut maze = triangle_maze();
        let before = maze.analysis.cycles(&maze.graph, &maze.meta).unwrap();
        assert_eq!(before.len(), 1);

        // Cut one edge of the triangle -- the cycle must disappear from the cache after
        // graph.version() bumps, not return the stale pre-mutation result.
        let nodes: Vec<_> = maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).collect();
        let cut = maze.graph.edge_between(nodes[2], nodes[0]).unwrap();
        maze.graph.remove_edge(cut);
        let after = maze.analysis.cycles(&maze.graph, &maze.meta).unwrap();
        assert!(after.is_empty(), "cache must invalidate after graph.version() changes");
    }

    #[test]
    fn none_on_cycle_enumeration_overflow() {
        // Same 6x6 fully-bidirectional grid as the cycles.rs regression test for issue #22
        // (2,444,782 simple cycles -- far past MAX_SIMPLE_CYCLES).
        const SIDE: i32 = 6;
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(SIDE as usize, SIDE as usize), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        for y in 0..SIDE {
            for x in 0..SIDE {
                let here = field.node_at(SquarePoint { x, y }).unwrap();
                if x + 1 < SIDE {
                    let right = field.node_at(SquarePoint { x: x + 1, y }).unwrap();
                    g.add_bidirectional_edge(here, right, EdgeKind::Basic);
                }
                if y + 1 < SIDE {
                    let up = field.node_at(SquarePoint { x, y: y + 1 }).unwrap();
                    g.add_bidirectional_edge(here, up, EdgeKind::Basic);
                }
            }
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        assert!(maze.analysis.cycles(&maze.graph, &maze.meta).is_none(), "overflow must yield None, not a partial result");
    }

    #[test]
    fn key_includes_meta_start_and_finish() {
        // Same graph.version(), different pinned start -- must not reuse a cache entry built
        // for a different pin, since pinning start/finish can change which junction-free rings
        // compress into passages (and therefore which cycles nav-enumeration finds).
        let mut maze = triangle_maze();
        let nodes: Vec<_> = maze.field.all_points().map(|p| maze.field.node_at(p).unwrap()).collect();
        let first = maze.analysis.cycles(&maze.graph, &maze.meta).unwrap();
        maze.meta.start = Some(nodes[0]);
        let second = maze.analysis.cycles(&maze.graph, &maze.meta).unwrap();
        assert_eq!(first.len(), second.len(), "the triangle stays one cycle regardless of pinning");
    }
}
