# Web Client Architecture Notes

## MSDF label font (`npm run gen:msdf`)

Canvas labels are drawn as MSDF `BitmapText` (crisp at any zoom), not pixi `Text` (blurs on zoom)
— GitHub issue #352. pixi.js v8 has no runtime MSDF generator, so the atlases are baked offline:

- Source: `tools/msdf/Roboto-Regular.ttf` + `tools/msdf/Roboto-Bold.ttf` (Apache-2.0,
  `tools/msdf/LICENSE.txt`). Two weights — MSDF glyphs can't be synthesized bold at runtime, so
  the `fontWeight` label setting needs a real atlas per weight.
- Script: `tools/msdf/generate.mjs` — run via `npm run gen:msdf` (from `maze-web/`). Bakes at
  `fontSize` 54 / `distanceRange` 8 into a 512×512 page — the wide spread is what keeps labels
  sharp at extreme viewport zoom.
- Output (committed): `public/fonts/roboto-{regular,bold}-msdf.fnt` + `.png`. Must be `.fnt`
  (AngelCode XML) — pixi's bitmap-font loader recognizes only `.fnt`/`.xml` by extension; a
  `.json` atlas loads as a plain object and `BitmapText` falls back to a blurry canvas font.
- Runtime: `src/pixi/renderers/msdfFont.ts` — `loadMsdfFont()` is awaited once at startup in
  `App.tsx` (before `setReady`); label call sites pick the font name via `msdfFontFamily(weight)`
  (or `MSDF_FONT_FAMILY` for the fixed-regular debug labels).

**When a new label needs a glyph not in the atlas**, extend `CHARSET` in `generate.mjs`, re-run
`npm run gen:msdf`, and commit the regenerated `.fnt` + `.png` (both weights). Current charset:
`A-Z`, `0-9`, `:`, `(`, `)`, `,`, space.

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
