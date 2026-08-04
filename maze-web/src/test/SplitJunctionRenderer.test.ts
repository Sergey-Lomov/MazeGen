import { describe, it, expect, vi } from "vitest";

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

const { SplitJunctionRenderer } = await import("../pixi/renderers/SplitJunctionRenderer");
const { Container, Graphics } = await import("pixi.js");

// Two wallFaces sharing a vertex — an ordinary corner, chainable when a style override is given.
const wallFaces = [
  { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } },
  { v0: { x: 10, y: 0 }, v1: { x: 10, y: 10 } },
];

function graphicsOf(renderer: InstanceType<typeof SplitJunctionRenderer>) {
  return (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;
}

describe("SplitJunctionRenderer.render wallFaces", () => {
  it("without a style override, draws each wallFace as its own isolated stroke", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [], wallFaces });
    const strokeCalls = graphicsOf(renderer).calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(2);
  });

  it("with a style override, chains wallFaces sharing a vertex into one continuous stroked path", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [], wallFaces }, { color: 0xabcdef, width: 4, join: "miter", cap: "square" });
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(1);
    expect(strokeCalls[0].args[0]).toMatchObject({ color: 0xabcdef, width: 4, join: "miter", cap: "square" });
  });
});

const passage = (pointKey: string, color: number) => ({
  color,
  pointKey,
  wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 0 }, isUndefined: false }],
  connectors: [{ from: { x: 5, y: 0 }, to: { x: 5, y: 5 }, isUndefined: false }],
});

const bridgeShape = {
  kind: "bridge" as const,
  pointKey: "0,0",
  crossFaces: [{ v0: { x: 10, y: 0 }, v1: { x: 30, y: 0 } }, { v0: { x: 10, y: 40 }, v1: { x: 30, y: 40 } }] as [
    { v0: { x: number; y: number }; v1: { x: number; y: number } },
    { v0: { x: number; y: number }; v1: { x: number; y: number } },
  ],
  edge0: [{ x: 10, y: 0 }, { x: 14, y: 8 }, { x: 14, y: 32 }, { x: 10, y: 40 }] as [
    { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number },
  ],
  edge1: [{ x: 30, y: 0 }, { x: 26, y: 8 }, { x: 26, y: 32 }, { x: 30, y: 40 }] as [
    { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number },
  ],
};

const diagonalShape = {
  kind: "diagonal" as const,
  pointKey: "1,1",
  corner0: { x: 0, y: 0 },
  corner1: { x: 40, y: 40 },
};

describe("SplitJunctionRenderer.render special shapes", () => {
  it("defaults on (no splitStyleOverride at all) — a recognized point's ordinary passage is skipped and the bridge shape draws instead, matching every non-VectorByWalls feature-renderer that never passes an override", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [passage("0,0", 0xaaaaaa)], wallFaces: [], specialShapes: [bridgeShape] });
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    // Bridge: 2 edges (left/right of the cross corridor); the ordinary passage (0,0)'s own
    // segment/connector must not appear at all.
    expect(strokeCalls).toHaveLength(2);
    expect(strokeCalls.every((c) => (c.args[0] as { color: number }).color !== 0xaaaaaa)).toBe(true);
  });

  it("explicit specialShapes: false opts a caller out — ordinary passages draw and special shapes are ignored", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [passage("0,0", 0xaaaaaa)], wallFaces: [], specialShapes: [bridgeShape] },
      undefined,
      { specialShapes: false },
    );
    const calls = graphicsOf(renderer).calls;
    // 1 wall segment + 1 connector = 2 strokes, no special-shape draw calls beyond that.
    expect(calls.filter((c) => c.fn === "stroke")).toHaveLength(2);
    expect(calls.some((c) => c.fn === "stroke" && (c.args[0] as { color: number }).color === 0xaaaaaa)).toBe(true);
  });

  it("with specialShapes on, a recognized point's ordinary passage is skipped and the bridge shape draws its 2 cross edges in wall color", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [passage("0,0", 0xaaaaaa)], wallFaces: [], specialShapes: [bridgeShape] },
      undefined,
      { specialShapes: true },
    );
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    // Bridge: 2 edges (left/right of the cross corridor); the ordinary passage (0,0)'s own
    // segment/connector must not appear at all, and neither edge uses the node's own color.
    expect(strokeCalls).toHaveLength(2);
    expect(strokeCalls.every((c) => (c.args[0] as { color: number }).color !== 0xaaaaaa)).toBe(true);
  });

  it("diagonal shape draws one straight stroke corner-to-corner, in wall color", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [], wallFaces: [], specialShapes: [diagonalShape] },
      undefined,
      { specialShapes: true },
    );
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(1);
    const moveTo = calls.find((c) => c.fn === "moveTo")!;
    const lineTo = calls.find((c) => c.fn === "lineTo")!;
    expect(moveTo.args).toEqual([0, 0]);
    expect(lineTo.args).toEqual([40, 40]);
  });

  it("a caller-supplied wallFaceStyleOverride's color/width/join apply to special shapes, but cap is always forced to 'butt'", () => {
    // A special shape's free ends already sit exactly on the tile's own face boundary — a round
    // or square cap would protrude past it into the neighboring tile/wall, regardless of what the
    // caller's own wall style asks for.
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [], wallFaces: [], specialShapes: [diagonalShape] },
      { color: 0xabcdef, width: 5, join: "miter", cap: "square" },
      { specialShapes: true },
    );
    const strokeCalls = graphicsOf(renderer).calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls[0].args[0]).toMatchObject({ color: 0xabcdef, width: 5, join: "miter", cap: "butt" });
  });

  it("with specialShapes on, an unrelated point's ordinary passage still draws normally", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [passage("5,5", 0xaaaaaa)], wallFaces: [], specialShapes: [bridgeShape] },
      undefined,
      { specialShapes: true },
    );
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    // 2 for the bridge + 2 (segment/connector) for the unrelated point's ordinary passage.
    expect(strokeCalls).toHaveLength(4);
    expect(strokeCalls.some((c) => (c.args[0] as { color: number }).color === 0xaaaaaa)).toBe(true);
  });
});
