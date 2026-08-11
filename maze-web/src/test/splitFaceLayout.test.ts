import { describe, it, expect } from "vitest";
import { computeSplitFaceLayouts, computeSplitConnectors, type SplitFaceInput, type SplitNodeFaceKind } from "../pixi/splitFaceLayout";

// A single square face spanning (0,0) -> (10,0) — enough for every division test below.
const face: SplitFaceInput = { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } };

describe("computeSplitFaceLayouts", () => {
  it("no connected node on a face (every node walls it off) — empty segments, allWall set", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "wall" }, { nodeIndex: 1, kind: "wall" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    expect(layouts[0].segments).toEqual([]);
    expect(layouts[0].allWall).toBe(true);
  });

  it("no per-node kind data at all for a face (no geometric neighbor there) — empty segments, not allWall", () => {
    const kinds: SplitNodeFaceKind[][] = [[]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    expect(layouts[0].segments).toEqual([]);
    expect(layouts[0].allWall).toBe(false);
  });

  it("wall face never gets its own segment, even alongside a connected node", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }, { nodeIndex: 1, kind: "wall" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    expect(layouts[0].segments).toHaveLength(1);
    expect(layouts[0].segments[0].nodeIndex).toBe(0);
  });

  it("a single connected node gets the whole face", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    expect(layouts[0].segments).toHaveLength(1);
    expect(layouts[0].segments[0].v0).toEqual({ x: 0, y: 0 });
    expect(layouts[0].segments[0].v1).toEqual({ x: 10, y: 0 });
    // GitHub issue #317: a lone node's segment spans the whole face, so both its own ends land on
    // the face's real boundary — no neighbor sub-segment on either side to butt against.
    expect(layouts[0].segments[0].atFaceStart).toBe(true);
    expect(layouts[0].segments[0].atFaceEnd).toBe(true);
  });

  it("two connected nodes split the face into two equal, non-overlapping halves; only the outer ends touch the face's real boundary (GitHub issue #317)", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }, { nodeIndex: 1, kind: "one_way_out" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    const [a, b] = layouts[0].segments;
    expect(a.v0).toEqual({ x: 0, y: 0 });
    expect(a.v1).toEqual({ x: 5, y: 0 });
    expect(b.v0).toEqual({ x: 5, y: 0 });
    expect(b.v1).toEqual({ x: 10, y: 0 });
    // `a.v0` and `b.v1` sit on the face's own real endpoints (free ends); `a.v1`/`b.v0` are the
    // same internal division point shared between the two nodes (never a free end).
    expect(a.atFaceStart).toBe(true);
    expect(a.atFaceEnd).toBe(false);
    expect(b.atFaceStart).toBe(false);
    expect(b.atFaceEnd).toBe(true);
  });

  it("without an active node, segments are ordered by node index", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 2, kind: "passage" }, { nodeIndex: 0, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    expect(layouts[0].segments.map(s => s.nodeIndex)).toEqual([0, 2]);
  });

  it("three connected nodes: only the first/last share touch the face's real boundary, the middle share's both ends are internal divisions (GitHub issue #317)", () => {
    const kinds: SplitNodeFaceKind[][] = [[
      { nodeIndex: 0, kind: "passage" },
      { nodeIndex: 1, kind: "passage" },
      { nodeIndex: 2, kind: "passage" },
    ]];
    const [first, middle, last] = computeSplitFaceLayouts([face], kinds, null)[0].segments;
    expect([first.atFaceStart, first.atFaceEnd]).toEqual([true, false]);
    expect([middle.atFaceStart, middle.atFaceEnd]).toEqual([false, false]);
    expect([last.atFaceStart, last.atFaceEnd]).toEqual([false, true]);
  });

  it("the active node's segment always sorts last (drawn on top), regardless of node index", () => {
    const kinds: SplitNodeFaceKind[][] = [[
      { nodeIndex: 0, kind: "passage" },
      { nodeIndex: 1, kind: "passage" },
      { nodeIndex: 2, kind: "passage" },
    ]];
    const layouts = computeSplitFaceLayouts([face], kinds, 1);
    expect(layouts[0].segments.at(-1)?.nodeIndex).toBe(1);
  });

  it("undefined kind still gets its own segment (not folded into the neutral no-connection case)", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "undefined" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    expect(layouts[0].segments).toHaveLength(1);
    expect(layouts[0].segments[0].kind).toBe("undefined");
  });
});

