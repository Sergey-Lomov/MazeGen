# Web Client Architecture Notes

## Feature-Renderer ownership rule

Each feature has exactly one feature-renderer that owns its canvas layers. No feature-renderer may use or depend on another feature's renderer.

If two feature-renderers share logic, extract that logic into a base class or utility — do not share renderer instances.

Examples:
- `GenerationRenderer` — owned by Generation feature only
- `AnalyticsRenderer` — owned by Analytics feature only

If `AnalyticsRenderer` and `GenerationRenderer` share rendering patterns, extract shared code into an abstract base class (e.g., `BaseFeatureRenderer`) that both inherit from.

## GridRenderer — base renderer, never used directly

`GridRenderer` is a low-level primitive. It is **never instantiated directly** from outside the renderer layer.

- `TessellationRenderer` wraps `GridRenderer` for the Tessellation feature. It manages its own visibility (shows grid when no feature card is open). It is the **only** feature-renderer for the tessellation feature.
- All other feature-renderers (GenerationRenderer, AnalyticsRenderer, etc.) **include their own `GridRenderer` instance as the bottom-most layer** directly inside themselves — `new GridRenderer(container)`. NOT via `TessellationRenderer`.
- `TessellationRenderer` is **never used** inside other feature-renderers. No exceptions.

## Data-loss confirmation dialogs

Confirmation dialogs that warn about data loss are driven by predicates in `src/pixi/selectors/mazeSelectors.ts` (`selectPostEditDirty`, `selectTessellationWouldLoseData`, etc.).

Current dirty flags in `MazeState` (all reset on `confirmTessellation` and project load):
- `fieldDirty` — field setup changed (shape, size, custom points, orientation)
- `presetsDirty` — preset connections changed
- `mazeDirty` — maze generated
- `postEditDirty` — manual post-edit changes made

**When adding a new feature that produces user data** (not read-only like analytics/debug overlays):
1. Add a `myFeatureDirty: boolean` flag to `MazeState` in `mazeStore.ts`.
2. Set it `true` on any user edit action, `false` on generate/reset/load and `confirmTessellation`.
3. Add it to the relevant predicate(s) in `mazeSelectors.ts` (`selectTessellationWouldLoseData`, `selectPostEditDirty`, or a new one).
4. Wire the predicate into the relevant confirmation dialog component.
