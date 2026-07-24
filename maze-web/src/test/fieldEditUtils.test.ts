import { describe, it, expect, vi } from "vitest";

vi.mock("../wasm/wasmLoader", () => ({
  getWasm: () => ({
    // Square tessellation's cartesian projection is the identity — see squareGeometry.ts's doc
    // comment on squareCenter.
    cartesian_coords: (config: { points: [number, number][] }) => config.points,
  }),
}));
import {
  canonicalize,
  edgeKey,
  computeInvalidKeysFromCells,
  computeAutoLockedNodes,
  applyTool,
  computeInvalidTeleportIds,
  computeInvalidMarkers,
  cycleTeleportDirection,
  removeTeleport,
  moveTeleportEndpoint,
  presetTeleportEntryToState,
  pickEdgeAtPosition,
  presetEdgeKey,
  rotatePresetSplitPoint,
} from "../pixi/fieldEditUtils";
import type { PresetConnectionEntry, FieldEdge, PresetTeleportEntry } from "../pixi/fieldEditUtils";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { makeProjection } from "../pixi/tessellationProjection";
import { TILE_SIZE } from "../pixi/constants";

// --- canonicalize ---

describe("canonicalize", () => {
  it("returns smaller x first", () => {
    expect(canonicalize([3, 0], [1, 0])).toEqual([[1, 0], [3, 0]]);
  });

  it("equal x — smaller y first", () => {
    expect(canonicalize([1, 5], [1, 2])).toEqual([[1, 2], [1, 5]]);
  });

  it("already sorted — unchanged", () => {
    expect(canonicalize([0, 0], [1, 0])).toEqual([[0, 0], [1, 0]]);
  });
});

// --- edgeKey ---

describe("edgeKey", () => {
  it("symmetric — same key regardless of order", () => {
    expect(edgeKey([0, 0], [1, 0])).toBe(edgeKey([1, 0], [0, 0]));
  });

  it("format is canonical", () => {
    expect(edgeKey([0, 0], [1, 0])).toBe("0,0-1,0");
  });
});

// --- computeInvalidKeysFromCells ---

const entry = (fx: number, fy: number, tx: number, ty: number): PresetConnectionEntry => ({
  from: presetEndpoint([fx, fy]),
  to: presetEndpoint([tx, ty]),
  state: "passage",
  source: "user",
});

describe("computeInvalidKeysFromCells", () => {
  it("entry with both endpoints in cells — valid", () => {
    const cells: [number, number][] = [[0, 0], [1, 0]];
    const connections = new Map([
      [edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)],
    ]);
    expect(computeInvalidKeysFromCells(connections, cells).size).toBe(0);
  });

  it("entry with one endpoint outside — invalid", () => {
    const cells: [number, number][] = [[0, 0]];
    const connections = new Map([
      [edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)],
    ]);
    const invalid = computeInvalidKeysFromCells(connections, cells);
    expect(invalid.has(edgeKey([0, 0], [1, 0]))).toBe(true);
  });

  it("entry with both endpoints outside — invalid", () => {
    const cells: [number, number][] = [[2, 0]];
    const connections = new Map([
      [edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)],
    ]);
    const invalid = computeInvalidKeysFromCells(connections, cells);
    expect(invalid.size).toBe(1);
  });

  it("empty cells — all entries invalid", () => {
    const connections = new Map([
      [edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)],
    ]);
    expect(computeInvalidKeysFromCells(connections, []).size).toBe(1);
  });

  it("empty connections — no invalid", () => {
    expect(computeInvalidKeysFromCells(new Map(), [[0, 0]]).size).toBe(0);
  });
});

// --- applyTool ---

const fe = (fx: number, fy: number, tx: number, ty: number): FieldEdge => ({
  key: edgeKey([fx, fy], [tx, ty]),
  from: [fx, fy],
  to: [tx, ty],
});

describe("applyTool — wall", () => {
  it("sets edge state to wall", () => {
    const result = applyTool(new Map(), fe(0, 0, 1, 0), "wall");
    expect(result.get(edgeKey([0, 0], [1, 0]))?.state).toBe("wall");
  });

  it("overwrites existing passage with wall", () => {
    const connections = new Map([[edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)]]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "wall");
    expect(result.get(edgeKey([0, 0], [1, 0]))?.state).toBe("wall");
  });
});

