import { describe, expect, it, vi } from "vitest";

const pixi = vi.hoisted(() => ({ graphics: [] as Array<Record<string, ReturnType<typeof vi.fn>>> }));

vi.mock("pixi.js", () => {
  class FakeGraphics {
    clear = vi.fn(() => this);
    poly = vi.fn(() => this);
    fill = vi.fn(() => this);
    stroke = vi.fn(() => this);
    moveTo = vi.fn(() => this);
    lineTo = vi.fn(() => this);
    destroy = vi.fn();

    constructor() {
      pixi.graphics.push(this as never);
    }
  }
  return { Graphics: FakeGraphics, Container: class {} };
});

import { GlueTabRenderer } from "../pixi/renderers/GlueTabRenderer";
import { glueTabOn } from "../pixi/imageExport/glueTabExport";
import { DEFAULT_GLUE_TAB_STYLE } from "../store/slices/imageExportDefaults";
import type { GlueTabStyle } from "../store/imageExportTypes";

const tabs = [glueTabOn([0, 0], [100, 0], [0, -1], { inset: 10, width: 20 })!];

function draw(patch: Partial<GlueTabStyle>) {
  const container = { addChild: vi.fn() };
  const renderer = new GlueTabRenderer(container as never);
  const g = pixi.graphics[pixi.graphics.length - 1];
  renderer.render(tabs, { ...DEFAULT_GLUE_TAB_STYLE, showTabs: true, ...patch });
  return g;
}

describe("GlueTabRenderer", () => {
  it("strokes nothing at zero outline thickness", () => {
    const g = draw({ lineWidth: 0 });
    expect(g.fill).toHaveBeenCalledTimes(1);
    expect(g.stroke).not.toHaveBeenCalled();
  });

  it("strokes the three sides away from the maze when solid, never the base", () => {
    const g = draw({ lineWidth: 2, lineStyle: "solid" });
    expect(g.stroke).toHaveBeenCalledWith(expect.objectContaining({ width: 2, color: DEFAULT_GLUE_TAB_STYLE.lineColor }));
    const [a, b, c, d] = tabs[0];
    expect(g.moveTo).toHaveBeenCalledWith(b[0], b[1]);
    expect(g.lineTo.mock.calls).toEqual([[c[0], c[1]], [d[0], d[1]], [a[0], a[1]]]);
  });

  it("keeps dashes off the base when dashed", () => {
    const g = draw({ lineWidth: 2, lineStyle: "dashed" });
    const alongBase = g.moveTo.mock.calls.some((from, i) => from[1] === 0 && g.lineTo.mock.calls[i][1] === 0);
    expect(alongBase).toBe(false);
  });

  it("strokes separate dashes when dashed", () => {
    const g = draw({ lineWidth: 2, lineStyle: "dashed" });
    expect(g.stroke).toHaveBeenCalledTimes(1);
    expect(g.moveTo.mock.calls.length).toBeGreaterThan(4);
  });

  it("draws nothing without tabs", () => {
    const container = { addChild: vi.fn() };
    const renderer = new GlueTabRenderer(container as never);
    const g = pixi.graphics[pixi.graphics.length - 1];
    renderer.render([], DEFAULT_GLUE_TAB_STYLE);
    expect(g.clear).toHaveBeenCalled();
    expect(g.fill).not.toHaveBeenCalled();
  });
});
