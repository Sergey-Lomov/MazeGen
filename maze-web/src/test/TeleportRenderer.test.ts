import { describe, it, expect } from "vitest";
import { computeMixedCells, clipDistance, resolvePointFillState, planGroupDrawOrder } from "../pixi/renderers/TeleportRenderer";
import { buildTeleportGroups } from "../pixi/selectors/teleportGroups";
import type { TeleportEdge } from "../pixi/renderers/types";
import type { RoutedConnector } from "../pixi/renderers/teleportConnectorRouting";

describe("computeMixedCells", () => {
  it("no edges — no mixed cells", () => {
    expect(computeMixedCells([]).size).toBe(0);
  });

  it("single two-way teleport — both ends filled, not mixed", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: false }];
    expect(computeMixedCells(edges).size).toBe(0);
  });

  it("single one-way teleport — origin filled, destination outline, not mixed", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: true }];
    expect(computeMixedCells(edges).size).toBe(0);
  });

  it("two one-way teleports whose destinations both land on the same cell — not mixed (both outline)", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: true },
      { from: [1, 1], to: [5, 5], oneWay: true },
    ];
    expect(computeMixedCells(edges).size).toBe(0);
  });

  it("one-way origin coincides with another one-way's destination on the same cell — mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [5, 5], to: [9, 9], oneWay: true },
      { from: [1, 1], to: [5, 5], oneWay: true },
    ];
    const mixed = computeMixedCells(edges);
    expect(mixed.size).toBe(1);
    expect(mixed.has("5000,5000")).toBe(true);
  });

  it("one-way destination coincides with a two-way endpoint on the same cell — mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [9, 9], to: [2, 2], oneWay: true },
      { from: [0, 0], to: [2, 2], oneWay: false },
    ];
    const mixed = computeMixedCells(edges);
    expect(mixed.size).toBe(1);
    expect(mixed.has("2000,2000")).toBe(true);
  });

  it("cell only ever wanted filled by multiple edges — not mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [3, 3], oneWay: false },
      { from: [0, 0], to: [4, 4], oneWay: false },
    ];
    expect(computeMixedCells(edges).size).toBe(0);
  });
});

describe("resolvePointFillState", () => {
  // GitHub issue #293 follow-up: the "grouped" pattern's points now resolve fill/outline/mixed the
  // same way "line"-pattern endpoints do, instead of always drawing filled.
  it("a two-way teleport's endpoint resolves filled", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: false }];
    expect(resolvePointFillState(edges, 0, 0)).toBe("filled");
    expect(resolvePointFillState(edges, 1, 1)).toBe("filled");
  });

  it("a one-way teleport's origin resolves filled, destination resolves outline", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: true }];
    expect(resolvePointFillState(edges, 0, 0)).toBe("filled");
    expect(resolvePointFillState(edges, 1, 1)).toBe("outline");
  });

  it("a point with no edges landing on it resolves outline (no filled edge wants it)", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [1, 1], oneWay: true }];
    expect(resolvePointFillState(edges, 9, 9)).toBe("outline");
  });

  it("a point wanted filled by one edge and outline by another resolves mixed", () => {
    const edges: TeleportEdge[] = [
      { from: [5, 5], to: [9, 9], oneWay: true },
      { from: [1, 1], to: [5, 5], oneWay: true },
    ];
    expect(resolvePointFillState(edges, 5, 5)).toBe("mixed");
  });
});