describe("applyTool — passage", () => {
  it("sets edge state to passage", () => {
    const result = applyTool(new Map(), fe(0, 0, 1, 0), "passage");
    expect(result.get(edgeKey([0, 0], [1, 0]))?.state).toBe("passage");
  });
});

describe("applyTool — reset", () => {
  it("clears the edge entirely when the default is undefined", () => {
    const connections = new Map([[edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)]]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "reset");
    expect(result.has(edgeKey([0, 0], [1, 0]))).toBe(false);
  });

  it("materializes the current default as a source:\"default\" entry", () => {
    const connections = new Map([[edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)]]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "reset", "wall");
    expect(result.get(edgeKey([0, 0], [1, 0]))).toMatchObject({ state: "wall", source: "default" });
  });

  it("resolves the active split slot before resetting — targets the slot's own key, not the plain point key", () => {
    const activeMap = { "0,0": presetEndpoint([0, 0], 0) };
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0], 0), presetEndpoint([1, 0])), {
        from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "wall" as const, source: "user" as const,
      }],
    ]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "reset", "undefined", activeMap);
    expect(result.has(presetEdgeKey(presetEndpoint([0, 0], 0), presetEndpoint([1, 0])))).toBe(false);
    expect(result.has(edgeKey([0, 0], [1, 0]))).toBe(false);
  });

  it("reset with an active split slot and a non-undefined default materializes the slot-addressed key", () => {
    const activeMap = { "0,0": presetEndpoint([0, 0], 0) };
    const result = applyTool(new Map(), fe(0, 0, 1, 0), "reset", "wall", activeMap);
    const key = presetEdgeKey(presetEndpoint([0, 0], 0), presetEndpoint([1, 0]));
    expect(result.get(key)).toMatchObject({ from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "wall", source: "default" });
  });
});

describe("applyTool — one_way", () => {
  it("no existing entry → sets one_way_forward", () => {
    const result = applyTool(new Map(), fe(0, 0, 1, 0), "one_way");
    expect(result.get(edgeKey([0, 0], [1, 0]))?.state).toBe("one_way_forward");
  });

  it("one_way_forward → one_way_backward", () => {
    const connections = new Map([[
      edgeKey([0, 0], [1, 0]),
      { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "one_way_forward" as const, source: "user" as const },
    ]]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "one_way");
    expect(result.get(edgeKey([0, 0], [1, 0]))?.state).toBe("one_way_backward");
  });

  it("one_way_backward → one_way_forward", () => {
    const connections = new Map([[
      edgeKey([0, 0], [1, 0]),
      { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "one_way_backward" as const, source: "user" as const },
    ]]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "one_way");
    expect(result.get(edgeKey([0, 0], [1, 0]))?.state).toBe("one_way_forward");
  });

  it("does not mutate input map", () => {
    const connections = new Map();
    applyTool(connections, fe(0, 0, 1, 0), "wall");
    expect(connections.size).toBe(0);
  });
});

// --- computeAutoLockedNodes ---

const squareCfg = { type: "square" as const, width: 3, height: 3 };

