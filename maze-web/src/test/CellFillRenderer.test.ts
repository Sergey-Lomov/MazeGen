import { describe, it, expect, vi } from "vitest";

vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    private record(fn: string, args: unknown[]) { this.calls.push({ fn, args }); return this; }
    moveTo(...args: unknown[]) { return this.record("moveTo", args); }
    lineTo(...args: unknown[]) { return this.record("lineTo", args); }
    arcTo(...args: unknown[]) { return this.record("arcTo", args); }
    stroke(...args: unknown[]) { return this.record("stroke", args); }
    poly(...args: unknown[]) { return this.record("poly", args); }
    roundPoly(...args: unknown[]) { return this.record("roundPoly", args); }
    closePath(...args: unknown[]) { return this.record("closePath", args); }
    fill(...args: unknown[]) { return this.record("fill", args); }
    clear() { this.calls = []; return this; }
  }
  class FakeContainer {
    addChild() {}
    destroy() {}
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

const { CellFillRenderer } = await import("../pixi/renderers/CellFillRenderer");
const { Container } = await import("pixi.js");
import { fieldOf } from "./fieldConfigFixtures";

const squareCfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
const cells: [number, number][] = [[0, 0], [1, 0], [2, 0]];

function callsOf(renderer: InstanceType<typeof CellFillRenderer>): { fn: string; args: unknown[] }[] {
  return (renderer as unknown as { g: { calls: { fn: string; args: unknown[] }[] } }).g.calls;
}

describe("CellFillRenderer.render", () => {
  it("fills a plain group (no inset, no border) with one path and one fill instruction", () => {
    const renderer = new CellFillRenderer(new Container());
    renderer.render({ cells, color: 0x123456, alpha: 0.5 }, squareCfg);
    const calls = callsOf(renderer);

    const fills = calls.filter((c) => c.fn === "fill");
    expect(fills).toHaveLength(1);
    expect(fills[0].args[0]).toMatchObject({ color: 0x123456, alpha: 0.5 });
    // One closed subpath per cell, the fill comes last.
    expect(calls.filter((c) => c.fn === "closePath")).toHaveLength(cells.length);
    expect(calls[calls.length - 1].fn).toBe("fill");
  });

  it("draws nothing for an empty plain group", () => {
    const renderer = new CellFillRenderer(new Container());
    renderer.render({ cells: [], color: 0xffffff, alpha: 1 }, squareCfg);
    expect(callsOf(renderer)).toHaveLength(0);
  });

  it("keeps a separate fill per group", () => {
    const renderer = new CellFillRenderer(new Container());
    renderer.render([
      { cells: [[0, 0]], color: 0xff0000, alpha: 1 },
      { cells: [[1, 0], [2, 0]], color: 0x00ff00, alpha: 1 },
    ], squareCfg);
    const fills = callsOf(renderer).filter((c) => c.fn === "fill");
    expect(fills.map((f) => (f.args[0] as { color: number }).color)).toEqual([0xff0000, 0x00ff00]);
  });

  it("does not batch a group with an inset: each cell is drawn on its own", () => {
    const renderer = new CellFillRenderer(new Container());
    renderer.render({ cells, color: 0x123456, alpha: 1, inset: 2 }, squareCfg);
    const fills = callsOf(renderer).filter((c) => c.fn === "fill");
    expect(fills).toHaveLength(cells.length);
  });

  it("does not batch a group with a border: each cell gets its own fill and stroke", () => {
    const renderer = new CellFillRenderer(new Container());
    renderer.render({ cells, color: 0x123456, alpha: 1, borderWidth: 3 }, squareCfg);
    const calls = callsOf(renderer);
    expect(calls.filter((c) => c.fn === "fill")).toHaveLength(cells.length);
    expect(calls.filter((c) => c.fn === "stroke")).toHaveLength(cells.length);
  });
});
