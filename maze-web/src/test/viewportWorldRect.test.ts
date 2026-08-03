import { describe, it, expect } from "vitest";
import { viewportWorldRect } from "../pixi/imageExport/VectorByWallsRenderer";

describe("viewportWorldRect", () => {
  it("identity viewport (no pan/zoom) maps to itself", () => {
    // `-0 / 1 === -0`, distinct from `+0` under `toEqual` — assert numerically instead.
    const rect = viewportWorldRect({ x: 0, y: 0, w: 800, h: 600, scale: 1 });
    // `-0 / scale === -0`, which `toBe`/`toEqual` treat as distinct from `+0` (Object.is
    // semantics) — `=== 0` is true for both, and that's the only distinction that matters here.
    expect(rect.x === 0).toBe(true);
    expect(rect.y === 0).toBe(true);
    expect(rect.w).toBe(800);
    expect(rect.h).toBe(600);
  });

  it("panned viewport — world origin is the inverse of the screen-space pan offset", () => {
    // Panning the scene right/down by (100, 50) at scale 1 means the world-space top-left
    // visible is (-100, -50) — this is the exact bug fixed in GitHub issue #289 (raw x/y were
    // used directly instead of negated).
    expect(viewportWorldRect({ x: 100, y: 50, w: 800, h: 600, scale: 1 })).toEqual({ x: -100, y: -50, w: 800, h: 600 });
  });

  it("zoomed-in viewport — width/height shrink in world space, pan offset divides by scale too", () => {
    expect(viewportWorldRect({ x: 200, y: 100, w: 800, h: 600, scale: 2 })).toEqual({ x: -100, y: -50, w: 400, h: 300 });
  });

  it("zoomed-out viewport — width/height grow in world space", () => {
    const rect = viewportWorldRect({ x: 0, y: 0, w: 800, h: 600, scale: 0.5 });
    // `-0 / scale === -0`, which `toBe`/`toEqual` treat as distinct from `+0` (Object.is
    // semantics) — `=== 0` is true for both, and that's the only distinction that matters here.
    expect(rect.x === 0).toBe(true);
    expect(rect.y === 0).toBe(true);
    expect(rect.w).toBe(1600);
    expect(rect.h).toBe(1200);
  });
});
