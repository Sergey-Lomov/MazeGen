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

The zoom readout is also exposed as a reset control: clicking the percentage label or pressing `Shift+1` resets the active viewport back to 100% scale without running fit-to-screen.

**`HoverProvider`** (`pixi/hoverTypes.ts`): `getHoverInfo(canvasX, canvasY): HoverInfo | null`. `canvasX/canvasY` are raw DOM pointer-event coordinates (before viewport pan/zoom is undone) — each provider does its own transform. Returns `null` only when hover info can't be determined at all (no active projection/viewport); coordinates outside the current field/graph bounds still return a valid `HoverInfo`.

**`DefaultHoverProvider`** (`pixi/hoverProviders.ts`): today's only implementation, used by every card. Converts canvas coords → viewport-local coords → grid coords via the active `TessellationProjection` (`canvasToGrid`, also reused by `FieldEditController.toGrid`).

**Resolution**: `MazeScene.getHoverProvider(st)` mirrors `getController(st)` — resolves which provider is active per `openCard`. Currently always returns the single cached `hoverProvider` instance; a future per-feature override (e.g. edge hit-testing, out of scope for now) would branch here instead, the same way `getController` branches per card. The config used to build the projection is picked via `TESSELLATION_CONFIG_BY_CARD` (a `Record<FeatureId, ...>` lookup, separate from `refit()`'s own config-selection — the two answer different questions and are not shared).

**Wiring**: `SceneInteraction` calls `getHoverProvider(st).getHoverInfo(...)` unconditionally on every `pointermove`, pushing the result to `MazeScene.setHoverListener`'s registered callback (`HoverInfoPanel`'s `setState`). Cleared (`null`) on `pointerleave`, `pointerupoutside`, and window `blur`. `setHoverListener` supports exactly one listener — registering a new one clears the previous.

## GenerationRenderer

Renders the active maze inside `viewport`. Subscribes to `mazeStore` directly. Receives only `viewport: Container` — all layer containers are created internally.

**Layer stack (z-order, bottom to top):**

