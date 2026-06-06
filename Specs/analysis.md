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
    pub fn scc(&mut self, graph: &Graph) -> &ConnectedComponents;
}
```

- On first call: builds the value and stores it.
- On subsequent calls: returns the cached value.
- Takes `&mut self` because it may populate the cache.

## Invariants

- `MazeAnalysis` is created via `Default::default()` inside `Maze::new` — all fields start as `None`.
- QC checks may read `maze.analysis` but must not write to it (per the QC architectural contract).
- Repair strategies may read `maze.analysis` but must not write maze data (`meta`, `graph`) via analysis. Calling a lazy accessor such as `nav_graph` is permitted — it manages its own cache and is transparent to the caller.
- Only code with `&mut Maze` access may call `&mut self` accessors on `MazeAnalysis`.
- The cache becomes stale if the underlying graph is mutated after `nav_graph` was first accessed. No invalidation mechanism exists — callers must not mutate the graph after analysis is cached.

## Future Extension

New derived values (shortest paths, reachability matrices, etc.) follow the same `Option<T>` pattern: `None` until first access, then cached.
