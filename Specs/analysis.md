# MazeAnalysis

Cached derived data attached to a `Maze`. Computed lazily on first access and reused until the maze is rebuilt.

## Structure

```rust
pub struct MazeAnalysis {
    nav_graph: Option<graph::nav::NavGraph>,
    scc: Option<graph::scc::ConnectedComponents>,
}
```

## Access

```rust
impl MazeAnalysis {
    pub fn nav_graph(&mut self, graph: &Graph) -> &NavGraph;
    pub fn nav_graph_pinned(&mut self, graph: &Graph, pinned: &HashSet<NodeId>) -> &NavGraph;
    pub fn scc(&mut self, graph: &Graph) -> &ConnectedComponents;
}
```

- `nav_graph`: builds once and caches. Returns the cached value on subsequent calls.
- `nav_graph_pinned`: **always rebuilds** and overwrites the shared `nav_graph` cache. The pinned set may differ between calls, so no cache reuse is possible. **Ordering rule:** always call `nav_graph` (unpinned) before `nav_graph_pinned` within a single build step. After `nav_graph_pinned` runs, any subsequent `nav_graph` call returns the pinned version silently. In `maze-wasm/src/lib.rs` the unpinned nav graph (for overlay DTO) is built first, then `nav_graph_pinned` is called for routing — this order must be preserved. If independent results are needed simultaneously, store them before the pinned call.
- Takes `&mut self` because it may populate the cache.

## Invariants

- `MazeAnalysis` is created via `Default::default()` inside `Maze::new` — all fields start as `None`.
- QC checks may read `maze.analysis` but must not write to it (per the QC architectural contract).
- Repair strategies may read `maze.analysis` but must not write maze data (`meta`, `graph`) via analysis. Calling a lazy accessor such as `nav_graph` is permitted — it manages its own cache and is transparent to the caller.
- Only code with `&mut Maze` access may call `&mut self` accessors on `MazeAnalysis`.
- The cache becomes stale if the underlying graph is mutated after `nav_graph` was first accessed. No invalidation mechanism exists — callers must not mutate the graph after analysis is cached.

## Future Extension

New derived values (shortest paths, reachability matrices, etc.) follow the same `Option<T>` pattern: `None` until first access, then cached.
