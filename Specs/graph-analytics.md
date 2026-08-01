# Graph Analytics

Structural metrics computed on the **NavGraph** (directed). Covers physical connectivity and directed-cycle structure ("pure cycles" — real cycles only, no connecting bridges).

## Data Structures

### `GraphAnalytics` (maze-core)

```rust
pub struct GraphAnalytics {
    pub node_count: usize,
    pub edge_count: usize,                  // unique undirected nav-edges
    pub cycle_count: usize,                 // number of fundamental cycles found (see below)
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
    pub node_component: HashMap<String, usize>, // maze node id (as string — see below) → SCC component id
    pub pure_cycle_node_ids: Vec<u32>,         // maze node ids in the pure-cycle core
    pub pure_cycle_edge_pairs: Vec<[u32; 2]>,  // [from_maze_id, to_maze_id] pure-cycle nav-edges
}
```

Maze-id translation happens in `build_analytics_snapshot` (maze-wasm/src/analytics.rs) — `GraphAnalytics` works in `NavNodeId`/edge-index domain, the DTO re-expresses everything in maze `NodeId` domain for the web layer.

`component_count` and `node_component` in the DTO both come from base-graph SCC (`maze.analysis.scc`), computed independently of `GraphAnalytics` — kept for the `RegionsRenderer` overlay (every id in `node_component` is `< component_count`). `GraphAnalytics` itself has no physical-connectivity field; nothing in the nav-graph domain needs it.

`node_component`'s key is `String`, not `u32` — `MazeSnapshot` is serialized via `serde_wasm_bindgen::Serializer::json_compatible()` (plain JS objects, not `Map`s), which requires string map keys; the maze node id is formatted with `.to_string()` when the map is built.

## Single Source of Truth: `find_fundamental_cycles`

`maze-core/src/graph/cycles.rs` implements a **fundamental cycle basis** construction over each SCC of
a `NavGraph`: a spanning tree plus exactly one cycle per non-tree connection. This replaces the former
Johnson's-algorithm enumeration of ALL simple directed cycles (removed in [issue #244](https://github.com/Sergey-Lomov/MazeGen/issues/244))
— composite cycles (a union of two or more independent loops) are no longer produced at all, only the
independent basis. This single function feeds the pure-cycle core (this spec), all loop-based QC checks
(`quality_control.md`), and the analytics overlay.

- **Self-loops are first-class cycles.** A self-loop `NavEdge` (`from == to`, produced only by `build_ring` for a junction-free ring) forms its own SCC of size 1 *with* a cycle, distinct from a size-1 SCC with no self-loop (no cycle). A self-loop's CW and CCW directions (if the ring is bidirectional) are linked via `reverse_edge` by the same path-reversal mechanism used for ordinary corridors — no special-case dedup needed.
- **One-way edges get a temporary fictitious reverse** (never mutating the real `NavGraph`) so the spanning tree can be built as if the SCC were bidirectional. A two-pass BFS builds the tree: pass 1 uses only real links, across the entire frontier, before pass 2 (fictitious links) ever runs for whatever remains unvisited — a per-node "prefer real over fictitious" ordering is insufficient, since a different node visited later in the same level may have a real path to a node a fictitious link would otherwise claim too early.
- **Physical connections are deduplicated** via a canonical id (min of an edge's index and its `reverse_edge`'s index, or an edge and its fictitious mirror) before tree-building — one physical wire is never treated as both a tree edge and someone else's non-tree edge. This structurally eliminates trivial reverse-pair 2-cycles (walking a corridor edge then immediately its own `reverse_edge`) — no post-filter needed, unlike the former Johnson's-based `is_trivial_reverse_pair`.
- **Discard is structurally impossible.** Every fictitious link is, by construction, backed by a real one-way edge somewhere in the same SCC; since an SCC is by definition fully reachable node-to-node via real directed edges alone, the real-only first pass of the spanning-tree BFS always covers the whole SCC before the fictitious pass ever runs — so a fictitious link can never become a tree edge, and no cycle is ever discarded for direction-invalidity. This is a proven, tested property (`one_way_only_scc_with_two_independent_loops_never_discards`), not merely an observed absence of counterexamples.
- No length bound is enforced inside the algorithm itself — `LoopLengthCheck` filters the full result by tile-length after the fact.

## Computation Pipeline

`compute_graph_analytics(nav: &NavGraph) -> GraphAnalytics`:

1. **Pure-cycle core** (`cycle_core`, `graph_analytics.rs`) — nodes/edges participating in a fundamental cycle, derived from `find_fundamental_cycles`. Union every node/edge appearing in any cycle into the core; for each surviving edge, also add its `reverse_edge` (if any) to the core edge set.

2. **Cycle metrics** on the fundamental cycle list:
   - `cycle_count` = `find_fundamental_cycles(nav).len()` — the number of fundamental cycles found. Since discard is structurally impossible (see above), this equals the topological β₁ (independent-cycle count) in practice, but is now computed directly as the basis length rather than via the Euler formula (`E - V + C`).
   - `cycle_region_count` = number of undirected connected components of the pure-cycle core (`count_core_regions`, DSU-based).

### Complexity

- `find_fundamental_cycles`: one spanning tree (BFS, two passes) plus one tree-path reconstruction per non-tree connection — no combinatorial blowup, unlike the former Johnson's enumeration. A dense fully-bidirectional grid that used to enumerate millions of simple cycles (a 6x6 grid: 2,444,782 under the old algorithm) now yields exactly its topological β₁ (25 for that grid) — see `dense_grid_that_used_to_overflow_completes_quickly` in `cycles/tests.rs`.
- Cycle metrics (`count_core_regions`): linear in core size once the core is known.
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
| `cycle_count` | Minimum cycle count — maze must not be a tree |
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

`SplitAnalyticsDto` (`maze-wasm/src/dto.rs`), computed in `build_analytics_snapshot` from
`maze.field`/`maze.graph` directly (not from `GraphAnalytics`):

```rust
pub struct SplitGroupDto {
    pub topology: Vec<Vec<SplitFaceRequirementDto>>,
    pub count: usize,
}

pub struct SplitAnalyticsDto {
    pub tile_count: usize,
    pub node_count: usize,
    pub groups: Vec<SplitGroupDto>,
}
```

`SplitFaceRequirementDto`/`OneWayDirectionDto` mirror `maze_core::generation::SplitFaceRequirement`/
`OneWayDirection` (tagged via `#[serde(tag = "kind", rename_all = "snake_case")]`, same convention
as `IssuePayloadDto`). `topology[i]` is one node's per-face-position requirement list, indexed by
`maze-core`'s `Tessellation::faces()` position directly (**not** the web `TileFaceEditor` authoring
order — see `nav-graph.md`/GitHub issue #273's face-index distinction).

`MazeSnapshot.split_analytics: SplitAnalyticsDto` follows `graph_analytics`'s wiring exactly:
`GenerationState.splitAnalytics`, `PostEditAnalytics.splitAnalytics`, reset alongside
`graphAnalytics` in `buildResetMazeState` — not persisted in project export (purely derived,
recomputed after load, same as `graphAnalytics`).

See `analytics-web.md`'s "Splits Block" section for the `AnalyticsFeature` UI built on this DTO.