// 3x3 square grid cells: (-1,-1) to (1,1). Corner (-1,-1) has interior neighbors (0,-1) and (-1,0).
describe("computeAutoLockedNodes", () => {
  it("no connections — no locked nodes", () => {
    const result = computeAutoLockedNodes(new Map(), squareCfg);
    expect(result.size).toBe(0);
  });

  it("corner node with all interior edges defined becomes locked", () => {
    // Corner (-1,-1) has exactly 2 interior neighbors: (0,-1) and (-1,0).
    const connections = new Map([
      [edgeKey([-1, -1], [0, -1]), entry(-1, -1, 0, -1)],
      [edgeKey([-1, -1], [-1, 0]), entry(-1, -1, -1, 0)],
    ]);
    const result = computeAutoLockedNodes(connections, squareCfg);
    expect(result.has("-1,-1")).toBe(true);
  });

  it("corner node with only one interior edge defined is not locked", () => {
    const connections = new Map([
      [edgeKey([-1, -1], [0, -1]), entry(-1, -1, 0, -1)],
    ]);
    const result = computeAutoLockedNodes(connections, squareCfg);
    expect(result.has("-1,-1")).toBe(false);
  });

  it("center node (0,0) with all 4 interior edges defined becomes locked", () => {
    const connections = new Map([
      [edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)],
      [edgeKey([0, 0], [-1, 0]), entry(0, 0, -1, 0)],
      [edgeKey([0, 0], [0, 1]), entry(0, 0, 0, 1)],
      [edgeKey([0, 0], [0, -1]), entry(0, 0, 0, -1)],
    ]);
    const result = computeAutoLockedNodes(connections, squareCfg);
    expect(result.has("0,0")).toBe(true);
  });

  // A declared split point (GitHub issue #234 follow-up) must check every one of its nodes
  // (original + every slot), not just the original's own edges -- a point whose original node
  // has every face decided but whose slot still has an undecided face must not auto-lock.
  it("a split point's slot node with an undecided face is not locked even if the original node's faces are all decided", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([-1, -1]), presetEndpoint([0, -1])), entry(-1, -1, 0, -1)],
      [presetEdgeKey(presetEndpoint([-1, -1]), presetEndpoint([-1, 0])), entry(-1, -1, -1, 0)],
      [presetEdgeKey(presetEndpoint([-1, -1], 0), presetEndpoint([0, -1])), entry(-1, -1, 0, -1)],
      // slot 0's other face, toward (-1,0), has no entry at all -- still undecided.
    ]);
    const result = computeAutoLockedNodes(connections, squareCfg, undefined, { "-1,-1": [0] });
    expect(result.has("-1,-1")).toBe(false);
  });

  it("a split point auto-locks once every one of its nodes has every interior face decided", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([-1, -1]), presetEndpoint([0, -1])), entry(-1, -1, 0, -1)],
      [presetEdgeKey(presetEndpoint([-1, -1]), presetEndpoint([-1, 0])), entry(-1, -1, -1, 0)],
      [presetEdgeKey(presetEndpoint([-1, -1], 0), presetEndpoint([0, -1])), entry(-1, -1, 0, -1)],
      [presetEdgeKey(presetEndpoint([-1, -1], 0), presetEndpoint([-1, 0])), entry(-1, -1, -1, 0)],
    ]);
    const result = computeAutoLockedNodes(connections, squareCfg, undefined, { "-1,-1": [0] });
    expect(result.has("-1,-1")).toBe(true);
  });
});

// --- teleport helpers ---

const teleport = (id: number, from: [number, number], to: [number, number], direction: PresetTeleportEntry["direction"] = "forward"): PresetTeleportEntry => ({
  id, from: presetEndpoint(from), to: presetEndpoint(to), direction,
});

describe("computeInvalidTeleportIds", () => {
  it("both endpoints in field — valid", () => {
    const result = computeInvalidTeleportIds([teleport(1, [-1, -1], [1, 1])], squareCfg);
    expect(result.size).toBe(0);
  });

  it("endpoint outside field — invalid", () => {
    const result = computeInvalidTeleportIds([teleport(1, [-1, -1], [5, 5])], squareCfg);
    expect(result.has(1)).toBe(true);
  });
});

describe("computeInvalidMarkers", () => {
  it("both markers in field — valid", () => {
    const result = computeInvalidMarkers(presetEndpoint([0, 0]), presetEndpoint([1, 1]), squareCfg);
    expect(result).toEqual({ start: false, finish: false });
  });

  it("start outside field — invalid", () => {
    const result = computeInvalidMarkers(presetEndpoint([50, 50]), presetEndpoint([1, 1]), squareCfg);
    expect(result.start).toBe(true);
    expect(result.finish).toBe(false);
  });

  it("finish outside field — invalid", () => {
    const result = computeInvalidMarkers(presetEndpoint([0, 0]), presetEndpoint([50, 50]), squareCfg);
    expect(result.start).toBe(false);
    expect(result.finish).toBe(true);
  });

  it("null markers — valid", () => {
    const result = computeInvalidMarkers(null, null, squareCfg);
    expect(result).toEqual({ start: false, finish: false });
  });
});

