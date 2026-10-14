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
