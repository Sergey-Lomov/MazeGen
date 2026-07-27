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
    pub node_component: HashMap<String, usize>, // maze node id (as string — see below) → SCC component id
    pub pure_cycle_node_ids: Vec<u32>,         // maze node ids in the pure-cycle core
    pub pure_cycle_edge_pairs: Vec<[u32; 2]>,  // [from_maze_id, to_maze_id] pure-cycle nav-edges
    pub cycle_analysis_overflowed: bool,
}
```

Maze-id translation happens in `build_analytics_snapshot` (maze-wasm/src/analytics.rs) — `GraphAnalytics` works in `NavNodeId`/edge-index domain, the DTO re-expresses everything in maze `NodeId` domain for the web layer.

`component_count` and `node_component` in the DTO both come from base-graph SCC (`maze.analysis.scc`), computed independently of `GraphAnalytics` — kept for the `RegionsRenderer` overlay (every id in `node_component` is `< component_count`). `GraphAnalytics` itself has no physical-connectivity field; nothing in the nav-graph domain needs it.

`node_component`'s key is `String`, not `u32` — `MazeSnapshot` is serialized via `serde_wasm_bindgen::Serializer::json_compatible()` (plain JS objects, not `Map`s), which requires string map keys; the maze node id is formatted with `.to_string()` when the map is built.

## Single Source of Truth: `find_all_simple_cycles`

`maze-core/src/graph/cycles.rs` implements **Johnson's algorithm** (1975) for enumerating ALL simple directed cycles of a `NavGraph` — no length bound, no per-consumer variant. This single function feeds the pure-cycle core (this spec), `LoopLengthCheck` (`quality_control.md`), and the analytics overlay.

- **Self-loops are first-class cycles.** A self-loop `NavEdge` (`from == to`, produced only by `build_ring` for a junction-free ring) forms its own SCC of size 1 *with* a cycle, distinct from a size-1 SCC with no self-loop (no cycle). A self-loop's CW and CCW directions (if the ring is bidirectional) are linked via `reverse_edge` by the same path-reversal mechanism used for ordinary corridors — no special-case dedup needed.
- **Johnson's itself produces no duplicates** — each simple directed cycle is visited exactly once, by construction (SCC decomposition + per-vertex blocking). If a bidirectional corridor exists as two separate nav-edges (`u->v` and `v->u`, linked via `reverse_edge`), Johnson's correctly returns BOTH as distinct directed cycles (`[u->v->u]`, `[v->u->v]`) — this is directed-correct, not a bug.
- **Trivial reverse-pair 2-cycles** (walking a corridor edge then immediately its own `reverse_edge` — e.g. stepping into a dead-end spur and back) are excluded from the algorithm's output via a deliberate post-filter (`drop_trivial_reverse_pairs` / `is_trivial_reverse_pair`), not inside the DFS itself — forbidding the reverse-edge step *inside* Johnson's blocking DFS breaks its blocking invariant (a node whose only path back happens to be the forbidden reverse gets wrongly marked "no cycle, stay blocked", hiding other genuinely longer cycles through that same node).
- **`dedup_bidirectional_pairs`** additionally collapses cycles that are the same physical loop walked in opposite directions via `reverse_edge` pairs (ordinary corridors or a self-loop CW/CCW pair) into one entry — used where "one entry per visual loop" matters (`LoopLengthCheck`).
- No length bound is enforced inside the algorithm itself — `LoopLengthCheck` filters the full result by tile-length after the fact.

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
- **`LoopLengthCheck`** (toggleable) silently skips the check on `TooManyCycles` — same effect as if the check were disabled for that maze.

### Surfacing the overflow as an `Issue`

`build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) computes `graph_analytics` first, then — if `cycle_analysis_overflowed` is true — pushes `Box::new(CycleAnalysisOverflowedIssue::default())` directly into the issue list, after `QualityControlEngine` (or `issues_override`) has already run. This bypasses the QC engine entirely: unlike every other `IssueKind`, `CycleAnalysisOverflowed` has no `Check<T, I>` and no toggle — it surfaces unconditionally whenever the analytics computation itself overflows. See `quality_control.md` for the full `IssueKind` contract. On the web side this is just another entry in `IssuesBlock`/the analytics `FeatureCard`, resolved to `critical` severity via `issueRegistry.ts`.

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

- `find_all_simple_cycles`: the blocking DFS itself (`johnson_circuit`) is `O((V+E)·(C+1))` where `C` is the number of simple cycles found — proportional to the actual result size, not wasted on exhausted branches, and bounded above by `MAX_SIMPLE_CYCLES` (see above). **This excludes SCC recomputation**: the outer loop removes exactly one start-vertex per iteration and needs the current SCC structure to do so. Since removing a single vertex can only split the SCC it belonged to — every other SCC is unaffected, as a path between two nodes in different SCCs never routes through a third SCC's interior — only that one SCC's subgraph is rerun through Tarjan's each iteration, not the whole remaining graph (fixed by [issue #25](https://github.com/Sergey-Lomov/MazeGen/issues/25); previously a full `O(V+E)` Tarjan rerun over the whole remaining graph on every iteration, up to `V` times in the worst case).
- Cycle metrics (`count_core_edges`/`count_core_regions`): linear in core size once the core is known.
- `MazeAnalysis::graph_analytics` (`maze-core/src/lib.rs`) caches the result per `(graph.version(), meta.start, meta.finish)`, same key as `nav_graph` — `compute_graph_analytics` has no toggle and runs on every analytics snapshot, so repeated calls within the same graph version reuse the cached result instead of re-running cycle enumeration.

