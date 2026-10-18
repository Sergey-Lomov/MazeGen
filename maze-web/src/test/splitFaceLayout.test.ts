import { describe, it, expect } from "vitest";
import { detectIdentity } from "./splitBindingFixture";
import { adjacentTripleOuterFaces, computeSplitFaceLayouts, computeSplitConnectors, circularDist, MIN_STRAIGHT_CONNECTOR_ANGLE_DEG, type SplitFaceInput, type SplitNodeFaceKind, type SplitFaceKind } from "../pixi/splitFaceLayout";

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

  it("switching which node is active reorders draw order only — every node's own geometry (v0/v1/atFaceStart/atFaceEnd) stays identical (GitHub issue #422)", () => {
    const kinds: SplitNodeFaceKind[][] = [[
      { nodeIndex: 0, kind: "passage" },
      { nodeIndex: 1, kind: "passage" },
      { nodeIndex: 2, kind: "passage" },
    ]];
    const geometryByNode = (segments: ReturnType<typeof computeSplitFaceLayouts>[number]["segments"]) =>
      new Map(segments.map((s) => [s.nodeIndex, { v0: s.v0, v1: s.v1, atFaceStart: s.atFaceStart, atFaceEnd: s.atFaceEnd }]));

    const noActive = geometryByNode(computeSplitFaceLayouts([face], kinds, null)[0].segments);
    for (const activeIndex of [0, 1, 2]) {
      const withActive = geometryByNode(computeSplitFaceLayouts([face], kinds, activeIndex)[0].segments);
      expect(withActive).toEqual(noActive);
    }
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

  // Two faces whose midpoints are 10 apart along x, the second face tilted so the straight line
  // makes `angleDeg` with it (the first face is perpendicular to the line).
  function connectorsForLineAngle(angleDeg: number) {
    const a = (angleDeg * Math.PI) / 180;
    const faceA: SplitFaceInput = { v0: { x: 0, y: -5 }, v1: { x: 0, y: 5 } };
    const cx = 10, half = 5;
    const faceB: SplitFaceInput = {
      v0: { x: cx - Math.cos(a) * half, y: -Math.sin(a) * half },
      v1: { x: cx + Math.cos(a) * half, y: Math.sin(a) * half },
    };
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }], [{ nodeIndex: 0, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([faceA, faceB], kinds, null);
    return computeSplitConnectors(layouts, 1, null, hubCenter, hubRadius, 0);
  }

  it("straight line stays just above the angle threshold, falls back just below it", () => {
    expect(connectorsForLineAngle(MIN_STRAIGHT_CONNECTOR_ANGLE_DEG + 1)[0].lines).toHaveLength(1);
    expect(connectorsForLineAngle(MIN_STRAIGHT_CONNECTOR_ANGLE_DEG - 1)[0].lines).toHaveLength(2);
  });

  it.each([
    ["square", 4],
    ["triangle", 3],
    ["hexagon", 6],
    ["octagon", 8],
  ])("adjacent faces of a regular %s keep the straight connector", (_name, sides) => {
    const vertex = (i: number) => ({ x: Math.cos((2 * Math.PI * i) / sides) * 10, y: Math.sin((2 * Math.PI * i) / sides) * 10 });
    const faces: SplitFaceInput[] = [0, 1].map((i) => ({ v0: vertex(i), v1: vertex(i + 1) }));
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }], [{ nodeIndex: 0, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts(faces, kinds, null);
    expect(computeSplitConnectors(layouts, 1, null, hubCenter, hubRadius, 0)[0].lines).toHaveLength(1);
  });

  it("coincident share centers do not trigger the hub fallback", () => {
    const face: SplitFaceInput = { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } };
    const kinds: SplitNodeFaceKind[][] = [[{ nodeIndex: 0, kind: "passage" }], [{ nodeIndex: 0, kind: "passage" }]];
    const layouts = computeSplitFaceLayouts([face, face], kinds, null);
    expect(computeSplitConnectors(layouts, 1, null, hubCenter, hubRadius, 0)[0].lines).toHaveLength(1);
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

describe("circularDist", () => {
  it("shortest distance around the ring, either direction", () => {
    expect(circularDist(0, 3, 6)).toBe(3);
    expect(circularDist(5, 0, 6)).toBe(1);
    expect(circularDist(0, 2, 6)).toBe(2);
    expect(circularDist(1, 1, 6)).toBe(0);
  });
});

describe("adjacentTripleOuterFaces", () => {
  it("returns the outer faces for ordinary and wrap-around triples", () => {
    expect(adjacentTripleOuterFaces([0, 1, 2], 6)).toEqual([0, 2]);
    expect(adjacentTripleOuterFaces([0, 4, 5], 6)).toEqual([4, 0]);
  });

  it("rejects a non-adjacent triple", () => {
    expect(adjacentTripleOuterFaces([0, 2, 4], 6)).toBeNull();
  });
});

describe("detectSplitSpecialShapeKind", () => {
  const passage = (idxs: number[], degree: number): SplitFaceKind[] =>
    Array.from({ length: degree }, (_, i) => (idxs.includes(i) ? "passage" : "wall"));

  it("degree 6, 2 nodes: opposite pairs -> hex_bridge", () => {
    const kinds = [passage([0, 3], 6), passage([1, 4], 6)];
    expect(detectIdentity(kinds)).toBe("hex_bridge");
  });

  it("degree 6, 2 nodes: non-opposite pairs (adjacent or skip) -> hex_diagonal", () => {
    expect(detectIdentity([passage([0, 1], 6), passage([3, 4], 6)])).toBe("hex_diagonal");
    expect(detectIdentity([passage([0, 2], 6), passage([4, 5], 6)])).toBe("hex_diagonal");
  });

  it("degree 6, 2 nodes: opposite adjacent-face triples -> hex_diagonal_divider", () => {
    const kinds = [passage([0, 1, 2], 6), passage([3, 4, 5], 6)];
    expect(detectIdentity(kinds)).toBe("hex_diagonal_divider");
  });

  it("degree 6, 2 nodes: overlapping or non-adjacent triples are not a diagonal divider", () => {
    expect(detectIdentity([
      passage([0, 1, 2], 6), passage([2, 3, 4], 6),
    ])).toBeNull();
    expect(detectIdentity([
      passage([0, 2, 4], 6), passage([1, 3, 5], 6),
    ])).toBeNull();
  });

  it("degree 6, 3 nodes: all opposite pairs, faces partition the hexagon -> hex_triple_bridge", () => {
    const kinds = [passage([0, 3], 6), passage([1, 4], 6), passage([2, 5], 6)];
    expect(detectIdentity(kinds)).toBe("hex_triple_bridge");
  });

  it("degree 6, 3 nodes: 1 opposite + 2 adjacent pairs, faces partition the hexagon -> hex_triple_corridor", () => {
    const kinds = [passage([0, 3], 6), passage([1, 2], 6), passage([4, 5], 6)];
    expect(detectIdentity(kinds)).toBe("hex_triple_corridor");
  });

  it("degree 6, 3 nodes: faces don't partition the full hexagon (overlap/gap) -> null", () => {
    const kinds = [passage([0, 3], 6), passage([1, 4], 6), passage([1, 2], 6)];
    expect(detectIdentity(kinds)).toBeNull();
  });

  it("degree 6, 3 nodes: 1 opposite + 2 skip pairs -> null (only adjacent+adjacent qualifies)", () => {
    const kinds = [passage([0, 3], 6), passage([1, 5], 6), passage([2, 4], 6)];
    expect(detectIdentity(kinds)).toBeNull();
  });

  it("degree 4, 2 nodes: unchanged bridge/diagonal behavior", () => {
    expect(detectIdentity([passage([0, 2], 4), passage([1, 3], 4)])).toBe("bridge");
    expect(detectIdentity([passage([0, 1], 4), passage([2, 3], 4)])).toBe("diagonal");
  });

  it("recognizes the Cairo divider in perimeter order", () => {
    expect(detectIdentity([passage([2, 3], 5), passage([1, 4], 5)])).toBe("cairo_diagonal_divider");
    expect(detectIdentity([passage([1, 2], 5), passage([3, 4], 5)])).toBe("cairo_adjacent_divider");
    expect(detectIdentity([passage([0, 2, 3], 5), passage([1, 4], 5)])).toBe("cairo_bridge_2x3");
  });

  it("degree 4, 2 nodes: both opposite pairs on the SAME axis -> null, not bridge (GitHub issue #591)", () => {
    expect(detectIdentity([passage([0, 2], 4), passage([0, 2], 4)])).toBeNull();
    expect(detectIdentity([passage([1, 3], 4), passage([1, 3], 4)])).toBeNull();
  });

  it("degree 6, 2 nodes: both opposite pairs on the SAME axis -> null, not hex_bridge (GitHub issue #591)", () => {
    expect(detectIdentity([passage([0, 3], 6), passage([0, 3], 6)])).toBeNull();
    expect(detectIdentity([passage([1, 4], 6), passage([1, 4], 6)])).toBeNull();
  });

  it("a node without the face count required by a recognized topology never matches a special shape", () => {
    const oneConnected = [passage([0], 6), passage([1, 4], 6)];
    expect(detectIdentity(oneConnected)).toBeNull();
    const threeConnected = [passage([0, 2, 4], 6), passage([1, 3], 6)];
    expect(detectIdentity(threeConnected)).toBeNull();
  });

  it("a one-way connection on any face disqualifies the point from every special shape (GitHub issue #477)", () => {
    const oneWayOut = (idxs: number[], oneWay: number, degree: number): SplitFaceKind[] =>
      Array.from({ length: degree }, (_, i) =>
        i === oneWay ? "one_way_out" : idxs.includes(i) ? "passage" : "wall",
      );
    // Same face topology as the "bridge" case above, but one of node 1's faces is one-way.
    expect(detectIdentity([passage([0, 2], 4), oneWayOut([1, 3], 1, 4)])).toBeNull();
    // ...and a one-way-in variant.
    const oneWayIn: SplitFaceKind[] = ["passage", "wall", "one_way_in", "wall"];
    expect(detectIdentity([oneWayIn, passage([1, 3], 4)])).toBeNull();
  });

  it("unsupported degree or node count returns null", () => {
    expect(detectIdentity([passage([0, 2], 3), passage([1], 3)])).toBeNull();
    expect(detectIdentity([passage([0, 3], 6)])).toBeNull(); // degree 6, 1 node
    expect(detectIdentity([passage([0, 2], 4), passage([1, 3], 4), passage([0, 1], 4)])).toBeNull(); // degree 4, 3 nodes
  });
});
