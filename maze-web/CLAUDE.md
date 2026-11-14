# Web Client Architecture Notes

## MSDF label font (`npm run gen:msdf`)

Canvas labels are drawn as MSDF `BitmapText` (crisp at any zoom), not pixi `Text` (blurs on zoom)
— GitHub issue #352. pixi.js v8 has no runtime MSDF generator, so the bundled atlases are baked offline
(installed and uploaded fonts get dynamic atlases from `@playcanvas/msdfgen-wasm` in a worker,
`src/pixi/renderers/rasterFont/`, GitHub issue #966):

- Source: `tools/msdf/<Font>-{Regular,Bold}.ttf` for every entry of `FONTS` in `generate.mjs`: Roboto
  (Apache-2.0, `public/licenses/Apache-2.0.txt`), Noto Sans, Noto Sans Condensed, Noto Serif, Fira Sans, Fira Mono, Arimo, Tinos, Cousine and Open Sans (SIL OFL 1.1,
  `tools/msdf/OFL-<Font>.txt`). Two weights per font — MSDF glyphs can't be synthesized bold at runtime, so
  a font offers only the weights it was baked with (`MSDF_FONTS`).
- Script: `tools/msdf/generate.mjs` — run via `npm run gen:msdf` (from `maze-web/`). Bakes at
  `fontSize` 54 / `distanceRange` 8 into a 1024×1024 page — the wide spread is what keeps labels
  sharp at extreme viewport zoom.
- Output (committed): `public/fonts/<id>-{regular,bold}-msdf.fnt` + `.png`. `npm run gen:msdf -- <id>...` bakes only
  the named fonts. A new font also needs a `msdfFont(...)` entry in `MSDF_FONTS` (`fontChoice.ts`), its license file next to the sources, and a `FONT_NOTICES` entry (`components/fontLicenses.ts`, copyright line from that license file; shown in the font licenses dialog, a test enforces it). Pick fonts that declare no Reserved Font Name and cover Latin and Cyrillic (a font without Cyrillic bakes empty glyphs and only warns). Must be `.fnt`
  (AngelCode XML) — pixi's bitmap-font loader recognizes only `.fnt`/`.xml` by extension; a
  `.json` atlas loads as a plain object and `BitmapText` falls back to a blurry canvas font.
- Runtime: `src/pixi/renderers/msdfFont.ts` — `loadMsdfFont()` loads only the default Roboto and is
  awaited once at startup in `App.tsx` (before `setReady`); every other `MSDF_FONTS` entry is fetched on
  demand by `loadMsdfFamily` (`msdfLoader.ts`, issue #982; see `Specs/font-picker.md`); label call sites pick the font name via `msdfFontFamily(font)`
  (or `MSDF_FONT_FAMILY` for the fixed-regular debug labels).

**When a new label needs a glyph not in the atlas**, extend `CHARSET` in `generate.mjs`, re-run
`npm run gen:msdf`, and commit the regenerated `.fnt` + `.png` (every font, both weights). Current charset:
uppercase/lowercase Latin and Cyrillic, `0-9`, `: ( ) , # № + - =`, space, and text punctuation
`. ; ! ? ' " / & _ * % @ [ ] « » – — …` (floor titles, GitHub issue #747).

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