describe("cycleTeleportDirection", () => {
  it("forward becomes backward", () => {
    const result = cycleTeleportDirection([teleport(1, [0, 0], [1, 1], "forward")], 1);
    expect(result[0].direction).toBe("backward");
  });

  it("backward becomes forward", () => {
    const result = cycleTeleportDirection([teleport(1, [0, 0], [1, 1], "backward")], 1);
    expect(result[0].direction).toBe("forward");
  });

  it("two_way is unaffected", () => {
    const result = cycleTeleportDirection([teleport(1, [0, 0], [1, 1], "two_way")], 1);
    expect(result[0].direction).toBe("two_way");
  });

  it("other entries are untouched", () => {
    const result = cycleTeleportDirection([teleport(1, [0, 0], [1, 1], "forward"), teleport(2, [0, 0], [1, 1], "forward")], 1);
    expect(result[1].direction).toBe("forward");
  });
});

describe("removeTeleport", () => {
  it("removes the matching entry only", () => {
    const result = removeTeleport([teleport(1, [0, 0], [1, 1]), teleport(2, [0, 0], [1, 1])], 1);
    expect(result.map(t => t.id)).toEqual([2]);
  });
});

describe("moveTeleportEndpoint", () => {
  it("moves the 'from' endpoint of the matching entry", () => {
    const result = moveTeleportEndpoint([teleport(1, [0, 0], [1, 1])], { id: 1, end: "from" }, [5, 5]);
    expect(result[0].from).toEqual(presetEndpoint([5, 5]));
    expect(result[0].to).toEqual(presetEndpoint([1, 1]));
  });

  it("moves the 'to' endpoint of the matching entry", () => {
    const result = moveTeleportEndpoint([teleport(1, [0, 0], [1, 1])], { id: 1, end: "to" }, [5, 5]);
    expect(result[0].to).toEqual(presetEndpoint([5, 5]));
    expect(result[0].from).toEqual(presetEndpoint([0, 0]));
  });
});

// --- pickEdgeAtPosition — vertex dead zone (#188) ---

describe("pickEdgeAtPosition", () => {
  // 2x2 square field: cells (0,0), (1,0), (0,1), (1,1). Their shared corner (grid vertex)
  // sits at viewport (TILE_SIZE, -TILE_SIZE), where the vertical edge between (0,0)/(1,0)
  // meets the horizontal edge between (0,0)/(0,1).
  const cfg = { type: "square" as const, width: 2, height: 2 };
  const cells: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const proj = makeProjection(cfg);
  const vx = proj.gridToScreen(0, 0).x + TILE_SIZE / 2; // = TILE_SIZE, shared corner x
  const vy = proj.gridToScreen(0, 0).y; // = -TILE_SIZE/2, midline of the vertical edge

  it("point in the interior of a vertical edge — picks that edge", () => {
    const edge = pickEdgeAtPosition(vx, vy, cfg, cells);
    expect(edge?.key).toBe(edgeKey([0, 0], [1, 0]));
  });

  it("point right at the shared vertex, deadZone on — no edge picked", () => {
    const cornerY = proj.gridToScreen(0, 0).y + TILE_SIZE / 2; // top of (0,0), the shared corner
    const edge = pickEdgeAtPosition(vx, cornerY, cfg, cells, undefined, true);
    expect(edge).toBeNull();
  });

  it("point just past the dead zone into the segment interior, deadZone on — picks the edge", () => {
    const cornerY = proj.gridToScreen(0, 0).y + TILE_SIZE / 2;
    const edge = pickEdgeAtPosition(vx, cornerY - TILE_SIZE * 0.3, cfg, cells, undefined, true);
    expect(edge?.key).toBe(edgeKey([0, 0], [1, 0]));
  });

  it("point right at the shared vertex, deadZone off (default) — still picks the nearest edge", () => {
    const cornerY = proj.gridToScreen(0, 0).y + TILE_SIZE / 2;
    const edge = pickEdgeAtPosition(vx, cornerY, cfg, cells);
    expect(edge?.key).toBe(edgeKey([0, 0], [1, 0]));
  });
});

describe("presetTeleportEntryToState", () => {
  it("maps forward/backward/two_way to wire states", () => {
    expect(presetTeleportEntryToState("forward")).toBe("teleport_forward");
    expect(presetTeleportEntryToState("backward")).toBe("teleport_backward");
    expect(presetTeleportEntryToState("two_way")).toBe("teleport_two_way");
  });
});

