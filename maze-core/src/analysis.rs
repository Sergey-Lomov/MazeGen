use crate::graph::{self, Graph, graph_analytics::GraphAnalytics, region_class::RegionClass};
use crate::ids;
use crate::meta::MazeMeta;
use crate::space;

/// `Graph::cache_key()`: graph version plus the id of the active scope mask, so a result computed
/// under a scope is never served to another scope or to the full graph.
type CacheKey = (u64, u64);

type NavGraphCache = Option<(
    CacheKey,
    Option<ids::NodeId>,
    Option<ids::NodeId>,
    graph::nav::NavGraph,
)>;
type RouteInfoCache = Option<(
    CacheKey,
    Option<ids::NodeId>,
    Option<ids::NodeId>,
    Option<graph::routing::RouteInfo>,
)>;
type GraphAnalyticsCache = Option<(
    CacheKey,
    Option<ids::NodeId>,
    Option<ids::NodeId>,
    GraphAnalytics,
)>;
type DistanceMapCache = Option<(
    CacheKey,
    ids::NodeId,
    std::collections::HashMap<graph::nav::NavNodeId, usize>,
)>;
type RegionClassesCache = Option<(
    CacheKey,
    Option<ids::NodeId>,
    Option<ids::NodeId>,
    std::collections::HashMap<graph::scc::ComponentId, RegionClass>,
)>;
type ReachableSetCache = Option<(
    CacheKey,
    ids::NodeId,
    std::collections::HashSet<ids::NodeId>,
)>;

