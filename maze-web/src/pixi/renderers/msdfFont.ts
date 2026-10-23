import { Assets, BitmapText, Cache } from "pixi.js";
import type { AbstractBitmapFont } from "pixi.js";
import type { LabelFontWeight } from "./indexLabel";

/** MSDF (multi-channel signed distance field) bitmap fonts for canvas labels (GitHub issue #352).
 *
 *  Plain pixi `Text` rasterizes each instance at a fixed pixel size and blurs once the viewport
 *  zooms past it. An MSDF `BitmapText` stays crisp at any zoom because the GPU reconstructs the
 *  glyph edges from the distance field.
 *
 *  pixi.js v8 has no runtime MSDF generator — the atlases are baked offline
 *  (`tools/msdf/generate.mjs`, `npm run gen:msdf`) from `tools/msdf/Roboto-{Regular,Bold}.ttf` and
 *  committed under `public/fonts/` as `.fnt` (AngelCode XML — pixi's bitmap-font loader only
 *  recognizes `.fnt`/`.xml` by extension; a `.json` atlas loads as a plain object and `BitmapText`
 *  silently falls back to a blurry runtime canvas font). This module only loads them.
 *
 *  Two weights are baked (MSDF glyph shapes can't be synthesized bold at runtime), so the label
 *  `fontWeight` setting actually switches. Every canvas-label call site (`floorBadge`,
 *  `MarkerIndexRenderer`, `VerticalConnectionRenderer`, `MazeGraphRenderer`) picks its font name
 *  via {@link msdfFontFamily}. A new label that needs a glyph outside the baked charset must
 *  extend `tools/msdf/generate.mjs`'s `CHARSET` and re-run `npm run gen:msdf` (see
 *  `maze-web/CLAUDE.md`). */

/** Paths (relative to the served root) of the baked atlas descriptors. `Assets.load` picks up each
 *  sibling `.png` via the `pages` field inside it. */
const MSDF_FONT_URLS = [
  "/fonts/roboto-regular-msdf.fnt",
  "/fonts/roboto-bold-msdf.fnt",
] as const;

/** `BitmapText`'s `style.fontFamily` value per weight — the `face` recorded in each baked atlas
 *  (its source `.ttf`'s font-face name). Use {@link msdfFontFamily} rather than indexing this
 *  directly at call sites. */
const MSDF_FONT_FAMILY_BY_WEIGHT: Record<LabelFontWeight, string> = {
  regular: "Roboto-Regular",
  bold: "Roboto-Bold",
};

/** The installed MSDF font-family name for a label weight — pass as `BitmapText`'s
 *  `style.fontFamily`. */
export function msdfFontFamily(weight: LabelFontWeight): string {
  return MSDF_FONT_FAMILY_BY_WEIGHT[weight];
}

/** The regular-weight family name — for call sites that draw a single fixed weight (debug node
 *  labels). */
export const MSDF_FONT_FAMILY = MSDF_FONT_FAMILY_BY_WEIGHT.regular;

/** How far `text`'s glyph-ink centre sits *below* a `BitmapText`'s transform origin when it's
 *  drawn with `anchor.set(0.5)` — scaled to `fontSize`, in local pixels. Feed straight into
 *  `pivot.y` to lift the ink onto the origin.
 *
 *  `anchor.set(0.5)` centres the font's *line box*, not the glyph ink, so descender-less labels
 *  (our digits / roman numerals / uppercase) sit low. Computed from the baked atlas's own metrics,
 *  matching how pixi lays a `BitmapText` out (`getBitmapTextLayout` + `BitmapText.updateBounds`):
 *
 *   - a glyph's ink spans `(yOffset + baseLineOffset) .. (yOffset + glyphHeight + baseLineOffset)`
 *     below the line-box top (atlas units);
 *   - `anchor.y = 0.5` then shifts everything up by `(lineHeight + baseLineOffset) / 2`;
 *   - so the ink centre lands at
 *     `(minTop + maxBottom)/2 + baseLineOffset - (lineHeight + baseLineOffset)/2` below the origin.
 *
 *  Returns `0` if the font isn't installed (shouldn't happen after `loadMsdfFont`) or carries no
 *  metrics for any glyph in `text`. */
function inkCentreOffset(text: string, fontFamily: string, fontSize: number): number {
  const cacheKey = `${fontFamily}-bitmap`;
  const font = typeof Cache.has !== "function" || Cache.has(cacheKey)
    ? Cache.get<AbstractBitmapFont<unknown>>(cacheKey)
    : undefined;
  if (!font) return 0;

  let minTop = Infinity;
  let maxBottom = -Infinity;
  for (const ch of text) {
    const glyph = font.chars[ch];
    if (!glyph?.texture) continue;
    const top = glyph.yOffset;
    const bottom = top + glyph.texture.orig.height;
    if (top < minTop) minTop = top;
    if (bottom > maxBottom) maxBottom = bottom;
  }
  if (!Number.isFinite(minTop)) return 0;

  const inkCentreBelowOrigin =
    (minTop + maxBottom) / 2 + font.baseLineOffset - (font.lineHeight + font.baseLineOffset) / 2;
  return inkCentreBelowOrigin * (fontSize / font.baseMeasurementFontSize);
}

/** Creates a label `BitmapText` centred on its glyph ink (not the font line box) under
 *  `anchor.set(0.5)` — the vertical correction ({@link inkCentreOffset}) is folded into `.pivot.y`
 *  so it survives later `.x`/`.y` writes by the caller. */
export function makeCenteredLabel(text: string, fontFamily: string, fontSize: number, fill: number): BitmapText {
  const label = new BitmapText({ text, style: { fontFamily, fontSize, fill } });
  label.anchor.set(0.5);
  label.pivot.y = inkCentreOffset(text, fontFamily, fontSize);
  return label;
}

let loadPromise: Promise<void> | null = null;

/** Loads and installs both MSDF bitmap fonts so `BitmapText` can reference them by the names
 *  {@link msdfFontFamily} returns. Idempotent — repeated calls await the same load. Call once at
 *  app startup (see `App.tsx`). */
export function loadMsdfFont(): Promise<void> {
  if (!loadPromise) {
    loadPromise = Promise.all(MSDF_FONT_URLS.map((url) => Assets.load(url))).then(() => undefined);
  }
  return loadPromise;
}
