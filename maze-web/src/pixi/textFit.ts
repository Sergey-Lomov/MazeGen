import { Cache } from "pixi.js";
import type { AbstractBitmapFont } from "pixi.js";
import type { LabelFontWeight } from "./renderers/indexLabel";
import { msdfFontFamily } from "./renderers/msdfFont";
import { TEXT_SIZE_RANGE, DEFAULT_TEXT_MARGIN } from "./renderConstants";
import type { MarkerShape } from "./renderers/types";
import { markerPolygonPoints } from "./renderers/markerShapes";

/** Text-vs-plate fit math for marker captions and floor-number badges (GitHub issue #707).
 *
 *  A label "fits" when its glyph ink, centred on the plate like `makeCenteredLabel` centres it, lies
 *  inside the plate's *actual shape* (circle, star, cross, ...) — so the allowed size depends on the
 *  shape. The ink is the real outline of each glyph: boundary pixels of the baked MSDF atlas
 *  (`inkBoundaryPoints`, median channel >= 0.5), not its bounding box — a rounded "S" leaves the
 *  corners of its box empty and fits a much tighter circle than the box would. When the atlas
 *  pixels can't be read (tests, font not loaded) it falls back to the glyph bounding rectangle
 *  (`measureText` + `rectInShape`). Metrics come from the same `Cache` entry `msdfFont.ts` reads
 *  for `inkCentreOffset`, not from a live `BitmapText`, so this module is pure and usable from
 *  selectors (export warnings) as well as UI handlers. Everything scales linearly with the font
 *  size, so one measurement resolves every fit question. `plateSize` is the plate's
 *  fill diameter and the shape's circle-equivalent size (`markerPolygonPoints` area-matches every
 *  shape to it). */

/** Atlas glyph quads carry this much distance-field padding per side, in atlas units at the font's
 *  base measurement size (`padding="4,4,4,4"` in the baked `.fnt`, `tools/msdf/generate.mjs`). It is
 *  empty space, not ink, so it is trimmed off every measured extent. */
const MSDF_GLYPH_PADDING = 4;

interface TextExtent {
  width: number;
  height: number;
}

/** A label with the plate it must fit into — the unit the warnings and auto-fit operate on. */
export interface TextFitItem {
  text: string;
  fontWeight: LabelFontWeight;
  /** Plate shape (`MarkerAppearance.shape`). */
  shape: MarkerShape;
  /** Plate fill diameter in px (`MarkerAppearance.size`). For a rectangular plate (`plateWidth` /
   *  `plateHeight` set) it is ignored. */
  plateSize: number;
  /** Rectangular plate (marker-index plates, GitHub issue #725): when both are set the label must
   *  fit this rectangle (centred) instead of `shape` / `plateSize`. */
  plateWidth?: number;
  plateHeight?: number;
  /** Shape of a rectangular plate. Parallelograms use the same skew as floor-label rendering. */
  plateShape?: "rectangle" | "parallelogram";
  /** Distance (px) the glyph ink must keep from the plate edge (`TextStyleFields.textMargin`);
   *  `DEFAULT_TEXT_MARGIN` when omitted. */
  margin?: number;
}

/** Ink extent of `text` at `fontSize` px. Falls back to a rough per-glyph estimate when the font
 *  isn't installed (e.g. before `loadMsdfFont` resolves). */