// --- rotatePresetSplitPoint ---

// 3x3 square grid (squareCfg above), center (0,0) has all 4 neighbors in-field.
// SQUARE_NEIGHBOR_OFFSETS order: [0]=E(1,0), [1]=N(0,1), [2]=W(-1,0), [3]=S(0,-1) — direction 1
// rotates E->N->W->S->E, direction -1 the reverse.
const centerCellSet = new Set(["0,0", "1,0", "-1,0", "0,1", "0,-1", "1,1", "-1,1", "1,-1", "-1,-1"]);

describe("rotatePresetSplitPoint", () => {
  it("no split slots — plain point's passage moves from E to N (direction 1)", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const result = rotatePresetSplitPoint(connections, [0, 0], [], 1, squareCfg, centerCellSet);
    expect(result.has(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])))).toBe(false);
    const moved = result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1])));
    expect(moved).toEqual({ from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage", source: "user" });
  });

  it("direction -1 moves E to S", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const result = rotatePresetSplitPoint(connections, [0, 0], [], -1, squareCfg, centerCellSet);
    expect(result.has(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, -1])))).toBe(true);
  });

  it("one-way direction relative to the split point is preserved across the rotation", () => {
    // (0,0) -> (1,0) one-way forward: canonical from=(0,0) (lower x), so state is directly
    // "one_way_forward" meaning "out of (0,0)".
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "one_way_forward" as const, source: "user" as const }],
    ]);
    const result = rotatePresetSplitPoint(connections, [0, 0], [], 1, squareCfg, centerCellSet);
    // New neighbor (0,1): canonical order is still (0,0) first (lower y) — same "out of (0,0)"
    // meaning must still be one_way_forward with (0,0) as `from`.
    const moved = result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1])));
    expect(moved).toEqual({ from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "one_way_forward", source: "user" });
  });

  it("one-way direction flips forward<->backward when canonical order flips across the rotation", () => {
    // (-1,0) -> (0,0): canonical from=(-1,0), meaning "into (0,0)" is one_way_forward here
    // (relative to (0,0), the passage direction is "in").
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([-1, 0]), presetEndpoint([0, 0])), { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "one_way_forward" as const, source: "user" as const }],
    ]);
    // Rotating (0,0) by -1 moves this W-face (index 2) connection to N (index 1): new neighbor
    // (0,1), whose canonical order puts (0,0) first (lower y). Same "into (0,0)" meaning must now
    // read as one_way_backward, since (0,0) is now the canonical `from`.
    const result = rotatePresetSplitPoint(connections, [0, 0], [], -1, squareCfg, centerCellSet);
    const moved = result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1])));
    expect(moved).toEqual({ from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "one_way_backward", source: "user" });
  });

  it("split node's own connection rotates independently of the original node's", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0], 0), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([-1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([-1, 0]), state: "wall" as const, source: "user" as const }],
    ]);
    const result = rotatePresetSplitPoint(connections, [0, 0], [0], 1, squareCfg, centerCellSet);
    expect(result.get(presetEdgeKey(presetEndpoint([0, 0], 0), presetEndpoint([0, 1])))?.state).toBe("passage");
    expect(result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 0], 0)))).toBeUndefined();
    expect(result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, -1])))?.state).toBe("wall");
  });

  it("rotation onto a field boundary is refused entirely — connections unchanged", () => {
    // Corner (-1,-1): only E(0,-1) and N(-1,0) are in-field; W(-2,-1) and S(-1,-2) are boundary.
    // Its N-face connection rotating by +1 (N -> W) would land on the boundary.
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([-1, -1]), presetEndpoint([-1, 0])), { from: presetEndpoint([-1, -1]), to: presetEndpoint([-1, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const result = rotatePresetSplitPoint(connections, [-1, -1], [], 1, squareCfg, centerCellSet);
    expect(result).toBe(connections); // same reference — untouched
  });

  it("no connections at all on this point — no-op, no boundary refusal", () => {
    const connections = new Map<string, PresetConnectionEntry>();
    const result = rotatePresetSplitPoint(connections, [-1, -1], [], 1, squareCfg, centerCellSet);
    expect(result).toEqual(connections);
  });
});
