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

### Issues Block

Displays `warnings: string[]` from the store (generation warnings reported by WASM). Each warning is one row styled in `textWarning` color.

### Overlay Layers Block

Five toggles, each backed by a store boolean:

| Toggle label | Store field | Default |
|---|---|---|
| Maze | `showMazeOverlay` | `true` |
| Connectivity regions | `showComponentsOverlay` | `false` |
| Graph | `showGraphOverlay` | `false` |
| Navigation graph | `showNavGraphOverlay` | `false` |
| Route | `showRouteOverlay` | `false` |

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

## Canvas Renderer — AnalyticsRenderer

Owns all analytics canvas layers. Lives in `analyticsContainer` which is a synced layer in `MazeScene` (position and scale kept in sync with viewport). No other renderer may use `AnalyticsRenderer`'s layers.

### Layer Stack (bottom to top)

| # | Container | Renderer | Visibility condition |
|---|---|---|---|
| 1 | `gridContainer` | `GridRenderer` | `analyticsOpen && showMazeOverlay && nodes.length > 0` |
| 2 | `floorContainer` | `CellFillRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 3 | `regionsContainer` | `RegionsRenderer` | `analyticsOpen && showComponentsOverlay && components.length > 0` |
| 4 | `wallsContainer` | `WallRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 5 | `markersContainer` | `WaypointsRenderer` (via `MazeOverlayRenderer`) | same as grid |
| 6 | `graphContainer` | `MazeGraphRenderer` | `analyticsOpen && showGraphOverlay && nodes.length > 0` |
| 7 | `navGraphContainer` | `NavGraphRenderer` | `analyticsOpen && showNavGraphOverlay && navNodes.length > 0` |
| 8 | `routeContainer` | `RouteOverlay` | `analyticsOpen && showRouteOverlay && routeInfo != null` |

Regions (layer 3) sits between floor and walls so region colors show through wall rendering — intentional.

### MazeOverlayRenderer

Utility class (not a feature-renderer). Accepts `{ floor, walls, markers }` containers from the caller so `AnalyticsRenderer` can control z-order. Does not create its own containers.

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
