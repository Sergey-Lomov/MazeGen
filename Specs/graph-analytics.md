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
    pub pure_cycle_basis: Vec<Vec<usize>>,  // GF(2) independent cycle basis (GitHub issue #284) — see below
    pub simple_cycle_count: usize,          // fully-deduped composite-inclusive simple-cycle count (GitHub issue #284) — see below
    pub cycle_analysis_overflowed: bool,    // true if cycle enumeration aborted (see below) — other cycle fields are empty placeholders, not real results
}
```

### `GraphStatsDto` (maze-wasm)

GitHub issue #364 renamed `GraphAnalyticsDto` to `GraphStatsDto` and moved it under
`MazeStatisticsDto` (see "Web Integration" below) — same fields as before, plus `floor_count` and
`average_degree`:

```rust
pub struct GraphStatsDto {
    pub floor_count: usize,       // MultiLevelField::level_count() — always 1 for a single-floor maze
    pub node_count: usize,
    pub edge_count: usize,
    pub component_count: usize,
    pub average_degree: f64,      // 2*E/V over the real graph (not the nav-graph), treated as undirected; 0 for an empty graph
    pub cycle_count: usize,
    pub cycle_region_count: usize,
    pub simple_cycle_count: usize,             // fully-deduped composite-inclusive simple-cycle count, always >= cycle_count
    pub node_component: HashMap<String, usize>, // maze node id (as string — see below) → SCC component id
    pub pure_cycle_node_ids: Vec<u32>,         // maze node ids in the pure-cycle core
    pub pure_cycle_edge_pairs: Vec<[u32; 2]>,  // [from_maze_id, to_maze_id] pure-cycle nav-edges
    pub cycle_analysis_overflowed: bool,
    pub region_classes: HashMap<String, RegionClass>,
}
```

Maze-id translation happens in `build_analytics_snapshot` (maze-wasm/src/analytics/snapshot.rs) — `GraphAnalytics` works in `NavNodeId`/edge-index domain, the DTO re-expresses everything in maze `NodeId` domain for the web layer.

`component_count` and `node_component` in the DTO both come from base-graph SCC (`maze.analysis.scc`), computed independently of `GraphAnalytics` — kept for the `RegionsRenderer` overlay (every id in `node_component` is `< component_count`). `GraphAnalytics` itself has no physical-connectivity field; nothing in the nav-graph domain needs it.

`node_component`'s key is `String`, not `u32` — `MazeSnapshot` is serialized via `serde_wasm_bindgen::Serializer::json_compatible()` (plain JS objects, not `Map`s), which requires string map keys; the maze node id is formatted with `.to_string()` when the map is built. Same reasoning applies to `region_classes`'s key (`component_id`).

`GraphStatsDto` is the one member of `MazeStatisticsDto` that is **not** `FloorScoped` — SCC components and cycles can span multiple floors (via teleport/vertical-passage/elevator edges), so there is no non-arbitrary way to attribute a spanning component/cycle to a single floor. `average_degree` in particular is maze-wide only and uses every edge kind/direction (`Graph::outgoing_neighbors`), unlike the Basic-only/bidirectional-only filter `classify_node` uses for cell-shape stats (see "Cell Shape Statistics" below) — these are deliberately different neighbor notions for different questions.

## Single Source of Truth: `find_all_simple_cycles`

`maze-core/src/graph/cycles.rs` implements **Johnson's algorithm** (1975) for enumerating ALL simple directed cycles of a `NavGraph` — no length bound, no per-consumer variant. This single function feeds the pure-cycle core (this spec), `LoopLengthCheck` (`quality_control.md`), and the analytics overlay.

- **Self-loops are first-class cycles.** A self-loop `NavEdge` (`from == to`, produced only by `build_ring` for a junction-free ring) forms its own SCC of size 1 *with* a cycle, distinct from a size-1 SCC with no self-loop (no cycle). A self-loop's CW and CCW directions (if the ring is bidirectional) are linked via `reverse_edge` by the same path-reversal mechanism used for ordinary corridors — no special-case dedup needed.
- **Johnson's itself produces no duplicates** — each simple directed cycle is visited exactly once, by construction (SCC decomposition + per-vertex blocking). If a bidirectional corridor exists as two separate nav-edges (`u->v` and `v->u`, linked via `reverse_edge`), Johnson's correctly returns BOTH as distinct directed cycles (`[u->v->u]`, `[v->u->v]`) — this is directed-correct, not a bug.
- **Trivial reverse-pair 2-cycles** (walking a corridor edge then immediately its own `reverse_edge` — e.g. stepping into a dead-end spur and back) are excluded from `cycles`/the basis at the source: `johnson_circuit` recognizes the one specific case of a 2-edge path closing straight back to `start` via its first edge's own `reverse_edge` and skips recording it, while still treating the closing move as a real "cycle found" event for its own blocking bookkeeping (`found_cycle = true`) — this never bloats `cycles` with one entry per bidirectional edge in the graph (GitHub issue #369 follow-up). Forbidding the reverse-edge step *generally* inside Johnson's blocking DFS (any occurrence, not just this one 2-edge closing case) would break its blocking invariant — a node whose only path back happens to be the forbidden reverse gets wrongly marked "no cycle, stay blocked", hiding other genuinely longer cycles through that same node — so only this one provably-safe case is special-cased; every other reverse-edge use mid-path (or found via the outer SCC loop) is a genuinely longer cycle and is never trivial.
- **`dedup_bidirectional_pairs`** additionally collapses cycles that are the same physical loop walked in opposite directions via `reverse_edge` pairs (ordinary corridors or a self-loop CW/CCW pair) into one entry — used where "one entry per visual loop" matters (`LoopLengthCheck`).
- No length bound is enforced inside the algorithm itself — `LoopLengthCheck` filters the full result by tile-length after the fact.

### `MAX_SIMPLE_CYCLES` abort bound

Dense graphs can have a very large number of simple cycles — confirmed by measurement: a 5x5 fully-bidirectional grid yields 9349, a 6x6 grid yields 2,444,782 (3.4s in a release build), and a 7x7 fully-preset grid was observed to **hang outright** (see [issue #22](https://github.com/Sergey-Lomov/MazeGen/issues/22)). Mazes are sparse by construction, so this doesn't happen on a generated maze, but a fully-preset edit-mode grid can reach it.

`find_all_simple_cycles` returns `CycleSearchResult`, not a bare `Vec`:

```rust
pub(crate) enum CycleSearchResult {
    Cycles { cycles: Vec<Vec<usize>>, basis: Vec<Vec<usize>> },
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
   - Run `find_all_simple_cycles` (trivial reverse-pair 2-cycles are already excluded at the source, inside `johnson_circuit` — see above). An `Elevator` connects its floors as a fully-connected fan (direct one-hop travel between any two floors), which is structurally a complete graph and would otherwise contain a combinatorial explosion of same-loop cycles that aren't real detours — `find_all_simple_cycles` itself forbids a simple cycle from using more than one edge of the same elevator fan (GitHub issue #410), so no elevator-only cycle is ever produced here; `cycle_core` needs no filtering step for this case. A cycle mixing one elevator hop with non-elevator edges is a genuine detour and stays.
   - Union every node/edge appearing in any surviving cycle into the core. For each surviving edge, also add its `reverse_edge` (if any) to the core edge set.
   - The Euler formula below needs BOTH directions of every surviving edge present (it pairs an edge with its `reverse_edge` to count one physical corridor once) — using the fully-deduped ("one walking direction per visual loop") cycle list here would only supply one direction and miscount, so `dedup_bidirectional_pairs` is not applied before this step.

2. **Cycle metrics** on the pure-cycle core subgraph:
   - `cycle_count` (β₁) = `E_core - V_core + C_core`. Undirected edge counting handles parallel corridors correctly: an edge and its paired `reverse_edge` count once (same physical corridor, including a self-loop CW/CCW pair); edges without a reverse (one-way, or whose reverse fell outside the core) each count individually by edge index — NOT deduped by node-pair, since two distinct one-way edges between the same pair are genuinely separate corridors (parallel corridors of the same kind, or a same-pair opposite-direction pair of different kind that `link_reverse_edges` deliberately left unlinked, GitHub issue #197; see GitHub issue #396).
   - `cycle_region_count` = number of undirected connected components of the pure-cycle core.
   - β₁ is intentionally NOT replaced by the raw count of simple cycles (`find_all_simple_cycles(nav).len()`) — these are different quantities (a bowtie graph has 3 simple cycles but β₁ = 1), and the Euler formula remains the correct way to compute the independent-cycle count.

### Complexity

- `find_all_simple_cycles`: the blocking DFS itself (`johnson_circuit`) is `O((V+E)·(C+1))` where `C` is the number of simple cycles found — proportional to the actual result size, not wasted on exhausted branches, and bounded above by `MAX_SIMPLE_CYCLES` (see above). **This excludes SCC recomputation**: the outer loop removes exactly one start-vertex per iteration and needs the current SCC structure to do so. Since removing a single vertex can only split the SCC it belonged to — every other SCC is unaffected, as a path between two nodes in different SCCs never routes through a third SCC's interior — only that one SCC's subgraph is rerun through Tarjan's each iteration, not the whole remaining graph (fixed by [issue #25](https://github.com/Sergey-Lomov/MazeGen/issues/25); previously a full `O(V+E)` Tarjan rerun over the whole remaining graph on every iteration, up to `V` times in the worst case).
- Cycle metrics (`count_core_edges`/`count_core_regions`): linear in core size once the core is known.
- `MazeAnalysis::graph_analytics` (`maze-core/src/lib.rs`) caches the result per `(graph.version(), meta.start, meta.finish)`, same key as `nav_graph` — `compute_graph_analytics` has no toggle and runs on every analytics snapshot, so repeated calls within the same graph version reuse the cached result instead of re-running cycle enumeration.

## Independent Cycle Basis (`basis` / `pure_cycle_basis`, GitHub issue #284)

Investigation in [issue #244](https://github.com/Sergey-Lomov/MazeGen/issues/244) established that deriving a basis *independently* of the full simple-cycle enumeration (e.g. via a spanning tree) gives an arbitrary, non-natural basis, and that most consumers of `find_all_simple_cycles` genuinely need the full simple-cycle list (a basis can miss a real bad cycle, an unacceptable false negative for health checks like `LoopLengthCheck`). #284 instead derives a GF(2) independent basis **on top of** the already-running Johnson's enumeration — additive, not a replacement — used only where independence specifically matters.

### Where the basis is used

- `GraphAnalytics.pure_cycle_basis` / `cycle_core` — additive alongside `pure_cycle_nav_nodes`/`pure_cycle_edge_indices` (the full pure-cycle core). `cycle_count` itself stays computed via the Euler formula (cheaper, no elimination needed), not `pure_cycle_basis.len()` — though they are always equal by construction.
- `MinLoopsCountCheck` — reads `analytics.cycle_count` only, no cycle list involved; unaffected.
- `MaxLoopsCountCheck` / `MaxLoopDensityCheck` — the flagged `InvalidLoopGroupIssue.all`/`invalid` set is now built from `analytics.pure_cycle_basis` / `find_all_simple_cycles`'s `basis` field, not the full composite-inclusive enumeration — the flagged set is now exactly `cycle_count` cycles, so cutting any one of them reduces the independent count by exactly one (unlike a composite-inclusive list, where cutting an edge shared by several linearly-dependent composite cycles does not reduce the independent count by the raw overlap amount).
- `MinLoopDensityCheck` — field-coverage computed from `basis` instead of the full list. This does not change the density number: a composite cycle's edge-set is always the symmetric difference (in GF(2)) of its basis components' edge-sets, hence always a subset of their union — no cell touched by a composite cycle is ever outside the union of cells touched by its basis components, so basis-only coverage equals full-list coverage by construction, never a strict subset. Basis-only is simply cheaper (fewer cycles to walk).
- `InvalidLoopScoredStrategy` (`Specs/repair.md`) — the `valid_overlap` valid-cycle penalty term is computed against the GF(2) basis of the *valid* subset of the issue's own cycle list (a separate, `EdgeId`-domain elimination, not `pure_cycle_basis`), not the raw valid list. See `Specs/repair.md` for the rationale.
- **Left unchanged (full list, not basis)**: `LoopLengthCheck`, `LoopDistanceFromStartCheck`, `LoopDistanceFromFinishCheck`, `ExternalEscapeDiversityCheck` (need every real simple cycle — a basis can omit a real cycle that happens to be linearly dependent on others), `PureCyclesOverlay` (needs every node/edge on any real cycle).

### `simple_cycle_count` — the composite-inclusive counterpart

`GraphAnalytics.simple_cycle_count` (built in `cycle_core`) is the fully-deduped (`dedup_bidirectional_pairs`, canonical-key dedup) simple-cycle count, surfaced to the UI ("Complex cycles") alongside `cycle_count`'s independent count, so composite noise is visible. It is computed from the elevator-only-filtered `cycles` list (see "Computation Pipeline" above) — that list deliberately keeps both directions of every surviving cycle's edges for the Euler-formula core, a different list shape than `dedup_bidirectional_pairs`'s canonical-key-deduped one. Using the raw pre-dedup `cycles.len()` would double-count every bidirectional cycle, since a CW and CCW walk of the same physical loop are two distinct entries in Johnson's raw output — only the full dedup collapses them to one, matching what a user visually perceives as "one loop."

### Construction: incremental GF(2) elimination inside Johnson's

`maze-core/src/graph/cycles.rs`'s `GF2Basis` — a small, domain-agnostic reduced row-echelon GF(2) elimination core (`try_insert(vector: Vec<u64>) -> bool`, bit-vectors as `Vec<u64>` words). `find_all_simple_cycles` uses one `GF2Basis` instance (`bit_count = nav.edges().count()`) for the entire call — every cycle it pushes to `cycles` is also offered to this basis via `offer_to_basis` (the single insertion point shared by both places a new cycle is found: the self-loop branch and `johnson_circuit`'s cycle-found branch), as a bit-vector built from each edge's `canonical_index` (the same undirected-pairing helper `dedup_bidirectional_pairs`/`count_core_edges` already use: an edge and its `reverse_edge`, if both present, map to the same bit). Using the raw directed `edge_idx` instead would be a bug: a self-loop ring's CW and CCW directed cycles (or a bidirectional corridor walked either way) are the *same physical loop* and must cancel to the zero vector under XOR, not register as two independent basis members — canonical-index bits make that cancellation automatic, with no separate dedup pass needed for the basis specifically (unlike `cycles`, which is deduped afterward on demand via `dedup_bidirectional_pairs`).

**One basis instance for the whole call, not one per SCC-fragment.** The outer per-SCC loop consumes one start vertex per iteration and re-runs Tarjan's on the remainder, splitting the current SCC into smaller fragments (see "Complexity" above) — but those fragments still share the *same* underlying cycle space as the original, pre-split SCC. An earlier version of this code reset the basis and recomputed a fresh Euler-formula target per fragment; this double-counted rank, since a fragment's own local target does not account for dimensions the parent SCC's cycles, found before the split, already spanned — confirmed by a bowtie-graph regression where summing per-fragment targets let a 3rd, linearly-dependent cycle slip into a true rank-2 basis. The fix: `global_basis_target` is computed once, before the outer loop runs at all, as the sum of each *initial* SCC's own Euler-formula rank (`E_scc_canonical - V_scc + 1`); the single shared `GF2Basis`/running count persist across every fragment the outer loop later derives from that SCC.

**Early-exit**: once the running basis count reaches `global_basis_target`, further `try_insert` calls are skipped for the rest of enumeration — `cycles` (the full list) is completely unaffected, every simple cycle Johnson's finds is still pushed to it as before; only the elimination bookkeeping is skipped. This is provably safe, not an approximation: `global_basis_target` is the exact GF(2) rank of the whole canonical edge space, so once it's reached the space is fully spanned — any cycle found afterward is necessarily a linear combination of what's already in the basis (otherwise the rank would exceed the target, a contradiction), so skipping its `try_insert` check can never omit a genuinely independent cycle.

**Traversal-order selection, not length-sorted.** Which specific cycles end up in the basis (among several valid choices — the linear-algebra sense of "a basis" is not unique) depends on the order Johnson's happens to find them in, not on cycle length or any other secondary criterion. Per #244's own conclusion, there is no canonical "human-natural" basis to aim for regardless; simplicity (no secondary sort pass) was chosen over an unreachable canonicalness goal.

## NavGraph Domain

All metrics are in NavGraph domain (nav-nodes/nav-edges; corridor nodes already compressed away), then translated to maze `NodeId` for the DTO.

## Web Integration

One read-only overlay in the Analytics feature, owned by `AnalyticsRenderer` (`maze-web/src/pixi/`):

- **`PureCyclesOverlay`** — draws nodes in `pure_cycle_node_ids` and edges keyed by `pure_cycle_edge_pairs`. Green (`0x44dd88`).

Toggled via `showPureCyclesOverlay` in `mazeStore`. `GraphSection` (in the Analytics feature's detailed report, see `analytics-web.md`) shows `component_count`, `average_degree`, `node_count`, `edge_count`, and — unless `cycle_analysis_overflowed` — `cycle_count` ("Basic cycles"), `simple_cycle_count` ("Complex cycles"), `cycle_region_count`.

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

`GraphStatsDto.region_classes: HashMap<String, String>` (maze-wasm) — component id (as string key) → `"path" | "alternative" | "unreachable" | "trap"`. Computed in `build_analytics_snapshot` only when both `maze.meta.start` and `maze.meta.finish` are set; empty otherwise (region classes are unavailable without both endpoints, independent of whether a route actually exists between them).

Web overlay: **`RegionClassesRenderer`** (`maze-web/src/pixi/`), toggled via `showRegionClassesOverlay` in `mazeStore`. Renders the same per-component cell groups as `RegionsRenderer` (derived from `statistics.graph_stats.node_component`), tinted by `REGION_CLASS_COLORS` (`maze-web/src/pixi/colorUtils.ts`) instead of the rotating component palette — fixed colors per class (path: green, alternative: blue, unreachable: gray, trap: red). An info icon next to the toggle opens a legend modal mapping each class's color to its name and meaning. The toggle is disabled whenever `statistics.graph_stats.region_classes` is empty (start or finish unset), not when no route exists — see `analytics-web.md`.

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

## Split Topology & Statistics (GitHub issue #262)

`maze-core/src/graph/split_topology.rs` — maze-wide split-tile statistics, independent of
`GraphAnalytics`/`NavGraph` (this is `Field`/`Graph` domain, not nav-domain) and independent of any
route (contrast `RouteInfo::split_count`, which counts split occurrences along one specific
route — `Specs/repair.md`'s "Score formula" section).

### `SplitTopology` and `canonical_split_topology`

```rust
pub type SplitTopology = Vec<Vec<SplitFaceRequirement>>;

pub fn canonical_split_topology<T: Tessellation>(
    graph: &Graph,
    field: &Field<T>,
    nodes: &[NodeId],
) -> Option<SplitTopology>;
```

A split tile's shape, independent of:
- **which physical node happens to be listed first** — `nodes_at` order is creation order, not
  geometry; the canonical form's outer `Vec` is sorted, so node identity never matters, only the
  multiset of per-node face-requirement shapes.
- **the tile's rotation/mirror orientation on the field** — every rotation/mirror the tessellation
  supports (`Tessellation::rotation_symmetries`/`mirror_symmetries`, via `transform_face_index`) is
  tried, and the lexicographically smallest resulting (sorted) candidate is kept as the one fixed
  representative.

Built on `reconstruct_tile_faces` (`quality_control::split_pattern_match`, made `pub(crate)` for
this reuse) — the same per-node, per-face-position `Passage`/`OneWay`/`Wall` reconstruction
`split_tile_matches_any` uses to check a tile against a configured `SplitPattern` list. Unlike that
function, `canonical_split_topology` needs no candidate pattern list at all — it reduces a tile to
one canonical value that can be grouped/compared with plain equality, no rotation search needed by
the caller. Returns `None` for a non-split tile (`nodes.len() < 2`) or a degenerate tessellation
(`T::faces()` empty).

### `split_totals`

```rust
pub fn split_totals<T: Tessellation>(
    graph: &Graph,
    field: &Field<T>,
) -> (usize, usize, HashMap<SplitTopology, usize>);
```

Returns `(split_tile_count, split_node_count, groups)`:
- `split_tile_count` — number of field points with `nodes_at(point).len() >= 2`.
- `split_node_count` — sum, over every split point, of its full node count (including the point's
  original node, not just the extra ones).
- `groups` — every split tile's canonical topology, grouped by equality, mapped to how many tiles
  share it. A tile whose topology can't be canonicalized (degenerate tessellation) is still counted
  in the two totals above but has no group entry.

Iterates via `Field::all_points`, deduped per point (a split point appears once per its own node
count in `all_points`'s NodeId-domain iteration) — same dedup shape as `build_analytics_snapshot`'s
node listing (GitHub issue #223). Not cached in `MazeAnalysis` — same precedent as
`compute_node_stats`/`compute_spatial_edge_stats`, which are also recomputed on every analytics
snapshot rather than going through `MazeAnalysis`'s `RefCell`-backed cache slots.

### Web Integration

GitHub issue #364 folded split statistics into `ElementsStatsDto` (`maze-wasm/src/dto.rs`), one
member of `MazeStatisticsDto` (see "Cell Shape & Passage Statistics" below) — there is no longer a
separate `SplitAnalyticsDto`/`MazeSnapshot.split_analytics` field:

```rust
pub struct SplitGroupDto {
    pub topology: Vec<Vec<SplitFaceRequirementDto>>,
    pub count: usize,
}

pub struct ElementsStatsDto {
    pub one_way_passages: usize,
    pub two_way_teleports: usize,
    pub one_way_teleports: usize,
    pub split_tile_count: usize,
    pub split_node_count: usize,
    pub split_groups: Vec<SplitGroupDto>,
}
```

`SplitFaceRequirementDto`/`OneWayDirectionDto` mirror `maze_core::generation::SplitFaceRequirement`/
`OneWayDirection` (tagged via `#[serde(tag = "kind", rename_all = "snake_case")]`, same convention
as `IssuePayloadDto`). `topology[i]` is one node's per-face-position requirement list, indexed by
`maze-core`'s `Tessellation::faces()` position directly (**not** the web `TileFaceEditor` authoring
order — see `nav-graph.md`/GitHub issue #273's face-index distinction).

`ElementsStatsDto`, like the rest of `MazeStatisticsDto`, is `FloorScoped` (`.total` + `.by_floor`)
— `split_totals_scoped` restricts the split-point scan to one floor when `Some(level)` is passed.
Not persisted in project export (purely derived, recomputed after load, same as the rest of
`statistics`).

See `analytics-web.md`'s "Elements Section" for the `AnalyticsFeature` UI built on this DTO.

## Cell Shape & Passage Statistics (GitHub issue #364)

`maze-core/src/graph/stats.rs` and `maze-core/src/graph/classify.rs` compute the remaining members
of `MazeStatisticsDto` — geometric cell-shape classification and spatial (wall/passage) adjacency —
independent of `GraphAnalytics`/`NavGraph` (this is `Field`/`Graph` domain, not nav-domain), and not
cached in `MazeAnalysis` (recomputed on every analytics snapshot, same precedent as `split_totals`
above).

### `classify_node` / `GeometricNodeClass`

```rust
pub enum GeometricNodeClass { DeadEnd, Straight, Turn, Junction(usize) }

pub fn classify_node<T: Tessellation>(graph: &Graph, node: NodeId, field: &MultiLevelField<T>) -> GeometricNodeClass
```

Classifies a node by how many **shape neighbors** it has (0/1 → DeadEnd, 2 → Straight or Turn
depending on `field.is_straight`, n>=3 → Junction(n)). A shape neighbor is a node reachable via an
`EdgeKind::Basic` edge that is **bidirectional** (both `node -> neighbor` and `neighbor -> node`
exist) — a one-way passage doesn't read as a "side" of the cell's own shape, and
`Teleport`/`VerticalPassage`/`Elevator` edges aren't spatial neighbors on the field at all (they'd
distort the classification with connections that don't correspond to an adjacent tile). This is a
deliberately different, stricter neighbor notion than `unique_neighbors`
(`graph::classify::unique_neighbors`, all edge kinds/directions via `Graph::outgoing_neighbors`),
which is what `GraphStatsDto.average_degree` uses instead — the two questions ("what does this
cell's shape look like" vs. "how connected is the graph overall") intentionally use different
neighbor sets.

### `compute_node_stats_scoped` / `NodeStatsDto`

```rust
pub struct GeometricNodeStats {
    pub dead_ends: usize,
    pub straight: usize,
    pub turns: usize,
    pub junctions: Vec<(usize, usize)>, // (degree, count), sorted by degree
    pub teleport_entries: usize,        // distinct nodes that are the destination of >=1 Teleport edge
}
```

`teleport_entries` is not part of the dead-end/straight/turn/junction partition (a node can be both
a teleport entry and e.g. a junction) — it's a cross-cutting count, surfaced separately in
`ElementsStatsDto` on the web DTO (`NodeStatsDto` has no `teleport_entries` field), not
`NodeStatsDto`.

`compute_node_stats_scoped(graph, field, level)` restricts both to nodes on `level` (`None` = maze-
wide) — a `Teleport` edge counts toward `teleport_entries` only if its destination is on `level` too
(a cross-floor teleport target isn't "this floor's" teleport entry, mirrors
`compute_spatial_edge_stats_scoped`'s own edge-scoping rule below).

### `compute_spatial_edge_stats_scoped` / `SpatialEdgeStatsDto`

```rust
pub struct SpatialEdgeStats {
    pub bidirectional: usize,
    pub one_way_passages: usize,
    pub walls: usize,
    pub total_pairs: usize, // bidirectional + one_way_passages + walls, from adjacency_pairs directly
}
```

Walls are a spatial concept (an adjacent tile pair — via `field.neighbors`, not graph edges — with
no edge between them at all), not a graph property; every adjacent tile pair is classified into
exactly one of the three buckets. `total_pairs` is computed directly from the deduped adjacency-pair
list rather than summed from the other fields, so it stays correct if a future edge category is
added without every summation site needing an update — it is also the percentage denominator the
web "Sides Section" uses (see `analytics-web.md`).

`one_way_passages` is **not** part of `SpatialEdgeStatsDto` on the web side — GitHub issue #364
moved it into `ElementsStatsDto` alongside the other directional/special edge kinds
(`two_way_teleports`, `one_way_teleports`), so `SpatialEdgeStatsDto` only distinguishes "connected"
from "not connected".

### Web Integration

All three (`cell_count`, `cell_stats`, `passage_stats`) are `FloorScoped` members of
`MazeStatisticsDto`, computed once per level (total + each floor) in `build_analytics_snapshot` —
`passage_stats`'s underlying `SpatialEdgeStats` is computed once per level and shared with
`elements_stats`'s `one_way_passages` field rather than recomputed, since `compute_spatial_edge_stats_scoped`
walks `adjacency_pairs` and every node's `classify_node` shape.

```rust
pub struct NodeStatsDto { pub dead_ends: usize, pub straight: usize, pub turns: usize, pub junctions: Vec<JunctionBucket> }
pub struct SpatialEdgeStatsDto { pub bidirectional: usize, pub walls: usize, pub total_pairs: usize }
pub struct FloorScoped<T> { pub total: T, pub by_floor: HashMap<String, T> } // key = floor index, as string (json_compatible())
```

`cell_count: FloorScoped<usize>` is the real geometric cell count per floor (`Field::all_points()`,
deduped by point) — derived straight from field shape, not reconstructed by summing `cell_stats`'
own counts (which would double-count a split point's every extra node).

See `analytics-web.md`'s "Cells Section" and "Sides Section" for the `AnalyticsFeature` UI built on
these DTOs.

## Vertical Connection Statistics (GitHub issue #346)

`maze-core/src/graph/stats.rs`'s `compute_vertical_stats` computes `VerticalPassage`/`Elevator`/
cross-floor-`Teleport` counts — maze-wide only, like `GraphStatsDto`, never `FloorScoped`: every one
of these edge kinds spans 2+ floors by construction (a `VerticalPassage` always crosses exactly one
floor boundary, an `Elevator`'s fan always spans 2+ floors, and only *cross-floor* `Teleport` pairs
are counted here), so there is no meaningful single-floor attribution.

```rust
pub struct VerticalStats {
    pub bidirectional_passages: usize,
    pub one_way_passages_up: usize,
    pub one_way_passages_down: usize,
    pub elevator_groups: usize,
    pub elevator_stop_count: usize,
    pub average_elevator_stops: f64,
    pub cross_floor_teleports: usize,
}

pub fn compute_vertical_stats<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>) -> VerticalStats

pub fn compute_elevator_stop_count_scoped<T: Tessellation>(elevator_groups: &[HashSet<NodeId>], field: &MultiLevelField<T>, level: LevelId) -> usize
```

- `bidirectional_passages` / `one_way_passages_up` / `one_way_passages_down` — `VerticalPassage`
  edges, paired the same way `compute_teleport_edge_stats_impl` pairs `Teleport` edges (dedup by
  unordered `(from, to)`, then check for the reverse edge). A one-way pair's direction is resolved
  via `field.level_index_of` — "up" means the edge's `from` has a lower floor index than its `to`.
- `elevator_groups` — see `Graph::elevator_groups` below; **not** a raw edge count and **not**
  grouped by shared x-y point.
- `elevator_stop_count` / `average_elevator_stops` (GitHub issue #436) — sum of stop counts (nodes)
  over every `elevator_groups()` entry, and that sum divided by `elevator_groups` (`0.0` when there
  are no elevators). Maze-wide only, same as the rest of `VerticalStats`.
- `cross_floor_teleports` — `Teleport` pairs (same pairing convention) whose two ends are on
  different floors (`field.level_of(from) != field.level_of(to)`); same-floor teleports are excluded
  entirely, mirroring `compute_teleport_edge_stats_scoped`'s own cross-floor exclusion rule.

`compute_elevator_stop_count_scoped` (GitHub issue #436) is the one exception to "no meaningful
single-floor attribution" above: unlike a `VerticalPassage`/`Elevator` edge or a cross-floor
`Teleport` pair, a single elevator *stop* is one node, and a node always belongs to exactly one
floor. It counts, over the caller-supplied `elevator_groups` slice, the stop nodes that belong to
`level` — it takes the already-computed `Graph::elevator_groups()` result rather than the `Graph`
itself and recomputing, since that's a union-find pass over every `Elevator` edge and a caller
building `FloorScoped<usize>` needs one count per floor from the same snapshot (see the web-side
snapshot builder below, which computes it once and reuses it across floors). Kept outside
`VerticalStats` (which stays maze-wide-only) — its own `FloorScoped<usize>` wrapper on the web side
is described below.

### `Graph::elevator_groups`

```rust
pub fn elevator_groups(&self) -> Vec<HashSet<NodeId>>
```

Every distinct `Elevator` group, as a **connected component of `Elevator`-kind edges** — union-find
over every `Elevator` edge's endpoints. Deliberately *not* grouped by shared x-y point: two elevators
can occupy the same point without being connected (e.g. one spanning floors 1-3, a separate one
spanning floors 4-6, both fanning out from the same x-y coordinate) — grouping by point alone would
wrongly merge them into one (this was a real bug, GitHub issue #346's follow-up fix). Order of both
the outer `Vec` and each group's node iteration is unspecified.

Public on `Graph` (not `stats.rs`-private) because both the Rust analytics side
(`compute_vertical_stats`) and the web post-edit store need the same "what does this elevator
actually connect" answer — the web side has its own connected-component BFS,
`elevatorComponent` (`maze-web/src/pixi/postEditUtils.ts`), used by `postEditSlice.ts` for two
things: un-suppressing a generation-time elevator's *entire* mesh on point reset, and seeding the
elevator-edit dialog's current floor set when clicking an existing elevator marker. `elevatorComponent`
takes every BFS start id at once (not one call per id) so a multi-node point (a split point with
several nodes on the same floor) builds the adjacency map only once.

### Web Integration

`vertical_stats: VerticalStatsDto` is a plain (non-`FloorScoped`) member of `MazeStatisticsDto`,
mirroring `VerticalStats` field-for-field. `AnalyticsFeature`'s `DetailedReportPanel` renders it via
`VerticalSection`, shown only when `graph_stats.floor_count > 1` (always-zero on a single-floor maze,
so the section stays hidden rather than showing a wall of zeroes). See `analytics-web.md`'s
"Vertical Connections Section".

`elevator_stop_count: FloorScoped<usize>` (GitHub issue #436) is a separate top-level member of
`MazeStatisticsDto`, alongside `vertical_stats` — not nested inside `VerticalStatsDto`, since it is
the one vertical-connection statistic that *is* meaningful `by_floor` (see
`compute_elevator_stop_count_scoped` above). `total` mirrors `vertical_stats.elevator_stop_count`
(computed independently, same `FloorScoped` convention as `cell_count`/`cell_stats`/etc.). The web
side renders `total` inside `VerticalSection` and `by_floor[idx]` as its own row under each floor's
own "Vertical Connections" subsection (shown under the same `floor_count > 1` condition) — see
`analytics-web.md`.
