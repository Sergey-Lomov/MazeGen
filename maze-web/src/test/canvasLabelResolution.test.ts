import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TEXTURE_PIXELS, MAX_TEXTURE_SIDE, SETTLE_MS, ZOOM_LEVELS, beginCanvasLabelScale, canvasLabelResolution, endCanvasLabelScale,
  levelFor, noteFontSelected, resetCanvasLabelResolution, setCanvasLabelZoom, textureResolutionCap,
} from "../pixi/renderers/canvasLabelResolution";

const listen = () => {
  const handler = vi.fn();
  window.addEventListener("mazegen:label-font-loaded", handler);
  return { handler, off: () => window.removeEventListener("mazegen:label-font-loaded", handler) };
};

describe("canvas label resolution", () => {
  beforeEach(() => { vi.useFakeTimers(); resetCanvasLabelResolution(); });
  afterEach(() => { vi.useRealTimers(); resetCanvasLabelResolution(); });

  it("snaps a zoom up to the next fixed level", () => {
    expect(levelFor(0.3, null)).toBe(1);
    expect(levelFor(1.2, null)).toBe(1.5);
    expect(levelFor(2.5, null)).toBe(3);
    expect(levelFor(4, null)).toBe(4);
  });

  it("continues geometrically past the last level, so a huge zoom still steps", () => {
    const level = levelFor(120, null);
    expect(level).toBeGreaterThanOrEqual(120);
    expect(level).toBeLessThan(120 * 1.5 + 1e-6);
    expect(levelFor(5, null)).toBeGreaterThan(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
  });

  it("treats the exact zoom of the selection as an extra level", () => {
    expect(levelFor(3.44, 3.44)).toBeCloseTo(3.44, 9);
    expect(levelFor(3.2, 3.44)).toBeCloseTo(3.44, 9);
    expect(levelFor(3.5, 3.44)).toBe(4);
  });

  it("bounds the texture by side and by pixel count", () => {
    expect(textureResolutionCap(100, 20)).toBeCloseTo(MAX_TEXTURE_SIDE / 100, 9);
    const cap = textureResolutionCap(800, 800);
    expect(800 * cap * 800 * cap).toBeLessThanOrEqual(MAX_TEXTURE_PIXELS + 1e-3);
  });

  it("never allocates a huge texture at an extreme zoom", () => {
    setCanvasLabelZoom(120);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    const width = 300;
    const height = 60;
    const resolution = canvasLabelResolution(width, height);
    expect(width * resolution).toBeLessThanOrEqual(MAX_TEXTURE_SIDE + 1e-6);
    expect(width * resolution * height * resolution).toBeLessThanOrEqual(MAX_TEXTURE_PIXELS + 1e-3);
  });

  it("builds at the exact zoom of the selection (344%), not a stepped one", () => {
    setCanvasLabelZoom(3.44);
    noteFontSelected();
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(canvasLabelResolution(50, 20)).toBeCloseTo(3.44 * Math.max(1, window.devicePixelRatio || 1), 6);
  });

  it("builds quickly at the base level while a selection is settling, then asks for a rebuild", () => {
    setCanvasLabelZoom(3);
    const { handler, off } = listen();
    noteFontSelected();
    expect(canvasLabelResolution(50, 20)).toBeCloseTo(Math.max(1, window.devicePixelRatio || 1), 6);
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(handler).toHaveBeenCalledTimes(1);
    off();
  });

  it("rebuilds after a zoom change only when the level changed and canvas labels exist", () => {
    const { handler, off } = listen();
    setCanvasLabelZoom(2);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(handler).not.toHaveBeenCalled(); // no canvas label was ever built
    canvasLabelResolution(50, 20);
    setCanvasLabelZoom(2.4);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(handler).toHaveBeenCalledTimes(1);
    canvasLabelResolution(50, 20);
    setCanvasLabelZoom(2.6); // same level (3)
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(handler).toHaveBeenCalledTimes(1);
    off();
  });

  it("debounces a burst of zoom changes into one rebuild", () => {
    const { handler, off } = listen();
    canvasLabelResolution(50, 20);
    for (const zoom of [1.2, 2.2, 3.2, 4.2]) setCanvasLabelZoom(zoom);
    vi.advanceTimersByTime(SETTLE_MS - 10);
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(handler).toHaveBeenCalledTimes(1);
    off();
  });

  it("uses the export scale while an export renders", () => {
    beginCanvasLabelScale(2.5);
    expect(canvasLabelResolution(50, 20)).toBeCloseTo(2.5, 9);
    endCanvasLabelScale();
    expect(canvasLabelResolution(50, 20)).not.toBeCloseTo(2.5, 9);
  });
});
