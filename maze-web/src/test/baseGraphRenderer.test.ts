import { describe, it, expect, vi } from "vitest";
import { nodeRadius, buildPairedRenderEdges, buildPathRenderEdges, buildCrossFloorMarkers } from "../pixi/BaseGraphRenderer";
import { NODE_RADIUS } from "../pixi/renderConstants";
import { TILE_SIZE } from "../pixi/constants";
import { getCellCenter, nearestCellCoord } from "../pixi/tessellationGeometry";
import type { Pos } from "../pixi/BaseGraphRenderer";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

// `getCellCenter`/`nearestCellCoord` (square tessellation) round-trip through wasm's own
// `cartesian_coords` — mocked here as an identity mapping (square cell (x, y) IS its own cartesian
// coordinate, so this is exact, not an approximation) purely so `buildCrossFloorMarkers`'s own
// badge-placement tests don't need a real wasm module loaded, same rationale
// `TeleportRenderer.test.ts` documents for its own wasm mock.
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (config: { points: [number, number][] }) => config.points,
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
});

describe("buildCrossFloorMarkers", () => {
  const cfg: TessellationConfig = { type: "square", width: 20, height: 20 };
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
