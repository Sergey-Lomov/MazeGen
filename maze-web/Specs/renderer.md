# maze-web Renderer

## Overview

Pixi.js-based rendering system. `MazeScene` owns a Pixi `Application` and orchestrates all renderers. Created by `App` once on mount, destroyed on unmount.

## MazeScene

Top-level coordinator. Holds a single `viewport: Container` for the maze, plus separate synced overlay containers for editor UI. All containers move together on pan/zoom via `syncLayersToViewport()`.

**Synced overlay containers** (kept in sync with viewport position/scale):
- `fieldEditorOverlayContainer`
- `primitivePreviewContainer`
- `presetConnectionsContainer`
- `tessellationContainer`

**Interaction:**
- **Pan**: `pointerdown → pointermove` delta applied to `viewport.x/y`, synced to overlays.
- **Zoom**: wheel event → factor `1.1` (in) / `0.9` (out) around mouse position.
- Window `blur` cancels drag.
- In field edit mode: pointer events routed to `FieldEditController`.
- In preset connections mode: pointer events routed to `PresetConnectionsController`.

**Auto-fit**: on new maze generation, `fitMaze()` scales and centers viewport around all node centers. `refit(durationMs)` repeats this over time (e.g., on panel resize).

## Hover info panel

Thin DOM bar docked at the bottom of the canvas column (`HoverInfoPanel`), showing the grid `x, y` under the cursor. Works uniformly across every card except `quality` (raw HTML5 canvas, no Pixi stage) — one shared mechanism rather than a per-feature reimplementation.

**`HoverProvider`** (`pixi/hoverTypes.ts`): `getHoverInfo(canvasX, canvasY): HoverInfo | null`. `canvasX/canvasY` are raw DOM pointer-event coordinates (before viewport pan/zoom is undone) — each provider does its own transform. Returns `null` only when hover info can't be determined at all (no active projection/viewport); coordinates outside the current field/graph bounds still return a valid `HoverInfo`.

**`DefaultHoverProvider`** (`pixi/hoverProviders.ts`): today's only implementation, used by every card. Converts canvas coords → viewport-local coords → grid coords via the active `TessellationProjection` (`canvasToGrid`, also reused by `FieldEditController.toGrid`).

**Resolution**: `MazeScene.getHoverProvider(st)` mirrors `getController(st)` — resolves which provider is active per `openCard`. Currently always returns the single cached `hoverProvider` instance; a future per-feature override (e.g. edge hit-testing, out of scope for now) would branch here instead, the same way `getController` branches per card. The config used to build the projection is picked via `TESSELLATION_CONFIG_BY_CARD` (a `Record<FeatureId, ...>` lookup, separate from `refit()`'s own config-selection — the two answer different questions and are not shared).

**Wiring**: `SceneInteraction` calls `getHoverProvider(st).getHoverInfo(...)` unconditionally on every `pointermove`, pushing the result to `MazeScene.setHoverListener`'s registered callback (`HoverInfoPanel`'s `setState`). Cleared (`null`) on `pointerleave`, `pointerupoutside`, and window `blur`. `setHoverListener` supports exactly one listener — registering a new one clears the previous.

## GenerationRenderer

Renders the active maze inside `viewport`. Subscribes to `mazeStore` directly. Receives only `viewport: Container` — all layer containers are created internally.

**Layer stack (z-order, bottom to top):**

| Layer | Renderer | Purpose |
|-------|----------|---------|
| `floorContainer` | `CellFillRenderer` | Fill all cells with `FLOOR_COLOR` |
| `closedCellsContainer` | `CellFillRenderer` | Fill isolated cells (no edges) with `WALL_COLOR` |
| `wallsContainer` | `WallRenderer` | Draw wall/passage edges |
| `markersContainer` | `WaypointsRenderer` | Draw start/finish markers |
| `debugActiveContainer` | `CellFillRenderer` | Frontier highlight (active nodes, blue) |
| `debugSrcContainer` | `CellFillRenderer` | Current source highlight (yellow) |

**Visibility:**
- All layers: hidden when `!generationOpen || !showMaze`
- `debugActiveContainer` / `debugSrcContainer`: additionally hidden when `!showDebugFrontier`

**Store subscription fires `renderAll` when:**
- `nodes`, `edges`, `start`, `finish`, `activeTessellationConfig` change
- `debugMode`, `debugSnapshot`, `debugStep` change

**Debug view projection (`debugView`):**
- When `debugMode && debugSnapshot`: reads nodes from snapshot, edges from `steps[debugStep].edges`
- Start/finish hidden on all steps except the last
- `currentStep` provides `active_nodes` and `current_src` for frontier rendering

**Closed cells** (`closedCells` layer): nodes with no edges (neither `from` nor `to`) in the current edge set. Rendered in `WALL_COLOR` to visually merge with walls.

## Layer Renderers

### CellFillRenderer
Fills a list of cells with a single color/alpha. Accepts `CellFillGroup | CellFillGroup[]`. Uses `getCellVertices` for polygon geometry.

### WallRenderer
Draws wall segments between cell pairs. Each `WallEdge` specifies two cell coordinates, passage kind (`both/forward/backward/none`), and style (`solid/faint/invalid`). One-way passages get a directional triangle marker at the midpoint.

### WaypointsRenderer
Draws filled circles at given positions (start/finish markers). Positions are in screen coordinates (pre-computed by selector).

## Graph Renderers (not used in GenerationRenderer — reserved for future analysis feature)

`MazeGraphRenderer` and `NavGraphRenderer` in `MazeRenderer.ts` render directed graph overlays with nodes (circles) and edges (lines with arrowheads). Not currently mounted.

**Node colors:** `0x4a9eff` (normal), `0xff9f4a` (hover), `0xff4a4a` (selected), `0x44dd88` (start), `0xdd4466` (finish).

**Edge rendering:** groups pairs by `min(from,to):max(from,to)`. Bidirectional = plain line. One-way = line + arrowhead at destination.

**Arrowhead geometry:**
```
side = min(0.3 * edgeLen, NODE_RADIUS * 3)
height = side * sqrt(3) / 2
tip = endPt
base = tip - unitDir * height
left/right = base ± perp * side/2
```

## Lifecycle

`destroy()` on all renderers: unsubscribes from store, destroys Pixi objects, removes event listeners.
