import { describe, it, expect } from "vitest";
import { nodeRadius, buildPairedRenderEdges, buildPathRenderEdges } from "../pixi/BaseGraphRenderer";
import { NODE_RADIUS } from "../pixi/colorUtils";
import type { Pos } from "../pixi/BaseGraphRenderer";

describe("nodeRadius", () => {
  it("returns enlarged radius for start node", () => {
    expect(nodeRadius(1, 1, 2)).toBe(NODE_RADIUS * 1.5);
  });

  it("returns enlarged radius for finish node", () => {
    expect(nodeRadius(2, 1, 2)).toBe(NODE_RADIUS * 1.5);
  });

  it("returns base radius for regular node", () => {
    expect(nodeRadius(3, 1, 2)).toBe(NODE_RADIUS);
  });

  it("returns base radius when start/finish are null", () => {
    expect(nodeRadius(1, null, null)).toBe(NODE_RADIUS);
  });
});

function posMap(entries: [number, Pos][]): Map<number, Pos> {
  return new Map(entries);
}

describe("buildPairedRenderEdges", () => {
  const nodePos = posMap([
    [1, { x: 0, y: 0 }],
    [2, { x: 10, y: 0 }],
  ]);

  it("marks one-directional edge as not having a reverse", () => {
    const result = buildPairedRenderEdges([{ from: 1, to: 2 }], nodePos);
    expect(result).toHaveLength(1);
    expect(result[0].hasReverse).toBe(false);
    expect(result[0].path).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });

  it("marks bidirectional edge pair as having a reverse on both sides", () => {
    const result = buildPairedRenderEdges([{ from: 1, to: 2 }, { from: 2, to: 1 }], nodePos);
    expect(result).toHaveLength(2);
    expect(result.every(e => e.hasReverse)).toBe(true);
  });

  it("skips edges referencing unknown nodes", () => {
    const result = buildPairedRenderEdges([{ from: 1, to: 99 }], nodePos);
    expect(result).toHaveLength(0);
  });

  it("deduplicates repeated identical edges into one direction entry", () => {
    const result = buildPairedRenderEdges([{ from: 1, to: 2 }, { from: 1, to: 2 }], nodePos);
    expect(result).toHaveLength(1);
  });
});

describe("buildPathRenderEdges", () => {
  const nodePos = posMap([
    [1, { x: 0, y: 0 }],
    [2, { x: 5, y: 0 }],
    [3, { x: 10, y: 0 }],
  ]);

  it("builds a path edge with no reverse when only one direction exists", () => {
    const result = buildPathRenderEdges([{ path: [1, 2, 3] }], nodePos);
    expect(result).toHaveLength(1);
    expect(result[0].hasReverse).toBe(false);
    expect(result[0].path).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]);
  });

  it("marks both directions as having a reverse when opposite path exists", () => {
    const result = buildPathRenderEdges([{ path: [1, 2, 3] }, { path: [3, 2, 1] }], nodePos);
    expect(result).toHaveLength(2);
    expect(result.every(e => e.hasReverse)).toBe(true);
  });

  it("skips paths shorter than 2 resolved points", () => {
    const result = buildPathRenderEdges([{ path: [1, 99] }], nodePos);
    expect(result).toHaveLength(0);
  });

  it("drops unresolved intermediate points but keeps edge if 2+ points resolve", () => {
    const result = buildPathRenderEdges([{ path: [1, 99, 3] }], nodePos);
    expect(result).toHaveLength(1);
    expect(result[0].path).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });
});