pub struct MazeAnalysis {
    nav_graph: std::cell::RefCell<NavGraphCache>,
    /// The nav graph of the whole maze while a scope is raised, so the landmark queries that lift the
    /// mask do not evict the scoped one.
    nav_graph_full: std::cell::RefCell<NavGraphCache>,
    scc: std::cell::RefCell<Option<(CacheKey, graph::scc::ConnectedComponents)>>,
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
            nav_graph_full: std::cell::RefCell::new(None),
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
    /// Keyed on `(graph.cache_key(), meta.start, meta.finish)` — a repair strategy mutating the
    /// graph (or changing which nodes are pinned) after this was first cached invalidates the
    /// entry and triggers a rebuild on the next call, instead of silently returning stale data
    /// (see issue #20).
    pub fn nav_graph(&self, graph: &Graph, meta: &MazeMeta) -> graph::nav::NavGraph {
        let key = (graph.cache_key(), meta.start, meta.finish);
        let mut cache = if graph.scope_active() {
            self.nav_graph.borrow_mut()
        } else {
            self.nav_graph_full.borrow_mut()
        };
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

    /// Keyed on `graph.cache_key()` — see `nav_graph` for why.
    pub fn scc(&self, graph: &Graph) -> graph::scc::ConnectedComponents {
        let version = graph.cache_key();
        let mut cache = self.scc.borrow_mut();
        if !matches!(&*cache, Some((v, _)) if *v == version) {
            *cache = Some((version, graph::scc::build_scc(graph)));
        }
        cache.as_ref().unwrap().1.clone()
    }

    /// Computes (and caches per `(graph.cache_key(), meta.start, meta.finish)` key) the route
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
        if graph.scope_active() {
            return graph.unscoped(|| self.route_info(graph, field, meta));
        }
        let (start, finish) = (meta.start?, meta.finish?);
        let version = graph.cache_key();
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
    /// `graph::region_class`). Keyed on `(graph.cache_key(), meta.start, meta.finish)` — same
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
        if graph.scope_active() {
            return graph.unscoped(|| self.region_classes(graph, field, meta));
        }
        let Some(start) = meta.start else {
            return std::collections::HashMap::new();
        };
        let Some(finish) = meta.finish else {
            return std::collections::HashMap::new();
        };
        let key = (graph.cache_key(), Some(start), Some(finish));
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
    /// graph for `(graph.cache_key(), meta.start, meta.finish)` — same key as `nav_graph`, since
    /// analytics is computed directly on that nav graph.
    ///
    /// `compute_graph_analytics` has no toggle and is called on every analytics snapshot
    /// (`maze-wasm/src/analytics.rs`) — caching it avoids recomputing cycle structure from
    /// scratch on every call within the same graph version (e.g. repeated UI refreshes), on
    /// top of the `MAX_SIMPLE_CYCLES` bound in `find_all_simple_cycles` that keeps any single
    /// computation from hanging (see issue #22).
    pub fn graph_analytics(&self, graph: &Graph, meta: &MazeMeta) -> GraphAnalytics {
        let key = (graph.cache_key(), meta.start, meta.finish);
        let mut cache = self.graph_analytics.borrow_mut();
        if !matches!(&*cache, Some((v, s, f, _)) if (*v, *s, *f) == key) {
            let nav = self.nav_graph(graph, meta);
            let analytics = graph::graph_analytics::compute_graph_analytics(&nav);
            // GitHub issue #976: cycle enumeration aborts on the QC deadline, so a result computed
            // after it expired may be a bogus "too many cycles" — hand it back uncached.
            if crate::deadline::expired() {
                return analytics;
            }
            *cache = Some((key.0, key.1, key.2, analytics));
        }
        cache.as_ref().unwrap().3.clone()
    }

    /// Builds and caches the per-nav-node shortest-path distance (in tiles) FROM `meta.start`,
    /// keyed on `(graph.cache_key(), meta.start)` — invalidated whenever the graph changes or
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
        if graph.scope_active() {
            return graph.unscoped(|| self.distance_from_start(graph, meta));
        }
        let start = meta.start?;
        let version = graph.cache_key();
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
    /// keyed on `(graph.cache_key(), meta.finish)` — same invalidation contract and nav-domain
    /// rationale as `distance_from_start`. Returns `None` if `meta.finish` isn't set.
    pub fn distance_from_finish(
        &self,
        graph: &Graph,
        meta: &MazeMeta,
    ) -> Option<std::collections::HashMap<graph::nav::NavNodeId, usize>> {
        if graph.scope_active() {
            return graph.unscoped(|| self.distance_from_finish(graph, meta));
        }
        let finish = meta.finish?;
        let version = graph.cache_key();
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

    /// `distance_from_start` re-keyed to `nav`, the nav graph of the raised scope: both are built on
    /// the same pinned junctions, so a junction of `nav` is one of the whole maze's nav graph too. A
    /// node of `nav` the whole maze's graph has no junction for stays out of the map.
    pub fn distance_from_start_in(
        &self,
        graph: &Graph,
        meta: &MazeMeta,
        nav: &graph::nav::NavGraph,
    ) -> Option<std::collections::HashMap<graph::nav::NavNodeId, usize>> {
        let dist = self.distance_from_start(graph, meta)?;
        Some(self.rekey_distances(graph, meta, &dist, nav))
    }

    /// `distance_from_finish` re-keyed to `nav`, see `distance_from_start_in`.
    pub fn distance_from_finish_in(
        &self,
        graph: &Graph,
        meta: &MazeMeta,
        nav: &graph::nav::NavGraph,
    ) -> Option<std::collections::HashMap<graph::nav::NavNodeId, usize>> {
        let dist = self.distance_from_finish(graph, meta)?;
        Some(self.rekey_distances(graph, meta, &dist, nav))
    }

    fn rekey_distances(
        &self,
        graph: &Graph,
        meta: &MazeMeta,
        dist: &std::collections::HashMap<graph::nav::NavNodeId, usize>,
        nav: &graph::nav::NavGraph,
    ) -> std::collections::HashMap<graph::nav::NavNodeId, usize> {
        let full = graph.unscoped(|| self.nav_graph(graph, meta));
        nav.nodes
            .iter()
            .enumerate()
            .filter_map(|(id, node)| {
                let whole = full.nav_node_for(node.node_id)?;
                Some((id, *dist.get(&whole)?))
            })
            .collect()
    }

    /// Builds and caches the set of maze nodes reachable FROM `meta.start` (graph-domain
    /// `NodeId`, directed forward traversal via `Graph::reachable_from`) — keyed on
    /// `(graph.cache_key(), meta.start)`, invalidated whenever the graph changes or `start` is
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
        if graph.scope_active() {
            return graph.unscoped(|| self.reachable_from_start(graph, meta));
        }
        let start = meta.start?;
        let version = graph.cache_key();
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
    /// `(graph.cache_key(), meta.finish)`, same invalidation contract as `reachable_from_start`.
    /// Returns `None` if `meta.finish` isn't set. Independent of `meta.start`, for the same
    /// reason as `reachable_from_start`.
    pub fn reachable_to_finish(
        &self,
        graph: &Graph,
        meta: &MazeMeta,
    ) -> Option<std::collections::HashSet<ids::NodeId>> {
        if graph.scope_active() {
            return graph.unscoped(|| self.reachable_to_finish(graph, meta));
        }
        let finish = meta.finish?;
        let version = graph.cache_key();
        let mut cache = self.reachable_to_finish.borrow_mut();
        if !matches!(&*cache, Some((v, f, _)) if *v == version && *f == finish) {
            let reachable: std::collections::HashSet<ids::NodeId> =
                graph.reachable_to(finish).into_iter().collect();
            *cache = Some((version, finish, reachable));
        }
        Some(cache.as_ref().unwrap().2.clone())
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::*;
    use crate::graph::{EdgeKind, Graph};

    fn triangle() -> Graph {
        let mut g = Graph::new();
        for id in [0, 1, 2] {
            g.add_node(id);
        }
        g.add_edge(0, 1, EdgeKind::Basic);
        g.add_edge(1, 2, EdgeKind::Basic);
        g.add_edge(2, 0, EdgeKind::Basic);
        g
    }

    #[test]
    fn graph_analytics_computed_under_an_expired_deadline_is_not_cached() {
        let graph = triangle();
        let meta = MazeMeta::empty();
        let analysis = MazeAnalysis::default();
        {
            let _deadline = crate::deadline::install(Some(crate::clock::now_ms() - 1.0));
            assert!(
                analysis
                    .graph_analytics(&graph, &meta)
                    .cycle_analysis_overflowed
            );
        }
        // Same graph version, deadline gone: a poisoned cache would still say "overflowed".
        assert!(
            !analysis
                .graph_analytics(&graph, &meta)
                .cycle_analysis_overflowed
        );
    }
}
