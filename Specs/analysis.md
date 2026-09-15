# MazeAnalysis

Cached derived data attached to a `Maze`. Computed lazily on first access; cache entries are invalidated automatically when the underlying `Graph` is mutated (or, for `nav_graph`, when `meta.start`/`meta.finish` change), keyed on `Graph::version()`.

## Structure

```rust
pub struct MazeAnalysis {
    nav_graph: RefCell<Option<(u64, Option<NodeId>, Option<NodeId>, graph::nav::NavGraph)>>,
    scc: RefCell<Option<(u64, graph::scc::ConnectedComponents)>>,
    route_info: RefCell<Option<(u64, Option<NodeId>, Option<NodeId>, Option<graph::routing::RouteInfo>)>>,
    graph_analytics: RefCell<Option<(u64, Option<NodeId>, Option<NodeId>, GraphAnalytics)>>,
    distance_from_start: RefCell<Option<(u64, NodeId, HashMap<graph::nav::NavNodeId, usize>)>>,
    distance_from_finish: RefCell<Option<(u64, NodeId, HashMap<graph::nav::NavNodeId, usize>)>>,
}
```

The `u64` in each tuple is the `Graph::version()` value the cached entry was built from.

## Access

```rust
impl MazeAnalysis {
    pub fn nav_graph(&self, graph: &Graph, meta: &MazeMeta) -> NavGraph;
    pub fn scc(&self, graph: &Graph) -> ConnectedComponents;
    pub fn route_info<T: Tessellation>(&self, graph: &Graph, field: &Field<T>, meta: &MazeMeta) -> Option<RouteInfo>;
    pub fn route_score<T: Tessellation>(&self, graph: &Graph, field: &MultiLevelField<T>, meta: &MazeMeta, weights: &ScoreWeights) -> Option<f64>;
    pub fn graph_analytics(&self, graph: &Graph, meta: &MazeMeta) -> GraphAnalytics;
    pub fn distance_from_start(&self, graph: &Graph, meta: &MazeMeta) -> Option<HashMap<graph::nav::NavNodeId, usize>>;
    pub fn distance_from_finish(&self, graph: &Graph, meta: &MazeMeta) -> Option<HashMap<graph::nav::NavNodeId, usize>>;
}
```

All return owned values (cloned out of the cache), not references — `RefCell` borrow guards can't outlive the call, and the cached types are all cheap-ish to clone relative to rebuilding them. Callers that need the value multiple times in one scope should bind it once (`let nav = maze.analysis.nav_graph(...)`) rather than calling repeatedly.

- `nav_graph`: keyed on `(graph.version(), meta.start, meta.finish)`. **Always pins `meta.start`/`meta.finish`** (whichever are `Some`) — once a route endpoint is set, it is forced to be a `NavNode` everywhere this method is the source of the nav graph, instead of risking being silently collapsed into a passage's interior the moment its local degree happens to look like one. This is the single, project-wide pinning policy: `LoopLengthCheck`, `FarthestEndpointsStrategy`, `ScoredEndpointsStrategy`, and the WASM analytics layer all call this method and all observe the same pinned topology. **This is not opt-in per caller** — any future `Check` or `RepairStrategy` that calls `maze.analysis.nav_graph(...)` automatically inherits the pinned topology with no separate decision to make; there is no unpinned variant to fall back to from this method.
- `scc`: keyed on `graph.version()`; independent of pinning.
- `route_info`: computes a route between `meta.start`/`meta.finish`, pinning exactly that pair — independent of `nav_graph`'s own cache. Returns `None` if either endpoint is unset. `field` is only used to detect split tiles for `RouteInfo::split_count` (GitHub issue #261). Keyed on `(graph.version(), meta.start, meta.finish)`; single-slot — a different key (including a graph mutation with the same pair) triggers a rebuild, and probing alternating pairs in a loop defeats the cache entirely.
- `route_score` (GitHub issue #532): scores the `meta.start`/`meta.finish` route against caller-supplied `scored_endpoints` weights (`ScoreWeights`, `maze_core::repair::strategies::score_for_route`), independent of repair dispatch — unlike `RouteInfo::score` (always `None`, see `routing.md`), this is how a route's score is actually obtained, both right after generation and after any post-edit. Not itself cached (weights are caller-supplied and may vary call to call), but reuses `nav_graph()`'s cache internally. Returns `None` if either endpoint is unset or no path exists.
- `graph_analytics`: keyed on `(graph.version(), meta.start, meta.finish)`, same key as `nav_graph` since it's computed directly on that pinned nav graph (cycle structure, component counts). See `graph-analytics.md`.
- `distance_from_start`/`distance_from_finish`: keyed on `(graph.version(), meta.start)` / `(graph.version(), meta.finish)` respectively. `NavNodeId`-domain shortest-path distance in tiles (not maze `NodeId`, not nav-edge hop count) — `None` if the corresponding endpoint isn't set. See `graph-analytics.md`'s "Distance Maps" section for the full contract, including the nav-domain rationale and the underlying `compute_distance_map`/`cycle_min_distance` helpers (`graph/distance_map.rs`).
- Takes `&self` — internally uses `RefCell` so callers don't need `&mut Maze` just to populate or refresh the cache.

## Graph versioning

`Graph` carries a `version: u64` counter, bumped by `add_edge`/`remove_edge` whenever they actually change the edge set (a no-op `add_edge` on an existing pair, or `remove_edge` on an already-removed id, does not bump it). `add_node` does not bump it either — adding a node in isolation can't make a cached cycle/nav-graph/SCC result wrong, only edge changes can.

This closes [issue #20](https://github.com/Sergey-Lomov/MazeGen/issues/20): previously, a repair strategy cutting an edge after an earlier `nav_graph()`/`scc()` call in the same `build_maze` run would silently leave the cache stale, and `LoopLengthCheck` (which reads `nav_graph()`) could hand a loop-breaking strategy cycle data describing edges that no longer matched the graph's actual topology — leading to cuts that fully disconnected a node, since the strategy had no way to know a previous repair iteration had already changed the relevant tile's degree.

## Invariants

- `MazeAnalysis` is created via `Default::default()` inside `Maze::new` — all cache cells start empty.
- QC checks may read `maze.analysis` (calling `nav_graph`/`scc`/`route_info` is permitted — they manage their own interior-mutable cache and don't require `&mut Maze`).
- Repair strategies may read `maze.analysis` the same way; must not write maze data (`meta`, `graph`) via analysis.
- Across repair iterations within `generation::pipeline::build_maze`, every `nav_graph()`/`scc()`/`route_info()` call sees a topology consistent with the graph's current state — no caller needs to construct a fresh `Maze` to force a rebuild.

## Future Extension

New derived values (shortest paths, reachability matrices, etc.) follow the same lazy-cache pattern: key the cache on whatever subset of `(graph.version(), start, finish, ...)` the value actually depends on, rather than inventing ad hoc invalidation per value.