export function measureText(text: string, fontWeight: LabelFontWeight, fontSize: number): TextExtent {
  const font = Cache.get<AbstractBitmapFont<unknown>>(`${msdfFontFamily(fontWeight)}-bitmap`);
  const glyphs = Array.from(text);
  if (glyphs.length === 0) return { width: 0, height: 0 };
  if (!font) return { width: glyphs.length * fontSize * 0.6, height: fontSize * 0.7 };

  const scale = fontSize / font.baseMeasurementFontSize;
  let cursor = 0;
  let minLeft = Infinity;
  let maxRight = -Infinity;
  let minTop = Infinity;
  let maxBottom = -Infinity;
  for (const ch of glyphs) {
    const glyph = font.chars[ch];
    if (!glyph) continue;
    if (glyph.texture) {
      const left = cursor + glyph.xOffset + MSDF_GLYPH_PADDING;
      const right = cursor + glyph.xOffset + glyph.texture.orig.width - MSDF_GLYPH_PADDING;
      const top = glyph.yOffset + MSDF_GLYPH_PADDING;
      const bottom = glyph.yOffset + glyph.texture.orig.height - MSDF_GLYPH_PADDING;
      if (left < minLeft) minLeft = left;
      if (right > maxRight) maxRight = right;
      if (top < minTop) minTop = top;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    cursor += glyph.xAdvance;
  }
  if (!Number.isFinite(minLeft)) return { width: 0, height: 0 };
  return { width: (maxRight - minLeft) * scale, height: (maxBottom - minTop) * scale };
}

function pointInPolygon(x: number, y: number, pts: number[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether segment (x1,y1)-(x2,y2) passes through the open rectangle `|x| < hw, |y| < hh`
 *  (Liang-Barsky clip against the rectangle). */
function segmentCrossesRect(x1: number, y1: number, x2: number, y2: number, hw: number, hh: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 + hw], [dx, hw - x1], [-dy, y1 + hh], [dy, hh - y1]]) {
    if (Math.abs(p) < 1e-12) {
      if (q <= 1e-9) return false;
    } else {
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return t1 - t0 > 1e-9;
}

/** Whether a `width` x `height` rectangle centred on a `shape` of circle-equivalent radius `r` lies
 *  inside it. Circle: corner distance. Polygons (incl. the concave star/cross): the contour must not
 *  cross the rectangle's interior and the rectangle's centre must be inside the polygon. */
function rectInShape(shape: MarkerShape, r: number, width: number, height: number): boolean {
  const hw = width / 2;
  const hh = height / 2;
  if (shape === "circle") return Math.hypot(hw, hh) <= r + 1e-9;
  const pts = markerPolygonPoints(shape, 0, 0, r);
  if (!pointInPolygon(0, 0, pts)) return false;
  for (let i = 0; i < pts.length; i += 2) {
    const j = (i + 2) % pts.length;
    if (segmentCrossesRect(pts[i], pts[i + 1], pts[j], pts[j + 1], hw, hh)) return false;
  }
  return true;
}


/** Boundary pixels of one glyph's ink in an RGBA atlas page: pixels inside the glyph (median of
 *  R/G/B >= 128, the MSDF surface) with at least one 4-neighbour outside it (or outside `frame`).
 *  Returns flat `[x, y, ...]` pixel centres relative to the frame's top-left corner, in atlas units
 *  (1 atlas pixel = 1 unit at the font's base size). Pure — the canvas read lives in
 *  `readAtlasPage`. */
export function inkBoundaryPoints(
  rgba: ArrayLike<number>, pageWidth: number, frame: { x: number; y: number; width: number; height: number },
): number[] {
  const inside = (px: number, py: number): boolean => {
    if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) return false;
    const i = ((frame.y + py) * pageWidth + frame.x + px) * 4;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    return Math.max(Math.min(r, g), Math.min(Math.max(r, g), b)) >= 128;
  };
  const points: number[] = [];
  for (let py = 0; py < frame.height; py++) {
    for (let px = 0; px < frame.width; px++) {
      if (!inside(px, py)) continue;
      if (!inside(px - 1, py) || !inside(px + 1, py) || !inside(px, py - 1) || !inside(px, py + 1)) {
        points.push(px + 0.5, py + 0.5);
      }
    }
  }
  return points;
}

type AtlasTexture = {
  frame: { x: number; y: number; width: number; height: number };
  source: { resource?: unknown };
};
type AtlasPage = { data: Uint8ClampedArray; width: number };

const atlasPages = new WeakMap<object, AtlasPage | null>();
const glyphInkCache = new Map<string, number[] | null>();

/** RGBA pixels of a texture's whole atlas page, read once through a 2D canvas. `null` when the
 *  runtime can't do it (no canvas, no image resource, cross-origin taint). */
function readAtlasPage(texture: AtlasTexture): AtlasPage | null {
  const source = texture.source;
  if (!source) return null;
  if (atlasPages.has(source)) return atlasPages.get(source) ?? null;
  let page: AtlasPage | null = null;
  try {
    const resource = source.resource as CanvasImageSource | undefined;
    if (resource) {
      const w = (resource as { width: number }).width;
      const h = (resource as { height: number }).height;
      const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
      if (ctx) {
        ctx.drawImage(resource, 0, 0);
        page = { data: ctx.getImageData(0, 0, w, h).data, width: w };
      }
    }
  } catch {
    page = null;
  }
  atlasPages.set(source, page);
  return page;
}

/** Ink boundary of one glyph in atlas units relative to the glyph's quad origin, or `null` when the
 *  atlas pixels aren't readable or the glyph has no ink. */
function glyphInk(family: string, ch: string, texture: AtlasTexture): number[] | null {
  const key = `${family}:${ch}`;
  if (glyphInkCache.has(key)) return glyphInkCache.get(key) ?? null;
  const page = readAtlasPage(texture);
  const points = page ? inkBoundaryPoints(page.data, page.width, texture.frame) : [];
  const result = points.length > 0 ? points : null;
  glyphInkCache.set(key, result);
  return result;
}

/** The label's ink outline as flat `[x, y, ...]` atlas-unit points relative to the label's drawn
 *  origin (`makeCenteredLabel`: `anchor 0.5` centres horizontally on the advance box, the pivot
 *  centres vertically on the quads' extent), plus the atlas base font size they are measured at.
 *  `null` when any glyph's ink is unavailable — callers fall back to the bounding rectangle. */
function textInk(text: string, fontWeight: LabelFontWeight): { points: number[]; base: number } | null {
  const family = msdfFontFamily(fontWeight);
  const font = Cache.get<AbstractBitmapFont<unknown>>(`${family}-bitmap`);
  if (!font) return null;
  const raw: number[] = [];
  let cursor = 0;
  let minTop = Infinity;
  let maxBottom = -Infinity;
  for (const ch of Array.from(text)) {
    const glyph = font.chars[ch];
    if (!glyph) continue;
    if (glyph.texture) {
      const ink = glyphInk(family, ch, glyph.texture as unknown as AtlasTexture);
      if (!ink) return null;
      for (let i = 0; i < ink.length; i += 2) raw.push(cursor + glyph.xOffset + ink[i], glyph.yOffset + ink[i + 1]);
      minTop = Math.min(minTop, glyph.yOffset);
      maxBottom = Math.max(maxBottom, glyph.yOffset + glyph.texture.orig.height);
    }
    cursor += glyph.xAdvance;
  }
  if (raw.length === 0) return null;
  const cx = cursor / 2;
  const cy = (minTop + maxBottom) / 2;
  const points = raw.map((v, i) => v - (i % 2 === 0 ? cx : cy));
  return { points, base: font.baseMeasurementFontSize };
}

/** Whether every ink point, scaled by `scale`, lies inside `shape` of circle-equivalent radius `r`. */
function inkInShape(shape: MarkerShape, r: number, points: number[], scale: number): boolean {
  if (shape === "circle") {
    const r2 = r * r + 1e-9;
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i] * scale, y = points[i + 1] * scale;
      if (x * x + y * y > r2) return false;
    }
    return true;
  }
  const outline = markerPolygonPoints(shape, 0, 0, r);
  for (let i = 0; i < points.length; i += 2) {
    if (!pointInPolygon(points[i] * scale, points[i + 1] * scale, outline)) return false;
  }
  return true;
}

