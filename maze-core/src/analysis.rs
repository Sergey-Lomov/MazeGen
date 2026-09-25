use crate::graph::{self, Graph, graph_analytics::GraphAnalytics, region_class::RegionClass};
use crate::ids;
use crate::meta::MazeMeta;
use crate::space;

type NavGraphCache = Option<(
    u64,
    Option<ids::NodeId>,
    Option<ids::NodeId>,
    graph::nav::NavGraph,
)>;
type RouteInfoCache = Option<(
    u64,
    Option<ids::NodeId>,
    Option<ids::NodeId>,
    Option<graph::routing::RouteInfo>,
)>;
type GraphAnalyticsCache = Option<(
    u64,
    Option<ids::NodeId>,
    Option<ids::NodeId>,
    GraphAnalytics,
)>;
type DistanceMapCache = Option<(
    u64,
    ids::NodeId,
    std::collections::HashMap<graph::nav::NavNodeId, usize>,
)>;
type RegionClassesCache = Option<(
    u64,
    Option<ids::NodeId>,
    Option<ids::NodeId>,
    std::collections::HashMap<graph::scc::ComponentId, RegionClass>,
)>;
type ReachableSetCache = Option<(u64, ids::NodeId, std::collections::HashSet<ids::NodeId>)>;

pub struct MazeAnalysis {
    nav_graph: std::cell::RefCell<NavGraphCache>,
    scc: std::cell::RefCell<Option<(u64, graph::scc::ConnectedComponents)>>,
    route_info: std::cell::RefCell<RouteInfoCache>,
    graph_analytics: std::cell::RefCell<GraphAnalyticsCache>,
    distance_from_start: std::cell::RefCell<DistanceMapCache>,
    distance_from_finish: std::cell::RefCell<DistanceMapCache>,
    region_classes: std::cell::RefCell<RegionClassesCache>,
    reachable_from_start: std::cell::RefCell<ReachableSetCache>,
    reachable_to_finish: std::cell::RefCell<ReachableSetCache>,
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
            if let Some(s) = meta.start {
                pinned.insert(s);
            }
            if let Some(f) = meta.finish {
                pinned.insert(f);
            }
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
    pub fn route_info<T: space::Tessellation>(
        &self,
        graph: &Graph,
        field: &space::MultiLevelField<T>,
        meta: &MazeMeta,
    ) -> Option<graph::routing::RouteInfo> {
        let (start, finish) = (meta.start?, meta.finish?);
        let version = graph.version();
        let mut cache = self.route_info.borrow_mut();
        if !matches!(&*cache, Some((v, s, f, _)) if *v == version && *s == Some(start) && *f == Some(finish))
        {
            let mut pinned = std::collections::HashSet::new();
            pinned.insert(start);
            pinned.insert(finish);
            let nav = graph::nav::build_nav_graph_pinned(graph, &pinned);
            let info = graph::routing::compute_route_info(&nav, field, start, finish);
            *cache = Some((version, Some(start), Some(finish), info));
        }
        cache.as_ref().unwrap().3.clone()
    }

    /// Computes the same weighted score `ScoredEndpointsStrategy` uses to pick endpoints, but for
    /// the route already fixed by `meta.start`/`meta.finish` (GitHub issue #532) — unlike the
    /// strategy, this never runs as a repair side effect, so it stays available for a route whose
    /// endpoints were never "missing" in the first place (e.g. right after a post-edit confirm,
    /// where the strategy's own `MissingEndpointsIssue` never fires). Not cached (weights are
    /// caller-supplied and may vary per call) — reuses `nav_graph()`'s own cache for the pinned nav
    /// graph, so repeated calls at the same graph version/endpoints/weights are still cheap.
    ///
    /// Returns `None` if either `meta.start` or `meta.finish` is unset, or if no route exists
    /// between them.
    pub fn route_score<T: space::Tessellation>(
        &self,
        graph: &Graph,
        field: &space::MultiLevelField<T>,
        meta: &MazeMeta,
        weights: &crate::repair::strategies::ScoreWeights,
    ) -> Option<f64> {
        let (start, finish) = (meta.start?, meta.finish?);
        let nav = self.nav_graph(graph, meta);
        crate::repair::strategies::score_for_route(&nav, field, graph, start, finish, weights)
    }