describe("clipDistance", () => {
  const half = 5.6;
  const strokeWidth = 3;

  it("axis-aligned direction — clips to flat side plus half stroke width", () => {
    expect(clipDistance(1, 0, half, strokeWidth)).toBeCloseTo(half + strokeWidth / 2);
    expect(clipDistance(0, 1, half, strokeWidth)).toBeCloseTo(half + strokeWidth / 2);
  });

  it("exact diagonal direction — clips to the square's corner distance plus half stroke width", () => {
    const u = Math.SQRT1_2;
    expect(clipDistance(u, u, half, strokeWidth)).toBeCloseTo(half * Math.SQRT2 + strokeWidth / 2);
  });

  it("shallow non-axis-aligned direction — geometric part of the clip lands exactly on the square's border", () => {
    const ux = 0.9486832980505138;
    const uy = -0.31622776601683794;
    const clip = clipDistance(ux, uy, half, strokeWidth);
    expect(clip).toBeGreaterThan(half + strokeWidth / 2);
    const geometricClip = clip - strokeWidth / 2;
    expect(Math.max(Math.abs(ux * geometricClip), Math.abs(uy * geometricClip))).toBeCloseTo(half);
  });
});

// `planGroupDrawOrder` resolves `TeleportRenderer.renderGroups`'s per-group interleave (a group's
// own connectors drawn immediately before its own points, then the next group — GitHub issue #293
// follow-up: previously "every connector, then every marker" globally) — pure, so testable without
// a `Graphics` mock.
describe("planGroupDrawOrder", () => {
  const routed = (): RoutedConnector => ({ points: [0, 0, 1, 1] });

  it("one group, one connector — single plan entry carrying that connector", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 }];
    const groups = buildTeleportGroups(edges);
    const connectors = [{ edge: edges[0], routed: routed(), color: 0 }];
    const plan = planGroupDrawOrder(groups, connectors, null);
    expect(plan).toHaveLength(1);
    expect(plan[0].group.key).toBe(groups[0].key);
    expect(plan[0].connectors).toEqual(connectors);
  });

  it("two independent groups — plan preserves groups' own order, each with only its own connector", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [9, 9], to: [3, 3], oneWay: false, fromNode: 10, toNode: 11 },
    ];
    const groups = buildTeleportGroups(edges);
    const connectors = edges.map((edge) => ({ edge, routed: routed(), color: 0 }));
    const plan = planGroupDrawOrder(groups, connectors, null);
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.group.key)).toEqual(groups.map((g) => g.key));
    // Each group's bucket contains only the connector whose endpoints land in that group — not
    // every connector globally (the bug this interleave replaces would draw all connectors first).
    for (const entry of plan) {
      expect(entry.connectors).toHaveLength(1);
      expect(groups.find((g) => g.key === entry.group.key)!.edgeKeys).toContain(
        entry.connectors[0].edge.fromNode! < entry.connectors[0].edge.toNode!
          ? `${entry.connectors[0].edge.fromNode}-${entry.connectors[0].edge.toNode}`
          : `${entry.connectors[0].edge.toNode}-${entry.connectors[0].edge.fromNode}`,
      );
    }
  });

  it("selectedKey filters to just the matching group, in visibility order", () => {
    const edges: TeleportEdge[] = [
      { from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 },
      { from: [9, 9], to: [3, 3], oneWay: false, fromNode: 10, toNode: 11 },
    ];
    const groups = buildTeleportGroups(edges);
    const connectors = edges.map((edge) => ({ edge, routed: routed(), color: 0 }));
    const plan = planGroupDrawOrder(groups, connectors, groups[0].key);
    expect(plan).toHaveLength(1);
    expect(plan[0].group.key).toBe(groups[0].key);
  });

  it("a connector whose endpoints match no group is dropped from the plan, not thrown", () => {
    const edges: TeleportEdge[] = [{ from: [0, 0], to: [5, 5], oneWay: false, fromNode: 1, toNode: 2 }];
    const groups = buildTeleportGroups(edges);
    const strayEdge: TeleportEdge = { from: [50, 50], to: [60, 60], oneWay: false, fromNode: 99, toNode: 100 };
    const connectors = [{ edge: strayEdge, routed: routed(), color: 0 }];
    const plan = planGroupDrawOrder(groups, connectors, null);
    expect(plan).toHaveLength(1);
    expect(plan[0].connectors).toHaveLength(0);
  });

  it("no groups — empty plan", () => {
    expect(planGroupDrawOrder([], [], null)).toEqual([]);
  });
});