function itemMargin(item: TextFitItem): number {
  return Math.max(item.margin ?? DEFAULT_TEXT_MARGIN, 0);
}

/** Radius of the shape the ink must stay inside: the plate's circle-equivalent radius less the
 *  text margin. */
function plateRadius(item: TextFitItem): number {
  return Math.max(item.plateSize / 2 - itemMargin(item), 0);
}

/** Half extents of a rectangular plate (margin applied), or `null` for a shaped plate. */
function plateHalfExtents(item: TextFitItem): { hw: number; hh: number } | null {
  if (item.plateWidth === undefined || item.plateHeight === undefined) return null;
  if (item.plateShape === "parallelogram") return null;
  const margin = itemMargin(item);
  return { hw: Math.max(item.plateWidth / 2 - margin, 0), hh: Math.max(item.plateHeight / 2 - margin, 0) };
}

function parallelogramInnerHalfExtents(item: TextFitItem): { hw: number; hh: number } | null {
  if (item.plateWidth === undefined || item.plateHeight === undefined || item.plateShape !== "parallelogram") return null;
  const width = Math.max(item.plateWidth - itemMargin(item) * 2, 0);
  const height = Math.max(item.plateHeight - itemMargin(item) * 2, 0);
  const skew = Math.min(height * 0.45, width * 0.2);
  // Use the narrowest horizontal slice of the plate. This is deliberately stricter than checking
  // only the text's current y-coordinates: BitmapText's ink pivot can differ by a few pixels from
  // the metric box, and the label must remain clear of both slanted sides in that case too.
  return { hw: Math.max(width / 2 - skew, 0), hh: height / 2 };
}

