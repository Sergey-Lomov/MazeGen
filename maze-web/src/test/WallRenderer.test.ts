import { describe, it, expect, vi } from "vitest";

vi.mock("../wasm/wasmLoader", () => ({
  getWasm: () => ({
    // Square tessellation's cartesian projection is the identity — see squareGeometry.ts's doc
    // comment on squareCenter.
    cartesian_coords: (config: { points: [number, number][] }) => config.points,
  }),
}));

vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    clear() { this.calls = []; return this; }
  }
  class FakeContainer {
    addChild() {}
    destroy() {}
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

const { WallRenderer } = await import("../pixi/renderers/WallRenderer");
const { Container, Graphics } = await import("pixi.js");
import type { WallEdge } from "../pixi/renderers/types";

const squareCfg = { type: "square" as const, width: 3, height: 3 };

// Two solid edges sharing a vertex: (0,0)-(1,0)'s east wall and (1,0)-(1,1)'s south wall meet at
// the cell corner between them, forming an ordinary corridor corner.
function cornerEdges(): WallEdge[] {
  return [
    { a: [0, 0], b: [1, 0], kind: "none", style: "solid" },
    { a: [1, 0], b: [1, 1], kind: "none", style: "solid" },
  ];
}

describe("WallRenderer.render", () => {
  it("without a style override, draws each solid edge as its own isolated stroke (no vertex-chaining) — preserves every other feature-renderer's exact prior look", () => {
    const renderer = new WallRenderer(new Container());
    renderer.render({ edges: cornerEdges() }, squareCfg);
    const g = (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;

    const strokeCalls = g.calls.filter((c) => c.fn === "stroke");
    // One stroke() per edge — never merged into a single chained path.
    expect(strokeCalls).toHaveLength(2);
  });

  it("with a style override, chains the two corner edges into one continuous path (single stroke call) so the join renders", () => {
    const renderer = new WallRenderer(new Container());
    renderer.render({ edges: cornerEdges() }, squareCfg, { color: 0x123456, width: 5, join: "miter", cap: "square" });
    const g = (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;

    const strokeCalls = g.calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(1);
    expect(strokeCalls[0].args[0]).toMatchObject({ color: 0x123456, width: 5, join: "miter", cap: "square" });

    // moveTo once, lineTo for each of the remaining chained points (3-point path -> 2 lineTo).
    const moveToCalls = g.calls.filter((c) => c.fn === "moveTo");
    const lineToCalls = g.calls.filter((c) => c.fn === "lineTo");
    expect(moveToCalls).toHaveLength(1);
    expect(lineToCalls).toHaveLength(2);
  });

  it("with a style override, an isolated (non-chainable) solid edge still draws as its own single-segment stroke", () => {
    const renderer = new WallRenderer(new Container());
    const isolated: WallEdge[] = [{ a: [0, 0], b: [1, 0], kind: "none", style: "solid" }];
    renderer.render({ edges: isolated }, squareCfg, { join: "miter", cap: "square" });
    const g = (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;

    expect(g.calls.filter((c) => c.fn === "stroke")).toHaveLength(1);
  });
});
