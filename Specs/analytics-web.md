# Analytics Feature — Web Client

The Analytics feature card is the last card in `FeaturesPanel`. It displays maze statistics and controls canvas overlays for visual inspection.

## Availability

- Card status `"unavailable"` (non-expandable) when `nodes.length === 0`
- Card status `"set"` after a maze has been generated

Opening the Analytics card sets `analyticsOpen = true` in the store; closing it sets `analyticsOpen = false`. The flag drives all overlay visibility in `AnalyticsRenderer`.

## Feature Card Content

Block order (top to bottom):

1. **Issues**
2. **Overlay layers** — always visible when card is open
3. **Path** — hidden when `routeInfo == null` (loose check — WASM may return `undefined`)
4. **Summary statistics** — hidden when `statistics == null`; a compact block plus a "Detailed report" button opening `DetailedReportPanel` (GitHub issue #364)
5. **Timing** — hidden when `timing == null`

`DetailedReportPanel` is a `SidePanel`, not part of the card's own scroll — see "Summary Statistics & Detailed Report" below for its own content structure (General/Cells/Sides/Elements/Graph, plus a per-floor breakdown).

## Data Source: Post-Edit Integration

Analytics always operates on the post-edited graph, not the raw generated graph. All data is sourced from `postEditAnalytics` (computed by `confirmPostEdit`) with fallback to generated fields when `postEditAnalytics` is null/undefined:

| Data | Source |
|---|---|
| `statistics` | `postEditAnalytics?.statistics ?? state.statistics` — `MazeStatisticsDto`, see `graph-analytics.md` |
| `warnings`/`issues` | `postEditAnalytics?.issues ?? state.issues`, via `selectAnalyticsIssues` |
| `routeInfo` | `postEditAnalytics != null ? postEditAnalytics.routeInfo : state.routeInfo` |
| `floors` | `state.floors` (live UI state, not part of `postEditAnalytics`) |
| `edges` (canvas) | `postEditEdgesToDto(state.postEditEdges)` — confirmed post-edit edges snapshot |
| `start/finish` (canvas) | `postEditMeta?.start/finish ?? state.start/finish` — confirmed post-edit meta snapshot |

`statistics` replaced the previously flat `nodeStats`/`edgeStats`/`graphAnalytics`/`splitAnalytics` fields (GitHub issue #364) — a single `MazeStatisticsDto`, most of it `FloorScoped` (`.total` + per-floor `.by_floor`, keyed by floor index as a string). See `graph-analytics.md`'s "Cell Shape & Passage Statistics" and "Web Integration" sections for the DTO shapes.

**`floors` and `statistics.*.by_floor` can desync.** `floors` is live UI state (`addFloor`/`removeFloor`/`moveFloor` in `floorsSlice.ts`); `statistics` is a snapshot from the last generate/post-edit-confirm. Adding a floor after generating, before regenerating, leaves that floor's `by_floor` entry missing. `DetailedReportPanel` filters `floors` down to `floorsWithStats` (those with a `statistics.cell_stats.by_floor[idx]` entry) before rendering the per-floor breakdown, so a stale/missing entry is silently excluded rather than crashing on `undefined`.

`routeInfo` uses strict `!= null` (not `??`) because `null` is a meaningful value meaning "no path exists" and must not fall back to generated `routeInfo`.

The Route overlay toggle is disabled when `routeInfo == null`. `showRouteOverlay` is auto-reset to `false` when `confirmPostEdit` produces `route_info == null`.

### Issues Block

Displays `issues: IssueDto[]` from the store (QC issues reported by WASM), one bubble per **contributing check** (not per issue) — see `quality-feature.md`'s "Issue rendering: IssuesBlock / IssueBubble" section for the full mechanism (per-source-check bubbles, labels, and highlight data). Each bubble is styled in `textWarning` (or `textError` for `cycle_analysis_overflowed`) color.

`invalid_loop` issues carry `payload: { kind: "invalid_loop", edges: Record<string, [number, number][][]> }` (`IssueDto.payload`, a discriminated union — see `quality_control.md`'s "IssueDto" section), keyed by source check id — one entry per invalid cycle *that check* flagged (too short for `min_loop_length`, too long for `max_loop_length`, etc.), each a list of base-graph `[from, to]` maze node-id pairs. Hovering one bubble narrows `issue.payload.kind === "invalid_loop"` and calls `setHoveredIssueLoopEdges(issue.payload.edges[sourceCheck].flat())` — only that check's cycles, not every contributing check's combined; leaving clears it back to `null`. This lets a maze-wide issue (e.g. a short loop entirely protected by a user preset, which the repair pass cannot fix) be visually located on the canvas instead of only reported by kind.

### Overlay Layers Block

Toggles, each backed by a store boolean:

| Toggle label | Store field | Default | Disabled when |
|---|---|---|---|
| Maze | `showMazeOverlay` | `true` | — |
| Connectivity regions | `showComponentsOverlay` | `false` | — |
| Graph | `showGraphOverlay` | `false` | — |
| Navigation graph | `showNavGraphOverlay` | `false` | — |
| Cycles | `showPureCyclesOverlay` | `false` | `statistics.graph_stats.cycle_count === 0` |
| Route | `showRouteOverlay` | `false` | `routeInfo == null` |
| Region classes | `showRegionClassesOverlay` | `false` | `statistics.graph_stats.region_classes` empty (start or finish unset) — independent of whether a route actually exists |

Toggle state persists when the card is closed and reopened. It resets only on full store reset. `showPureCyclesOverlay` and `showRegionClassesOverlay` are not yet persisted in project export (`ProjectFileAnalytics`) — they reset to default on project load, unlike the other toggles in this table.

An info icon (ℹ) sits left of the Region classes switch, opening a legend modal that maps each `RegionClass` color to its name and a one-line meaning (`RegionClassLegendModal` in `AnalyticsFeature.tsx`) — see `graph-analytics.md`'s "Region Classes" section for the class semantics and `REGION_CLASS_COLORS`.

### Path Block

Shown only when `routeInfo != null`. Fields:

- `path_length` — integer, number of nodes on the route
- `junction_count` — number of junction nodes on the route
- `one_way_count` — number of one-way passages on the route
- `split_count` — number of split-tile occurrences on the route (GitHub issue #261)
- `score` — float, shown only when `routeInfo.score != null`

### Summary Statistics & Detailed Report (GitHub issue #364)

The card itself shows only a compact summary block (hidden when `statistics == null`): floor count,
total cell count, graph components, cycle count, average degree — plus a "Detailed report" button
that opens `DetailedReportPanel`, a `SidePanel` (not a `Modal`) with two collapsible top-level
sections:

- **General statistics** (`report_general`) — maze-wide totals, in order:
  - **Graph** (`GraphSection`) — `component_count`, `average_degree` (2 decimals), `node_count`,
    `edge_count`, and — unless `cycle_analysis_overflowed` — `cycle_count` ("Basic cycles"),
    `simple_cycle_count` ("Complex cycles"), `cycle_region_count`.
  - **Cells** (`CellsSection`) — total cell count (`cell_count.total`, no percentage) plus
    `cell_stats.total`'s dead-end/straight/turn/junction breakdown, each with count and percentage
    of `dead_ends + straight + turns + sum(junctions[*].count)`.
  - **Sides** (`SidesSection`) — total adjacent-pair count (`passage_stats.total.total_pairs`, no
    percentage) plus passages (`bidirectional`), one-way (`elements_stats.total.one_way_passages`),
    and walls, each with count and percentage of `total_pairs`. An info icon opens `SidesInfoModal`
    explaining the wall/passage/one-way distinction.
  - **Elements** (`ElementsSection`) — `one_way_passages`, `two_way_teleports`,
    `one_way_teleports`, `split_tile_count`, `split_node_count`, one row per named split group (see
    "Named Split Patterns" below), and a "Pattern statistics" button (hidden when
    `split_groups` is empty) opening `SplitPatternStatsModal`.
  - **Vertical Connections** (`VerticalSection`, GitHub issue #346) — shown only when
    `graph_stats.floor_count > 1` (a single-floor maze has none of these by construction, so the
    section stays hidden rather than rendering a wall of zeroes). Rows: `bidirectional_passages`
    ("two-way vertical passages"), `one_way_passages_up`, `one_way_passages_down`,
    `elevator_groups` (distinct `Elevator` groups — see `graph-analytics.md`'s `Graph::elevator_groups`
    for the connected-component-not-shared-point counting rule), `cross_floor_teleports`. No
    percentages (unlike Sides/Elements) — these counts have no natural denominator. Maze-wide only,
    reading straight from `statistics.vertical_stats: VerticalStatsDto`; never appears under "By
    floors" since `VerticalStatsDto` has no `by_floor` slice.
- **By floors** (`report_by_floors`) — one collapsible sub-section per floor that has a
  `statistics.cell_stats.by_floor[idx]` entry (`floorsWithStats`, topmost floor first), each
  containing its own Cells/Sides/Elements sub-blocks built from that floor's own `by_floor[idx]`
  slice of `cell_stats`/`passage_stats`/`elements_stats`/`cell_count`. No per-floor Graph
  sub-section — `graph_stats` is maze-wide only (SCCs/cycles can span floors via
  teleport/vertical-passage/elevator edges), see `graph-analytics.md`.

A "Pattern statistics" button opens `SplitPatternStatsModal`, listing every distinct canonical
topology found on the field (`elements_stats.total.split_groups`), regardless of whether it has a
registered title — see "Split Pattern Statistics Modal" below.

#### Named Split Patterns

`maze-web/src/pixi/splitPatternTitles.ts` — a small, curated, client-only title registry mapping a
handful of recognizable canonical topologies to an i18n title (`split_pattern_title.*`), filtered
by tile degree (`topology[0].length`) the same way `splitBlueprints.ts`'s `SplitNodeBlueprint`
registry is filtered by degree. Deliberately independent from that blueprint registry — a blueprint
is an editor action template with no title of its own; this registry exists purely to label a
handful of shapes in the stats UI. Matching is plain structural equality against the exact
canonical topology core already computed (`titleKeyForTopology`, no rotation search needed
client-side, since core already picked one fixed representative per shape).

Currently registered (each entry's canonical topology was computed once via a throwaway diagnostic
Rust test, not derived at runtime):

| Tessellation | Title | Shape |
|---|---|---|
| Triangle | Split fork | The tessellation's only built-in triangle blueprint |
| Square | Bridge | Two nodes, each a straight-through opposite-face pair |
| Square | Diagonal divider | Two nodes, each an adjacent-face pair |
| Hex | Bridge | Two nodes, each a straight-through opposite-face pair |
| Hex | Double bridge | Three nodes, all opposite-face pairs |
| Hex | Triple corridor | One opposite-face pair plus two adjacent-face pairs |

A group whose topology has no registered title is shown only in the "Pattern statistics" modal, not
directly in the Splits Block.

#### Split Pattern Statistics Modal

One row per `elements_stats.total.split_groups` entry (sorted by `count` descending), each showing:
- **Preview thumbnail** — `SplitGroupPreviewTile`, reusing `TileFaceEditor` itself (via
  `tileNodesForTopology`, which converts the DTO's core-ordered `topology` to the web
  `TileFaceEditor` face order — see GitHub issue #273) at a fixed anchor point, same rationale as
  `SplitPatternListEditor`'s own `PatternPreviewTile` (no separate rendering path to keep in sync).
- **Title** — via `titleKeyForTopology`, omitted for an unregistered topology.
- **Count**, **% of splits** (`count / elements_stats.total.split_tile_count`), **% of field tiles**
  (`count / fieldTileCount`, computed lazily inside the modal from `state.nodes`' distinct `(x, y)`
  coordinates — not precomputed on every `AnalyticsFeature` render, since it's only needed while
  this modal is open).

### Timing Block

Shown only when `timing != null` — see GitHub issue #285 (originally #56) and `repair.md`'s "Timing Instrumentation" section for the core data source. `timing` comes straight from the store's generation-run value (`MazeSnapshot.timing`), with **no `postEditAnalytics` fallback** — post-edit/`compute_analytics` snapshots never run the generation pipeline, so they carry no timing data; this is the one analytics block that doesn't follow the `postEditAnalytics?.x ?? state.x` pattern used everywhere else in this file.

The block itself is trimmed to four top-level rows:

| Row | Value |
|---|---|
| Total | `timing.initial_build_ms` + sum of `timing.qc[*].total_ms` + `timing.snapshot_ms` |
| Initial generation | `timing.initial_build_ms` |
| Quality control | sum of `timing.qc[*].total_ms` |
| Analytics snapshot | `timing.snapshot_ms` — post-generation `build_analytics_snapshot` cost (incl. `graph_analytics`/`nav_graph`), unmeasured by the QC tree above (GitHub issue #414) |

A "Detailed report" button opens `TimingDetailedReportModal`, a `size="complex"` `Modal` using `rawBody` (a fixed, non-scrolling header row above a separately-scrolling tree, so a tall report never scrolls its own column headers out of view). The table has four columns — Task, Calls, Time, % — with one row per node in the tree, recursively:

- Three synthetic root rows: "Initial generation" (`timing.initial_build_ms`, a leaf), "Quality control" (sum of `timing.qc[*].total_ms`, containing `timing.qc` as its children), and "Analytics snapshot" (`timing.snapshot_ms`, a leaf).
- `timing.qc`'s own nodes: one per stage, containing one child per rule, each rule containing its checks and (if dispatched) its one strategy as leaf children — the same tree `TimingNode` describes in `repair.md`.
- Each row is prefixed by its kind, resolved via i18n templates taking the resolved name as a parameter: `"Stage: {name}"`, `"Rule: {name}"`, `"Check: {name}"`, `"Strategy: {name}"` (`analytics.timing_report_prefix_*`). Stage/rule names are resolved from the store's own `stages`/`rules` lists by id (falling back to the raw id if not found — e.g. a stage/rule since removed from the current config); check/strategy names go through `resolveCheckLabel`/`resolveStrategyLabel` (`qualityI18n.ts`), also falling back to the raw id. A leaf id is classified as a check if it's present in `availableChecks`, a strategy otherwise (`leafKind`) — the `per_check`/`per_strategy` accumulators feeding one rule's children are otherwise indistinguishable once merged into one `children` array.
- `%` is always relative to the whole run's total time (the same `Total` row's value), at every nesting level — never to the immediate parent — so any row's contribution is directly comparable to any other row's regardless of depth.
- `Calls` is blank (not `0`) for a node whose `entry.calls` is `0` — true for every rule node (a pure time container) and for a stage node that converged on its very first pass.
- Vertical hierarchy lines (mirroring `NestedStrategyPanel`'s `entryStackWithWeight` pattern) run down the left of each node's own children block as one continuous `borderLeft`, not a per-row dashed segment — ties every descendant row visually to the parent it's nested under. Rows highlight on hover only (`"hoverable"`), no permanent striping.

## Canvas Renderer — AnalyticsRenderer

Owns all analytics canvas layers. Lives in `analyticsContainer` which is a synced layer in `MazeScene` (position and scale kept in sync with viewport). No other renderer may use `AnalyticsRenderer`'s layers.

### Layer Stack (bottom to top)

| # | Container | Renderer | Visibility condition |
|---|---|---|---|
| 1 | `gridContainer` | `GridRenderer` | `analyticsOpen && showMazeOverlay && nodes.length > 0` |
| 2 | `floorContainer` | `CellFillRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 3 | `closedCellsContainer` | `CellFillRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 4 | `regionsContainer` | `RegionsRenderer` | `analyticsOpen && showComponentsOverlay && componentCount > 0` |
| 5 | `regionClassesContainer` | `RegionClassesRenderer` | `analyticsOpen && showRegionClassesOverlay && componentCount > 0` |
| 6 | `wallsContainer` | `WallRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 7 | `teleportContainer` | `TeleportRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 8 | `markersContainer` | `WaypointsRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 9 | `graphContainer` | `MazeGraphRenderer` | `analyticsOpen && showGraphOverlay && nodes.length > 0` |
| 10 | `navGraphContainer` | `NavGraphRenderer` | `analyticsOpen && showNavGraphOverlay && navNodes.length > 0` |
| 11 | `pureCyclesContainer` | `PureCyclesOverlay` | `analyticsOpen && showPureCyclesOverlay && navNodes.length > 0` |
| 12 | `routeContainer` | `RouteOverlay` | `analyticsOpen && showRouteOverlay && routeInfo != null` |
| 13 | `issueHighlightContainer` | `IssueHighlightOverlay` | `analyticsOpen && (hoveredIssueLoopEdges or hoveredIssueRegionGroups non-empty)` |

`closedCells` (layer 3) renders nodes with no connection at all in `WALL_COLOR` — isolated cells that are completely walled off, including a cell whose only connection is a teleport (a teleport counts as a connection here even though it renders no wall opening on any geometric side — see `buildClosedCells` in `mazeSelectors.ts`). Regions (layer 4) and Region classes (layer 5) both sit between closedCells and walls so their tint shows through wall rendering — intentional. The `components: number[][]` array (member node ids per SCC, derived from `statistics.graph_stats.node_component`) is built once in `syncAll` and shared by both renderers rather than rebuilt per layer.

### IssueHighlightOverlay

Extends `BaseGraphRenderer` (GitHub issue #367). Draws straight lines directly between base-graph node centers for `hoveredIssueLoopEdges` (red, `0xff4444`) — no path compression needed since these are base-graph edges, not nav-edges. Visibility is independent of `showGraphOverlay`; it activates purely from `hoveredIssueLoopEdges` set by hovering an `IssueBubble` in `IssuesBlock`. Draws cross-floor badges (own red color) for a highlighted edge whose other endpoint is on a different floor, same mechanism as `PureCyclesOverlay`/`RouteOverlay` — see `floors.md`'s "Cross-floor badges in the graph overlays" section. `AnalyticsRenderer` passes `resolveNodeLevel`/`resolveNodeCell`/`activeFloorIndex`; `PostEditRenderer`'s own `redrawIssueHighlight` builds the same trio from its own unscoped `state.nodes`.

### MazeOverlayRenderer

Utility class (not a feature-renderer). Accepts `{ floor, closedCells, walls, teleports, markers }` containers from the caller so `AnalyticsRenderer` can control z-order. Does not create its own containers.

### RegionsRenderer

Renders connectivity regions from `components: number[][]`. Builds a color palette with `buildPalette(n)`, one `CellFillGroup` per component. Renders nothing (clears) when `nodes` or `components` is empty.

### Graph overlay

`MazeGraphRenderer` is created with `interactive: false` — no node click handling in analytics mode.

### Viewport

`AnalyticsRenderer.onViewportChanged(x, y, w, h, scale)` is called from `MazeScene.syncLayersToViewport()`. Grid re-renders on viewport change when maze overlay is visible.

## Direction Arrows

One-way arrows on graph edges and wall one-way indicators share a single drawing function `drawDirectionArrow` in `maze-web/src/pixi/renderers/wallUtils.ts`.

```ts
drawDirectionArrow(g, cx, cy, dx, dy, size, color?)
```

- Triangle centered at `(cx, cy)` pointing in direction `(dx, dy)`
- Centroid lands exactly at `(cx, cy)` by construction: tip at `+size`, base at `-0.5*size`
- `drawOneWayTriangle` delegates to this function with `size = TILE_SIZE * 0.18`
- Graph edge arrows use the same size and call `drawDirectionArrow` directly
- Any change to arrow shape must go through this single function to keep both uses in sync