## NavGraph Domain

All metrics are in NavGraph domain (nav-nodes/nav-edges; corridor nodes already compressed away), then translated to maze `NodeId` for the DTO.

## Web Integration

One read-only overlay in the Analytics feature, owned by `AnalyticsRenderer` (`maze-web/src/pixi/`):

- **`PureCyclesOverlay`** — draws nodes in `pure_cycle_node_ids` and edges keyed by `pure_cycle_edge_pairs`. Green (`0x44dd88`).

Toggled via `showPureCyclesOverlay` in `mazeStore`. Stats block in `AnalyticsFeature` shows `node_count`, `edge_count`, `component_count`, `cycle_count`, `cycle_region_count`.

Base-graph SCC (`maze.analysis.scc`) is computed separately for the `RegionsRenderer` overlay (regions are derived client-side from `graph_analytics.node_component`).

## Region Classes (`RegionClass` / `classify_regions`)

Classifies every base-graph SCC region (`maze.analysis.scc`) relative to `meta.start`/`meta.finish`. Location: `maze_core::graph::region_class`.

```rust
pub enum RegionClass {
    Path,         // on RouteInfo::path
    Alternative,  // reachable from start AND can reach finish, but not on the shortest path
    Unreachable,  // not reachable from start at all
    Trap,         // reachable from start, but cannot reach finish
}

pub fn classify_regions(
    graph: &Graph,
    scc: &ConnectedComponents,
    route: Option<&RouteInfo>,
    start: NodeId,
    finish: NodeId,
) -> HashMap<ComponentId, RegionClass>
```

Every region gets exactly one class:

- **Path** — the region appears in `route.path` (the single shortest start→finish route — other equal-length routes are not distinguished and fall under Alternative). If `route` is `None` (e.g. a disconnected graph, or `start`/`finish` cut off from everything by post-edit walls), no region is Path — the region containing `start` or `finish` falls through to the reachability-based classes like any other region, so a fully walled-off `start` correctly comes out Unreachable rather than Path.
- **Alternative** — not Path, but at least one member node is in `graph.reachable_from(start)` AND at least one member node is in `graph.reachable_to(finish)`.
- **Unreachable** — no member node is in `graph.reachable_from(start)`.
- **Trap** — reachable from `start`, but no member node is in `graph.reachable_to(finish)`.

`reachable_from`/`reachable_to` are plain directed BFS on the base `Graph` (not nav-domain) — region classification works in maze `NodeId` domain throughout, unlike the nav-domain distance maps below.

### Caching: `MazeAnalysis::region_classes`

```rust
pub fn region_classes<T: Tessellation>(&self, graph: &Graph, field: &Field<T>, meta: &MazeMeta) -> HashMap<ComponentId, RegionClass>
```

Keyed on `(graph.version(), meta.start, meta.finish)` — same invalidation shape as `route_info`/`scc`. Internally calls `self.scc(graph)` and `self.route_info(graph, field, meta)`, both independently cached, so a cache hit on either is reused rather than recomputed. `field` is threaded through only because `route_info` needs it (`RouteInfo::split_count`) — region classification itself never inspects splits.

### Web Integration

`GraphAnalyticsDto.region_classes: HashMap<String, String>` (maze-wasm) — component id (as string key) → `"path" | "alternative" | "unreachable" | "trap"`. Computed in `build_analytics_snapshot` only when both `maze.meta.start` and `maze.meta.finish` are set; empty otherwise (region classes are unavailable without both endpoints, independent of whether a route actually exists between them).

Web overlay: **`RegionClassesRenderer`** (`maze-web/src/pixi/`), toggled via `showRegionClassesOverlay` in `mazeStore`. Renders the same per-component cell groups as `RegionsRenderer` (derived from `graph_analytics.node_component`), tinted by `REGION_CLASS_COLORS` (`maze-web/src/pixi/colorUtils.ts`) instead of the rotating component palette — fixed colors per class (path: green, alternative: blue, unreachable: gray, trap: red). An info icon next to the toggle opens a legend modal mapping each class's color to its name and meaning. The toggle is disabled whenever `graphAnalytics.region_classes` is empty (start or finish unset), not when no route exists — see `analytics-web.md`.

## Distance Maps (`distance_from_start` / `distance_from_finish`)

Two lazily-computed, cached maps from `NavNodeId` to shortest-path distance **in tiles**:

- `MazeAnalysis::distance_from_start(graph, meta)` — distance FROM `meta.start` to every reachable nav-node, following directed edges forward. Returns `None` if `meta.start` is unset.
- `MazeAnalysis::distance_from_finish(graph, meta)` — distance TO `meta.finish` from every nav-node that can reach it, following directed edges backward. Returns `None` if `meta.finish` is unset.

