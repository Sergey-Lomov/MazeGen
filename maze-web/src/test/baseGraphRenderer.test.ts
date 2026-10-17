import { describe, it, expect, vi } from "vitest";
import { nodeRadius, buildPairedRenderEdges, buildPathRenderEdges, buildCrossFloorMarkers } from "../pixi/BaseGraphRenderer";
import { NODE_RADIUS } from "../pixi/renderConstants";
import { TILE_SIZE } from "../pixi/constants";
import { computeCrossFloorBadgePos } from "../pixi/renderers/floorBadge";
import { getCellCenter, nearestCellCoord } from "../pixi/tessellationGeometry";
import type { Pos } from "../pixi/BaseGraphRenderer";
import type { FieldConfig } from "../fieldConfig";
import { debugRefEdgePairs } from "../pixi/DebugRefHighlightOverlay";
import { fieldOf } from "./fieldConfigFixtures";

// Geometry comes from the real wasm module; only generation entry points are mocked elsewhere.
vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

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

  it("checks hasReverse against reverseCheckEdges, not navEdges, when given a filtered subset", () => {
    // Reverse direction (3->1) exists in the full graph but not in the filtered subset itself —
    // `reverseCheckEdges` must still catch it (GitHub issue #367 follow-up regression:
    // `PureCyclesOverlay` originally checked reverse only within its own filtered subset, wrongly
    // drawing a one-way arrow whenever the reverse edge existed but wasn't itself in that subset).
    const subset = [{ path: [1, 2, 3] }];
    const fullGraph = [{ path: [1, 2, 3] }, { path: [3, 2, 1] }];
    const result = buildPathRenderEdges(subset, nodePos, fullGraph);
    expect(result).toHaveLength(1);
    expect(result[0].hasReverse).toBe(true);
  });

  it("defaults reverseCheckEdges to navEdges itself when omitted", () => {
    const result = buildPathRenderEdges([{ path: [1, 2, 3] }], nodePos);
    expect(result[0].hasReverse).toBe(false);
  });

  it("keeps hasReverse=false for a direct one-way hop parallel to a two-way corridor between the same endpoints", () => {
    // A one-way teleport hop `[3, 1]` shares its endpoints with a genuine two-way corridor
    // (`[1, 2, 3]` + `[3, 2, 1]`). Endpoint-pair matching alone would see `1->3` present and
    // suppress the hop's one-way arrow; matching the reversed *full path* keeps them distinct —
    // the hop's reversal `[1, 3]` is not among the nav-edges, so it stays one-way.
    const graph = [{ path: [1, 2, 3] }, { path: [3, 2, 1] }, { path: [3, 1] }];
    const result = buildPathRenderEdges(graph, nodePos);
    const hop = result.find(e => e.path.length === 2)!;
    expect(hop.hasReverse).toBe(false);
    const corridors = result.filter(e => e.path.length === 3);
    expect(corridors.every(e => e.hasReverse)).toBe(true);
  });

  it("still marks a two-way corridor pair as reversed when an unrelated same-endpoint edge of a third shape is present", () => {
    // `[1, 2, 3]` / `[3, 2, 1]` are a true reverse pair; a stray `[1, 3]` between the same
    // endpoints must not prevent the corridor pair from being recognised as bidirectional.
    const graph = [{ path: [1, 2, 3] }, { path: [3, 2, 1] }, { path: [1, 3] }];
    const result = buildPathRenderEdges(graph, nodePos);
    const corridors = result.filter(e => e.path.length === 3);
    expect(corridors).toHaveLength(2);
    expect(corridors.every(e => e.hasReverse)).toBe(true);
  });
});