/** Whether `item` drawn at `fontSize` px exceeds its plate shape. */
export function textOverflows(item: TextFitItem, fontSize: number): boolean {
  if (item.text.length === 0) return false;
  const ink = textInk(item.text, item.fontWeight);
  if (ink) return !inkFitsPlate(item, ink.points, fontSize / ink.base);
  const extent = measureText(item.text, item.fontWeight, fontSize);
  return !extentFitsPlate(item, extent.width, extent.height);
}

/** Whether every ink point, scaled by `scale`, lies inside the item's plate. */
function inkFitsPlate(item: TextFitItem, points: number[], scale: number): boolean {
  const parallelogram = parallelogramInnerHalfExtents(item);
  if (parallelogram) {
    for (let i = 0; i < points.length; i += 2) {
      if (Math.abs(points[i] * scale) > parallelogram.hw + 1e-9 || Math.abs(points[i + 1] * scale) > parallelogram.hh + 1e-9) return false;
    }
    return true;
  }
  const half = plateHalfExtents(item);
  if (!half) return inkInShape(item.shape, plateRadius(item), points, scale);
  for (let i = 0; i < points.length; i += 2) {
    if (Math.abs(points[i] * scale) > half.hw + 1e-9 || Math.abs(points[i + 1] * scale) > half.hh + 1e-9) return false;
  }
  return true;
}

/** Whether a `width` x `height` centred rectangle lies inside the item's plate. */
function extentFitsPlate(item: TextFitItem, width: number, height: number): boolean {
  const parallelogram = parallelogramInnerHalfExtents(item);
  if (parallelogram) {
    return width / 2 <= parallelogram.hw + 1e-9 && height / 2 <= parallelogram.hh + 1e-9;
  }
  const half = plateHalfExtents(item);
  if (!half) return rectInShape(item.shape, plateRadius(item), width, height);
  return width / 2 <= half.hw + 1e-9 && height / 2 <= half.hh + 1e-9;
}

