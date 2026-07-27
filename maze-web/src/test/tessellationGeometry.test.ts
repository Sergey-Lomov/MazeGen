import { describe, it, expect, vi } from "vitest";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

// `getCartesian` (cartesianCache.ts) delegates to wasm, unavailable in this unit-test environment
// — same mock `hexGeometry.test.ts` uses, canonical (unit-tile-scale) formulas mirroring
// `maze-core::space`'s Tessellation impls.
vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number, cfg: { type: string }): [number, number] => {
    if (cfg.type.startsWith("square")) return [x, y];
    if (cfg.type.startsWith("hex")) {
      const inradius = Math.sqrt(3) / 2;
      return [x * 1.5, -(y * inradius * 2 + x * inradius)];
    }
    const s = 2, h = (s * Math.sqrt(3)) / 2;
    const pointingUp = (x + y) % 2 === 0;
    const cx = (x * s) / 2 + s / 4;
    const cy = pointingUp ? -(y * h + h / 3) : -(y * h + (2 * h) / 3);
    return [cx, cy];
  },
}));

const { getTileDiagram, getSharedEdgeSegment, getCellCenter, getNeighborData, getSplitCircleRotationDeg, splitHubPoint, buildNodePositions } = await import("../pixi/tessellationGeometry");

// A face's `v0 -> v1` direction must agree with `getSharedEdgeSegment`'s own choice for that same
// shared edge — both the split-node dialog's tile diagram (`TileFaceEditor`, via `getTileDiagram`)
// and the post-generation canvas (`SplitJunctionRenderer`, via `getSharedEdgeSegment`) feed the
// same `computeSplitFaceLayouts`, which divides a multi-node face along `v0 -> v1` in node order —
// a disagreement here mirrors the split order between the dialog and the canvas for identical data
// (GitHub issue #235 follow-up). Checked from the *higher*-coordinate cell's own diagram, since
// `getTileDiagram` used its own `edgeVerts` unconditionally before the fix — a bug only visible
// when the diagram's own cell isn't the canonical-lower one for a given shared edge.
function expectSideMatchesShared(cfg: TessellationConfig, x: number, y: number) {
  const diagram = getTileDiagram(x, y, cfg);
  expect(diagram).not.toBeNull();
  const center = getCellCenter(x, y, cfg);
  const { offsets } = getNeighborData(cfg, x, y);

  diagram!.sides.forEach((side, i) => {
    const [dx, dy] = offsets[i];
    const nx = x + dx, ny = y + dy;
    const shared = getSharedEdgeSegment([x, y], [nx, ny], cfg);
    expect(shared).not.toBeNull();
    const expectedV0 = { x: shared!.v0.x - center.x, y: shared!.v0.y - center.y };
    const expectedV1 = { x: shared!.v1.x - center.x, y: shared!.v1.y - center.y };
    expect(side.v0.x).toBeCloseTo(expectedV0.x);
    expect(side.v0.y).toBeCloseTo(expectedV0.y);
    expect(side.v1.x).toBeCloseTo(expectedV1.x);
    expect(side.v1.y).toBeCloseTo(expectedV1.y);
  });
}

describe("getTileDiagram side direction matches getSharedEdgeSegment", () => {
  it("agrees for a hex cell that is the canonical-lower cell on every shared edge", () => {
    expectSideMatchesShared({ type: "hex_hexagon", radius: 3, orientation: "flat_top" }, -1, -1);
  });

  it("agrees for a hex cell that is the canonical-higher cell on some shared edges", () => {
    // (1, 1) has neighbors with both lower and higher coordinates — exercises both branches.
    expectSideMatchesShared({ type: "hex_hexagon", radius: 3, orientation: "flat_top" }, 1, 1);
  });

  it("agrees for a triangle 'up' cell ((x+y) even)", () => {
    expectSideMatchesShared({ type: "triangle_hexagon", radius: 3 }, 2, 2);
  });

  it("agrees for a triangle 'down' cell ((x+y) odd)", () => {
    expectSideMatchesShared({ type: "triangle_hexagon", radius: 3 }, 3, 2);
  });

  it("agrees for a square cell (sanity check — square never disagreed even before the fix)", () => {
    expectSideMatchesShared({ type: "square", width: 5, height: 5 }, 1, 1);
  });
});

