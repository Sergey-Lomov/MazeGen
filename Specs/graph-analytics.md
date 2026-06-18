# Graph Analytics

Structural metrics computed on the **undirected projection** of the NavGraph. Self-loops ignored. Parallel edges deduplicated via normalized pairs `(min(u,v), max(u,v))`.

## Data Structures

### `GraphAnalytics` (maze-core)

```rust
pub struct GraphAnalytics {
    pub node_count: usize,
    pub edge_count: usize,           // unique undirected edges
    pub component_count: usize,      // undirected connected components (DSU)
    pub cycle_rank: usize,           // β₁ = E - V + C
    pub min_cycle_length: Option<usize>, // None when cycle_rank == 0
    pub max_cycle_density: Option<f64>,  // max(β₁_c / V_c) over components
    pub component_sizes: Vec<usize>, // nav-node count per component
}
```

### `GraphAnalyticsDto` (maze-wasm)

Flat mirror of `GraphAnalytics`. Field names identical. Serialized as JSON in `MazeSnapshot.graph_analytics`.

## Computation Pipeline

Three steps, no cross-dependency:

1. **Topology** — DSU on nav-edges (direction ignored, self-loops skipped). Produces undirected CC + component sizes.

2. **Global metrics** — count unique undirected edges via `HashSet<(min,max)>`. Compute:
   - `cycle_rank = edge_count - node_count + component_count` (β₁)
   - `max_cycle_density = max over components of (β₁_c / V_c)`

3. **Min cycle length** — only when `cycle_rank > 0`. For each undirected edge `(u,v)`, BFS from `u` to `v` skipping the direct `u→v` edge (and separately `v→u` direction). Cycle length = BFS distance + 1. Take global minimum.

### Complexity

- Topology: O(E α(V))
- Min cycle length: O(E · (V + E)) — BFS per edge

## NavGraph Domain

All metrics are in NavGraph domain (nav-nodes and nav-edges), not base maze graph.

- `node_count` = nav-nodes (junction nodes only; corridor nodes compressed away)
- `edge_count` = unique undirected nav-edges
- `component_sizes` = nav-node counts per component

## WASM Integration

`compute_graph_analytics(nav: &NavGraph) -> GraphAnalytics` — takes only nav-graph, no SCC dependency.

Called in `build_analytics_snapshot` before `nav_graph_pinned` (which overwrites the nav cache).

Base-graph SCC (`maze.analysis.scc`) is still computed separately for the overlay `components` field (`RegionsRenderer`).

## Quality Control Use Cases

| Metric | QC check |
|---|---|
| `cycle_rank` (β₁) | Minimum cycle count — maze must not be a tree |
| `min_cycle_length` | Minimum cycle length — avoid trivially short cycles |
| `max_cycle_density` | Maximum cycle concentration — avoid local over-cycling |