describe("buildCrossFloorMarkers", () => {
  const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 20, rows: 20 });
  const nodePos = posMap([
    [1, { x: 0, y: 0 }],
    [2, { x: 10, y: 0 }],
  ]);
  // Node cell coordinates (unscoped, every floor) — 1/2 are on-floor, 3 sits on a different cell
  // on another floor, 4 sits on the *same* cell as 1 (the vertical-passage/elevator case).
  const cells = new Map<number, [number, number]>([[1, [0, 0]], [2, [3, 0]], [3, [5, 5]], [4, [0, 0]]]);
  const resolveNodeCell = (id: number) => cells.get(id);
  const levels = new Map<number, number>([[1, 0], [2, 0], [3, 1], [4, 2]]);
  const resolveNodeLevel = (id: number) => levels.get(id);
  const badgeRadius = 8;

  it("places a marker at the on-floor endpoint when the other endpoint is off-floor", () => {
    const result = buildCrossFloorMarkers([{ from: 1, to: 3 }], nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius);
    expect(result).toHaveLength(1);
    expect(result[0].nodeId).toBe(1);
    expect(result[0].nodePos).toEqual({ x: 0, y: 0 });
    expect(result[0].targetFloorIndex).toBe(1);
  });

  it("places a marker at the on-floor endpoint for the symmetric (from off-floor) case", () => {
    const result = buildCrossFloorMarkers([{ from: 3, to: 2 }], nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius);
    expect(result).toHaveLength(1);
    expect(result[0].nodeId).toBe(2);
    expect(result[0].nodePos).toEqual({ x: 10, y: 0 });
    expect(result[0].targetFloorIndex).toBe(1);
  });

  it("produces no marker when both endpoints resolve on-floor", () => {
    const result = buildCrossFloorMarkers([{ from: 1, to: 2 }], nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius);
    expect(result).toHaveLength(0);
  });

  it("produces no marker when the off-floor endpoint's level can't be resolved", () => {
    const result = buildCrossFloorMarkers([{ from: 1, to: 999 }], nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius);
    expect(result).toHaveLength(0);
  });

  it("deduplicates repeated pairs to the same target floor into one marker", () => {
    const result = buildCrossFloorMarkers(
      [{ from: 1, to: 3 }, { from: 1, to: 3 }],
      nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius,
    );
    expect(result).toHaveLength(1);
  });

  it("emits one marker per distinct target floor from the same on-floor node (elevator case)", () => {
    const result = buildCrossFloorMarkers(
      [{ from: 1, to: 3 }, { from: 1, to: 4 }],
      nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius,
    );
    expect(result).toHaveLength(2);
    expect(result.map(m => m.targetFloorIndex).sort()).toEqual([1, 2]);
    expect(result.every(m => m.nodeId === 1)).toBe(true);
    // Distinct slots keep the two badges from overlapping.
    expect(result[0].badgePos).not.toEqual(result[1].badgePos);
  });

  it("uses 75% of the badge radius for positioning when targets exceed cell corners", () => {
    const targetLevels = new Map([[1, 0], [3, 1], [4, 2], [5, 3], [6, 4], [7, 5]]);
    const targetCells = new Map<number, [number, number]>([
      [1, [0, 0]], [3, [1, 0]], [4, [2, 0]], [5, [3, 0]], [6, [4, 0]], [7, [5, 0]],
    ]);
    const result = buildCrossFloorMarkers(
      [{ from: 1, to: 3 }, { from: 1, to: 4 }, { from: 1, to: 5 }, { from: 1, to: 6 }, { from: 1, to: 7 }],
      posMap([[1, { x: 0, y: 0 }]]),
      (id) => targetLevels.get(id),
      (id) => targetCells.get(id),
      0, cfg, badgeRadius,
    );
    expect(result).toHaveLength(5);
    expect(result[0].badgePos).toEqual(
      computeCrossFloorBadgePos([0, 0], [1, 0], cfg, badgeRadius, TILE_SIZE, 0, 5, 0.75),
    );
    expect(result[0].badgePos).not.toEqual(
      computeCrossFloorBadgePos([0, 0], [1, 0], cfg, badgeRadius, TILE_SIZE, 0, 5),
    );
  });

  it("assigns distinct layout slots to nodes sharing a cell", () => {
    const result = buildCrossFloorMarkers(
      [{ from: 8, to: 10 }, { from: 9, to: 11 }],
      posMap([[8, { x: 0, y: 0 }], [9, { x: 1, y: 1 }]]),
      (id) => new Map([[10, 1], [11, 2]]).get(id),
      (id) => new Map<number, [number, number]>([
        [8, [0, 0]], [9, [0, 0]], [10, [1, 0]], [11, [2, 0]],
      ]).get(id),
      0, cfg, badgeRadius,
    );
    expect(result).toHaveLength(2);
    expect(result[0].badgePos).not.toEqual(result[1].badgePos);
  });

  it("offsets the badge away from the node's own cell center on a different cell", () => {
    const result = buildCrossFloorMarkers([{ from: 1, to: 3 }], nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius);
    expect(result[0].badgePos).not.toEqual(result[0].nodePos);
  });

  it("offsets the different-cell badge at half the same-cell radius, from the snapped midpoint", () => {
    const result = buildCrossFloorMarkers([{ from: 1, to: 3 }], nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius);
    const { badgePos: b } = result[0];
    const onCenter = getCellCenter(0, 0, cfg);
    const offCenter = getCellCenter(5, 5, cfg);
    const midX = (onCenter.x + offCenter.x) / 2;
    const midY = (onCenter.y + offCenter.y) / 2;
    const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
    const snapped = getCellCenter(snapX, snapY, cfg);
    const snapDist = Math.hypot(b.x - snapped.x, b.y - snapped.y);
    expect(snapDist).toBeCloseTo((TILE_SIZE - badgeRadius) / 2);
  });

  it("offsets the badge diagonally from the node's own cell center when the off-floor node shares the same cell", () => {
    const result = buildCrossFloorMarkers([{ from: 1, to: 4 }], nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius);
    const { badgePos: b } = result[0];
    const onCenter = getCellCenter(0, 0, cfg);
    const dist = Math.hypot(b.x - onCenter.x, b.y - onCenter.y);
    // Both axes shift (a diagonal offset, not axis-aligned) — the exact sign depends on
    // `squareCenter`'s own screen-Y inversion, not asserted here.
    expect(dist).toBeCloseTo(TILE_SIZE - badgeRadius);
    expect(b.x).not.toBeCloseTo(onCenter.x);
    expect(b.y).not.toBeCloseTo(onCenter.y);
  });

  it("places the different-cell badge on the angle opposite the same-cell badge's own angle", () => {
    // Node 1 has only a different-cell target here, isolated from node 4's same-cell case —
    // both resolve with slot=0/slotCount=1 (single target each), so their angles are directly
    // comparable: same-cell sits at `angle` from its node's own cell center, different-cell at
    // `angle+180°` from the snapped midpoint.
    const sameCell = buildCrossFloorMarkers([{ from: 1, to: 4 }], nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius);
    const diffCell = buildCrossFloorMarkers([{ from: 1, to: 3 }], nodePos, resolveNodeLevel, resolveNodeCell, 0, cfg, badgeRadius);
    const onCenter = getCellCenter(0, 0, cfg);
    const sameAngle = Math.atan2(sameCell[0].badgePos.y - onCenter.y, sameCell[0].badgePos.x - onCenter.x);

    const offCenter = getCellCenter(5, 5, cfg);
    const midX = (onCenter.x + offCenter.x) / 2;
    const midY = (onCenter.y + offCenter.y) / 2;
    const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
    const snapped = getCellCenter(snapX, snapY, cfg);
    const diffAngle = Math.atan2(diffCell[0].badgePos.y - snapped.y, diffCell[0].badgePos.x - snapped.x);

    const normalized = ((diffAngle - sameAngle - Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    expect(normalized).toBeCloseTo(0, 5);
  });
});

describe("debugRefEdgePairs (GitHub issue #449)", () => {
  it("keeps a one-way debug edge as one directed graph connection", () => {
    expect(debugRefEdgePairs({ kind: "edge", from: 1n, to: 2n, bidirectional: false })).toEqual([
      { from: 1, to: 2 },
    ]);
  });

  it("expands a bidirectional debug edge so the graph marker has a reverse direction", () => {
    expect(debugRefEdgePairs({ kind: "edge", from: 1n, to: 2n, bidirectional: true })).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 1 },
    ]);
  });
});