describe("computeSplitConnectors", () => {
  const hubCenter = { x: 0, y: 0 };
  const hubRadius = 10;

  it("a node with exactly 2 plain two-way passages gets a single straight connector, no hub", () => {
    const faceA: SplitFaceInput = { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } };
    const faceB: SplitFaceInput = { v0: { x: 0, y: 10 }, v1: { x: 10, y: 10 } };
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }], [{ nodeIndex: 0, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([faceA, faceB], kinds, null);
    const connectors = computeSplitConnectors(layouts, 1, null, hubCenter, hubRadius, 0);
    expect(connectors[0].lines).toHaveLength(1);
    expect(connectors[0].lines[0].from).toEqual({ x: 5, y: 0 });
    expect(connectors[0].lines[0].to).toEqual({ x: 5, y: 10 });
    expect(connectors[0].lines[0].oneWayOut).toBeUndefined();
  });

  it("2 connections but one is one-way — hub point used, not a straight line", () => {
    const faceA: SplitFaceInput = { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } };
    const faceB: SplitFaceInput = { v0: { x: 0, y: 10 }, v1: { x: 10, y: 10 } };
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }], [{ nodeIndex: 0, kind: "one_way_out" }]];
    const layouts = computeSplitFaceLayouts([faceA, faceB], kinds, null);
    const connectors = computeSplitConnectors(layouts, 1, null, hubCenter, hubRadius, 0);
    expect(connectors[0].lines).toHaveLength(2);
    for (const line of connectors[0].lines) {
      const dist = Math.hypot(line.from.x - hubCenter.x, line.from.y - hubCenter.y);
      expect(dist).toBeCloseTo(hubRadius, 5);
    }
  });

  it("forceHub keeps the hub point even at exactly 2 plain passages", () => {
    const faceA: SplitFaceInput = { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } };
    const faceB: SplitFaceInput = { v0: { x: 0, y: 10 }, v1: { x: 10, y: 10 } };
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }], [{ nodeIndex: 0, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([faceA, faceB], kinds, null);
    const connectors = computeSplitConnectors(layouts, 1, null, hubCenter, hubRadius, 0, () => true);
    expect(connectors[0].lines).toHaveLength(2);
  });

  it("one-way direction sets oneWayOut true for one_way_out, false for one_way_in", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "one_way_out" }, { nodeIndex: 1, kind: "one_way_in" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    const connectors = computeSplitConnectors(layouts, 2, null, hubCenter, hubRadius, 0);
    const outNode = connectors.find(c => c.nodeIndex === 0)!;
    const inNode = connectors.find(c => c.nodeIndex === 1)!;
    expect(outNode.lines[0].oneWayOut).toBe(true);
    expect(inNode.lines[0].oneWayOut).toBe(false);
  });

  it("a node with no connections gets an empty lines array", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    const connectors = computeSplitConnectors(layouts, 2, null, hubCenter, hubRadius, 0);
    const node1 = connectors.find(c => c.nodeIndex === 1)!;
    expect(node1.lines).toEqual([]);
  });

  it("without an active node, connectors are returned in node-index order", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }, { nodeIndex: 1, kind: "passage" }, { nodeIndex: 2, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    const connectors = computeSplitConnectors(layouts, 3, null, hubCenter, hubRadius, 0);
    expect(connectors.map(c => c.nodeIndex)).toEqual([0, 1, 2]);
  });

  it("the active node's connector always sorts last, regardless of node index", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }, { nodeIndex: 1, kind: "passage" }, { nodeIndex: 2, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, 0);
    const connectors = computeSplitConnectors(layouts, 3, 0, hubCenter, hubRadius, 0);
    expect(connectors.at(-1)?.nodeIndex).toBe(0);
  });

  it("hub points are evenly distributed around the circle starting at rotationRad", () => {
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }, { nodeIndex: 1, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([face], kinds, null);
    const connectors = computeSplitConnectors(layouts, 2, null, hubCenter, hubRadius, Math.PI / 4);
    const hub0 = connectors[0].lines[0].from;
    expect(hub0.x).toBeCloseTo(hubRadius * Math.cos(Math.PI / 4), 5);
    expect(hub0.y).toBeCloseTo(hubRadius * Math.sin(Math.PI / 4), 5);
  });
});
