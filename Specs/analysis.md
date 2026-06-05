# MazeAnalysis

Cached derived data attached to a `Maze`. Computed lazily on first access and reused until the maze is rebuilt.

## Structure

```rust
pub struct MazeAnalysis {
    nav_graph: Option<graph::nav::NavGraph>,
}
```

## Access

```rust
impl MazeAnalysis {
    pub fn nav_graph(&mut self, graph: &Graph) -> &NavGraph;
}
```

- On first call: builds the `NavGraph` via `build_nav_graph(graph)` and stores it.
- On subsequent calls: returns the cached value.
- Takes `&mut self` because it may populate the cache.

## Invariants

- `MazeAnalysis` is created via `Default::default()` inside `Maze::new` — all fields start as `None`.
- QC checks may read `maze.analysis` but must not write to it (per the QC architectural contract).
- Repair strategies may read `maze.analysis` but must not write to it.
- Only code that owns the `Maze` may call `&mut self` accessors.
- The cache becomes stale if the underlying graph is mutated after `nav_graph` was first accessed. No invalidation mechanism exists — callers must not mutate the graph after analysis is cached.

## Future Extension

New derived values (shortest paths, reachability matrices, etc.) follow the same `Option<T>` pattern: `None` until first access, then cached.
