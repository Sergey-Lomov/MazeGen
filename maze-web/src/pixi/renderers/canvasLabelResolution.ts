/** Texture density of canvas-drawn labels (GitHub issues #966, #1003). A label in a font that has no MSDF atlas
 *  yet (a font being previewed, or one whose atlas is still being built, or whose conversion is off) is a pixi
 *  `Text` whose canvas texture must match the on-screen size. Every label is built at the cheap base level
 *  (the device pixel ratio). Once the view settles, only the labels that intersect the screen are raised to
 *  the zoom level, snapped to a few levels so a zoom gesture does not rebuild every label. The raise is
 *  bounded per texture (side, pixel count, and what the screen can show) and by one pixel budget shared by all
 *  labels: when it runs out, labels get a lower density instead of more memory. */

/** Zoom levels a texture is built for. Beyond the last one the levels continue geometrically. */
export const ZOOM_LEVELS = [1, 1.5, 2, 3, 4];
const LEVEL_GROWTH = 1.5;

/** Longest side of a label texture, in pixels. */
export const MAX_TEXTURE_SIDE = 2048;
/** Pixel count of a label texture (4 MB of RGBA). */
export const MAX_TEXTURE_PIXELS = 1024 * 1024;
/** Pixel count of all canvas label textures together (128 MB of RGBA). */
export const MAX_TOTAL_PIXELS = 32 * 1024 * 1024;
const MIN_RESOLUTION = 0.5;

/** Wait after the last view change or font selection before the visible labels are raised to full quality. */
export const SETTLE_MS = 150;

/** What a managed label must offer: the part of a pixi `Text` this module touches. */
export interface CanvasLabel {
  resolution: number | null;
  destroyed: boolean;
  parent: { parent: unknown } | null;
  getBounds(): { minX: number; minY: number; maxX: number; maxY: number };
  once(event: "destroyed", listener: () => void): unknown;
}

interface ManagedLabel {
  label: CanvasLabel;
  width: number;
  height: number;
}

let zoom = 1;
/** The exact zoom at the moment the font was last selected: an extra level, so the label is sharp right
 *  where the user chose it, whatever the zoom (344%, say). */
let selectionZoom: number | null = null;
let stage: unknown = null;
let screenWidth = 0;
let screenHeight = 0;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
/** An export renders at its own scale: pixels per logical pixel, overriding zoom and device ratio. */
let pixelScaleOverride: number | null = null;
const managed = new Set<ManagedLabel>();

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

/** Highest resolution a `width` x `height` label may be rasterized at: within the texture bounds, and never
 *  with more pixels than the screen (`viewWidth` x `viewHeight` device pixels, when known) can show. */
export function textureResolutionCap(width: number, height: number, viewWidth = 0, viewHeight = 0): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  let cap = Math.min(MAX_TEXTURE_SIDE / Math.max(w, h), Math.sqrt(MAX_TEXTURE_PIXELS / (w * h)));
  if (viewWidth > 0 && viewHeight > 0) cap = Math.min(cap, viewWidth / w, viewHeight / h);
  return cap;
}

function viewCap(width: number, height: number): number {
  const ratio = deviceRatio();
  return textureResolutionCap(width, height, screenWidth * ratio, screenHeight * ratio);
}

function clampResolution(wanted: number, width: number, height: number): number {
  return Math.max(MIN_RESOLUTION, Math.min(wanted, viewCap(width, height)));
}

const pixelsOf = (m: ManagedLabel, resolution: number) => m.width * m.height * resolution * resolution;

/** Resolution a new canvas label of `width` x `height` logical pixels is built at: the cheap base level, or
 *  the export scale while an export renders. Raising the visible labels is `applyQuality`. */
export function canvasLabelResolution(width: number, height: number): number {
  if (pixelScaleOverride !== null) return Math.max(MIN_RESOLUTION, Math.min(pixelScaleOverride, textureResolutionCap(width, height)));
  return clampResolution(deviceRatio(), width, height);
}

/** Puts a freshly built canvas label under the shared quality management. */
export function registerCanvasLabel(label: CanvasLabel, width: number, height: number): void {
  const entry: ManagedLabel = { label, width, height };
  managed.add(entry);
  label.once("destroyed", () => managed.delete(entry));
  scheduleSettle();
}

function rootOf(label: CanvasLabel): unknown {
  let node: { parent: unknown } = label as unknown as { parent: unknown };
  while (node.parent) node = node.parent as { parent: unknown };
  return node;
}

function setResolution(label: CanvasLabel, resolution: number): void {
  if (label.resolution === null || Math.abs(label.resolution - resolution) > 1e-6) label.resolution = resolution;
}

/** Applies the quality plan: every label of the live scene drops to the base level, then the visible ones are
 *  raised to the zoom level while the shared pixel budget lasts. Labels outside the scene (a preview, an
 *  export) are left as built; they leave the registry when destroyed. */
function applyQuality(): void {
  // No scene yet: labels built before the first view sync wait for it.
  if (stage === null) return;
  const live: ManagedLabel[] = [];
  for (const entry of managed) {
    if (entry.label.destroyed) managed.delete(entry);
    // Detached from the scene for now (a hidden layer): kept, so it is managed again once it is back.
    else if (rootOf(entry.label) === stage) live.push(entry);
  }
  const base = new Map<ManagedLabel, number>();
  let left = MAX_TOTAL_PIXELS;
  for (const entry of live) {
    const resolution = clampResolution(deviceRatio(), entry.width, entry.height);
    base.set(entry, resolution);
    left -= pixelsOf(entry, resolution);
  }
  const target = levelFor(zoom) * deviceRatio();
  const raised = new Map<ManagedLabel, number>();
  for (const entry of live) {
    const baseResolution = base.get(entry)!;
    if (!visible(entry.label)) continue;
    let resolution = Math.max(baseResolution, clampResolution(target, entry.width, entry.height));
    const extra = pixelsOf(entry, resolution) - pixelsOf(entry, baseResolution);
    if (extra > left) resolution = Math.sqrt((pixelsOf(entry, baseResolution) + Math.max(0, left)) / (entry.width * entry.height));
    left -= Math.max(0, pixelsOf(entry, resolution) - pixelsOf(entry, baseResolution));
    raised.set(entry, Math.max(baseResolution, resolution));
  }
  for (const entry of live) setResolution(entry.label, raised.get(entry) ?? base.get(entry)!);
}

function visible(label: CanvasLabel): boolean {
  const bounds = label.getBounds();
  return bounds.maxX >= 0 && bounds.maxY >= 0 && bounds.minX <= screenWidth && bounds.minY <= screenHeight;
}

function scheduleSettle(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    applyQuality();
  }, SETTLE_MS);
}

/** The view changed (zoom, pan or resize) over the scene `sceneStage`. Visible labels are raised once it settles. */
export function setCanvasLabelView(sceneStage: unknown, nextZoom: number, width: number, height: number): void {
  stage = sceneStage;
  zoom = nextZoom;
  screenWidth = width;
  screenHeight = height;
  if (managed.size > 0) scheduleSettle();
}

/** A font was selected in a picker: remember the exact zoom, so the label is sharp right where it was chosen. */
export function noteFontSelected(): void {
  selectionZoom = zoom;
  if (managed.size > 0) scheduleSettle();
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
  stage = null;
  screenWidth = 0;
  screenHeight = 0;
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  pixelScaleOverride = null;
  managed.clear();
}
