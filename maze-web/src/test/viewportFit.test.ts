import { describe, it, expect } from "vitest";
import { fitViewportToCenters } from "../pixi/viewportFit";

describe("fitViewportToCenters", () => {
  it("returns a centered, scale-1 fallback for an empty center list", () => {
    expect(fitViewportToCenters([], 800, 600)).toEqual({ x: 400, y: 300, scale: 1 });
  });

  it("places a single point at screen center, still scaled to fit its own tile-padded bounding box", () => {
    // `mazeBounds` pads the box by `TILE_SIZE` on every side even for one point, so this isn't the
    // degenerate `W<=0`/`H<=0` fallback — it's a small, real box symmetric around the point, so the
    // point itself lands exactly at screen center regardless of the resulting scale.
    const { x, y, scale } = fitViewportToCenters([{ x: 5, y: 5 }], 800, 600);
    expect(scale).toBeGreaterThan(0);
    expect(x + scale * 5).toBeCloseTo(400);
    expect(y + scale * 5).toBeCloseTo(300);
  });

  it("centers the bounding box's own midpoint on the screen's own midpoint", () => {
    const { x, y } = fitViewportToCenters([{ x: -10, y: -10 }, { x: 10, y: 10 }], 800, 600);
    expect(x).toBeCloseTo(400);
    expect(y).toBeCloseTo(300);
  });

  it("scales down to fit the wider of the two screen dimensions' own padded constraint", () => {
    // A very wide, short bounding box is constrained by screen width, not height.
    const wide = fitViewportToCenters([{ x: -1000, y: 0 }, { x: 1000, y: 0 }], 800, 600);
    // A very tall, narrow bounding box is constrained by screen height, not width.
    const tall = fitViewportToCenters([{ x: 0, y: -1000 }, { x: 0, y: 1000 }], 800, 600);
    expect(wide.scale).toBeLessThan(1);
    expect(tall.scale).toBeLessThan(1);
    expect(wide.scale).not.toBeCloseTo(tall.scale);
  });
});
