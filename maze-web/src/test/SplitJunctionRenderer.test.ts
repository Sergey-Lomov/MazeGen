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

const { SplitJunctionRenderer, collectSplitWallPaths } = await import("../pixi/renderers/SplitJunctionRenderer");
const { Container, Graphics } = await import("pixi.js");

// Two wallFaces sharing a vertex — an ordinary corner, chainable by WallRenderer once passed
// through as extraWalls.
const wallFaces = [
  { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } },
  { v0: { x: 10, y: 0 }, v1: { x: 10, y: 10 } },
];

function graphicsOf(renderer: InstanceType<typeof SplitJunctionRenderer>) {
  return (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;
}

// GitHub issue #319 follow-up: `SplitJunctionRenderer` no longer draws wallFaces/specialShapes
// itself — a feature-renderer collects their geometry via `collectSplitWallPaths` and feeds it to
// `WallRenderer.render`'s `extraWalls` param instead, so it joins with ordinary walls in
// `WallRenderer`'s own single `Graphics` stroke pass (a join can only render within one continuous
// stroke of a single `Graphics`, never across two independent ones).
describe("collectSplitWallPaths", () => {
  it("returns each wallFace as its own 2-point path, with no noCapPoints", () => {
    const { paths, noCapPoints } = collectSplitWallPaths(wallFaces, undefined);
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(paths).toContainEqual([{ x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(noCapPoints).toHaveLength(0);
  });

  it("returns a curved wallFace as its whole polyline", () => {
    const arc = [{ x: 0, y: 0 }, { x: 4, y: 3 }, { x: 10, y: 0 }];
    const { paths } = collectSplitWallPaths([{ v0: arc[0], v1: arc[2], polyline: arc }], undefined);
    expect(paths).toEqual([arc]);
  });

  it("includes a 'diagonal' special shape as its own corner-to-corner path", () => {
    const diagonal = { kind: "diagonal" as const, pointKey: "2,2", corner0: { x: 20, y: 10 }, corner1: { x: 30, y: 20 } };
    const { paths } = collectSplitWallPaths([], [diagonal]);
    expect(paths).toEqual([[{ x: 20, y: 10 }, { x: 30, y: 20 }]]);
  });

  it("uses a diagonal shape's explicit wallPath for a bent triple-corridor boundary", () => {
    const wallPath = [{ x: 0, y: 0 }, { x: 12, y: 10 }, { x: 30, y: 20 }];
    const diagonal = {
      kind: "diagonal" as const,
      pointKey: "2,2",
      corner0: wallPath[0],
      corner1: wallPath[2],
      wallPath,
    };
    const { paths } = collectSplitWallPaths([], [diagonal]);
    expect(paths).toEqual([wallPath]);
  });

  it("includes a 'bridge' special shape's edge0/edge1 as 2 separate 4-point paths", () => {
    const { paths } = collectSplitWallPaths([], [bridgeShape]);
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual(bridgeShape.edge0);
    expect(paths).toContainEqual(bridgeShape.edge1);
  });

  it("with includeSpecialShapes = false, omits special shapes but keeps wallFaces", () => {
    const diagonal = { kind: "diagonal" as const, pointKey: "2,2", corner0: { x: 20, y: 10 }, corner1: { x: 30, y: 20 } };
    const { paths } = collectSplitWallPaths(wallFaces, [diagonal], false);
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });

  it("a hex_triple_bridge point's earlier bridge edge is cut open where a later bridge's silhouette crosses it, and the cut's own new endpoints are reported as noCapPoints", () => {
    const earlier = bridgeShape;
    const later = {
      ...bridgeShape,
      // Silhouette crossing straight through the middle of `earlier`'s edge0/edge1 span (y: 0..40).
      edge0: [{ x: 5, y: 18 }, { x: 19, y: 18 }, { x: 19, y: 22 }, { x: 5, y: 22 }] as [
        { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number },
      ],
      edge1: [{ x: 35, y: 18 }, { x: 21, y: 18 }, { x: 21, y: 22 }, { x: 35, y: 22 }] as [
        { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number },
      ],
    };
    const { paths, noCapPoints } = collectSplitWallPaths([], [earlier, later]);
    // `earlier`'s 2 edges are cut open by the crossing later silhouette (no single path spans the
    // full original 4-point edge); `later`'s own 2 edges are untouched (nothing crosses it).
    expect(paths).not.toContainEqual(earlier.edge0);
    expect(paths).not.toContainEqual(earlier.edge1);
    expect(paths).toContainEqual(later.edge0);
    expect(paths).toContainEqual(later.edge1);
    // Every cut piece's own new endpoint (not one of `earlier`'s original 8 edge0/edge1 points) is
    // a synthetic intersection point — must never get a protruding cap in WallRenderer.
    expect(noCapPoints.length).toBeGreaterThan(0);
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

describe("SplitJunctionRenderer.render special shapes", () => {
  it("GitHub issue #893: a seam mirror of a special-shape point draws only while special shapes are off", () => {
    const mirror = { ...passage("9,9", 0xaaaaaa), mirrored: true, mirroredFromSpecial: true, connectors: [] };
    const strokes = (override?: { specialShapes: boolean }) => {
      const renderer = new SplitJunctionRenderer(new Container());
      renderer.render({ passages: [mirror], wallFaces: [], specialShapes: [bridgeShape] }, undefined, override);
      return graphicsOf(renderer).calls.filter((c) => c.fn === "stroke").length;
    };
    expect(strokes()).toBe(0);
    expect(strokes({ specialShapes: false })).toBeGreaterThan(0);
  });

  it("defaults on (no splitStyleOverride at all) — a recognized point's ordinary passage is skipped, matching every non-VectorByWalls feature-renderer that never passes an override", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [passage("0,0", 0xaaaaaa)], wallFaces: [], specialShapes: [bridgeShape] });
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    // The bridge shape itself is never drawn by this renderer (moved to WallRenderer via
    // collectSplitWallPaths) — only the ordinary passage (0,0) would draw, and it's skipped as a
    // recognized special point.
    expect(strokeCalls).toHaveLength(0);
  });

  it("explicit specialShapes: false opts a caller out — ordinary passages draw", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [passage("0,0", 0xaaaaaa)], wallFaces: [], specialShapes: [bridgeShape] },
      undefined,
      { specialShapes: false },
    );
    const calls = graphicsOf(renderer).calls;
    // 1 wall segment + 1 connector = 2 strokes.
    expect(calls.filter((c) => c.fn === "stroke")).toHaveLength(2);
    expect(calls.some((c) => c.fn === "stroke" && (c.args[0] as { color: number }).color === 0xaaaaaa)).toBe(true);
  });

  it("with specialShapes on, a recognized point's ordinary passage is skipped entirely", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [passage("0,0", 0xaaaaaa)], wallFaces: [], specialShapes: [bridgeShape] },
      undefined,
      { specialShapes: true },
    );
    const calls = graphicsOf(renderer).calls;
    expect(calls.filter((c) => c.fn === "stroke")).toHaveLength(0);
  });

  it("a caller-supplied wallFaceStyleOverride's width applies to ordinary passages (segment and connector); color stays the node's own; every cap is 'butt' under a sharp (miter) style, including a wallSegment's own free end", () => {
    // GitHub issue #304: width was previously hardcoded to WALL_THICKNESS for ordinary
    // (non-special) passages, ignoring the caller's wall style entirely. GitHub issue #317/#319
    // follow-up: a wallSegment end landing on the face's own real boundary (`atFaceStart`/
    // `atFaceEnd`, both true here since this node is alone on the face) has no neighboring
    // sub-segment to butt against, but under a sharp style it still stays "butt" — a protruding
    // cap has no shared join with whatever unrelated line meets it at that tile corner. This
    // passage has exactly one connector (the 2-share straight-line case, no hub) — both its ends
    // are division points, so it stays "butt" regardless of style either way.
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render(
      { passages: [passage("9,9", 0xaaaaaa)], wallFaces: [] },
      { color: 0xabcdef, width: 7, join: "miter", cap: "square" },
    );
    const strokeCalls = graphicsOf(renderer).calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(2);
    const [connectorStroke, segmentStroke] = strokeCalls;
    expect(connectorStroke.args[0]).toMatchObject({ color: 0xaaaaaa, width: 7, cap: "butt" });
    expect(segmentStroke.args[0]).toMatchObject({ color: 0xaaaaaa, width: 7, cap: "butt" });
  });

  it("GitHub issue #421: a hub fan-out connector's hub end always gets a round cap patch, while the stroke itself still draws 'butt' (its division-point end always stays butt)", () => {
    // A node with 3+ shares (or 0/1, or exactly 2 but not both plain passages) fans out from a hub
    // point never drawn on its own — `connectors.length > 1` is exactly this case. Each connector's
    // `from` is the hub (a genuine free end, nothing to butt against) and `to` is a shared
    // face-division point (still needs "butt"). Previously the hub end was always forced to "butt"
    // too, creating a visible sharp cut even when the caller's style was "round".
    const hubPassage = {
      color: 0xaaaaaa,
      pointKey: "4,4",
      center: { x: 5, y: 5 },
      wallSegments: [],
      connectors: [
        { from: { x: 5, y: 5 }, to: { x: 0, y: 0 }, isUndefined: false },
        { from: { x: 5, y: 5 }, to: { x: 10, y: 0 }, isUndefined: false },
        { from: { x: 5, y: 5 }, to: { x: 5, y: 10 }, isUndefined: false },
      ],
    };
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [hubPassage], wallFaces: [] }, { width: 7, cap: "round" });
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(3);
    for (const call of strokeCalls) expect(call.args[0]).toMatchObject({ cap: "butt" });

    const circleCalls = calls.filter((c) => c.fn === "circle");
    expect(circleCalls).toHaveLength(3);
    for (const call of circleCalls) expect(call.args).toEqual([5, 5, 3.5]);
  });

  it("GitHub issue #421 follow-up: with a 'square' caller cap, a hub fan-out connector's hub end still gets a round patch, not square — several connectors of the same node converge on the hub at arbitrary angles, and independent square patches there overlap into a visible star", () => {
    const hubPassage = {
      color: 0xaaaaaa,
      pointKey: "4,4",
      center: { x: 5, y: 5 },
      wallSegments: [],
      connectors: [
        { from: { x: 5, y: 5 }, to: { x: 0, y: 0 }, isUndefined: false },
        { from: { x: 5, y: 5 }, to: { x: 10, y: 0 }, isUndefined: false },
      ],
    };
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [hubPassage], wallFaces: [] }, { width: 7, cap: "square" });
    const calls = graphicsOf(renderer).calls;
    expect(calls.filter((c) => c.fn === "closePath")).toHaveLength(0);
    const circleCalls = calls.filter((c) => c.fn === "circle");
    expect(circleCalls).toHaveLength(2);
    for (const call of circleCalls) expect(call.args).toEqual([5, 5, 3.5]);
  });

  it("GitHub issue #421: a single (no-hub) connector never gets a hub-end cap patch, even with a round caller cap", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [passage("9,9", 0xaaaaaa)], wallFaces: [] }, { width: 7, cap: "round" });
    const calls = graphicsOf(renderer).calls;
    // This fixture's lone wallSegment is free-ended on both sides (drawn with the real cap
    // directly, no separate patch) — a circle here would only come from a (wrongly) patched
    // no-hub connector.
    expect(calls.filter((c) => c.fn === "circle")).toHaveLength(0);
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
    // 2 (segment/connector) for the unrelated point's ordinary passage; the bridge (pointKey "0,0")
    // itself is never drawn by this renderer.
    expect(strokeCalls).toHaveLength(2);
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

  it("GitHub issue #317/#319 follow-up: a sharp (miter) style draws the free end as plain 'butt', no round patch", () => {
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
    renderer.render({ passages: [halfFacePassage], wallFaces: [] }, { join: "miter", cap: "square" });
    const calls = graphicsOf(renderer).calls;
    expect(calls.filter((c) => c.fn === "circle")).toHaveLength(0);
    expect(calls.filter((c) => c.fn === "closePath")).toHaveLength(0);
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls[0].args[0]).toMatchObject({ cap: "butt" });
  });
});