describe("getSplitCircleRotationDeg", () => {
  it("returns 45 for square tessellations (halfway between its 4 edge directions)", () => {
    expect(getSplitCircleRotationDeg({ type: "square", width: 5, height: 5 })).toBe(45);
    expect(getSplitCircleRotationDeg({ type: "square_custom", points: [] })).toBe(45);
  });

  it("returns 30 for hex tessellations (halfway between its 6 edge directions)", () => {
    expect(getSplitCircleRotationDeg({ type: "hex_hexagon", radius: 3 })).toBe(30);
    expect(getSplitCircleRotationDeg({ type: "hex_parallelogram", cols: 3, rows: 3 })).toBe(30);
    expect(getSplitCircleRotationDeg({ type: "hex_custom", points: [] })).toBe(30);
  });

  it("returns 60 for triangle tessellations (halfway between its 3 edge directions)", () => {
    expect(getSplitCircleRotationDeg({ type: "triangle_hexagon", radius: 3 })).toBe(60);
    expect(getSplitCircleRotationDeg({ type: "triangle_rect", cols: 3, rows: 3 })).toBe(60);
    expect(getSplitCircleRotationDeg({ type: "triangle_triangle", side: 3 })).toBe(60);
    expect(getSplitCircleRotationDeg({ type: "tri_custom", points: [] })).toBe(60);
  });
});

describe("splitHubPoint", () => {
  it("distributes slots evenly around the center starting at the tessellation's own rotation", () => {
    const cfg: TessellationConfig = { type: "square", width: 5, height: 5 };
    const center = { x: 0, y: 0 };
    const p0 = splitHubPoint(center, 0, 4, cfg);
    const p1 = splitHubPoint(center, 1, 4, cfg);
    // slot 0 sits exactly at the 45° rotation angle.
    const angle0 = Math.atan2(p0.y, p0.x);
    expect(angle0).toBeCloseTo((45 * Math.PI) / 180);
    // consecutive slots are 90° apart for a 4-slot split.
    const angle1 = Math.atan2(p1.y, p1.x);
    expect(angle1 - angle0).toBeCloseTo(Math.PI / 2);
  });

  it("places every slot at the same distance from center", () => {
    const cfg: TessellationConfig = { type: "hex_hexagon", radius: 3 };
    const center = { x: 10, y: -5 };
    const distances = [0, 1, 2].map((i) => {
      const p = splitHubPoint(center, i, 3, cfg);
      return Math.hypot(p.x - center.x, p.y - center.y);
    });
    expect(distances[1]).toBeCloseTo(distances[0]);
    expect(distances[2]).toBeCloseTo(distances[0]);
  });
});

describe("buildNodePositions", () => {
  const cfg: TessellationConfig = { type: "square", width: 10, height: 10 };

  it("matches getCellCenter/splitHubPoint exactly, the same formula the canvas uses for split passages", () => {
    const nodes = [
      { id: 20, x: 2, y: 2 },
      { id: 21, x: 2, y: 2 },
    ];
    const nodePos = buildNodePositions(nodes, cfg);
    const center = getCellCenter(2, 2, cfg);
    expect(nodePos.get(20)).toEqual(splitHubPoint(center, 0, 2, cfg));
    expect(nodePos.get(21)).toEqual(splitHubPoint(center, 1, 2, cfg));
  });

  it("spreads split-tile siblings sharing the same (x, y) into distinct positions", () => {
    const nodes = [
      { id: 10, x: 4, y: 4 },
      { id: 11, x: 4, y: 4 },
      { id: 12, x: 4, y: 4 },
    ];
    const nodePos = buildNodePositions(nodes, cfg);
    const positions = [nodePos.get(10)!, nodePos.get(11)!, nodePos.get(12)!];
    for (const p of positions) expect(p).toBeDefined();
    expect(new Set(positions.map(p => `${p.x}:${p.y}`)).size).toBe(3);
  });

  it("does not offset nodes on different tiles", () => {
    const nodes = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 1, y: 0 },
    ];
    const nodePos = buildNodePositions(nodes, cfg);
    const solo = buildNodePositions([nodes[0]], cfg);
    expect(nodePos.get(1)).toEqual(solo.get(1));
  });

  it("leaves an unsplit node exactly at its cell center", () => {
    const nodes = [{ id: 5, x: 3, y: 3 }];
    const nodePos = buildNodePositions(nodes, cfg);
    expect(nodePos.get(5)).toEqual(getCellCenter(3, 3, cfg));
  });
});