    /// Classifies every SCC region relative to `meta.start`/`meta.finish` (see
    /// `graph::region_class`). Keyed on `(graph.version(), meta.start, meta.finish)` — same
    /// invalidation shape as `route_info`/`scc`, since classification depends on both. Reuses
    /// `scc()` and `route_info()`, both independently cached, so repeated calls within the same
    /// key are cheap.
    ///
    /// Returns an empty map if either `meta.start` or `meta.finish` is unset — there is no
    /// start/finish to classify regions relative to.
    pub fn region_classes<T: space::Tessellation>(
        &self,
        graph: &Graph,
        field: &space::MultiLevelField<T>,
        meta: &MazeMeta,
    ) -> std::collections::HashMap<graph::scc::ComponentId, RegionClass> {
        let Some(start) = meta.start else {
            return std::collections::HashMap::new();
        };
        let Some(finish) = meta.finish else {
            return std::collections::HashMap::new();
        };
        let key = (graph.version(), Some(start), Some(finish));
        let mut cache = self.region_classes.borrow_mut();
        if !matches!(&*cache, Some((v, s, f, _)) if (*v, *s, *f) == key) {
            let scc = self.scc(graph);
            let route = self.route_info(graph, field, meta);
            let classes =
                graph::region_class::classify_regions(graph, &scc, route.as_ref(), start, finish);
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
    pub fn distance_from_start(
        &self,
        graph: &Graph,
        meta: &MazeMeta,
    ) -> Option<std::collections::HashMap<graph::nav::NavNodeId, usize>> {
        let start = meta.start?;
        let version = graph.version();
        let mut cache = self.distance_from_start.borrow_mut();
        if !matches!(&*cache, Some((v, s, _)) if *v == version && *s == start) {
            let nav = self.nav_graph(graph, meta);
            let source = nav
                .nav_node_for(start)
                .expect("nav_graph always pins meta.start as a NavNode when meta.start is Some");
            let dist = graph::distance_map::compute_distance_map(
                &nav,
                source,
                graph::distance_map::DistanceDirection::Forward,
            );
            *cache = Some((version, start, dist));
        }
        Some(cache.as_ref().unwrap().2.clone())
    }

    /// Builds and caches the per-nav-node shortest-path distance (in tiles) TO `meta.finish`,
    /// keyed on `(graph.version(), meta.finish)` — same invalidation contract and nav-domain
    /// rationale as `distance_from_start`. Returns `None` if `meta.finish` isn't set.
    pub fn distance_from_finish(
        &self,
        graph: &Graph,
        meta: &MazeMeta,
    ) -> Option<std::collections::HashMap<graph::nav::NavNodeId, usize>> {
        let finish = meta.finish?;
        let version = graph.version();
        let mut cache = self.distance_from_finish.borrow_mut();
        if !matches!(&*cache, Some((v, f, _)) if *v == version && *f == finish) {
            let nav = self.nav_graph(graph, meta);
            let source = nav
                .nav_node_for(finish)
                .expect("nav_graph always pins meta.finish as a NavNode when meta.finish is Some");
            let dist = graph::distance_map::compute_distance_map(
                &nav,
                source,
                graph::distance_map::DistanceDirection::Reverse,
            );
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
    pub fn reachable_from_start(
        &self,
        graph: &Graph,
        meta: &MazeMeta,
    ) -> Option<std::collections::HashSet<ids::NodeId>> {
        let start = meta.start?;
        let version = graph.version();
        let mut cache = self.reachable_from_start.borrow_mut();
        if !matches!(&*cache, Some((v, s, _)) if *v == version && *s == start) {
            let reachable: std::collections::HashSet<ids::NodeId> =
                graph.reachable_from(start).into_iter().collect();
            *cache = Some((version, start, reachable));
        }
        Some(cache.as_ref().unwrap().2.clone())
    }

    /// Builds and caches the set of maze nodes that can reach `meta.finish` (graph-domain
    /// `NodeId`, directed reverse traversal via `Graph::reachable_to`) — keyed on
    /// `(graph.version(), meta.finish)`, same invalidation contract as `reachable_from_start`.
    /// Returns `None` if `meta.finish` isn't set. Independent of `meta.start`, for the same
    /// reason as `reachable_from_start`.
    pub fn reachable_to_finish(
        &self,
        graph: &Graph,
        meta: &MazeMeta,
    ) -> Option<std::collections::HashSet<ids::NodeId>> {
        let finish = meta.finish?;
        let version = graph.version();
        let mut cache = self.reachable_to_finish.borrow_mut();
        if !matches!(&*cache, Some((v, f, _)) if *v == version && *f == finish) {
            let reachable: std::collections::HashSet<ids::NodeId> =
                graph.reachable_to(finish).into_iter().collect();
            *cache = Some((version, finish, reachable));
        }
        Some(cache.as_ref().unwrap().2.clone())
    }
}
