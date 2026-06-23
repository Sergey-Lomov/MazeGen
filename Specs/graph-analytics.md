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
    pub cycle_analysis_overflowed: bool,    // true if cycle enumeration aborted (see below) — other cycle fields are empty placeholders, not real results
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
    pub cycle_analysis_overflowed: bool,
}
```

Maze-id translation happens in `build_analytics_snapshot` (maze-wasm/src/analytics.rs) — `GraphAnalytics` works in `NavNodeId`/edge-index domain, the DTO re-expresses everything in maze `NodeId` domain for the web layer.

`component_count` and `node_component` in the DTO both come from base-graph SCC (`maze.analysis.scc`), computed independently of `GraphAnalytics` — kept for the `RegionsRenderer` overlay (every id in `node_component` is `< component_count`). `GraphAnalytics` itself has no physical-connectivity field; nothing in the nav-graph domain needs it.

## Single Source of Truth: `find_all_simple_cycles`

`maze-core/src/graph/cycles.rs` implements **Johnson's algorithm** (1975) for enumerating ALL simple directed cycles of a `NavGraph` — no length bound, no per-consumer variant. This single function feeds the pure-cycle core (this spec), `MinLoopLengthCheck` (`quality_control.md`), and the analytics overlay.

- **Self-loops are first-class cycles.** A self-loop `NavEdge` (`from == to`, produced only by `build_ring` for a junction-free ring) forms its own SCC of size 1 *with* a cycle, distinct from a size-1 SCC with no self-loop (no cycle). A self-loop's CW and CCW directions (if the ring is bidirectional) are linked via `reverse_edge` by the same path-reversal mechanism used for ordinary corridors — no special-case dedup needed.
- **Johnson's itself produces no duplicates** — each simple directed cycle is visited exactly once, by construction (SCC decomposition + per-vertex blocking). If a bidirectional corridor exists as two separate nav-edges (`u->v` and `v->u`, linked via `reverse_edge`), Johnson's correctly returns BOTH as distinct directed cycles (`[u->v->u]`, `[v->u->v]`) — this is directed-correct, not a bug.
- **Trivial reverse-pair 2-cycles** (walking a corridor edge then immediately its own `reverse_edge` — e.g. stepping into a dead-end spur and back) are excluded from the algorithm's output via a deliberate post-filter (`drop_trivial_reverse_pairs` / `is_trivial_reverse_pair`), not inside the DFS itself — forbidding the reverse-edge step *inside* Johnson's blocking DFS breaks its blocking invariant (a node whose only path back happens to be the forbidden reverse gets wrongly marked "no cycle, stay blocked", hiding other genuinely longer cycles through that same node).
- **`dedup_bidirectional_pairs`** additionally collapses cycles that are the same physical loop walked in opposite directions via `reverse_edge` pairs (ordinary corridors or a self-loop CW/CCW pair) into one entry — used where "one entry per visual loop" matters (`MinLoopLengthCheck`).
- No length bound is enforced inside the algorithm itself — `MinLoopLengthCheck` filters the full result by tile-length after the fact.

### `MAX_SIMPLE_CYCLES` abort bound

Dense graphs can have a very large number of simple cycles — confirmed by measurement: a 5x5 fully-bidirectional grid yields 9349, a 6x6 grid yields 2,444,782 (3.4s in a release build), and a 7x7 fully-preset grid was observed to **hang outright** (see [issue #22](https://github.com/Sergey-Lomov/MazeGen/issues/22)). Mazes are sparse by construction, so this doesn't happen on a generated maze, but a fully-preset edit-mode grid can reach it.

`find_all_simple_cycles` returns `CycleSearchResult`, not a bare `Vec`:

```rust
pub(crate) enum CycleSearchResult {
    Cycles(Vec<Vec<usize>>),
    TooManyCycles,
}
```

It aborts and returns `TooManyCycles` once the running cycle count exceeds `MAX_SIMPLE_CYCLES` (20,000 — comfortably above the 5x5 raw count, well below the 6x6 regime) — checked both inside `johnson_circuit` (so a single pathologically dense SCC can't run unbounded before control returns) and after each SCC in the outer loop. Every caller must handle both outcomes:

- **`cycle_core`** (`graph_analytics.rs`, used by `compute_graph_analytics` — no toggle, runs unconditionally) returns `None` on `TooManyCycles`. `compute_graph_analytics` then returns a `GraphAnalytics` with `cycle_analysis_overflowed: true` and empty/zero placeholders for the other cycle fields, instead of hanging.
- **`MinLoopLengthCheck`** (toggleable) silently skips the check on `TooManyCycles` — same effect as if the check were disabled for that maze.

### Surfacing the overflow as an `Issue`

`build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) computes `graph_analytics` first, then — if `cycle_analysis_overflowed` is true — pushes `Issue::new(CYCLE_ANALYSIS_OVERFLOWED)` directly into the issue list, after `QualityControlEngine` (or `issues_override`) has already run. This bypasses the QC engine entirely: unlike every other `IssueKind`, `CycleAnalysisOverflowed` has no `Check<T>` and no toggle — it surfaces unconditionally whenever the analytics computation itself overflows. See `quality_control.md` for the full `IssueKind` contract. On the web side this is just another entry in `IssuesBlock`/the analytics `FeatureCard`, resolved to `critical` severity via `issueRegistry.ts`.

