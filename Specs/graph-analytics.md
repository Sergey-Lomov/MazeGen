# Graph Analytics

Structural metrics computed on the **NavGraph** (directed). Covers physical connectivity and directed-cycle structure ("pure cycles" — real cycles only, no connecting bridges).

## Data Structures

### `GraphAnalytics` (maze-core)

```rust
pub struct GraphAnalytics {
    pub node_count: usize,
    pub edge_count: usize,                  // unique undirected nav-edges
    pub cycle_count: usize,                 // β₁ on the pure-cycle core: E_core - V_core + C_core
    pub cycle_region_count: usize,          // connected components (undirected) of the pure-cycle core
    pub pure_cycle_nav_nodes: HashSet<NavNodeId>,
    pub pure_cycle_edge_indices: HashSet<usize>,
}
```

### `GraphAnalyticsDto` (maze-wasm)

```rust
pub struct GraphAnalyticsDto {
    pub node_count: usize,
    pub edge_count: usize,
    pub component_count: usize,
    pub cycle_count: usize,
    pub cycle_region_count: usize,
    pub node_component: HashMap<u32, usize>,   // maze node id → SCC component id
    pub pure_cycle_node_ids: Vec<u32>,         // maze node ids in the pure-cycle core
    pub pure_cycle_edge_pairs: Vec<[u32; 2]>,  // [from_maze_id, to_maze_id] pure-cycle nav-edges
}
```

Maze-id translation happens in `build_analytics_snapshot` (maze-wasm/src/analytics.rs) — `GraphAnalytics` works in `NavNodeId`/edge-index domain, the DTO re-expresses everything in maze `NodeId` domain for the web layer.

`component_count` and `node_component` in the DTO both come from base-graph SCC (`maze.analysis.scc`), computed independently of `GraphAnalytics` — kept for the `RegionsRenderer` overlay (every id in `node_component` is `< component_count`). `GraphAnalytics` itself has no physical-connectivity field; nothing in the nav-graph domain needs it.

## Computation Pipeline

`compute_graph_analytics(nav: &NavGraph) -> GraphAnalytics`:

1. **Pure-cycle core** (`build_cyclic_core`) — nodes/edges participating in a *real* directed cycle, with **no connecting bridges**:
   - **Pre-pass (`trim_dead_ends`)** — iteratively strips nodes with at most one distinct undirected connection (an edge and its `reverse_edge` count as one; separate parallel corridors between the same pair count separately). Cheap, direction-agnostic, just shrinks the graph before the expensive step.
   - **Main pass** — for each surviving nav-edge `(u -> v)`, BFS from `v` back to `u` with that edge and its reverse excluded. If `u` is reachable, the edge and every edge on the found return path are marked as part of the pure-cycle core. This is edge-disjoint from the forward edge, so a plain bridge between two otherwise-cyclic nodes (with no alternate route) is never marked — its only way back is the forbidden reverse.

2. **Cycle metrics** on the pure-cycle core subgraph:
   - `cycle_count` (β₁) = `E_core - V_core + C_core`. Undirected edge counting handles parallel corridors correctly: an edge and its paired `reverse_edge` count once (same physical corridor); edges without a reverse (one-way, or whose reverse fell outside the core) dedupe by undirected node-pair instead — this hybrid avoids both under- and over-counting multi-edge cycles.
   - `cycle_region_count` = number of undirected connected components of the pure-cycle core.

### Complexity

- Pure-cycle core: O(E · (V + E)) worst case — one BFS per surviving edge, after the cheap dead-end trim shrinks the graph.

## NavGraph Domain

All metrics are in NavGraph domain (nav-nodes/nav-edges; corridor nodes already compressed away), then translated to maze `NodeId` for the DTO.

## Web Integration

One read-only overlay in the Analytics feature, owned by `AnalyticsRenderer` (`maze-web/src/pixi/`):

- **`PureCyclesOverlay`** — draws nodes in `pure_cycle_node_ids` and edges keyed by `pure_cycle_edge_pairs`. Green (`0x44dd88`).

Toggled via `showPureCyclesOverlay` in `mazeStore`. Stats block in `AnalyticsFeature` shows `node_count`, `edge_count`, `component_count`, `cycle_count`, `cycle_region_count`.

Base-graph SCC (`maze.analysis.scc`) is computed separately for the `RegionsRenderer` overlay (regions are derived client-side from `graph_analytics.node_component`).

## Quality Control Use Cases

| Metric | QC check |
|---|---|
| `cycle_count` (β₁) | Minimum cycle count — maze must not be a tree |
| `cycle_region_count` | Cycle spread — avoid all cycles concentrated in one region (or too fragmented) |
