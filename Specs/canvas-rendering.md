# Main canvas rendering (on-demand render, MSAA, display density)

GitHub issue #738. How the main editor Pixi `Application` (`App.tsx` → `MazeScene`) decides when to draw a frame and at which density. The small standalone Pixi canvases (split-point previews, tool glyphs) are out of scope — they already run without a ticker and render once per change themselves.

## Application options (`App.tsx`)

- `resolution: window.devicePixelRatio || 1`, `autoDensity: true` — the backing buffer matches the display's physical pixels, so the maze stays sharp on Retina.
- `antialias: devicePixelRatio < 2` — MSAA only below density 2. At 2+ edges are already smooth, while 4x MSAA multiplies framebuffer memory and bandwidth. `antialias` is a WebGL context attribute: it is decided once at init and never changes afterwards, even if the window later moves to a display with a different density (recreating the context for that is not worth the cost).
- `autoStart: false` — the ticker never drives rendering; `RenderScheduler` does.

## `RenderScheduler` (`src/pixi/renderScheduler.ts`)

Owned by `MazeScene` (created first in its constructor, destroyed right before `app.destroy()`).

**On-demand rendering.** The app's ticker is stopped. A render is requested by:

1. **Render-group hooks (primary).** The scheduler enables a render group on `app.stage` and wraps its Pixi v8 internals: `onChildUpdate` (transform / visibility / color / blend changes), `onChildViewUpdate` (view content changes — a redrawn `Graphics` context, new text, a texture update) and the `structureDidChange` flag via a property accessor (add/remove/reorder children, masks, filters, render layers). Nested render groups are hooked when they attach (`addRenderGroupChild`). Any edit to any Pixi object on stage therefore requests a frame, regardless of which renderer, controller, rAF callback or async load made it.
2. **Explicit `requestRender()` (safety net).** `MazeScene` calls it on every store update (subscription), at the end of `syncLayersToViewport()` (pan / zoom / refit / resize), and after a display-density change.

Requests coalesce: at most one `app.render()` per animation frame. Nothing renders while nothing changes, so idle CPU/GPU use is near zero. During continuous interaction (panning, dragging, hover) the rate stays at most one render per frame, as before.

**`app.render` is routed through the scheduler.** Pixi's own synchronous renders (the resize plugin) go through the same path and consume an already-queued frame. Notifications fired while a render is in progress are ignored — they are Pixi's bookkeeping for the frame being drawn, not new content.

**Suspension.** `setSuspended(true)` while the Quality card hides the canvas (`MazeScene.subscribeToQualityOpen`, see `Specs/quality-feature.md`): no renders at all, including the resize plugin's. `setSuspended(false)` triggers one render that draws everything changed meanwhile.

**Fallback.** If the stage's render group does not have the expected internal shape (a Pixi upgrade changed it), the scheduler logs a warning and starts the ticker instead — continuous rendering, so the canvas never goes stale. `setSuspended` then stops/starts the ticker, as the pre-#738 code did.

**Dev-build check.** In dev builds (`import.meta.env.DEV`) the scheduler polls every 1000 ms: if the stage's render groups hold pending changes (`structureDidChange`, queued transform or view updates) while no frame is queued and the scheduler is not suspended, it warns `RenderScheduler: scene changed without a render request` and renders. Changes already pending right after the last render (left by Pixi during that render) are not reported.