/** Upper bound of the bisection range: any scale beyond it overflows regardless of shape. */
function plateReach(item: TextFitItem): number {
  if (item.plateShape === "parallelogram" && item.plateWidth !== undefined && item.plateHeight !== undefined) {
    return Math.max(item.plateWidth, item.plateHeight) / 2;
  }
  const half = plateHalfExtents(item);
  return half ? Math.max(half.hw, half.hh) : plateRadius(item);
}

/** Largest scale `k` such that the probe rectangle scaled by `k` still fits (bisection — fitting is
 *  monotonic in `k` for a shape containing its own centre). */
function maxFitScale(item: TextFitItem, width: number, height: number): number {
  let lo = 0;
  let hi = (4 * plateReach(item)) / Math.max(width, height);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (extentFitsPlate(item, width * mid, height * mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Largest font size (px, floored to `TEXT_SIZE_RANGE.step`, clamped to its range) at which every
 *  item fits its plate. `null` when there is nothing to fit. Items that can never fit even at the
 *  range minimum resolve to the minimum. */
export function maxFittingFontSize(items: readonly TextFitItem[], range: { min: number; max: number; step: number } = TEXT_SIZE_RANGE): number | null {
  let best = Infinity;
  // Identical labels (one elevator badge per floor target, many markers) fit identically.
  const seen = new Set<string>();
  for (const item of items) {
    if (item.text.length === 0) continue;
    const key = `${item.text}|${item.fontWeight}|${item.shape}|${item.plateSize}|${item.plateWidth}|${item.plateHeight}|${item.plateShape}|${itemMargin(item)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reachLimit = plateReach(item);
    const ink = textInk(item.text, item.fontWeight);
    if (ink) {
      let reach = 0;
      for (const v of ink.points) reach = Math.max(reach, Math.abs(v));
      if (reach <= 0) continue;
      let lo = 0;
      let hi = (4 * reachLimit) / reach;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (inkFitsPlate(item, ink.points, mid)) lo = mid;
        else hi = mid;
      }
      best = Math.min(best, lo * ink.base);
      continue;
    }
    const probeSize = 100;
    const extent = measureText(item.text, item.fontWeight, probeSize);
    if (extent.width <= 0 || extent.height <= 0) continue;
    best = Math.min(best, probeSize * maxFitScale(item, extent.width, extent.height));
  }
  if (!Number.isFinite(best)) return null;
  const { min, max, step } = range;
  const snapped = Math.floor(best / step + 1e-9) * step;
  return Math.min(Math.max(snapped, min), max);
}

/** Required rectangular plate dimensions for every label in `items` at the supplied font size.
 *  The largest measured glyph extent across all floors wins; the text margin is added on both
 *  sides. This is intentionally based on glyph metrics rather than character count, so Roman
 *  `VIII` and `X` receive their actual widths. */
export function requiredTextPlateDimensions(items: readonly TextFitItem[], fontSize: number): { width: number; height: number } | null {
  let width = 0;
  let height = 0;
  let found = false;
  for (const item of items) {
    if (!item.text) continue;
    const extent = measureText(item.text, item.fontWeight, fontSize);
    if (extent.width <= 0 || extent.height <= 0) continue;
    const margin = item.margin ?? DEFAULT_TEXT_MARGIN;
    const baseWidth = extent.width + margin * 2;
    const baseHeight = extent.height + margin * 2;
    if (item.plateShape === "parallelogram") {
      // The renderer skews the top/bottom edges by min(height * .45, width * .2). The usable
      // centre width is therefore width - skew, so solve that dependency before rounding.
      let requiredWidth = baseWidth;
      for (let i = 0; i < 8; i++) {
        const skew = Math.min(baseHeight * 0.45, requiredWidth * 0.2);
        requiredWidth = baseWidth + skew * 2;
      }
      width = Math.max(width, requiredWidth);
    } else {
      width = Math.max(width, baseWidth);
    }
    height = Math.max(height, baseHeight);
    found = true;
  }
  return found ? { width: Math.ceil(width), height: Math.ceil(height) } : null;
}
