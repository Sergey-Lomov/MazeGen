/** Tiny imperative bridge (same shape as `viewportScaleBridge.ts`) exposing the live Pixi canvas
 * to `ColorPickerPanel`'s eyedropper (GitHub issue #507) — the panel is reached through
 * `ColorRow` → `ColorSwatch` → `ColorPickerPanel` with no scene access, so a canvas-bound sampler
 * can't be prop-drilled the way `onExportPng` is. `App.tsx` registers the sampler once the scene's
 * `app.canvas` exists; the panel reads it only while actively sampling (not reactively). */

export interface PixelRegion {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  /** Index (within this region, not canvas-wide) of the actually-sampled pixel — equal to
   *  `radiusPx` unless the region was clamped near a canvas edge, in which case it shifts with
   *  the clamp. Use this instead of assuming the geometric center. */
  centerX: number;
  centerY: number;
}

export interface ColorSampler {
  /** The on-screen Pixi canvas element — used only to resolve its screen rect (for hit-testing
   *  and coordinate conversion). Its own WebGL buffer is not `preserveDrawingBuffer`, so it can't
   *  be `drawImage`'d directly (reads back blank/black outside the render tick) — the loupe reads
   *  pixels through `sampleRegion` instead, same as the click sample. */
  canvas: HTMLCanvasElement;
  /** Reads the pixel color at the given client (viewport) coordinates via the renderer's
   *  `extract.pixels()`, or `null` when the point falls outside the canvas. Packed 24-bit RGB,
   *  same representation as every other color in the picker. */
  sampleAt: (clientX: number, clientY: number) => number | null;
  /** Reads a small square region of raw RGBA pixels around the given client coordinates, for the
   *  eyedropper's magnified loupe — `radiusPx` whole canvas-physical pixels on each side of the
   *  sampled pixel, so the region is `2*radiusPx + 1` pixels wide/tall with the sampled pixel
   *  exactly centered. `null` outside the canvas. */
  sampleRegion: (clientX: number, clientY: number, radiusPx: number) => PixelRegion | null;
}

let sampler: ColorSampler | null = null;

export function setColorSampler(next: ColorSampler | null): void {
  sampler = next;
}

export function getColorSampler(): ColorSampler | null {
  return sampler;
}
