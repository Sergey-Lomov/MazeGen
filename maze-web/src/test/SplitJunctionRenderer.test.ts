import { describe, it, expect, vi } from "vitest";

vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    circle(...args: unknown[]) { this.calls.push({ fn: "circle", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    closePath(...args: unknown[]) { this.calls.push({ fn: "closePath", args }); return this; }
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
  center: { x: 5, y: 5 },
  wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 0 }, isUndefined: false, atFaceStart: true, atFaceEnd: true }],
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
  throughLine: [{ x: 0, y: 20 }, { x: 40, y: 20 }] as [{ x: number; y: number }, { x: number; y: number }],
  throughColor: 0xaaaaaa,
  crossColor: 0xbbbbbb,
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

  it("a caller-supplied wallFaceStyleOverride's width applies to ordinary passages (segment and connector); color stays the node's own; connector cap is always forced to 'butt', wallSegment cap follows the caller since its lone share spans the whole (free-ended) face", () => {
    // GitHub issue #304: width was previously hardcoded to WALL_THICKNESS for ordinary
    // (non-special) passages, ignoring the caller's wall style entirely. GitHub issue #317: a
    // wallSegment end landing on the face's own real boundary (`atFaceStart`/`atFaceEnd`, both true
    // here since this node is alone on the face) has no neighboring sub-segment to butt against, so
    // it follows the caller's own cap instead of always "butt". The connector still has no such
    // concept (its outer end is always a hub or a shared face-division point) — always "butt".
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [passage("9,9", 0xaaaaaa)], wallFaces: [] },
      { color: 0xabcdef, width: 7, join: "miter", cap: "square" },
    );
    const strokeCalls = graphicsOf(renderer).calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(2);
    const [connectorStroke, segmentStroke] = strokeCalls;
    expect(connectorStroke.args[0]).toMatchObject({ color: 0xaaaaaa, width: 7, cap: "butt" });
    expect(segmentStroke.args[0]).toMatchObject({ color: 0xaaaaaa, width: 7, cap: "square" });
  });

  it("a node's own two wallSegments meeting at a shared angled vertex chain into one stroked path with the caller's join, instead of leaving a gap at butt-capped independent strokes", () => {
    // GitHub issue #304 follow-up: two adjacent faces of the same node (e.g. a hexagon's two
    // neighboring faces) meet at a tile vertex under an angle, not colinearly. Drawing them as two
    // independent butt-capped strokes opens a visible gap on the angle's outer side; chaining them
    // into one path lets the caller's `join` close it, same as `wallFaces` already does.
    const angledPassage = {
      color: 0xaaaaaa,
      pointKey: "3,3",
      center: { x: 5, y: 5 },
      wallSegments: [
        { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 0 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
        { v0: { x: 10, y: 0 }, v1: { x: 15, y: 8 }, center: { x: 12.5, y: 4 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
      ],
      connectors: [],
    };
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [angledPassage], wallFaces: [] },
      { color: 0xabcdef, width: 6, join: "miter", cap: "square" },
    );
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(1);
    expect(strokeCalls[0].args[0]).toMatchObject({ color: 0xaaaaaa, width: 6, join: "miter", cap: "butt" });
    expect(calls.filter((c) => c.fn === "moveTo")).toHaveLength(1);
    expect(calls.filter((c) => c.fn === "lineTo")).toHaveLength(2);
  });

  it("undefined wallSegments chain and stroke separately from defined ones, in the disabled color", () => {
    // The grouped-chaining loop splits a node's wallSegments into a defined group (passage.color)
    // and an undefined group (disabledColor), chaining each independently — this covers the
    // undefined branch, only exercised implicitly elsewhere.
    const mixedPassage = {
      color: 0xaaaaaa,
      pointKey: "7,7",
      center: { x: 5, y: 5 },
      wallSegments: [
        { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 0 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
        { v0: { x: 20, y: 0 }, v1: { x: 30, y: 0 }, center: { x: 25, y: 0 }, isUndefined: true, atFaceStart: false, atFaceEnd: false },
        { v0: { x: 30, y: 0 }, v1: { x: 35, y: 8 }, center: { x: 32.5, y: 4 }, isUndefined: true, atFaceStart: false, atFaceEnd: false },
      ],
      connectors: [],
    };
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [mixedPassage], wallFaces: [] }, { color: 0xabcdef, width: 6, join: "miter", cap: "square" });
    const strokeCalls = graphicsOf(renderer).calls.filter((c) => c.fn === "stroke");
    // 1 defined-group stroke (single segment) + 1 undefined-group stroke (two chained segments).
    expect(strokeCalls).toHaveLength(2);
    expect(strokeCalls[0].args[0]).toMatchObject({ color: 0xaaaaaa, width: 6, cap: "butt" });
    const disabledCall = strokeCalls[1].args[0] as { color: number };
    expect(disabledCall.color).not.toBe(0xaaaaaa);
    expect(strokeCalls[1].args[0]).toMatchObject({ width: 6, join: "miter", cap: "butt" });
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

  it("GitHub issue #317: a wallSegment's face-boundary free end gets a round cap patch while its internal-division end stays butt", () => {
    // Two nodes divide the same face: node A's share runs from the face's real start (a free end,
    // no neighbor sub-segment there) to the division point with node B (an internal end, always
    // butt). Only the free end should get a patched cap.
    const halfFacePassage = {
      color: 0xaaaaaa,
      pointKey: "4,4",
      center: { x: 5, y: 5 },
      wallSegments: [
        { v0: { x: 0, y: 0 }, v1: { x: 5, y: 0 }, center: { x: 2.5, y: 0 }, isUndefined: false, atFaceStart: true, atFaceEnd: false },
      ],
      connectors: [],
    };
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [halfFacePassage], wallFaces: [] });
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(1);
    // No override at all -> default free-end cap is "round" (mirrors wallFaces' own no-override cap).
    expect(strokeCalls[0].args[0]).toMatchObject({ cap: "butt" });
    const circleCalls = calls.filter((c) => c.fn === "circle");
    expect(circleCalls).toHaveLength(1);
    expect(circleCalls[0].args[0]).toBe(0);
    expect(circleCalls[0].args[1]).toBe(0);
  });

  it("GitHub issue #317: with a 'square' caller cap, the free end gets a square patch instead of a circle", () => {
    const halfFacePassage = {
      color: 0xaaaaaa,
      pointKey: "6,6",
      center: { x: 5, y: 5 },
      wallSegments: [
        { v0: { x: 0, y: 0 }, v1: { x: 5, y: 0 }, center: { x: 2.5, y: 0 }, isUndefined: false, atFaceStart: true, atFaceEnd: false },
      ],
      connectors: [],
    };
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [halfFacePassage], wallFaces: [] }, { cap: "square" });
    const calls = graphicsOf(renderer).calls;
    expect(calls.filter((c) => c.fn === "circle")).toHaveLength(0);
    expect(calls.filter((c) => c.fn === "closePath")).toHaveLength(1);
    const fillCalls = calls.filter((c) => c.fn === "fill");
    expect(fillCalls).toHaveLength(1);
    expect(fillCalls[0].args[0]).toBe(0xaaaaaa);
  });
});