## Computation Pipeline

`compute_graph_analytics(nav: &NavGraph) -> GraphAnalytics`:

1. **Pure-cycle core** (`cycle_core`, `graph_analytics.rs`) — nodes/edges participating in a *real* directed cycle, derived from `find_all_simple_cycles` (not a separate BFS pass). Returns `None` on `TooManyCycles`, propagated by `compute_graph_analytics` as `cycle_analysis_overflowed: true`.
   - Run `find_all_simple_cycles`, then `drop_trivial_reverse_pairs` (only the trivial-pair filter, NOT the full `dedup_bidirectional_pairs` — see below for why).
   - Union every node/edge appearing in any surviving cycle into the core. For each surviving edge, also add its `reverse_edge` (if any) to the core edge set.
   - **Why only the trivial filter, and why both directions**: a dead-end spur (single bidirectional edge to a leaf) only ever appears as its own trivial walk-out-and-back pair — dropping trivial pairs correctly excludes it (not a real cycle). But two distinct routes between the same junction pair (e.g. a direct corridor plus a detour) also produce trivial pairs (each route walked back on itself) *alongside* the real cycle (route A forward + route B backward) — only the trivial pairs are dropped, the real cycle's edges remain. The Euler formula below needs BOTH directions of every surviving edge present (it pairs an edge with its `reverse_edge` to count one physical corridor once) — using the fully-deduped ("one walking direction per visual loop") cycle list here would only supply one direction and miscount.

2. **Cycle metrics** on the pure-cycle core subgraph:
   - `cycle_count` (β₁) = `E_core - V_core + C_core`. Undirected edge counting handles parallel corridors correctly: an edge and its paired `reverse_edge` count once (same physical corridor, including a self-loop CW/CCW pair); edges without a reverse (one-way, or whose reverse fell outside the core) dedupe by undirected node-pair instead.
   - `cycle_region_count` = number of undirected connected components of the pure-cycle core.
   - β₁ is intentionally NOT replaced by the raw count of simple cycles (`find_all_simple_cycles(nav).len()`) — these are different quantities (a bowtie graph has 3 simple cycles but β₁ = 1), and the Euler formula remains the correct way to compute the independent-cycle count.

### Complexity

- `find_all_simple_cycles`: the blocking DFS itself (`johnson_circuit`) is `O((V+E)·(C+1))` where `C` is the number of simple cycles found — proportional to the actual result size, not wasted on exhausted branches, and bounded above by `MAX_SIMPLE_CYCLES` (see above). **This excludes SCC recomputation**: the outer loop in `find_all_simple_cycles` reruns `strongly_connected_components` (full Tarjan's, `O(V+E)`) from scratch on every iteration, removing exactly one start-vertex each time — up to `V` full SCC recomputations in the worst case, adding a separate `O(V·(V+E))` term on top of the DFS cost. On dense graphs this SCC-recompute term can be significant; see [issue #25](https://github.com/Sergey-Lomov/MazeGen/issues/25) for a proposed incremental-SCC optimization.
- Cycle metrics (`count_core_edges`/`count_core_regions`): linear in core size once the core is known.
- `MazeAnalysis::graph_analytics` (`maze-core/src/lib.rs`) caches the result per `(graph.version(), meta.start, meta.finish)`, same key as `nav_graph` — `compute_graph_analytics` has no toggle and runs on every analytics snapshot, so repeated calls within the same graph version reuse the cached result instead of re-running cycle enumeration.

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
