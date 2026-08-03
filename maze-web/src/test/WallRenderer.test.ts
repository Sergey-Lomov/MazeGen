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
    poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
    roundPoly(...args: unknown[]) { this.calls.push({ fn: "roundPoly", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
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
import type { WallEdge, OneWayStyleOverride } from "../pixi/renderers/types";

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

  it("draws a one-way indicator (roundPoly triangle, bordered) for an edge with oneWayDir, even without a style override", () => {
    const renderer = new WallRenderer(new Container());
    const oneWayEdges: WallEdge[] = [{ a: [0, 0], b: [1, 0], kind: "forward", style: "solid", oneWayDir: { dx: 1, dy: 0 } }];
    renderer.render({ edges: oneWayEdges }, squareCfg);
    const g = (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;

    const roundPolyCalls = g.calls.filter((c) => c.fn === "roundPoly");
    // One roundPoly call for the fill, one for the border stroke (GitHub issue #292 follow-up:
    // the default look always has a border, so both passes always run).
    expect(roundPolyCalls).toHaveLength(2);
    const strokeAfterFill = g.calls.filter((c) => c.fn === "stroke");
    expect(strokeAfterFill.length).toBeGreaterThan(0);
    expect(strokeAfterFill[strokeAfterFill.length - 1].args[0]).toMatchObject({ width: 3 });
  });

  it("draws walls before the one-way indicator so the indicator renders on top", () => {
    const renderer = new WallRenderer(new Container());
    const oneWayEdges: WallEdge[] = [{ a: [0, 0], b: [1, 0], kind: "forward", style: "solid", oneWayDir: { dx: 1, dy: 0 } }];
    renderer.render({ edges: oneWayEdges }, squareCfg);
    const g = (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;

    const wallStrokeIndex = g.calls.findIndex((c) => c.fn === "stroke");
    const roundPolyIndex = g.calls.findIndex((c) => c.fn === "roundPoly");
    expect(wallStrokeIndex).toBeGreaterThanOrEqual(0);
    expect(roundPolyIndex).toBeGreaterThan(wallStrokeIndex);
  });

  it("dispatches to the chevron/arrow pattern instead of the triangle when the override says so", () => {
    const renderer = new WallRenderer(new Container());
    const oneWayEdges: WallEdge[] = [{ a: [0, 0], b: [1, 0], kind: "forward", style: "solid", oneWayDir: { dx: 1, dy: 0 } }];
    const chevronStyle: OneWayStyleOverride = {
      pattern: "chevron", color: 0x1, borderColor: 0x2, borderWidth: 0, size: 10, thickness: 4, join: "round", cap: "round",
    };
    renderer.render({ edges: oneWayEdges }, squareCfg, undefined, chevronStyle);
    const g = (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;

    // Chevron draws via moveTo/lineTo/stroke, never roundPoly/poly/fill.
    expect(g.calls.filter((c) => c.fn === "roundPoly")).toHaveLength(0);
    expect(g.calls.filter((c) => c.fn === "poly")).toHaveLength(0);
    expect(g.calls.filter((c) => c.fn === "fill")).toHaveLength(0);
    expect(g.calls.filter((c) => c.fn === "stroke").length).toBeGreaterThan(0);
  });

  it("passes the override's color/size/thickness/join/cap through to the triangle pattern", () => {
    const renderer = new WallRenderer(new Container());
    const oneWayEdges: WallEdge[] = [{ a: [0, 0], b: [1, 0], kind: "forward", style: "solid", oneWayDir: { dx: 1, dy: 0 } }];
    const triangleStyle: OneWayStyleOverride = {
      pattern: "triangle", color: 0xaaaaaa, borderColor: 0xbbbbbb, borderWidth: 5, size: 30, thickness: 4, join: "miter", cap: "square",
    };
    renderer.render({ edges: oneWayEdges }, squareCfg, undefined, triangleStyle);
    const g = (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;

    const [fillCall] = g.calls.filter((c) => c.fn === "fill");
    expect(fillCall.args[0]).toBe(0xaaaaaa);
    const strokeCalls = g.calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls[strokeCalls.length - 1].args[0]).toMatchObject({ width: 5, color: 0xbbbbbb, join: "miter" });
  });
});
