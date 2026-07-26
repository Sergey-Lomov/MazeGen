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

const { getTileDiagram, getSharedEdgeSegment, getCellCenter, getNeighborData } = await import("../pixi/tessellationGeometry");

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
