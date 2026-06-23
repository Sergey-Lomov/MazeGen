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

## Data Source: Post-Edit Integration

Analytics always operates on the post-edited graph, not the raw generated graph. All data is sourced from `postEditAnalytics` (computed by `confirmPostEdit`) with fallback to generated fields when `postEditAnalytics` is null/undefined:

| Data | Source |
|---|---|
| `nodeStats` | `postEditAnalytics?.nodeStats ?? state.nodeStats` |
| `edgeStats` | `postEditAnalytics?.edgeStats ?? state.edgeStats` |
| `warnings` | `postEditAnalytics?.warnings ?? state.warnings` |
| `routeInfo` | `postEditAnalytics != null ? postEditAnalytics.routeInfo : state.routeInfo` |
| `graphAnalytics` | `postEditAnalytics?.graphAnalytics ?? state.graphAnalytics` |
| `components` | `postEditAnalytics?.components ?? state.components` |
| `navNodes/navEdges` | `postEditAnalytics?.navNodes/navEdges ?? state.navNodes/navEdges` |
| `edges` (canvas) | `postEditEdgesToDto(state.postEditEdges)` — confirmed post-edit edges snapshot |
| `start/finish` (canvas) | `postEditMeta?.start/finish ?? state.start/finish` — confirmed post-edit meta snapshot |

`routeInfo` uses strict `!= null` (not `??`) because `null` is a meaningful value meaning "no path exists" and must not fall back to generated `routeInfo`.

The Route overlay toggle is disabled when `routeInfo == null`. `showRouteOverlay` is auto-reset to `false` when `confirmPostEdit` produces `route_info == null`.

### Issues Block

Displays `issues: IssueDto[]` from the store (QC issues reported by WASM). Each issue is one row styled in `textWarning` color. `IssueDto = { kind: string, invalid_loop_edges: [number, number][][] | null }`.

`invalid_loop` issues carry `invalid_loop_edges` — one entry per invalid cycle (too short, too long, or invalid for some other check-specific reason), each a list of base-graph `[from, to]` maze node-id pairs. Hovering the issue bubble calls `setHoveredIssueLoopEdges(invalid_loop_edges.flat())`; leaving clears it back to `null`. This lets a maze-wide issue (e.g. a short loop entirely protected by a user preset, which the repair pass cannot fix) be visually located on the canvas instead of only reported by kind.

### Overlay Layers Block

Five toggles, each backed by a store boolean:

| Toggle label | Store field | Default | Disabled when |
|---|---|---|---|
| Maze | `showMazeOverlay` | `true` | — |
| Connectivity regions | `showComponentsOverlay` | `false` | — |
| Graph | `showGraphOverlay` | `false` | — |
| Navigation graph | `showNavGraphOverlay` | `false` | — |
| Route | `showRouteOverlay` | `false` | `routeInfo == null` |

Toggle state persists when the card is closed and reopened. It resets only on full store reset.

### Path Block

Shown only when `routeInfo != null`. Fields:

- `path_length` — integer, number of nodes on the route
- `junction_count` — number of junction nodes on the route
- `one_way_count` — number of one-way passages on the route
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

## Canvas Renderer — AnalyticsRenderer

Owns all analytics canvas layers. Lives in `analyticsContainer` which is a synced layer in `MazeScene` (position and scale kept in sync with viewport). No other renderer may use `AnalyticsRenderer`'s layers.

### Layer Stack (bottom to top)

| # | Container | Renderer | Visibility condition |
|---|---|---|---|
| 1 | `gridContainer` | `GridRenderer` | `analyticsOpen && showMazeOverlay && nodes.length > 0` |
| 2 | `floorContainer` | `CellFillRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 3 | `closedCellsContainer` | `CellFillRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 4 | `regionsContainer` | `RegionsRenderer` | `analyticsOpen && showComponentsOverlay && components.length > 0` |
| 5 | `wallsContainer` | `WallRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 6 | `markersContainer` | `WaypointsRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 7 | `graphContainer` | `MazeGraphRenderer` | `analyticsOpen && showGraphOverlay && nodes.length > 0` |
| 8 | `navGraphContainer` | `NavGraphRenderer` | `analyticsOpen && showNavGraphOverlay && navNodes.length > 0` |
| 9 | `routeContainer` | `RouteOverlay` | `analyticsOpen && showRouteOverlay && routeInfo != null` |
| 10 | `issueHighlightContainer` | `IssueHighlightOverlay` | `analyticsOpen && hoveredIssueLoopEdges != null && hoveredIssueLoopEdges.length > 0` |

`closedCells` (layer 3) renders nodes with no edges in `WALL_COLOR` — isolated cells that are completely walled off. Regions (layer 4) sits between closedCells and walls so region colors show through wall rendering — intentional.

### IssueHighlightOverlay

Draws straight lines directly between base-graph node centers for `hoveredIssueLoopEdges` (red, `0xff4444`) — no path compression needed since these are base-graph edges, not nav-edges. Visibility is independent of `showGraphOverlay`; it activates purely from `hoveredIssueLoopEdges` set by hovering an `IssueBubble` in `IssuesBlock`.

### MazeOverlayRenderer

Utility class (not a feature-renderer). Accepts `{ floor, closedCells, walls, markers }` containers from the caller so `AnalyticsRenderer` can control z-order. Does not create its own containers.

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
