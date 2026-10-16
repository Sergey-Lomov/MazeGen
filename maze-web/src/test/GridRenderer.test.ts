import { describe, expect, it, vi } from "vitest";

const pixi = vi.hoisted(() => ({
  graphics: [] as Array<{ clear: ReturnType<typeof vi.fn> }>,
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

vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number, cfg: { tessellation: { kind: string } }): [number, number] =>
    fakeCellCenter(x, y, cfg.tessellation.kind),
}));

import {
  GridRenderer,
  MAX_VIEWPORT_GRID_CELLS,
  shouldRenderViewportGrid,
  viewportGridCellCount,
} from "../pixi/renderers/GridRenderer";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeCellCenter } from "./cellCentersFake";

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

  it("reuses geometry while panning inside the same grid bounds, but redraws for zoom", () => {
    pixi.graphics.length = 0;
    const renderer = new GridRenderer({ addChild: vi.fn() } as never);
    const cfg = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });
    const graphics = pixi.graphics[0];

    renderer.render({ viewport: { x: 0, y: 0, w: 100, h: 100, scale: 1 } }, cfg);
    renderer.render({ viewport: { x: -1, y: -1, w: 100, h: 100, scale: 1 } }, cfg);
    expect(graphics.clear).toHaveBeenCalledOnce();

    renderer.render({ viewport: { x: -1, y: -1, w: 100, h: 100, scale: 1.1 } }, cfg);
    expect(graphics.clear).toHaveBeenCalledTimes(2);
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