**Destroy.** Cancels the queued frame, stops the dev check, and removes every hook (restores Pixi's prototype methods and a plain `structureDidChange` data property). Pixi pools `RenderGroup` objects, so a group left hooked would keep notifying the destroyed scheduler after another canvas reuses it.

## Display density changes (`src/pixi/devicePixelRatioWatcher.ts`)

`watchDevicePixelRatio(onChange)` listens to a `(resolution: Xdppx)` media query for the current density and re-arms it for the new value after every change. It fires when the window moves to a display with a different `devicePixelRatio` and on browser zoom.

`MazeScene.applyDevicePixelRatio(dpr)` resizes the renderer to the same CSS-pixel screen size at the new resolution (`renderer.resize(screen.width, screen.height, dpr)`) and requests a render; an unchanged density is a no-op. Consumers that read `renderer.resolution` (the eyedropper's `sampleColorAt` / `sampleRegionAt`) read it live, so they follow the change. MSAA stays as chosen at init (see above).

## Seams (GitHub issue #841)

Topology seams (`Specs/topology.md`, "Seam rendering model") are drawn on the main canvas by duplication: a glued face is one logical element with two copies, and each side draws it in full from its own face geometry. The partner cell is never drawn on this side.

- **Walls.** `buildMazeWalls` emits one `WallEdge` per side of a closed seam face (`a` the cell, `b` the partner, `face` the cell's face index, drawn by `WallRenderer` through `getFaceEdgeSegment`). An open seam passage draws none. A glued face is never a boundary wall. A one-way indicator points out of the source cell and into the target cell.
- **Corridors.** `buildCorridorSegments` emits one segment per side, `center` to that side's face `contact`, flagged `v1TouchesSplit` (the end belongs to this cell alone, so the contour engine builds one port and a butt cap). `fromNode` / `toNode` still name both cells.
- **Hit-testing.** `pickEdgeAtPosition` also tests each copy of a seam face (`getFaceEdgeSegment`); a hit on either copy resolves to the same canonical edge key over the pair of cells.
- **Highlights.** `logicalEdgeSegments(a, b, cfg)` (`selectors/seamEdges.ts`) returns the one shared face of ordinary neighbors or both copies of a seam face; the hover and invalid-preset edge highlights use it. `drawCellBoundaryHighlight` (issue / debug-ref `asWall` edges) draws its band on each side's own face.
- **Graph overlays.** `graphSeams.ts` (pure) draws a hop between glued cells as two stubs: node to the slot of its face on the glue's contour, and from the partner face's slot to the node; nothing between them. The feature-renderer (`AnalyticsRenderer`, `GenerationRenderer` for debug-value sequence and map highlight) builds the context with `selectSeamHopContext` and passes it as `seam` in the render data; the graph renderers never read the store. The route overlay breaks its polyline at the slots; nav graph, analytics graph, pure cycles, sequence and map highlight use it. The slot is the anchor of the pair's route on the contour; it is not drawn.
- **Seam arrows.** `SeamArrowRenderer` (`pixi/renderers/`, a base renderer like `GridRenderer`; the field, preset, generation, analytics and post-edit renderers each own one in a container above their maze layers and below only their highlight layers, and feed it through `SeamArrowLayer` (`seamArrowSync.ts`: the renderer plus `watchSeamArrows`); the tessellation and image export renderers have none; `SeamHoverTracker` in `MazeScene` finds the arrow or pair under the pointer and stores it as `seamHover`; the topology panel's hover is focused too; the face zones that focus a pair are off on the post-edit and preset cards, which highlight a glued face with its copy themselves) draws one arrow per glue of the active floor, in every canvas mode: a contour parallel to the faces of each run, and a single polyline from the middle of one contour to the middle of the other with a head at each end, each glue in its own hue of one opaque dark muted gamut, lighter on hover (hovering a glued pair's face zone or contour shows the route of that single pair); a twisted glue carries a white refresh icon on a disc at the middle. The body is straight (or has one bend where two runs end in the same corner) only when clear and along the tessellation's connector axes, otherwise it goes round the field on a ring, nested rings for nested runs, (see `Specs/topology.md`). The geometry is the pure `buildSeamArrows(cfg, topology)` (`selectors/seamArrows.ts`); without the topology every fold is its own glue. The pointer focuses an arrow or pair only after resting on it for `HOVER_DELAY_MS` (100 ms); losing focus and moving it between arrows or pairs is immediate. Analytics and post-edit issue highlights (loops, regions, passages) take their data, including the seam hop context, from the shared `selectIssueHighlightData` (`selectors/issueHighlight.ts`), so a highlighted hop across a glue breaks into stubs at the contour in both.
- Tests: `src/test/seamRendering.test.ts` (cylinder, torus, Möbius), run against the real core module.
