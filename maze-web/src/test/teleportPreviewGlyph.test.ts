import { describe, it, expect, vi } from "vitest";
import { DEFAULT_MAZE_RENDER_STYLE } from "../pixi/defaultMazeRenderStyle";
import { TILE_SIZE } from "../pixi/constants";
import { clipDistance } from "../pixi/renderers/teleportGeometry";

vi.mock("pixi.js", () => ({
  Graphics: vi.fn(),
}));

const { drawTeleportPreview } = await import("../pixi/renderers/teleportPreviewGlyph");

type Call = { fn: string; args: unknown[] };

/** Chainable Graphics spy that records every call in order. */
function makeGraphicsSpy() {
  const calls: Call[] = [];
  const g: Record<string, (...a: unknown[]) => unknown> = {};
  for (const fn of ["moveTo", "lineTo", "stroke", "fill", "circle", "poly", "roundRect", "rect", "arc", "arcTo", "quadraticCurveTo", "closePath"]) {
    g[fn] = (...args: unknown[]) => {
      calls.push({ fn, args });
      return g;
    };
  }
  return { g: g as unknown as import("pixi.js").Graphics, calls };
}

const style = DEFAULT_MAZE_RENDER_STYLE.teleport;

describe("drawTeleportPreview", () => {
  it("draws the floor-colored gap ring (dimmed) behind the marker when edgeGapWidth > 0", () => {
    expect(style.edgeGapWidth).toBeGreaterThan(0); // guards the branch under test
    const spy = makeGraphicsSpy();
    drawTeleportPreview(spy.g, 0, 0, 100, 0);

    const fills = spy.calls.filter((c) => c.fn === "fill").map((c) => c.args[0] as { color: number; alpha: number });
    expect(fills.some((f) => f.color === style.floorColor && f.alpha === 0.5)).toBe(true);
    // and the marker's own fill is still there
    expect(fills.some((f) => f.color === style.edgeColor && f.alpha === 0.5)).toBe(true);
  });

  it("clips the connector to the marker's full footprint (size + border + gap), not the bare fill radius", () => {
    const spy = makeGraphicsSpy();
    drawTeleportPreview(spy.g, 0, 0, 100, 0);

    const firstMove = spy.calls.find((c) => c.fn === "moveTo");
    expect(firstMove).toBeDefined();
    const r = style.size * TILE_SIZE;
    const outerR = r + style.borderWidth + style.edgeGapWidth;
    const expectedClip = clipDistance(1, 0, outerR, style.connectorWidth);
    expect(firstMove!.args[0] as number).toBeCloseTo(expectedClip);
    // sanity: the bare-fill-radius clip would be visibly smaller
    expect(expectedClip).toBeGreaterThan(clipDistance(1, 0, r, style.connectorWidth) + 1);
  });

  it("omits the connector entirely when the cursor is inside the marker footprint", () => {
    const spy = makeGraphicsSpy();
    drawTeleportPreview(spy.g, 0, 0, 2, 0); // 2px away — well inside outerR

    // No stroke with the connector color (the marker border stroke uses edgeBorderColor, which
    // here equals connectorColor, so assert on the absence of any moveTo/lineTo connector pair
    // reaching the cursor instead).
    const lineTos = spy.calls.filter((c) => c.fn === "lineTo").map((c) => c.args[0] as number);
    expect(lineTos.some((x) => x === 2)).toBe(false);
  });
});
