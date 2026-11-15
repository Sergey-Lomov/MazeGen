import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TEXTURE_PIXELS, MAX_TEXTURE_SIDE, MAX_TOTAL_PIXELS, SETTLE_MS, ZOOM_LEVELS, beginCanvasLabelScale, canvasLabelResolution,
  endCanvasLabelScale, levelFor, noteFontSelected, registerCanvasLabel, resetCanvasLabelResolution, setCanvasLabelView,
  textureResolutionCap, type CanvasLabel,
} from "../pixi/renderers/canvasLabelResolution";

const ratio = () => Math.max(1, window.devicePixelRatio || 1);
const STAGE = { parent: null };

interface FakeLabel extends CanvasLabel { destroy(): void }

/** A label at `x`, `y` (screen pixels) in the scene stage, as wide as the texture's logical size. */
function makeLabel(x: number, y: number, width = 50, height = 20, parent: { parent: unknown } | null = STAGE): FakeLabel {
  let onDestroy: (() => void) | null = null;
  const label: FakeLabel = {
    resolution: canvasLabelResolution(width, height),
    destroyed: false,
    parent,
    getBounds: () => ({ minX: x, minY: y, maxX: x + width, maxY: y + height }),
    once: (_event, listener) => { onDestroy = listener; },
    destroy: () => { label.destroyed = true; onDestroy?.(); },
  };
  registerCanvasLabel(label, width, height);
  return label;
}

const settle = () => vi.advanceTimersByTime(SETTLE_MS + 1);

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

  it("never needs more pixels than the screen can show", () => {
    const cap = textureResolutionCap(100, 20, 400, 300);
    expect(100 * cap).toBeLessThanOrEqual(400 + 1e-9);
    expect(20 * cap).toBeLessThanOrEqual(300 + 1e-9);
  });

  it("builds a new label at the base level", () => {
    setCanvasLabelView(STAGE, 8, 1000, 800);
    expect(canvasLabelResolution(50, 20)).toBeCloseTo(ratio(), 6);
  });

  it("raises only the visible labels to the zoom level", () => {
    setCanvasLabelView(STAGE, 3, 1000, 800);
    const inside = makeLabel(100, 100);
    const outside = makeLabel(5000, 5000);
    settle();
    expect(inside.resolution).toBeCloseTo(3 * ratio(), 6);
    expect(outside.resolution).toBeCloseTo(ratio(), 6);
  });

  it("drops a label back to the base level when it leaves the screen", () => {
    setCanvasLabelView(STAGE, 3, 1000, 800);
    const label = makeLabel(100, 100);
    settle();
    expect(label.resolution).toBeGreaterThan(ratio());
    label.getBounds = () => ({ minX: 9000, minY: 9000, maxX: 9050, maxY: 9020 });
    setCanvasLabelView(STAGE, 3, 1000, 800);
    settle();
    expect(label.resolution).toBeCloseTo(ratio(), 6);
  });

  it("never allocates a huge texture at an extreme zoom", () => {
    setCanvasLabelView(STAGE, 120, 1000, 800);
    const label = makeLabel(10, 10, 300, 60);
    settle();
    const resolution = label.resolution as number;
    expect(300 * resolution).toBeLessThanOrEqual(MAX_TEXTURE_SIDE + 1e-6);
    expect(300 * resolution * 60 * resolution).toBeLessThanOrEqual(MAX_TEXTURE_PIXELS + 1e-3);
    expect(300 * resolution).toBeLessThanOrEqual(1000 * ratio() + 1e-6);
  });

  it("shares one pixel budget: labels get a lower density instead of more memory", () => {
    setCanvasLabelView(STAGE, 120, 4000, 4000);
    const labels = Array.from({ length: 200 }, (_, i) => makeLabel(10 + (i % 20) * 10, 10 + Math.floor(i / 20) * 10, 400, 100));
    settle();
    const total = labels.reduce((sum, l) => sum + 400 * 100 * (l.resolution as number) ** 2, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_PIXELS + 1);
    for (const label of labels) expect(label.resolution as number).toBeGreaterThanOrEqual(ratio() - 1e-6);
  });

  it("builds at the exact zoom of the selection (344%), not a stepped one", () => {
    setCanvasLabelView(STAGE, 3.44, 1000, 800);
    noteFontSelected();
    const label = makeLabel(100, 100);
    settle();
    expect(label.resolution).toBeCloseTo(3.44 * ratio(), 6);
  });

  it("leaves a label outside the scene (a preview) as built", () => {
    setCanvasLabelView(STAGE, 3, 1000, 800);
    const elsewhere = makeLabel(100, 100, 50, 20, { parent: { parent: null } });
    settle();
    expect(elsewhere.resolution).toBeCloseTo(ratio(), 6);
  });

  it("does not touch a destroyed label", () => {
    setCanvasLabelView(STAGE, 3, 1000, 800);
    const gone = makeLabel(100, 100);
    gone.destroy();
    settle();
    expect(gone.resolution).toBeCloseTo(ratio(), 6);
  });

  it("manages a label again when it returns to the scene after being detached", () => {
    setCanvasLabelView(STAGE, 3, 1000, 800);
    const label = makeLabel(100, 100);
    label.parent = null;
    settle();
    expect(label.resolution).toBeCloseTo(ratio(), 6);
    label.parent = STAGE;
    setCanvasLabelView(STAGE, 3, 1000, 800);
    settle();
    expect(label.resolution).toBeCloseTo(3 * ratio(), 6);
  });

  it("holds labels built before the first view sync until the scene is known", () => {
    const label = makeLabel(100, 100);
    settle();
    expect(label.resolution).toBeCloseTo(ratio(), 6);
    setCanvasLabelView(STAGE, 3, 1000, 800);
    settle();
    expect(label.resolution).toBeCloseTo(3 * ratio(), 6);
  });

  it("debounces a burst of view changes into one pass", () => {
    setCanvasLabelView(STAGE, 1, 1000, 800);
    const label = makeLabel(100, 100);
    const spy = vi.spyOn(label, "getBounds");
    for (const zoom of [1.2, 2.2, 3.2, 4.2]) setCanvasLabelView(STAGE, zoom, 1000, 800);
    vi.advanceTimersByTime(SETTLE_MS - 10);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("uses the export scale while an export renders", () => {
    beginCanvasLabelScale(2.5);
    expect(canvasLabelResolution(50, 20)).toBeCloseTo(2.5, 9);
    endCanvasLabelScale();
    expect(canvasLabelResolution(50, 20)).not.toBeCloseTo(2.5, 9);
  });
});
