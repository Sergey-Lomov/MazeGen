import { describe, it, expect } from "vitest";
import { buildTeleportGroups, teleportEdgeKey } from "../pixi/selectors/teleportGroups";
import type { TeleportEdge } from "../pixi/renderers/types";

describe("teleportEdgeKey", () => {
  it("is order-independent over fromNode/toNode", () => {
    const a: TeleportEdge = { from: [0, 0], to: [1, 1], oneWay: false, fromNode: 3, toNode: 7 };
    const b: TeleportEdge = { from: [1, 1], to: [0, 0], oneWay: false, fromNode: 7, toNode: 3 };
    expect(teleportEdgeKey(a)).toBe(teleportEdgeKey(b));
  });
});

describe("buildTeleportGroups", () => {
  it("no edges — no groups", () => {
    expect(buildTeleportGroups([])).toEqual([]);
  });

  it("single isolated teleport pair — one group, two points", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 }];
    const groups = buildTeleportGroups(edges);
    expect(groups).toHaveLength(1);
    expect(groups[0].edgeKeys).toEqual([teleportEdgeKey(edges[0])]);
    expect(groups[0].points).toHaveLength(2);
  });

  it("two teleport pairs sharing no coordinate — two separate groups", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [9, 9], to: [3, 3], oneWay: false, fromNode: 10, toNode: 11 },
    ];
    expect(buildTeleportGroups(edges)).toHaveLength(2);
  });

  it("two teleport pairs sharing an endpoint coordinate — merge into one group", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [5, 5], to: [9, 9], oneWay: true, fromNode: 2, toNode: 3 },
    ];
    const groups = buildTeleportGroups(edges);
    expect(groups).toHaveLength(1);
    expect(groups[0].edgeKeys).toHaveLength(2);
    expect(groups[0].points).toHaveLength(3);
  });

  it("three pairs chained through shared coordinates — all merge into one group", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [5, 5], to: [9, 9], oneWay: false, fromNode: 2, toNode: 3 },
      { from: [9, 9], to: [1, 1], oneWay: false, fromNode: 3, toNode: 4 },
    ];
    const groups = buildTeleportGroups(edges);
    expect(groups).toHaveLength(1);
    expect(groups[0].edgeKeys).toHaveLength(3);
    expect(groups[0].points).toHaveLength(4);
  });

  it("edges missing fromNode/toNode still group (via teleportEdgeKey's position-based fallback) — needed so TeleportRenderer still draws callers like PresetConnectionsRenderer that build TeleportEdges without node ids", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [5, 5], oneWay: false }];
    const groups = buildTeleportGroups(edges);
    expect(groups).toHaveLength(1);
    expect(groups[0].points).toHaveLength(2);
  });

  it("group key is stable regardless of input edge order", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [5, 5], to: [9, 9], oneWay: false, fromNode: 2, toNode: 3 },
    ];
    const reversed = [...edges].reverse();
    expect(buildTeleportGroups(edges)[0].key).toBe(buildTeleportGroups(reversed)[0].key);
  });
});