Both are keyed on `(graph.version(), start_or_finish_node)` (`maze-core/src/lib.rs`) — same invalidation contract as `nav_graph`/`graph_analytics`: any edge mutation or moving start/finish busts the cache.

**Nav-domain (`NavNodeId`), not maze `NodeId`** — junction/start/finish nodes only, not corridor-interior nodes compressed out of the nav graph. Every consumer (QC checks operating on cycles, which are themselves lists of nav-edge indices) works in `NavNodeId` already, so there's no reason to unroll into maze-node domain. The distance value itself is still tile count, never nav-edge hop count: each nav-edge already carries its own tile length (`path.len() - 1`), so a nav-node four tiles away via one corridor has distance 4, not 1.

Distance is **strictly graph-based** (Dijkstra shortest path on the directed nav-graph adjacency, weight = tile length per nav-edge) — never geometric/coordinate distance. Unreachable nav-nodes are absent from the map (no sentinel value); query with `.get()`.

### Implementation: `compute_distance_map` (`maze-core/src/graph/distance_map.rs`)

Single shared utility, reused by both directions (`DistanceDirection::Forward`/`Reverse`) — avoids duplicating shortest-path logic per consumer. Thin wrapper around `dijkstra_forward`/`dijkstra_reverse` (`pathfinding.rs`, same Dijkstra used by `routing.rs`): runs it from the source nav-node, then drops unreachable entries (`usize::MAX`) before returning the `HashMap<NavNodeId, usize>`.

This feeds [issue #33](https://github.com/Sergey-Lomov/MazeGen/issues/33)'s `LoopDistanceFromStartCheck`/`LoopDistanceFromFinishCheck` (`quality_control.md`) — cycle placement in progression space — and any other consumer needing topology-based distance-to-start/finish in nav-domain.

`cycle_min_distance(nav, cycle, dist_map)` (same file) is the other shared piece those two checks need: given a cycle (a list of nav-edge indices) and one of the two distance maps, returns the minimum distance among every nav-node the cycle touches (every `from`/`to` endpoint of its nav-edges) — the cycle's closest point to start/finish. A touched nav-node absent from `dist_map` is skipped; if every touched nav-node is absent, returns `usize::MAX` (no defined distance). One function, not duplicated per check — issue #33 explicitly called for extracting any such shared distance-reduction logic rather than letting each check reimplement it.

### `exact_tile_distance` (GitHub issue #249)

```rust
pub(crate) fn exact_tile_distance(nav: &NavGraph, from: NodeId, to: NodeId, max_dist: Option<usize>) -> Option<usize>;
```

Exact directed tile-hop distance between two arbitrary maze nodes — unlike `compute_distance_map`, which is nav-domain only (junction/start/finish nodes), this also correctly handles either endpoint being a corridor-interior node, by combining `NavGraph::corridor_exit_offsets`/`corridor_entry_offsets` (see `nav-graph.md`) with a nav-domain Dijkstra pass between the resolved endpoints. `from == to` is always `0`, even when neither resolves to a nav node. Returns `None` if `to` is unreachable from `from` within `max_dist` (or at all, when `max_dist` is `None`).

**Why this exists, not just `nav_node_for(..).or_else(|| corridor_index.get(..))`**: that resolution (`routing::resolve_nav_node`, `SplitDistanceFromWaypointCheck`) snaps a corridor-interior node to its containing edge's destination nav-node, silently dropping however many tiles remain in that segment — acceptable when the caller only needs *a* reasonable nav-node to start a search from, wrong when the distance value itself is compared against a threshold. `SplitGroupGraphProximityCheck` (`quality_control.md`) is exactly this second case: two split nodes anywhere within the same long corridor would otherwise report distance ≈0 regardless of how many tiles actually separate them (GitHub issue #249's original bug report).

**Same-edge shortcut**: if `from` and `to` are both interior to the very same corridor edge (`NavGraph::corridor_edge_positions`), the direct in-path hop count (their path-index difference) is checked first — this is the *only* route between them on a single-edge corridor with no other nav-graph connections, and must never be skipped in favor of a route through either end's nav-node.

**Cost**: up to two bounded Dijkstra passes per call (one per `from`-exit candidate, since a corridor-interior `from` can be interior to both a corridor edge and its reverse). `SplitGroupGraphProximityCheck` calls this once per node-pair inside an `O(tiles²)` scan with no caching across calls, unlike `TeleportGroupProximityCheck`/`OneWayGroupGraphProximityCheck`'s `compute_distance_map_filtered_bounded`-backed caches — a known, not-yet-addressed optimization opportunity for mazes with many split tiles, tracked as a follow-up, not a correctness issue.

## Quality Control Use Cases

| Metric | QC check |
|---|---|
| `cycle_count` (β₁) | Minimum cycle count — maze must not be a tree |
| `cycle_region_count` | Cycle spread — avoid all cycles concentrated in one region (or too fragmented) |
