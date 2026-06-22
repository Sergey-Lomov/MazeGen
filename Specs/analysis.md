# MazeAnalysis

Cached derived data attached to a `Maze`. Computed lazily on first access and reused until the maze is rebuilt.

## Structure

```rust
pub struct MazeAnalysis {
    nav_graph: OnceCell<graph::nav::NavGraph>,
    scc: OnceCell<graph::scc::ConnectedComponents>,
    route_info: RefCell<Option<(NodeId, NodeId, Option<graph::routing::RouteInfo>)>>,
}
```

## Access

```rust
impl MazeAnalysis {
    pub fn nav_graph(&self, graph: &Graph, meta: &MazeMeta) -> &NavGraph;
    pub fn scc(&self, graph: &Graph) -> &ConnectedComponents;
    pub fn route_info(&self, graph: &Graph, start: NodeId, finish: NodeId) -> Option<RouteInfo>;
}
```

- `nav_graph`: builds once and caches. **Always pins `meta.start`/`meta.finish`** (whichever are `Some`) — once a route endpoint is set, it is forced to be a `NavNode` everywhere this method is the source of the nav graph, instead of risking being silently collapsed into a passage's interior the moment its local degree happens to look like one. This is the single, project-wide pinning policy: `MinLoopLengthCheck`, `FarthestEndpointsStrategy`, `ScoredEndpointsStrategy`, and the WASM analytics layer all call this method and all observe the same pinned topology. **This is not opt-in per caller** — any future `Check` or `RepairStrategy` that calls `maze.analysis.nav_graph(...)` automatically inherits the pinned topology with no separate decision to make; there is no unpinned variant to fall back to from this method.
- `scc`: builds once and caches; independent of pinning.
- `route_info`: computes a route between two specific nodes, pinning exactly that `(start, finish)` pair — independent of `nav_graph`'s own cache, since a caller may want to probe a candidate pair before committing it to `meta` (or the pair may differ from `meta.start`/`meta.finish` entirely). Cached per `(start, finish)` key; a different pair triggers a rebuild.
- Takes `&self` — internally uses `OnceCell`/`RefCell` so callers don't need `&mut Maze` just to populate the cache. `nav_graph`/`scc` populate once and never rebuild from then on; `route_info` rebuilds whenever the `(start, finish)` key changes.

## Known limitation: no graph-mutation invalidation

**There is currently no invalidation when the underlying `Graph` is mutated** (e.g. a repair strategy cutting an edge) after `nav_graph`/`scc` have been cached. Only `route_info`'s `(start, finish)` key is checked; nothing re-validates against the graph's actual edge set. A `Maze` whose `analysis` cache was populated, then had its `graph` mutated, then has `analysis` queried again will silently return stale results.

This is tracked as [issue #20](https://github.com/Sergey-Lomov/MazeGen/issues/20) — the planned fix adds a `Graph` version counter and keys the caches on `(graph_version, start, finish)`. Until that lands:
- Within `generation::pipeline::build_maze`, any repair iteration that mutates the graph after an earlier `nav_graph()` call in the same `Maze` instance risks operating on stale data. The pipeline test exercising this (`pipeline_breaks_short_loop_via_min_loop_length`) is currently `#[ignore]`d for this reason.
- Code paths that need correctness across a graph mutation must construct a fresh `Maze` (and therefore a fresh `MazeAnalysis`) rather than reusing the cache.

## Invariants

- `MazeAnalysis` is created via `Default::default()` inside `Maze::new` — all cache cells start empty.
- QC checks may read `maze.analysis` (calling `nav_graph`/`scc`/`route_info` is permitted — they manage their own interior-mutable cache and don't require `&mut Maze`).
- Repair strategies may read `maze.analysis` the same way; must not write maze data (`meta`, `graph`) via analysis.

## Future Extension

New derived values (shortest paths, reachability matrices, etc.) follow the same lazy-cache pattern. Once issue #20 lands, new derived values should key their cache on whatever subset of `(graph_version, start, finish, ...)` they actually depend on, rather than inventing ad hoc invalidation per value.
