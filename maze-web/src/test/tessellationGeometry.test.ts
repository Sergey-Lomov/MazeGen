import { describe, it, expect, vi } from "vitest";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { SplitPattern } from "../wasm/types";
import { TILE_SIZE } from "../pixi/constants";

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

const { getTileDiagram, getSharedEdgeSegment, getCellCenter, getNeighborData, getSplitCircleRotationDeg, splitHubPoint, specialSplitNodePoint, buildNodePositions, splitFaceIndexToCore, splitFaceIndexToWeb, splitPatternsToCore, splitPatternsToWeb } = await import("../pixi/tessellationGeometry");

// `maze-core`'s own `Tessellation::faces()` order per space (`Specs/split-patterns.md`,
// GitHub issue #273) — used here only to name expected indices by face, not to duplicate the
// mapping under test.
const SQUARE_CORE_ORDER = ["N", "S", "E", "W"];
const HEX_CORE_ORDER = ["E", "NE", "NW", "W", "SW", "SE"];

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

describe("specialSplitNodePoint", () => {
  const cfg: TessellationConfig = { type: "square", width: 10, height: 10 };
  const center = { x: 0, y: 0 };

  // GitHub issue #318 follow-up — the tessellation-type guard is only reachable directly (every
  // caller today, `buildNodePositions`, never passes a non-null `kind` for a non-square cfg, since
  // `detectSplitSpecialShapeKind` requires degree 4, which hex/triangle points never have).
  it("returns null for a non-square tessellation even when kind/faces would otherwise resolve", () => {
    const hexCfg: TessellationConfig = { type: "hex_hexagon", radius: 3 };
    expect(specialSplitNodePoint(hexCfg, center, "diagonal", [0, 1], 0)).toBeNull();
    expect(specialSplitNodePoint(hexCfg, center, "bridge", [0, 2], 0)).toBeNull();
  });

  it("returns null for a diagonal face pair with no dedicated table entry", () => {
    // Only adjacent pairs (0,1)/(1,2)/(2,3)/(3,0) have entries — an opposite pair like (0,2)
    // shouldn't reach this function via detectSplitSpecialShapeKind's own "diagonal" classification
    // in practice, but the function itself stays total (returns null, not a throw/garbage value).
    expect(specialSplitNodePoint(cfg, center, "diagonal", [0, 2], 0)).toBeNull();
  });

  it("bridge slot 1 always sits at plain center regardless of its own face pair", () => {
    expect(specialSplitNodePoint(cfg, center, "bridge", [1, 3], 1)).toEqual(center);
    expect(specialSplitNodePoint(cfg, center, "bridge", [0, 2], 1)).toEqual(center);
  });

  it("bridge slot 0 offsets toward its own first face", () => {
    const east = specialSplitNodePoint(cfg, center, "bridge", [0, 2], 0)!; // faces[0] = E
    expect(east.x).toBeCloseTo(TILE_SIZE * 0.25);
    expect(east.y).toBeCloseTo(0);

    const north = specialSplitNodePoint(cfg, center, "bridge", [1, 3], 0)!; // faces[0] = N
    expect(north.x).toBeCloseTo(0);
    expect(north.y).toBeCloseTo(-TILE_SIZE * 0.25);
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

  // GitHub issue #318 — a degree-4 split point recognized as a "diagonal"/"bridge" special shape
  // gets a dedicated point instead of the generic hub circle, once `directedPairs` are supplied.
  describe("shape-aware positioning for a recognized bridge/diagonal split point", () => {
    // Split point at (2,2); neighbors at E(3,2), N(2,3), W(1,2), S(2,1) — face order per
    // `getNeighborData`: 0=E, 1=N, 2=W, 3=S (confirmed by `splitFaceIndexToCore`'s own tests above).
    const east = { id: 100, x: 3, y: 2 };
    const north = { id: 101, x: 2, y: 3 };
    const west = { id: 102, x: 1, y: 2 };
    const south = { id: 103, x: 2, y: 1 };

    it("diagonal: each node's point sits at the centroid of its own half (adjacent-face pair), not the hub circle", () => {
      const node0 = { id: 0, x: 2, y: 2 }; // connects E, N
      const node1 = { id: 1, x: 2, y: 2 }; // connects W, S
      const nodes = [node0, node1, east, north, west, south];
      const directedPairs = [
        { from: node0.id, to: east.id }, { from: node0.id, to: north.id },
        { from: node1.id, to: west.id }, { from: node1.id, to: south.id },
      ];
      const nodePos = buildNodePositions(nodes, cfg, directedPairs);
      const center = getCellCenter(2, 2, cfg);

      // node0 (E,N) — half-centroid direction, scaled to 1/4 tile (GitHub issue #318 follow-up:
      // 1/3 sat too close to the corner, 1/6 and 1/5 overcorrected, 1/4 is the final value).
      const p0 = nodePos.get(0)!;
      expect(p0.x).toBeCloseTo(center.x + TILE_SIZE / 4);
      expect(p0.y).toBeCloseTo(center.y - TILE_SIZE / 4);

      // node1 (W,S) — the opposite half, offset (-1/4, 1/4) tile.
      const p1 = nodePos.get(1)!;
      expect(p1.x).toBeCloseTo(center.x - TILE_SIZE / 4);
      expect(p1.y).toBeCloseTo(center.y + TILE_SIZE / 4);

      // Neither point sits on the generic hub circle (radius SPLIT_HUB_RADIUS from center).
      const hubDist0 = Math.hypot(p0.x - center.x, p0.y - center.y);
      expect(hubDist0).not.toBeCloseTo(TILE_SIZE / 4);
    });

    it("bridge: slot 1 sits at tile center, slot 0 offsets toward its own first face (GitHub issue #318 follow-up: keyed by slot, and the offset axis is slot 0's own face pair, not slot 1's)", () => {
      const node0 = { id: 0, x: 2, y: 2 }; // slot 0 — connects E, W (opposite)
      const node1 = { id: 1, x: 2, y: 2 }; // slot 1 — connects N, S (opposite)
      const nodes = [node0, node1, east, north, west, south];
      const directedPairs = [
        { from: node0.id, to: east.id }, { from: node0.id, to: west.id },
        { from: node1.id, to: north.id }, { from: node1.id, to: south.id },
      ];
      const nodePos = buildNodePositions(nodes, cfg, directedPairs);
      const center = getCellCenter(2, 2, cfg);

      // Slot 1 (node1) sits at plain center.
      expect(nodePos.get(1)).toEqual(center);

      // Slot 0 (node0) offsets 0.25 tile toward its own first face (E).
      const p0 = nodePos.get(0)!;
      expect(p0.x).toBeCloseTo(center.x + TILE_SIZE * 0.25);
      expect(p0.y).toBeCloseTo(center.y);
    });

    it("falls back to the generic hub circle when no directedPairs are given", () => {
      const node0 = { id: 0, x: 2, y: 2 };
      const node1 = { id: 1, x: 2, y: 2 };
      const nodePos = buildNodePositions([node0, node1], cfg);
      const center = getCellCenter(2, 2, cfg);
      expect(nodePos.get(0)).toEqual(splitHubPoint(center, 0, 2, cfg));
      expect(nodePos.get(1)).toEqual(splitHubPoint(center, 1, 2, cfg));
    });

    it("falls back to the generic hub circle for a non-degree-4 tessellation (hex)", () => {
      const hexCfg: TessellationConfig = { type: "hex_hexagon", radius: 3 };
      const node0 = { id: 0, x: 0, y: 0 };
      const node1 = { id: 1, x: 0, y: 0 };
      const { offsets } = getNeighborData(hexCfg, 0, 0);
      const [dx0, dy0] = offsets[0];
      const [dx1, dy1] = offsets[1];
      const neighbor0 = { id: 200, x: dx0, y: dy0 };
      const neighbor1 = { id: 201, x: dx1, y: dy1 };
      const directedPairs = [{ from: node0.id, to: neighbor0.id }, { from: node1.id, to: neighbor1.id }];
      const nodePos = buildNodePositions([node0, node1, neighbor0, neighbor1], hexCfg, directedPairs);
      const center = getCellCenter(0, 0, hexCfg);
      expect(nodePos.get(0)).toEqual(splitHubPoint(center, 0, 2, hexCfg));
      expect(nodePos.get(1)).toEqual(splitHubPoint(center, 1, 2, hexCfg));
    });
  });
});

// Web-authored `face_index` (per `getNeighborData`'s offset order) must land on the same physical
// face in `maze-core`'s own `Tessellation::faces()` order once converted — GitHub issue #273.
// Named by axial/cartesian delta (E/N/W/S, E/NE/NW/W/SW/SE) so this test fails if either side's
// face-name-to-delta mapping ever changes, not just the permutation table.
describe("splitFaceIndexToCore", () => {
  it("maps every square web offset to its same-direction core index", () => {
    const cfg: TessellationConfig = { type: "square", width: 3, height: 3 };
    const { offsets } = getNeighborData(cfg, 1, 1);
    const deltaToName: Record<string, string> = { "1,0": "E", "0,1": "N", "-1,0": "W", "0,-1": "S" };
    offsets.forEach(([dx, dy], webIndex) => {
      const name = deltaToName[`${dx},${dy}`];
      expect(SQUARE_CORE_ORDER[splitFaceIndexToCore(cfg, webIndex)]).toBe(name);
    });
  });

  it("maps every hex flat_top web offset to its same-direction core index", () => {
    const cfg: TessellationConfig = { type: "hex_parallelogram", cols: 3, rows: 3, orientation: "flat_top" };
    const { offsets } = getNeighborData(cfg, 1, 1);
    const deltaToName: Record<string, string> = { "1,0": "E", "0,1": "SE", "-1,1": "SW", "-1,0": "W", "0,-1": "NW", "1,-1": "NE" };
    offsets.forEach(([dx, dy], webIndex) => {
      const name = deltaToName[`${dx},${dy}`];
      expect(HEX_CORE_ORDER[splitFaceIndexToCore(cfg, webIndex)]).toBe(name);
    });
  });

  it("maps every hex pointy_top web offset to its same-direction core index", () => {
    const cfg: TessellationConfig = { type: "hex_parallelogram", cols: 3, rows: 3, orientation: "pointy_top" };
    const { offsets } = getNeighborData(cfg, 1, 1);
    const deltaToName: Record<string, string> = { "1,0": "E", "0,1": "SE", "-1,1": "SW", "-1,0": "W", "0,-1": "NW", "1,-1": "NE" };
    offsets.forEach(([dx, dy], webIndex) => {
      const name = deltaToName[`${dx},${dy}`];
      expect(HEX_CORE_ORDER[splitFaceIndexToCore(cfg, webIndex)]).toBe(name);
    });
  });

  it("is identity for triangle tessellations (web/core orders already agree)", () => {
    const cfg: TessellationConfig = { type: "triangle_rect", cols: 3, rows: 3 };
    for (let i = 0; i < 3; i++) expect(splitFaceIndexToCore(cfg, i)).toBe(i);
  });
});

// `splitFaceIndexToWeb`/`splitPatternsToWeb` must invert `splitFaceIndexToCore`/`splitPatternsToCore`
// exactly — a repair/check strategy's `pattern_list`/`split_generation_config` param stores patterns
// in core ordering (GitHub issue #273's `ParamFields.tsx` fix) but re-opening the editor converts
// back to web ordering for `TileFaceEditor`; a round-trip must reproduce the original web indices.
describe("splitFaceIndexToWeb / splitPatternsToWeb (round-trip with *ToCore)", () => {
  const cfgs: [string, TessellationConfig][] = [
    ["square", { type: "square", width: 3, height: 3 }],
    ["hex flat_top", { type: "hex_parallelogram", cols: 3, rows: 3, orientation: "flat_top" }],
    ["hex pointy_top", { type: "hex_parallelogram", cols: 3, rows: 3, orientation: "pointy_top" }],
    ["triangle", { type: "triangle_rect", cols: 3, rows: 3 }],
  ];

  it.each(cfgs)("round-trips every face index for %s", (_label, cfg) => {
    const degree = getNeighborData(cfg, 1, 1).offsets.length;
    for (let webIndex = 0; webIndex < degree; webIndex++) {
      const core = splitFaceIndexToCore(cfg, webIndex);
      expect(splitFaceIndexToWeb(cfg, core)).toBe(webIndex);
    }
  });

  it("splitPatternsToWeb undoes splitPatternsToCore for a full pattern", () => {
    const cfg: TessellationConfig = { type: "hex_parallelogram", cols: 3, rows: 3, orientation: "flat_top" };
    const original: SplitPattern[] = [
      {
        node_count: 2,
        faces: [
          [{ face_index: 0, requirement: { kind: "passage" } }, { face_index: 3, requirement: { kind: "wall" } }],
          [{ face_index: 5, requirement: { kind: "one_way", direction: "forward" }, sibling_target: 0 }],
        ],
        weight: 1.0,
      },
    ];
    const roundTripped = splitPatternsToWeb(splitPatternsToCore(original, cfg), cfg);
    expect(roundTripped).toEqual(original);
  });
});
