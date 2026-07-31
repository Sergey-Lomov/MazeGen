# Analytics Feature — Web Client

The Analytics feature card is the last card in `FeaturesPanel`. It displays maze statistics and controls canvas overlays for visual inspection.

## Availability

- Card status `"unavailable"` (non-expandable) when `nodes.length === 0`
- Card status `"set"` after a maze has been generated

Opening the Analytics card sets `analyticsOpen = true` in the store; closing it sets `analyticsOpen = false`. The flag drives all overlay visibility in `AnalyticsRenderer`.

## Feature Card Content

Block order (top to bottom):

1. **Issues** — hidden when `warnings.length === 0`
2. **Overlay layers** — always visible when card is open
3. **Path** — hidden when `routeInfo == null` (loose check — WASM may return `undefined`)
4. **Nodes**
5. **Edges**
6. **Graph** — hidden when `graphAnalytics == null`
7. **Splits** — hidden when `splitAnalytics == null` (GitHub issue #262)

## Data Source: Post-Edit Integration

Analytics always operates on the post-edited graph, not the raw generated graph. All data is sourced from `postEditAnalytics` (computed by `confirmPostEdit`) with fallback to generated fields when `postEditAnalytics` is null/undefined:

| Data | Source |
|---|---|
| `nodeStats` | `postEditAnalytics?.nodeStats ?? state.nodeStats` |
| `edgeStats` | `postEditAnalytics?.edgeStats ?? state.edgeStats` |
| `warnings` | `postEditAnalytics?.warnings ?? state.warnings` |
| `routeInfo` | `postEditAnalytics != null ? postEditAnalytics.routeInfo : state.routeInfo` |
| `graphAnalytics` | `postEditAnalytics?.graphAnalytics ?? state.graphAnalytics` |
| `splitAnalytics` | `postEditAnalytics?.splitAnalytics ?? state.splitAnalytics` |
| `components` | `postEditAnalytics?.components ?? state.components` |
| `navNodes/navEdges` | `postEditAnalytics?.navNodes/navEdges ?? state.navNodes/navEdges` |
| `edges` (canvas) | `postEditEdgesToDto(state.postEditEdges)` — confirmed post-edit edges snapshot |
| `start/finish` (canvas) | `postEditMeta?.start/finish ?? state.start/finish` — confirmed post-edit meta snapshot |

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
| Cycles | `showPureCyclesOverlay` | `false` | `graphAnalytics.cycle_count === 0` |
| Route | `showRouteOverlay` | `false` | `routeInfo == null` |
| Region classes | `showRegionClassesOverlay` | `false` | `graphAnalytics.region_classes` empty (start or finish unset) — independent of whether a route actually exists |

Toggle state persists when the card is closed and reopened. It resets only on full store reset. `showPureCyclesOverlay` and `showRegionClassesOverlay` are not yet persisted in project export (`ProjectFileAnalytics`) — they reset to default on project load, unlike the other toggles in this table.

An info icon (ℹ) sits left of the Region classes switch, opening a legend modal that maps each `RegionClass` color to its name and a one-line meaning (`RegionClassLegendModal` in `AnalyticsFeature.tsx`) — see `graph-analytics.md`'s "Region Classes" section for the class semantics and `REGION_CLASS_COLORS`.

### Path Block

Shown only when `routeInfo != null`. Fields:

- `path_length` — integer, number of nodes on the route
- `junction_count` — number of junction nodes on the route
- `one_way_count` — number of one-way passages on the route
- `split_count` — number of split-tile occurrences on the route (GitHub issue #261)
- `score` — float, shown only when `routeInfo.score != null`

### Nodes Block

Statistics from `nodeStats: NodeStatsDto`. Denominator = `dead_ends + straight + turns + sum(junctions[*].count)`.

| Row | Value |
|---|---|
| Dead ends | `nodeStats.dead_ends` |
| Straight | `nodeStats.straight` |
| Turns | `nodeStats.turns` |
| Junction ×N | one row per `junctions[]` entry, sorted by `degree` ascending |

Each row shows count and percentage.

### Edges Block

Statistics from `edgeStats: EdgeStatsDto`. Denominator = `bidirectional + one_way + walls`.

| Row | Value |
|---|---|
| Passages | `edgeStats.bidirectional` |
| One-way | `edgeStats.one_way` |
| Walls | `edgeStats.walls` |

Each row shows count and percentage.

### Graph Block

Shown only when `graphAnalytics != null`. Statistics from `graphAnalytics: GraphAnalyticsDto`.

| Row | Value |
|---|---|
| Nav nodes | `node_count` |
| Nav edges | `edge_count` |
| Components | `component_count` |
| Cycle rank (β₁) | `cycle_rank` |
| Min cycle length | `min_cycle_length` — hidden when null |
| Max cycle density | `max_cycle_density` (2 decimal places) — shown as "—" when null |

### Splits Block (GitHub issue #262)

Shown only when `splitAnalytics != null`. Statistics from `splitAnalytics: SplitAnalyticsDto` —
maze-wide split totals, independent of any route (contrast the Path Block's `split_count`, which
counts split occurrences along the one shortest route — see `graph-analytics.md`'s "Split Topology
& Statistics" section for the core computation).

| Row | Value |
|---|---|
| Split tiles | `tile_count` |
| Split nodes | `node_count` — every node at a split point, including each point's original node |
| One row per named group | `count` — see "Named Split Patterns" below |

A "Pattern statistics" button opens a modal listing every distinct canonical topology found on the
field (`splitAnalytics.groups`), regardless of whether it has a registered title — see "Split
Pattern Statistics Modal" below. The button is hidden when `splitAnalytics.groups` is empty.

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

One row per `splitAnalytics.groups` entry (sorted by `count` descending), each showing:
- **Preview thumbnail** — `SplitGroupPreviewTile`, reusing `TileFaceEditor` itself (via
  `tileNodesForTopology`, which converts the DTO's core-ordered `topology` to the web
  `TileFaceEditor` face order — see GitHub issue #273) at a fixed anchor point, same rationale as
  `SplitPatternListEditor`'s own `PatternPreviewTile` (no separate rendering path to keep in sync).
- **Title** — via `titleKeyForTopology`, omitted for an unregistered topology.
- **Count**, **% of splits** (`count / splitAnalytics.tile_count`), **% of field tiles**
  (`count / fieldTileCount`, computed lazily inside the modal from `state.nodes`' distinct `(x, y)`
  coordinates — not precomputed on every `AnalyticsFeature` render, since it's only needed while
  this modal is open).

### Timing Block

Shown only when `timing != null` — see GitHub issue #56 and `repair.md`'s "Timing Instrumentation" section for the core data source. `timing` comes straight from the store's generation-run value (`MazeSnapshot.timing`), with **no `postEditAnalytics` fallback** — post-edit/`compute_analytics` snapshots never run the generation pipeline, so they carry no timing data; this is the one analytics block that doesn't follow the `postEditAnalytics?.x ?? state.x` pattern used everywhere else in this file.

| Row | Value |
|---|---|
| Initial build | `timing.initial_build_ms` |
| Quality control | `timing.qc_total_ms` |
| Repair | `timing.repair_total_ms` |
| Per check (one row per entry) | `timing.per_check[id].total_ms` and `.calls`, keyed by check type id |
| Per strategy (one row per entry) | `timing.per_strategy[id].total_ms` and `.calls`, keyed by strategy id |

Per-check/per-strategy rows are rendered directly from the raw type/strategy id string (no i18n label lookup) — unlike `IssuesBlock`'s check-label resolution, this is a diagnostics view, not user-facing terminology.

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

`closedCells` (layer 3) renders nodes with no connection at all in `WALL_COLOR` — isolated cells that are completely walled off, including a cell whose only connection is a teleport (a teleport counts as a connection here even though it renders no wall opening on any geometric side — see `buildClosedCells` in `mazeSelectors.ts`). Regions (layer 4) and Region classes (layer 5) both sit between closedCells and walls so their tint shows through wall rendering — intentional. The `components: number[][]` array (member node ids per SCC, derived from `graph_analytics.node_component`) is built once in `syncAll` and shared by both renderers rather than rebuilt per layer.

### IssueHighlightOverlay

Draws straight lines directly between base-graph node centers for `hoveredIssueLoopEdges` (red, `0xff4444`) — no path compression needed since these are base-graph edges, not nav-edges. Visibility is independent of `showGraphOverlay`; it activates purely from `hoveredIssueLoopEdges` set by hovering an `IssueBubble` in `IssuesBlock`.

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
