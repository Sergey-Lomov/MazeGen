import { LABEL_FONT_LOADED_EVENT } from "./fontChoice";

/** Texture density of canvas-drawn labels (GitHub issue #966). A label in a font that has no MSDF atlas yet
 *  (a font being previewed, or one whose atlas is still being built) is a pixi `Text` whose canvas texture
 *  must match the on-screen size: the density follows the viewport zoom and the device pixel ratio, snapped
 *  to a few levels so a zoom gesture does not rebuild every label, and bounded so a huge zoom never
 *  allocates a huge texture. */

/** Zoom levels a texture is built for. Beyond the last one the levels continue geometrically. */
export const ZOOM_LEVELS = [1, 1.5, 2, 3, 4];
const LEVEL_GROWTH = 1.5;

/** Longest side of a label texture, in pixels. */
export const MAX_TEXTURE_SIDE = 4096;
/** Pixel count of a label texture (16 MB of RGBA). */
export const MAX_TEXTURE_PIXELS = 2048 * 2048;
const MIN_RESOLUTION = 0.5;

/** Wait after the last zoom change or font selection before textures are rebuilt at full quality. */
export const SETTLE_MS = 150;

let zoom = 1;
/** The exact zoom at the moment the font was last selected: an extra level, so the label is sharp right
 *  where the user chose it, whatever the zoom (344%, say). */
let selectionZoom: number | null = null;
/** Set while a font selection or zoom change is still settling: labels are built at the quick level. */
let settling = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
/** An export renders at its own scale: pixels per logical pixel, overriding zoom and device ratio. */
let pixelScaleOverride: number | null = null;
/** Level the labels of the last build used, and whether any of them is canvas text. */
let builtLevel = 1;
let canvasLabelsBuilt = false;

function deviceRatio(): number {
  return typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
}

/** Smallest level at or above `target`: the fixed ones, the zoom of the last selection, then geometric ones. */
export function levelFor(target: number, extra: number | null = selectionZoom): number {
  const levels = extra === null ? ZOOM_LEVELS : [...ZOOM_LEVELS, extra].sort((a, b) => a - b);
  for (const level of levels) if (level >= target - 1e-9) return level;
  let level = levels[levels.length - 1];
  while (level < target - 1e-9) level *= LEVEL_GROWTH;
  return level;
}

/** Highest resolution a `width` x `height` label may be rasterized at without crossing the texture bounds. */
export function textureResolutionCap(width: number, height: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return Math.min(MAX_TEXTURE_SIDE / Math.max(w, h), Math.sqrt(MAX_TEXTURE_PIXELS / (w * h)));
}

function wantedLevel(): number {
  return settling ? 1 : levelFor(zoom);
}

/** Resolution for a canvas label of `width` x `height` logical pixels. Records the level, so a later zoom
 *  change knows whether the labels need rebuilding. */
export function canvasLabelResolution(width: number, height: number): number {
  canvasLabelsBuilt = true;
  if (pixelScaleOverride !== null) return Math.max(MIN_RESOLUTION, Math.min(pixelScaleOverride, textureResolutionCap(width, height)));
  builtLevel = wantedLevel();
  return Math.max(MIN_RESOLUTION, Math.min(builtLevel * deviceRatio(), textureResolutionCap(width, height)));
}

function rebuildLabels(): void {
  canvasLabelsBuilt = false;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LABEL_FONT_LOADED_EVENT));
}

function scheduleSettle(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    settling = false;
    if (canvasLabelsBuilt && builtLevel !== wantedLevel()) rebuildLabels();
  }, SETTLE_MS);
}

/** The viewport zoom changed. Canvas labels are rebuilt once it settles, and only when their level changed. */
export function setCanvasLabelZoom(next: number): void {
  if (next === zoom) return;
  zoom = next;
  if (!canvasLabelsBuilt) return;
  settling = true;
  scheduleSettle();
}

/** A font was selected in a picker: remember the exact zoom, and build the new font's labels quickly first
 *  so fast browsing stays responsive. They are rebuilt at full quality once selection stops. */
export function noteFontSelected(): void {
  selectionZoom = zoom;
  settling = true;
  scheduleSettle();
}

/** Renders canvas labels at `pixelScale` pixels per logical pixel until `endCanvasLabelScale` (an export). */
export function beginCanvasLabelScale(pixelScale: number): void {
  pixelScaleOverride = pixelScale;
}

export function endCanvasLabelScale(): void {
  pixelScaleOverride = null;
}

/** Test hook: back to the initial state. */
export function resetCanvasLabelResolution(): void {
  zoom = 1;
  selectionZoom = null;
  settling = false;
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  pixelScaleOverride = null;
  builtLevel = 1;
  canvasLabelsBuilt = false;
}