| Layer | Renderer | Purpose |
|-------|----------|---------|
| `gridContainer` | `GridRenderer` | Own grid layer, bottom-most (see `CLAUDE.md`'s renderer-ownership rule) |
| `floorContainer` | `CellFillRenderer` | Fill all cells with `FLOOR_COLOR` |
| `closedCellsContainer` | `CellFillRenderer` | Fill isolated cells (no edges) with `WALL_COLOR` |
| `wallsContainer` | `WallRenderer` | Draw wall/passage edges |
| `splitJunctionContainer` | `SplitJunctionRenderer` | Draw split points' independent passages |
| `teleportContainer` | `TeleportRenderer` | Draw teleport edge markers |
| `markersContainer` | `WaypointsRenderer` | Draw start/finish markers |

**Visibility:** all layers hidden when `openCard !== "generation" || !showMaze`.

**Store subscription fires `renderAll` when:**
- `nodes`, `edges`, `start`, `finish`, `tessellationConfig`, `activeTessellationConfig` change
- `debugMode`, `debugArena`, `debugStep` change

**Debug view projection (`debugView`)** — event-tree based (GitHub issue #124/#125), replaces the old per-step full-graph-snapshot model:
- When `debugMode`: `selectDebugMazeView(debugArena, debugStep)` replays the event tape up to `debugStep` (from the nearest checkpoint, see `Specs/event_log.md`'s Intermediate Snapshot Checkpointing) to reconstruct `nodes`/`edges`, memoized per `(debugArena, debugStep)` pair (GitHub issue #139) so repeated calls for the same pair are free; falls back to live `state.nodes`/`state.edges` when there's no arena yet
- Start/finish stay hidden for the whole debug replay — Recursive Backtracker doesn't emit events for them (see `Specs/event_log.md`), so there's no reconstructed value to show until generation's real (non-debug) result is used instead

**Closed cells** (`closedCells` layer): nodes with no edges (neither `from` nor `to`) in the current edge set. Rendered in `WALL_COLOR` to visually merge with walls.

## Layer Renderers

### CellFillRenderer
Fills a list of cells with a single color/alpha. Accepts `CellFillGroup | CellFillGroup[]`. Uses `getCellVertices` for polygon geometry.

### WallRenderer
Draws wall segments between cell pairs. Each `WallEdge` specifies two cell coordinates, passage kind (`both/forward/backward/none`), and style (`solid/faint/invalid`). One-way passages get a directional triangle marker at the midpoint. Split points (more than one `NodeDto` per point) are excluded entirely — see `SplitJunctionRenderer` below.

### SplitJunctionRenderer (GitHub issue #223/#231/#234/#294)
Draws a split point's independent passages — wired into `PostEditRenderer` (its own instance), `GenerationRenderer` (its own instance, geometry cached alongside `wallEdges`/`teleportEdges`, keyed additionally on `start`/`finish` since `specialNodeIds` depends on them), `AnalyticsRenderer` (via `MazeOverlayRenderer`, which owns a `SplitJunctionRenderer` layer alongside its walls/floor/teleports/markers), and `PresetConnectionsRenderer` (GitHub issue #231 — presets run before generation, so its instantiation has no `NodeId`/`specialNodeIds` concept, identity is `presetEndpointKey` instead) — see `Specs/post-edit.md`'s Rendering section and `Specs/preset-connections.md`'s "Split nodes" section for the full geometry/color rules. Each `SplitPassage` (one per connected node) draws its `wallSegments` (its own share of the wall on every face it connects across) plus `connectors` linking those shares — a single straight line between the two shares for a node with exactly 2 plain two-way connections, or one line per share from a small circle point otherwise. A one-way's arrowhead is drawn on its connector line (never on the along-face segment); an `isUndefined` share/connector draws desaturated (`disabledOfNumber`) instead of the node's normal color. `render()` also takes `wallFaces` — faces where every one of a point's nodes explicitly has `wall`, drawn once as a plain solid wall (`canvas.wall.default`) instead of per-node segments. All per-node drawing in the node's own color. Built by `buildSplitPassagesCore`/`buildSplitPassages`/`buildPresetSplitPassages` (`mazeSelectors.ts`/`presetSelectors.ts`), sharing the geometric algorithm with the dialog's tile diagram via `pixi/splitFaceLayout.ts`. Every post-generation caller builds `specialNodeIds` the same way: `start`/`finish` plus every teleport edge's `from`/`to` (presets have no such concept).

**Wall-segment cap (GitHub issue #304/#317).** A `wallSegment`'s two ends draw `cap: "butt"` only where a real neighbor sits — an internal division point where this face is shared with another node's own sub-segment, or (for a chained multi-face path, see below) a tile vertex a `join` applies at instead. An end that lands on the face's own real endpoint (`SplitFaceSegment.atFaceStart`/`atFaceEnd`, `pixi/splitFaceLayout.ts` — set when this share's `v0`/`v1` is the first/last in that face's division order) has no such neighbor and instead follows the caller's own cap (`wallFaceStyleOverride?.cap`, defaulting to `"round"` when no override is given, same default `wallFaces` itself uses). Since Pixi's `stroke()` applies one `cap` to both of a path's ends, a path with exactly one free end draws `"butt"` first and gets that one end's own round/square cap patched in afterward as a standalone filled shape (`computeSquareCapPatch`, `pixi/renderers/wallUtils.ts` — pure geometry shared with `VectorByCorridorsRenderer`'s own free-end restore, so neither feature-renderer owns the other's utility); a path with both ends free (e.g. a lone node spanning the whole face) draws once with the real cap directly. Connectors have no such concept — their outer end is always either a hub point (several connectors meet there) or a shared face-division point — so they stay `cap: "butt"` unconditionally.

**Special shapes (GitHub issue #294).** `render()`'s third param, `SplitStyleOverride`, also carries `specialShapes?: boolean` — defaults to **on** when the caller passes no override at all (every caller above except `VectorByWallsRenderer`, see `Specs/image-export.md`'s "Splits" section). A recognized degree-4 topology (`detectSplitSpecialShapeKind`, `mazeSelectors.ts` — `"bridge"`: two nodes each a straight-through opposite-face pair; `"diagonal"`: two nodes each an adjacent-face pair) draws via `drawSplitSpecialShape` instead of that point's ordinary per-node `SplitPassage` entries, in the plain wall color/width (never a node's own identity color) and always `cap: "butt"` (a special shape's free ends already sit on the tile's own face boundary, so a round/square cap would protrude past it). `wallFaces` draw first, special shapes on top, so an ordinary neighboring wall's own protruding join gets painted over rather than poking past the special shape's line. Geometry (`SplitSpecialShape`, `pixi/renderers/types.ts`) is computed unconditionally by `buildSplitPassagesCore` alongside every point's ordinary passages (`SplitPassagesResult.specialShapes`), so the toggle costs no extra geometry pass either way.

### WaypointsRenderer
Draws filled circles at given positions (start/finish markers). Positions are in screen coordinates (pre-computed by selector). A split-point marker's own position comes from `buildNodePositions`/`getSplitAwareNodePosition` (`tessellationGeometry.ts`/`mazeSelectors.ts`) — the generic hub-circle slot, or `specialSplitNodePoint`'s dedicated bridge/diagonal point when the point is recognized as one (GitHub issue #318, independent of this renderer's own `specialShapes` drawing toggle above) — see `Specs/post-edit.md`'s "Marker/teleport anchoring"/"Shape-aware node point" notes.

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
