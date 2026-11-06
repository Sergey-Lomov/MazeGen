import { describe, expect, it, vi } from "vitest";

const pixi = vi.hoisted(() => ({
  graphics: [] as Array<{ clear: ReturnType<typeof vi.fn>; moveTo: ReturnType<typeof vi.fn> }>,
}));

vi.mock("pixi.js", () => {
  class FakeGraphics {
    clear = vi.fn(() => this);
    setStrokeStyle = vi.fn(() => this);
    moveTo = vi.fn(() => this);
    lineTo = vi.fn(() => this);
    stroke = vi.fn(() => this);
    destroy = vi.fn();

    constructor() {
      pixi.graphics.push(this);
    }
  }

  return { Graphics: FakeGraphics };
});

import {
  GridRenderer,
  MAX_VIEWPORT_GRID_CELLS,
  shouldRenderViewportGrid,
  VIEWPORT_GRID_REBUILD_DELAY_MS,
  viewportGridMaxChordAngle,
  viewportGridCellCount,
} from "../pixi/renderers/GridRenderer";
import { fieldOf } from "./fieldConfigFixtures";
import { cellsInDisplayRect, getCellVertices, gridEdgesNearDisplayRect } from "../pixi/tessellationGeometry";

describe("viewport grid density", () => {
  it("counts the inclusive viewport bounds", () => {
    expect(viewportGridCellCount({ minX: -1, maxX: 1, minY: 2, maxY: 3 })).toBe(6);
  });

  it("renders a normal viewport grid", () => {
    expect(shouldRenderViewportGrid({ minX: 0, maxX: 199, minY: 0, maxY: 199 })).toBe(true);
  });

  it("suppresses an impractically dense zoomed-out grid", () => {
    const width = 251;
    const height = Math.ceil(MAX_VIEWPORT_GRID_CELLS / width) + 1;
    const bounds = { minX: 0, maxX: width - 1, minY: 0, maxY: height - 1 };

    expect(viewportGridCellCount(bounds)).toBeGreaterThan(MAX_VIEWPORT_GRID_CELLS);
    expect(shouldRenderViewportGrid(bounds)).toBe(false);
  });

  it("reduces curve detail only while zoomed out", () => {
    expect(viewportGridMaxChordAngle(1)).toBeCloseTo(Math.PI / 16);
    expect(viewportGridMaxChordAngle(0.5)).toBeCloseTo(Math.PI / 8);
    expect(viewportGridMaxChordAngle(0.01)).toBeCloseTo(Math.PI / 4);
  });

  it("reuses geometry while panning inside the same grid bounds, then rebuilds after zoom settles", () => {
    vi.useFakeTimers();
    pixi.graphics.length = 0;
    const renderer = new GridRenderer({ addChild: vi.fn() } as never);
    const cfg = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });
    const graphics = pixi.graphics[0];

    renderer.render({ viewport: { x: -5, y: -5, w: 100, h: 100, scale: 1 } }, cfg);
    renderer.render({ viewport: { x: -6, y: -6, w: 100, h: 100, scale: 1 } }, cfg);
    expect(graphics.clear).toHaveBeenCalledOnce();

    renderer.render({ viewport: { x: -6, y: -6, w: 100, h: 100, scale: 1.1 } }, cfg);
    expect(graphics.clear).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(VIEWPORT_GRID_REBUILD_DELAY_MS);
    expect(graphics.clear).toHaveBeenCalledTimes(2);
    renderer.destroy();
    vi.useRealTimers();
  });

  it("coalesces repeated viewport rebuilds until navigation becomes idle", () => {
    vi.useFakeTimers();
    pixi.graphics.length = 0;
    const renderer = new GridRenderer({ addChild: vi.fn() } as never);
    const cfg = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });
    const graphics = pixi.graphics[0];

    renderer.render({ viewport: { x: 0, y: 0, w: 100, h: 100, scale: 1 } }, cfg);
    renderer.render({ viewport: { x: 0, y: 0, w: 100, h: 100, scale: 1.1 } }, cfg);
    vi.advanceTimersByTime(VIEWPORT_GRID_REBUILD_DELAY_MS - 1);
    renderer.render({ viewport: { x: 0, y: 0, w: 100, h: 100, scale: 1.2 } }, cfg);
    vi.advanceTimersByTime(VIEWPORT_GRID_REBUILD_DELAY_MS - 1);
    expect(graphics.clear).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(graphics.clear).toHaveBeenCalledTimes(2);

    renderer.destroy();
    vi.useRealTimers();
  });

  it("reuses geometry for a pan inside the drawn margin and rebuilds after a pan leaves it", () => {
    vi.useFakeTimers();
    pixi.graphics.length = 0;
    const renderer = new GridRenderer({ addChild: vi.fn() } as never);
    const cfg = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });
    const graphics = pixi.graphics[0];
    const size = { w: 1000, h: 1000, scale: 1 };

    renderer.render({ viewport: { x: 0, y: 0, ...size } }, cfg);
    renderer.render({ viewport: { x: -150, y: -150, ...size } }, cfg);
    expect(graphics.clear).toHaveBeenCalledOnce();

    renderer.render({ viewport: { x: -500, y: 0, ...size } }, cfg);
    expect(graphics.clear).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(VIEWPORT_GRID_REBUILD_DELAY_MS);
    expect(graphics.clear).toHaveBeenCalledTimes(2);
    renderer.destroy();
    vi.useRealTimers();
  });

  it("draws explicit cells once regardless of panning and redraws for a different cell set", () => {
    pixi.graphics.length = 0;
    const renderer = new GridRenderer({ addChild: vi.fn() } as never);
    const cfg = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });
    const graphics = pixi.graphics[0] as unknown as { clear: ReturnType<typeof vi.fn>; moveTo: ReturnType<typeof vi.fn> };
    const cells: [number, number][] = [[0, 0], [1, 0]];
    const size = { w: 100, h: 100, scale: 1 };

    renderer.render({ viewport: { x: 0, y: 0, ...size } }, cfg, cells);
    expect(graphics.moveTo).toHaveBeenCalled();
    renderer.render({ viewport: { x: -5000, y: -5000, ...size } }, cfg, cells);
    expect(graphics.clear).toHaveBeenCalledOnce();

    renderer.render({ viewport: { x: 0, y: 0, ...size } }, cfg, [[0, 0]]);
    expect(graphics.clear).toHaveBeenCalledTimes(2);
    renderer.destroy();
  });

  it("renders a Cairo viewport without touching lattice coordinates that are not cells", () => {
    pixi.graphics.length = 0;
    const renderer = new GridRenderer({ addChild: vi.fn() } as never);
    const cfg = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });

    expect(() => renderer.render({ viewport: { x: 1400, y: 1300, w: 800, h: 600, scale: 1 } }, cfg)).not.toThrow();
    renderer.destroy();
  });

  it("keeps every cell of the viewport drawn after a pan that reuses the geometry", () => {
    pixi.graphics.length = 0;
    const renderer = new GridRenderer({ addChild: vi.fn() } as never);
    const cfg = fieldOf("hex", { shape: "hexagon", radius: 6 }, "flat_top");
    const graphics = pixi.graphics[0] as unknown as { clear: ReturnType<typeof vi.fn>; moveTo: ReturnType<typeof vi.fn> };
    const size = { w: 300, h: 200, scale: 1 };

    renderer.render({ viewport: { x: -100, y: -100, ...size } }, cfg);
    renderer.render({ viewport: { x: -103, y: -102, ...size } }, cfg);
    expect(graphics.clear).toHaveBeenCalledOnce();

    const drawn = new Set(graphics.moveTo.mock.calls.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`));
    const visible = cellsInDisplayRect({ minX: 103, maxX: 403, minY: 102, maxY: 302 }, "intersects", cfg);
    expect(visible.length).toBeGreaterThan(0);
    for (const [x, y] of visible) {
      const last = getCellVertices(x, y, cfg)[0];
      expect(drawn.has(`${Math.round(last.x)},${Math.round(last.y)}`)).toBe(true);
    }
    renderer.destroy();
  });

  it("clears dense grid geometry once and keeps it suppressed during further panning", () => {
    pixi.graphics.length = 0;
    const renderer = new GridRenderer({ addChild: vi.fn() } as never);
    const cfg = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });
    const graphics = pixi.graphics[0];

    renderer.render({ viewport: { x: 0, y: 0, w: 1_000_000, h: 1_000_000, scale: 1 } }, cfg);
    renderer.render({ viewport: { x: -1, y: -1, w: 1_000_000, h: 1_000_000, scale: 1 } }, cfg);

    expect(graphics.clear).toHaveBeenCalledOnce();
    renderer.destroy();
  });
});

describe("gridEdgesNearDisplayRect", () => {
  const strokes = (chunks: readonly (readonly { op: string }[])[]) => chunks.flat().filter((command) => command.op === "move_to").length;

  it("serves a repeated rectangle from the chunk cache", () => {
    const cfg = fieldOf("snub_hexagonal", { shape: "rect", cols: 3, rows: 3 });
    const rect = { minX: 100, maxX: 700, minY: -200, maxY: 300 };
    const first = gridEdgesNearDisplayRect(rect, cfg);
    expect(strokes(first)).toBeGreaterThan(0);
    expect(gridEdgesNearDisplayRect(rect, cfg)).toEqual(first);
    first.forEach((chunk, index) => expect(gridEdgesNearDisplayRect(rect, cfg)[index]).toBe(chunk));
  });

  it("strokes no edge twice within one chunk", () => {
    const cfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const [chunk] = gridEdgesNearDisplayRect({ minX: 10, maxX: 20, minY: 10, maxY: 20 }, cfg);
    const keys: string[] = [];
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const from = chunk[i], to = chunk[i + 1];
      if (from.op !== "move_to" || to.op !== "line_to") throw new Error("a square edge is one move and one line");
      const ends = [from.to, to.to].map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).sort();
      keys.push(ends.join("|"));
    }
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
