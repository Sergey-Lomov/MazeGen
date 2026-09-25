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
  computeInvalidEndpoint,
  computeInvalidLockedNodeKeys,
  cycleTeleportDirection,
  removeTeleport,
  moveTeleportEndpoint,
  presetTeleportEntryToState,
  pickEdgeAtPosition,
  presetEdgeKey,
  rotatePresetSplitPoint,
  rotatePresetSplitPointBreaksNeighborShape,
  resolvePresetPartnerAt,
  allNodesAt,
  presetSplitNodeFaceKinds,
  presetConnectionsOnLevel,
  cellExistsAt,
  computeInvalidVerticalPassageIds,
  computeInvalidElevatorIds,
  cycleVerticalPassageDirection,
  moveVerticalPassageEndpoint,
  moveElevatorEndpoint,
  presetVerticalPassageDirectionToDto,
} from "../pixi/fieldEditUtils";
import type { PresetConnectionEntry, FieldEdge, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../pixi/fieldEditUtils";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { makeProjection } from "../pixi/tessellationProjection";
import { TILE_SIZE } from "../pixi/constants";
import type { LevelField, ResolveFieldAt } from "../pixi/fieldEditUtils";

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
  it("stores explicit undefined when the default is undefined", () => {
    const connections = new Map([[edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)]]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "reset");
    expect(result.get(edgeKey([0, 0], [1, 0]))).toMatchObject({ state: "undefined", source: "user" });
  });

  it("stores reset as an explicit undefined user entry", () => {
    const connections = new Map([[edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)]]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "reset", "wall");
    expect(result.get(edgeKey([0, 0], [1, 0]))).toMatchObject({ state: "undefined", source: "user" });
  });

  it("resolves the active split slot before resetting — targets the slot's own key, not the plain point key", () => {
    const activeMap = { "0,0": presetEndpoint([0, 0], 0) };
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0], 0), presetEndpoint([1, 0])), {
        from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "wall" as const, source: "user" as const,
      }],
    ]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "reset", "undefined", activeMap);
    expect(result.get(presetEdgeKey(presetEndpoint([0, 0], 0), presetEndpoint([1, 0])))).toMatchObject({ state: "undefined", source: "user" });
    expect(result.has(edgeKey([0, 0], [1, 0]))).toBe(false);
  });

  it("reset with an active split slot stores the slot-addressed undefined key", () => {
    const activeMap = { "0,0": presetEndpoint([0, 0], 0) };
    const result = applyTool(new Map(), fe(0, 0, 1, 0), "reset", "wall", activeMap);
    const key = presetEdgeKey(presetEndpoint([0, 0], 0), presetEndpoint([1, 0]));
    expect(result.get(key)).toMatchObject({ from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "undefined", source: "user" });
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

// --- presetConnectionsOnLevel ---

describe("presetConnectionsOnLevel", () => {
  const levelEntry = (fx: number, fy: number, tx: number, ty: number, level: number): PresetConnectionEntry => ({
    from: presetEndpoint([fx, fy], undefined, level),
    to: presetEndpoint([tx, ty], undefined, level),
    state: "passage",
    source: "user",
  });

  it("re-keys a non-floor-0 entry to the plain, level-agnostic edgeKey, not presetEdgeKey", () => {
    // Regression for a bug where a wall/passage set on a non-floor-0 floor applied correctly
    // (generation picked it up) but rendered as permanently undecided -- the renderer's
    // level filter kept the level-suffixed presetEdgeKey, which buildPresetWallGroups (looking
    // entries up via plain edgeKey) could never match on any floor but 0.
    const e = levelEntry(0, 0, 1, 0, 1);
    const connections = new Map([[presetEdgeKey(e.from, e.to), e]]);
    const onLevel = presetConnectionsOnLevel(connections, 1);
    expect(onLevel.get(edgeKey([0, 0], [1, 0]))?.state).toBe("passage");
  });

  it("excludes entries from other floors", () => {
    const e = levelEntry(0, 0, 1, 0, 1);
    const connections = new Map([[presetEdgeKey(e.from, e.to), e]]);
    expect(presetConnectionsOnLevel(connections, undefined).size).toBe(0);
    expect(presetConnectionsOnLevel(connections, 2).size).toBe(0);
  });

  it("floor 0 entries keep their existing plain key unchanged", () => {
    const connections = new Map([[edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)]]);
    const onLevel = presetConnectionsOnLevel(connections, undefined);
    expect(onLevel.get(edgeKey([0, 0], [1, 0]))?.state).toBe("passage");
  });

  it("strips level from the stored entry's own from/to, not just the map key", () => {
    // Regression for GitHub issue #424: leaving `.level` set on the returned entry's from/to
    // made presetEndpointKey(entry.from/.to) disagree with every other level-free id computed
    // on this floor (declared split nodes, edgeKey lookups) -- buildPresetSplitPassages then
    // registered the still-leveled endpoint as a brand-new phantom node, fanning stray
    // connector lines from nodes that don't exist in "Manage split nodes".
    const e = levelEntry(0, 0, 1, 0, 1);
    const connections = new Map([[presetEdgeKey(e.from, e.to), e]]);
    const onLevel = presetConnectionsOnLevel(connections, 1);
    const result = onLevel.get(edgeKey([0, 0], [1, 0]));
    expect(result?.from.level).toBeUndefined();
    expect(result?.to.level).toBeUndefined();
  });
});

describe("presetSplitNodeFaceKinds", () => {
  // 3x3 square, point (1,1). Square offsets are [+x, +y, -x, -y] -> neighbors (2,1),(1,2),(0,1),(1,0).
  const cfg = { type: "square" as const, width: 3, height: 3 };
  const inFieldCells = new Set(["0,1", "1,0", "1,1", "1,2", "2,1"]);
  const point: [number, number] = [1, 1];
  const original = presetEndpoint(point);
  const mk = (state: PresetConnectionEntry["state"]) =>
    (a: ReturnType<typeof presetEndpoint>, b: ReturnType<typeof presetEndpoint>): [string, PresetConnectionEntry] =>
      [presetEdgeKey(a, b), { from: a, to: b, state, source: "user" }];

  it("maps passage / wall per face, and an in-field face with no entry to 'undefined'", () => {
    const passage = mk("passage");
    const wall = mk("wall");
    const connections = new Map<string, PresetConnectionEntry>([
      passage(original, presetEndpoint([2, 1])),
      wall(original, presetEndpoint([1, 2])),
      // (0,1) left with no entry -> "undefined"; (1,0) is out of `inFieldCells` -> "wall"
    ]);
    const inField = new Set(["0,1", "1,1", "1,2", "2,1"]);
    const kinds = presetSplitNodeFaceKinds(
      original, point, cfg, inField, connections, { "1,1": [] }, {}, undefined,
    );
    expect(kinds).toEqual(["passage", "wall", "undefined", "wall"]);
  });

  it("distinguishes one_way_out from one_way_in by the entry's stored direction", () => {
    const connections = new Map<string, PresetConnectionEntry>([
      mk("one_way_forward")(original, presetEndpoint([2, 1])),
      mk("one_way_backward")(original, presetEndpoint([0, 1])),
    ]);
    const kinds = presetSplitNodeFaceKinds(
      original, point, cfg, inFieldCells, connections, { "1,1": [] }, {}, undefined,
    );
    // presetEdgeKey canonicalizes (1,1) before (2,1)/(0,1), so `from` stays `original` in both:
    // forward => out toward (2,1); backward => in from (0,1).
    expect(kinds[0]).toBe("one_way_out");
    expect(kinds[2]).toBe("one_way_in");
  });

  it("resolves a floor-scoped split node with level-free endpoints (GitHub issue #596)", () => {
    const floorLevel = 1;
    const originalAtFloor = presetEndpoint(point, undefined, floorLevel);
    const neighborAtFloor = presetEndpoint([2, 1], undefined, floorLevel);
    const globalConnections = new Map([
      [presetEdgeKey(originalAtFloor, neighborAtFloor), {
        from: originalAtFloor,
        to: neighborAtFloor,
        state: "passage" as const,
        source: "user" as const,
      }],
    ]);
    const scopedConnections = presetConnectionsOnLevel(globalConnections, floorLevel);

    // Selectors operating on one floor strip both the endpoint level and the record key suffix.
    // Passing a level-bearing endpoint to this scoped map would miss the passage and return
    // "undefined", which prevents semantic split-node names from being recognized.
    const kinds = presetSplitNodeFaceKinds(
      presetEndpoint(point), point, cfg, inFieldCells, scopedConnections, { "1,1": [0] }, {}, undefined,
    );
    expect(kinds[0]).toBe("passage");
  });
});

// --- computeAutoLockedNodes ---

const squareCfg = { type: "square" as const, width: 3, height: 3 };
const squareLevelFields: LevelField[] = [{ level: undefined, cfg: squareCfg }];
const resolveSquare: ResolveFieldAt = (level) => (level === undefined || level === 0 ? { cfg: squareCfg } : undefined);

// 3x3 square grid cells: (-1,-1) to (1,1). Corner (-1,-1) has interior neighbors (0,-1) and (-1,0).
describe("computeAutoLockedNodes", () => {
  it("no connections — no locked nodes", () => {
    const result = computeAutoLockedNodes(new Map(), squareLevelFields);
    expect(result.size).toBe(0);
  });

  it("corner node with all interior edges defined becomes locked", () => {
    // Corner (-1,-1) has exactly 2 interior neighbors: (0,-1) and (-1,0).
    const connections = new Map([
      [edgeKey([-1, -1], [0, -1]), entry(-1, -1, 0, -1)],
      [edgeKey([-1, -1], [-1, 0]), entry(-1, -1, -1, 0)],
    ]);
    const result = computeAutoLockedNodes(connections, squareLevelFields);
    expect(result.has("-1,-1")).toBe(true);
  });

  it("corner node with only one interior edge defined is not locked", () => {
    const connections = new Map([
      [edgeKey([-1, -1], [0, -1]), entry(-1, -1, 0, -1)],
    ]);
    const result = computeAutoLockedNodes(connections, squareLevelFields);
    expect(result.has("-1,-1")).toBe(false);
  });

  it("center node (0,0) with all 4 interior edges defined becomes locked", () => {
    const connections = new Map([
      [edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)],
      [edgeKey([0, 0], [-1, 0]), entry(0, 0, -1, 0)],
      [edgeKey([0, 0], [0, 1]), entry(0, 0, 0, 1)],
      [edgeKey([0, 0], [0, -1]), entry(0, 0, 0, -1)],
    ]);
    const result = computeAutoLockedNodes(connections, squareLevelFields);
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
    const result = computeAutoLockedNodes(connections, squareLevelFields, { "-1,-1": [0] });
    expect(result.has("-1,-1")).toBe(false);
  });

  it("a split point auto-locks once every one of its nodes has every interior face decided", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([-1, -1]), presetEndpoint([0, -1])), entry(-1, -1, 0, -1)],
      [presetEdgeKey(presetEndpoint([-1, -1]), presetEndpoint([-1, 0])), entry(-1, -1, -1, 0)],
      [presetEdgeKey(presetEndpoint([-1, -1], 0), presetEndpoint([0, -1])), entry(-1, -1, 0, -1)],
      [presetEdgeKey(presetEndpoint([-1, -1], 0), presetEndpoint([-1, 0])), entry(-1, -1, -1, 0)],
    ]);
    const result = computeAutoLockedNodes(connections, squareLevelFields, { "-1,-1": [0] });
    expect(result.has("-1,-1")).toBe(true);
    expect(result.has("-1,-1:0")).toBe(true);
  });

  it("autoblock resolves a decided connection to a neighboring split node", () => {
    const splitPoints = { "-1,-1": [0], "0,-1": [0] };
    const connections = new Map<string, PresetConnectionEntry>();
    const put = (from: ReturnType<typeof presetEndpoint>, to: ReturnType<typeof presetEndpoint>) => {
      connections.set(presetEdgeKey(from, to), {
        from, to, state: "passage", source: "user",
      });
    };
    const points: [number, number][] = [[-1, -1], [0, -1]];
    for (const point of points) {
      const endpoints = [presetEndpoint(point), presetEndpoint(point, 0)];
      for (const from of endpoints) {
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
          if (neighbor[0] < -1 || neighbor[0] > 1 || neighbor[1] < -1 || neighbor[1] > 1) continue;
          const isSplitNeighbor = neighbor[0] === 0 && neighbor[1] === -1;
          const to = isSplitNeighbor
            ? presetEndpoint(neighbor, from.slotId === undefined ? 0 : undefined)
            : presetEndpoint(neighbor);
          put(from, to);
        }
      }
    }

    const result = computeAutoLockedNodes(connections, squareLevelFields, splitPoints);
    expect(result.has("-1,-1")).toBe(true);
    expect(result.has("-1,-1:0")).toBe(true);
    expect(result.has("0,-1")).toBe(true);
    expect(result.has("0,-1:0")).toBe(true);
  });
});

// --- teleport helpers ---

const teleport = (id: number, from: [number, number], to: [number, number], direction: PresetTeleportEntry["direction"] = "forward"): PresetTeleportEntry => ({
  id, from: presetEndpoint(from), to: presetEndpoint(to), direction,
});

describe("computeInvalidTeleportIds", () => {
  it("both endpoints in field — valid", () => {
    const result = computeInvalidTeleportIds([teleport(1, [-1, -1], [1, 1])], resolveSquare);
    expect(result.size).toBe(0);
  });

  it("endpoint outside field — invalid", () => {
    const result = computeInvalidTeleportIds([teleport(1, [-1, -1], [5, 5])], resolveSquare);
    expect(result.has(1)).toBe(true);
  });
});

describe("computeInvalidMarkers", () => {
  it("both markers in field — valid", () => {
    const result = computeInvalidMarkers(presetEndpoint([0, 0]), presetEndpoint([1, 1]), resolveSquare);
    expect(result).toEqual({ start: false, finish: false });
  });

  it("start outside field — invalid", () => {
    const result = computeInvalidMarkers(presetEndpoint([50, 50]), presetEndpoint([1, 1]), resolveSquare);
    expect(result.start).toBe(true);
    expect(result.finish).toBe(false);
  });

  it("finish outside field — invalid", () => {
    const result = computeInvalidMarkers(presetEndpoint([0, 0]), presetEndpoint([50, 50]), resolveSquare);
    expect(result.start).toBe(false);
    expect(result.finish).toBe(true);
  });

  it("null markers — valid", () => {
    const result = computeInvalidMarkers(null, null, resolveSquare);
    expect(result).toEqual({ start: false, finish: false });
  });
});

describe("computeInvalidEndpoint", () => {
  it("detects an endpoint outside the field", () => {
    expect(computeInvalidEndpoint(presetEndpoint([50, 50]), resolveSquare)).toBe(true);
    expect(computeInvalidEndpoint(presetEndpoint([0, 0]), resolveSquare)).toBe(false);
    expect(computeInvalidEndpoint(null, resolveSquare)).toBe(false);
  });
});

describe("computeInvalidLockedNodeKeys", () => {
  it("detects locked nodes outside their floor", () => {
    expect(computeInvalidLockedNodeKeys(new Map([["0,0", "both"], ["5,5", "in"]]), resolveSquare))
      .toEqual(new Set(["5,5"]));
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
    const result = moveTeleportEndpoint([teleport(1, [0, 0], [1, 1])], { id: 1, end: "from" }, [5, 5], 0);
    expect(result[0].from).toEqual(presetEndpoint([5, 5], undefined, 0));
    expect(result[0].to).toEqual(presetEndpoint([1, 1]));
  });

  it("moves the 'to' endpoint of the matching entry", () => {
    const result = moveTeleportEndpoint([teleport(1, [0, 0], [1, 1])], { id: 1, end: "to" }, [5, 5], 0);
    expect(result[0].to).toEqual(presetEndpoint([5, 5], undefined, 0));
    expect(result[0].from).toEqual(presetEndpoint([0, 0]));
  });

  it("preserves the dragged endpoint's floor", () => {
    const entry: PresetTeleportEntry = {
      id: 1,
      from: presetEndpoint([0, 0], undefined, 1),
      to: presetEndpoint([1, 1], undefined, 0),
      direction: "forward",
    };
    const result = moveTeleportEndpoint([entry], { id: 1, end: "from" }, [5, 5], 1);
    expect(result[0].from).toEqual(presetEndpoint([5, 5], undefined, 1));
    expect(result[0].to).toEqual(entry.to);
  });
});

// --- vertical passages / elevators (GitHub issue #357) ---

const resolveTwoFloors: ResolveFieldAt = (level) => ((level ?? 0) === 0 || level === 1 ? { cfg: squareCfg } : undefined);

const verticalPassage = (
  id: number, from: [number, number], to: [number, number], direction: PresetVerticalPassageEntry["direction"] = "forward",
): PresetVerticalPassageEntry => ({ id, from: presetEndpoint(from), to: presetEndpoint(to, undefined, 1), direction });

describe("cellExistsAt", () => {
  it("true for an in-field point on the resolved floor", () => {
    expect(cellExistsAt(resolveTwoFloors, [0, 0], undefined)).toBe(true);
  });

  it("false for an out-of-field point on the resolved floor", () => {
    expect(cellExistsAt(resolveTwoFloors, [50, 50], undefined)).toBe(false);
  });

  it("false when the floor itself doesn't resolve", () => {
    expect(cellExistsAt(resolveTwoFloors, [0, 0], 5)).toBe(false);
  });
});

describe("computeInvalidVerticalPassageIds", () => {
  it("both endpoints in field on their own floor — valid", () => {
    const result = computeInvalidVerticalPassageIds([verticalPassage(1, [0, 0], [0, 0])], resolveTwoFloors);
    expect(result.size).toBe(0);
  });

  it("'to' endpoint outside its own floor's field — invalid", () => {
    const result = computeInvalidVerticalPassageIds([verticalPassage(1, [0, 0], [50, 50])], resolveTwoFloors);
    expect(result.has(1)).toBe(true);
  });

  it("'from' endpoint outside its own floor's field — invalid", () => {
    const result = computeInvalidVerticalPassageIds([verticalPassage(1, [50, 50], [0, 0])], resolveTwoFloors);
    expect(result.has(1)).toBe(true);
  });
});

describe("computeInvalidElevatorIds", () => {
  it("every floor resolves and at least two remain — valid", () => {
    const elevator: PresetElevatorEntry = { id: 1, floors: [presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1)] };
    const result = computeInvalidElevatorIds([elevator], resolveTwoFloors);
    expect(result.size).toBe(0);
  });

  it("one floor's point falls outside its own field — invalid", () => {
    const elevator: PresetElevatorEntry = { id: 1, floors: [presetEndpoint([0, 0]), presetEndpoint([50, 50], undefined, 1)] };
    const result = computeInvalidElevatorIds([elevator], resolveTwoFloors);
    expect(result.has(1)).toBe(true);
  });

  it("fewer than two in-field floors remain — invalid even if every floor itself resolves", () => {
    const elevator: PresetElevatorEntry = { id: 1, floors: [presetEndpoint([0, 0])] };
    const result = computeInvalidElevatorIds([elevator], resolveTwoFloors);
    expect(result.has(1)).toBe(true);
  });
});

describe("cycleVerticalPassageDirection", () => {
  it("forward becomes backward", () => {
    const result = cycleVerticalPassageDirection([verticalPassage(1, [0, 0], [0, 0], "forward")], 1);
    expect(result[0].direction).toBe("backward");
  });

  it("backward becomes forward", () => {
    const result = cycleVerticalPassageDirection([verticalPassage(1, [0, 0], [0, 0], "backward")], 1);
    expect(result[0].direction).toBe("forward");
  });

  it("two_way is unaffected", () => {
    const result = cycleVerticalPassageDirection([verticalPassage(1, [0, 0], [0, 0], "two_way")], 1);
    expect(result[0].direction).toBe("two_way");
  });
});

describe("moveVerticalPassageEndpoint", () => {
  it("moves BOTH ends to the dragged point's (x, y) when it exists on the other end's floor (GitHub issue #566)", () => {
    const result = moveVerticalPassageEndpoint(
      [verticalPassage(1, [0, 0], [0, 0])], { id: 1, end: "from" }, [1, 1], resolveTwoFloors,
    );
    expect(result.failure).toBeUndefined();
    expect(result.passages[0].from).toEqual(presetEndpoint([1, 1]));
    expect(result.passages[0].to).toEqual(presetEndpoint([1, 1], undefined, 1));
  });

  it("moves the 'to' endpoint and syncs 'from' to the same point", () => {
    const result = moveVerticalPassageEndpoint(
      [verticalPassage(1, [0, 0], [0, 0])], { id: 1, end: "to" }, [1, 1], resolveTwoFloors,
    );
    expect(result.failure).toBeUndefined();
    expect(result.passages[0].to).toEqual(presetEndpoint([1, 1], undefined, 1));
    expect(result.passages[0].from).toEqual(presetEndpoint([1, 1], undefined, 0));
  });

  it("reverts the whole move and reports a failure when the other end's floor has no cell there", () => {
    const original = verticalPassage(1, [0, 0], [0, 0]);
    const result = moveVerticalPassageEndpoint([original], { id: 1, end: "from" }, [50, 50], resolveTwoFloors);
    expect(result.failure).toEqual({ level: 1, point: [50, 50] });
    expect(result.passages[0]).toEqual(original);
  });
});

describe("moveElevatorEndpoint", () => {
  const elevator: PresetElevatorEntry = {
    id: 1,
    floors: [presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1)],
  };

  it("moves EVERY floor endpoint to the dragged point's (x, y) when it exists on the other floors (GitHub issue #566)", () => {
    const result = moveElevatorEndpoint([elevator], { id: 1, level: 0 }, [1, 1], resolveTwoFloors);
    expect(result.failure).toBeUndefined();
    expect(result.elevators[0].floors).toEqual([
      presetEndpoint([1, 1]),
      presetEndpoint([1, 1], undefined, 1),
    ]);
  });

  it("reverts the whole move and reports a failure when an OTHER floor has no cell at the dragged point", () => {
    const result = moveElevatorEndpoint([elevator], { id: 1, level: 0 }, [50, 50], resolveTwoFloors);
    expect(result.failure).toEqual({ level: 1, point: [50, 50] });
    expect(result.elevators[0]).toEqual(elevator);
  });
});

describe("presetVerticalPassageDirectionToDto", () => {
  it("two_way maps to undefined (Rust's Option<VerticalPassageDirection>::None)", () => {
    expect(presetVerticalPassageDirectionToDto("two_way")).toBeUndefined();
  });

  it("forward maps to \"forward\"", () => {
    expect(presetVerticalPassageDirectionToDto("forward")).toBe("forward");
  });

  it("backward maps to \"backward\"", () => {
    expect(presetVerticalPassageDirectionToDto("backward")).toBe("backward");
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
    const result = rotatePresetSplitPoint(connections, [0, 0], [], 1, squareCfg, centerCellSet, {}, {});
    expect(result.has(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])))).toBe(false);
    const moved = result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1])));
    expect(moved).toEqual({ from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage", source: "user" });
  });

  it("direction -1 moves E to S", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const result = rotatePresetSplitPoint(connections, [0, 0], [], -1, squareCfg, centerCellSet, {}, {});
    expect(result.has(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, -1])))).toBe(true);
  });

  it("one-way direction relative to the split point is preserved across the rotation", () => {
    // (0,0) -> (1,0) one-way forward: canonical from=(0,0) (lower x), so state is directly
    // "one_way_forward" meaning "out of (0,0)".
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "one_way_forward" as const, source: "user" as const }],
    ]);
    const result = rotatePresetSplitPoint(connections, [0, 0], [], 1, squareCfg, centerCellSet, {}, {});
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
    const result = rotatePresetSplitPoint(connections, [0, 0], [], -1, squareCfg, centerCellSet, {}, {});
    const moved = result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1])));
    expect(moved).toEqual({ from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "one_way_backward", source: "user" });
  });

  it("split node's own connection rotates independently of the original node's", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0], 0), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0], 0), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([-1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([-1, 0]), state: "wall" as const, source: "user" as const }],
    ]);
    const result = rotatePresetSplitPoint(connections, [0, 0], [0], 1, squareCfg, centerCellSet, {}, {});
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
    const result = rotatePresetSplitPoint(connections, [-1, -1], [], 1, squareCfg, centerCellSet, {}, {});
    expect(result).toBe(connections); // same reference — untouched
  });

  it("rotating onto a neighbor whose split slot already forms a finished bridge doesn't add a 3rd face to it (GitHub issue #580 preset counterpart)", () => {
    // Square face order [E,N,W,S] = [0,1,2,3]. Rotating (0,0) by +1 lands the new connection on
    // neighbor (0,1)'s S face (index 3, toward (0,0)) — geometrically that can never be "opposite"
    // a bridge occupying {E,W} = {0,2} (circularDist(3,0,4)=1, circularDist(3,2,4)=1), so geometry
    // evidence can't fire; this exercises the fallback-tier safety guard instead.
    const bridgeSlot = presetEndpoint([0, 1], 0);
    const eastOfNeighbor = presetEndpoint([1, 1]);
    const westOfNeighbor = presetEndpoint([-1, 1]);
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "one_way_forward" as const, source: "user" as const }],
      [presetEdgeKey(bridgeSlot, eastOfNeighbor), { from: bridgeSlot, to: eastOfNeighbor, state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(bridgeSlot, westOfNeighbor), { from: bridgeSlot, to: westOfNeighbor, state: "passage" as const, source: "user" as const }],
    ]);
    const presetSplitPoints = { "0,1": [0] };
    const activeSplitNode = { "0,1": bridgeSlot };
    const result = rotatePresetSplitPoint(connections, [0, 0], [], 1, squareCfg, centerCellSet, presetSplitPoints, activeSplitNode);
    // The neighbor's ORIGINAL node (0 decided faces, safe) gets the new connection instead of the
    // finished bridge slot, even though the bridge slot is active.
    const moved = result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1])));
    expect(moved).toEqual({ from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "one_way_forward", source: "user" });
    // The bridge slot's own two faces must be untouched.
    expect(result.get(presetEdgeKey(bridgeSlot, eastOfNeighbor))?.state).toBe("passage");
    expect(result.get(presetEdgeKey(bridgeSlot, westOfNeighbor))?.state).toBe("passage");
  });

  it("rotating a bridge tile re-stitches the static neighbor's existing bridge slot onto the original node that lands on the shared face — and a SECOND rotation still resolves it correctly (GitHub issue #580 preset second-rotation repro)", () => {
    // Mirrors post-edit's own #580 user repro: two adjacent bridge tiles, (0,0) rotating, (0,1)
    // static, both wired to each other via their own slot 0. After the first rotation, (0,0)'s
    // ORIGINAL node ends up facing (0,1)'s bridge slot — a decided connection between two nodes that
    // are each addressed by a DIFFERENT form (plain vs `slotId`). A second rotation must still
    // recognize that connection when checking `bridgeSlot`'s own decided faces (previously
    // `presetDecidedFaceIndicesOf` only ever checked a neighbor's plain/original form, silently
    // missing any connection actually stored against one of the neighbor's slots).
    const bridgeSlot = presetEndpoint([0, 1], 0);
    const east = presetEndpoint([1, 0]);
    const west = presetEndpoint([-1, 0]);
    const original = presetEndpoint([0, 0]);
    const slot = presetEndpoint([0, 0], 0);
    const connections = new Map([
      // (0,0)'s original: E/W through-passage, unrelated to the neighbor.
      [presetEdgeKey(original, east), { from: original, to: east, state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(original, west), { from: original, to: west, state: "passage" as const, source: "user" as const }],
      // (0,0)'s slot 0: N face, bridge-to-bridge with the static neighbor's own bridge slot.
      [presetEdgeKey(slot, bridgeSlot), { from: slot, to: bridgeSlot, state: "passage" as const, source: "user" as const }],
    ]);
    const presetSplitPoints = { "0,0": [0], "0,1": [0] };

    // First rotation (direction 1): original's E face moves to N (now facing the static neighbor),
    // slot's N face moves to W (now unrelated).
    const afterFirst = rotatePresetSplitPoint(connections, [0, 0], [0], 1, squareCfg, centerCellSet, presetSplitPoints, {});
    const firstMoved = afterFirst.get(presetEdgeKey(original, bridgeSlot));
    expect(firstMoved).toEqual({ from: original, to: bridgeSlot, state: "passage", source: "user" });
    // The stale bridge-to-bridge entry must be explicitly walled off, not left as a missing/"undefined" face.
    expect(afterFirst.get(presetEdgeKey(slot, bridgeSlot))?.state).toBe("wall");

    // Second rotation: original's N face (now facing the bridge) moves to W, slot's W face moves to S.
    // The bridge slot's connection to `original` must still be recognized as a real decided face
    // (not silently dropped/misrouted to the neighbor's original) when resolving this move.
    // Second rotation, same direction: original's N face (now facing the bridge) moves to W —
    // `selectExistingPresetFaceOwner` must recognize `bridgeSlot`'s decided face toward `original`
    // on this exact (E, from the neighbor's side) face and keep the connection intact via the new
    // (-1,0) neighbor's real node — not fall through to some unrelated candidate. Since (-1,0) isn't
    // itself split, the connection lands on its plain form; the point under test is that the tier
    // before it (existing-connection reuse against `bridgeSlot`) doesn't wrongly disturb `bridgeSlot`
    // itself, and `bridgeSlot`'s own two faces stay exactly as they were.
    const afterSecond = rotatePresetSplitPoint(afterFirst, [0, 0], [0], 1, squareCfg, centerCellSet, presetSplitPoints, {});
    expect(afterSecond.get(presetEdgeKey(presetEndpoint([-1, 0]), original))?.state).toBe("passage");
    // `bridgeSlot` must have exactly one face now (toward nothing from `point`'s side any more) —
    // the stale bridge-to-bridge entry must be explicitly walled, not left dangling alongside a new one.
    expect(afterSecond.get(presetEdgeKey(original, bridgeSlot))?.state).toBe("wall");
    expect(afterSecond.get(presetEdgeKey(slot, bridgeSlot))?.state).toBe("wall");
  });

  it("selectExistingPresetFaceOwner recognizes a decided face against a neighbor's SPLIT slot, not just its original (GitHub issue #580 preset second-rotation repro)", () => {
    // The exact failing condition: `point`'s original already connects to neighbor (0,1)'s SLOT 0
    // (not its original) on the face that IS the new target face for an incoming rotation — before
    // the fix, `presetDecidedFaceIndicesOf` only ever checked the neighbor's plain/original form, so
    // this real, already-standing connection was invisible to `selectExistingPresetFaceOwner`,
    // wrongly falling through to the geometry/fallback tier and re-wiring the face onto the
    // neighbor's ORIGINAL node instead of leaving the existing slot connection alone.
    const original = presetEndpoint([0, 0]);
    const bridgeSlot = presetEndpoint([0, 1], 0);
    const eastOfNeighbor = presetEndpoint([1, 1]);
    const westOfNeighbor = presetEndpoint([-1, 1]);
    const connections = new Map([
      [presetEdgeKey(original, bridgeSlot), { from: original, to: bridgeSlot, state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(bridgeSlot, eastOfNeighbor), { from: bridgeSlot, to: eastOfNeighbor, state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(bridgeSlot, westOfNeighbor), { from: bridgeSlot, to: westOfNeighbor, state: "passage" as const, source: "user" as const }],
    ]);
    const presetSplitPoints = { "0,1": [0] };
    // Rotating (0,0) by -1 moves its (only) N-face passage to E — a brand-new move that must resolve
    // the OLD neighbor side correctly too (via `bridgeSlot`, found through `allNodesAt`), independent
    // of the actual bug under test, then land on a fresh E-face connection.
    const result = rotatePresetSplitPoint(connections, [0, 0], [], -1, squareCfg, centerCellSet, presetSplitPoints, {});
    // The bridge slot's connection to `original` must be explicitly walled (the point's N face moved
    // away) and NOT silently re-attached to the neighbor's original node — `original` itself moved to face E.
    expect(result.get(presetEdgeKey(original, bridgeSlot))?.state).toBe("wall");
    expect(result.has(presetEdgeKey(original, presetEndpoint([0, 1])))).toBe(false);
    // The bridge slot's own two faces are untouched — the rotation of (0,0) must not perturb them.
    expect(result.get(presetEdgeKey(bridgeSlot, eastOfNeighbor))?.state).toBe("passage");
    expect(result.get(presetEdgeKey(bridgeSlot, westOfNeighbor))?.state).toBe("passage");
  });

  it("no connections at all on this point — no-op, no boundary refusal", () => {
    const connections = new Map<string, PresetConnectionEntry>();
    const result = rotatePresetSplitPoint(connections, [-1, -1], [], 1, squareCfg, centerCellSet, {}, {});
    expect(result).toEqual(connections);
  });

  it("old neighbor's connection lives on its SPLIT slot, not its original node — still found and moved (GitHub issue #580 preset counterpart)", () => {
    // Old neighbor (0,1) declares a slot 0; the passage from (0,0) actually connects to that slot,
    // not (0,1)'s original node. The old-neighbor lookup must search every declared node of (0,1),
    // not just presetEndpoint([0,1]).
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1], 0)), { from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1], 0), state: "passage" as const, source: "user" as const }],
    ]);
    const presetSplitPoints = { "0,1": [0] };
    const result = rotatePresetSplitPoint(connections, [0, 0], [], 1, squareCfg, centerCellSet, presetSplitPoints, {});
    expect(result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1], 0)))?.state).toBe("wall");
    const moved = result.get(presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([-1, 0])));
    expect(moved?.state).toBe("passage");
  });

  it("a neighbor's slot already connected to `point` on the exact target face keeps that connection as-is, even though it also forms a finished bridge (GitHub issue #580 user repro, preset counterpart)", () => {
    // Point (0,0) has a passage on its N-face (to (0,1)) and another on its W-face (to neighbor
    // (-1,0)'s slot 0, which also forms a finished E/W bridge — its other face goes to (-2,0)).
    // Rotating direction 1 moves the N-face passage onto W (landing on (-1,0)) and the W-face
    // passage onto S (landing on (0,-1)) at the same time. The neighbor's slot 0 already has a
    // REAL decided connection on exactly the face the N-face move is landing on (its own E face,
    // toward `point`) — that existing partner simply carries over via `point`'s original node
    // (unchanged content, since it was already exactly this), regardless of it being a finished
    // bridge; the geometry/fallback "avoid disturbing a finished bridge" tier only applies when
    // there is no real existing connection to defer to.
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1])), { from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([-1, 0], 0), presetEndpoint([0, 0])), { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0]), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([-1, 0], 0), presetEndpoint([-2, 0])), { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([-2, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const presetSplitPoints = { "-1,0": [0] };
    const presetActiveSplitNode = { "-1,0": presetEndpoint([-1, 0], 0) };
    const result = rotatePresetSplitPoint(connections, [0, 0], [], 1, squareCfg, centerCellSet, presetSplitPoints, presetActiveSplitNode);
    // The bridge slot's connection to `point`'s original stands, untouched.
    expect(result.get(presetEdgeKey(presetEndpoint([-1, 0], 0), presetEndpoint([0, 0])))?.state).toBe("passage");
    // The W-face move (formerly toward the bridge slot) lands on the new S neighbor's original node.
    expect(result.get(presetEdgeKey(presetEndpoint([0, -1]), presetEndpoint([0, 0])))?.state).toBe("passage");
    // The bridge slot's OTHER face (toward (-2,0)) is untouched — still a two-face bridge, not three.
    expect(result.get(presetEdgeKey(presetEndpoint([-1, 0], 0), presetEndpoint([-2, 0])))?.state).toBe("passage");
  });

  it("control: no finished bridge on the new neighbor — active slot is honored as usual", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1])), { from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([-1, 0], 0), presetEndpoint([-2, 0])), { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([-2, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const presetSplitPoints = { "-1,0": [0] };
    const presetActiveSplitNode = { "-1,0": presetEndpoint([-1, 0], 0) };
    const result = rotatePresetSplitPoint(connections, [0, 0], [], 1, squareCfg, centerCellSet, presetSplitPoints, presetActiveSplitNode);
    const moved = result.get(presetEdgeKey(presetEndpoint([-1, 0], 0), presetEndpoint([0, 0])));
    expect(moved?.state).toBe("passage");
  });

  it("every node of the new neighbor already holds a finished bridge — the new face is refused outright, not wired onto the least-bad option", () => {
    // Neighbor (-1,0)'s slot 0 AND its original node each already hold their own complete N/S
    // opposite pair (toward (-1,1) and (-1,-1) — two independent edges per neighbor node, unrelated
    // to `point`). There is no safe candidate left at all for the new E-face connection (toward
    // `point`): picking either would corrupt it, so the rotate must leave this connection unwritten
    // instead of guessing (the actual repro: a bridge tile rotated onto a neighbor that's itself a
    // finished two-node bridge on both its own nodes).
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([0, 1])), { from: presetEndpoint([0, 0]), to: presetEndpoint([0, 1]), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([-1, 1]), presetEndpoint([-1, 0], 0)), { from: presetEndpoint([-1, 1]), to: presetEndpoint([-1, 0], 0), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([-1, -1]), presetEndpoint([-1, 0], 0)), { from: presetEndpoint([-1, -1]), to: presetEndpoint([-1, 0], 0), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([-1, 1]), presetEndpoint([-1, 0])), { from: presetEndpoint([-1, 1]), to: presetEndpoint([-1, 0]), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([-1, -1]), presetEndpoint([-1, 0])), { from: presetEndpoint([-1, -1]), to: presetEndpoint([-1, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const presetSplitPoints = { "-1,0": [0] };
    const presetActiveSplitNode = { "-1,0": presetEndpoint([-1, 0], 0) };
    const result = rotatePresetSplitPoint(connections, [0, 0], [], 1, squareCfg, centerCellSet, presetSplitPoints, presetActiveSplitNode);
    // Neither the slot nor the original gained a 3rd face — the point's own connection to the
    // neighbor is simply not written for the new (W) face at all.
    expect(result.has(presetEdgeKey(presetEndpoint([-1, 0], 0), presetEndpoint([0, 0])))).toBe(false);
    expect(result.has(presetEdgeKey(presetEndpoint([-1, 0]), presetEndpoint([0, 0])))).toBe(false);
  });
});

// --- rotatePresetSplitPointBreaksNeighborShape (GitHub issue #588) ---

describe("rotatePresetSplitPointBreaksNeighborShape", () => {
  // 5x5 field so a split point one step off-center still has all 4 of its own neighbors in-field
  // (`centerCellSet` above only fits a split point AT the center).
  const wideCellSet = new Set<string>();
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) wideCellSet.add(`${x},${y}`);

  it("rotating an unsplit point breaks a split neighbor's recognized bridge shape", () => {
    // Neighbor (1,0) is a degree-4 bridge: original node E-W (E=(2,0), W=(0,0) — the rotating
    // point), slot 0 N-S (N=(1,1), S=(1,-1)). Every non-participating face is explicit `wall` —
    // `detectSplitSpecialShapeKind` counts a preset's default `"undefined"` face as connected too
    // (only `"wall"` excludes it), so a face left unset would wrongly look connected.
    const neighborOriginal = presetEndpoint([1, 0]);
    const neighborSlot = presetEndpoint([1, 0], 0);
    const center = presetEndpoint([0, 0]);
    const connections = new Map([
      [presetEdgeKey(neighborOriginal, presetEndpoint([2, 0])), { from: neighborOriginal, to: presetEndpoint([2, 0]), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(neighborOriginal, center), { from: center, to: neighborOriginal, state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(neighborOriginal, presetEndpoint([1, 1])), { from: neighborOriginal, to: presetEndpoint([1, 1]), state: "wall" as const, source: "user" as const }],
      [presetEdgeKey(neighborOriginal, presetEndpoint([1, -1])), { from: presetEndpoint([1, -1]), to: neighborOriginal, state: "wall" as const, source: "user" as const }],
      [presetEdgeKey(neighborSlot, presetEndpoint([1, 1])), { from: neighborSlot, to: presetEndpoint([1, 1]), state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(neighborSlot, presetEndpoint([1, -1])), { from: presetEndpoint([1, -1]), to: neighborSlot, state: "passage" as const, source: "user" as const }],
      [presetEdgeKey(neighborSlot, presetEndpoint([2, 0])), { from: neighborSlot, to: presetEndpoint([2, 0]), state: "wall" as const, source: "user" as const }],
      [presetEdgeKey(neighborSlot, center), { from: center, to: neighborSlot, state: "wall" as const, source: "user" as const }],
    ]);
    const presetSplitPoints = { "1,0": [0] };

    // Rotating the (unsplit) center by +1 moves its E-face passage to N — (1,0)'s original node
    // loses its W-face connection to `center` and, being itself split, gets it wall-compensated
    // instead of just vanishing, dropping it to 1 connected face (E only) — no longer a bridge.
    const broken = rotatePresetSplitPointBreaksNeighborShape(connections, [0, 0], [], 1, squareCfg, wideCellSet, presetSplitPoints, {});
    expect(broken).toBe(true);

    // The reverse direction (-1) moves the E-face passage to S instead — same outcome.
    const brokenOtherDirection = rotatePresetSplitPointBreaksNeighborShape(connections, [0, 0], [], -1, squareCfg, wideCellSet, presetSplitPoints, {});
    expect(brokenOtherDirection).toBe(true);
  });

  it("no-op rotation (nothing wired at the rotating point) never reports a break", () => {
    const presetSplitPoints = { "1,0": [0] };
    const broken = rotatePresetSplitPointBreaksNeighborShape(new Map(), [0, 0], [], 1, squareCfg, wideCellSet, presetSplitPoints, {});
    expect(broken).toBe(false);
  });

  it("rotating next to a plain (non-split) neighbor never reports a break", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const broken = rotatePresetSplitPointBreaksNeighborShape(connections, [0, 0], [], 1, squareCfg, wideCellSet, {}, {});
    expect(broken).toBe(false);
  });
});

// --- allNodesAt ---

describe("allNodesAt", () => {
  it("returns just the original endpoint for an undeclared point", () => {
    expect(allNodesAt([0, 0], {})).toEqual([presetEndpoint([0, 0])]);
  });

  it("returns the original plus every declared slot, in slot order", () => {
    expect(allNodesAt([0, 0], { "0,0": [1, 0] })).toEqual([
      presetEndpoint([0, 0]),
      presetEndpoint([0, 0], 1),
      presetEndpoint([0, 0], 0),
    ]);
  });
});

// --- resolvePresetPartnerAt ---

describe("resolvePresetPartnerAt (GitHub issue #243)", () => {
  it("returns the neighbor's real connecting node when it has a decided passage", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0], 0)), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0], 0), state: "passage" as const, source: "user" as const }],
    ]);
    const result = resolvePresetPartnerAt([presetEndpoint([0, 0])], [1, 0], connections, { "1,0": [0] }, {});
    expect(result).toEqual(presetEndpoint([1, 0], 0));
  });

  it("a passage to a later candidate wins over an explicit wall to an earlier candidate", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0])), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall" as const, source: "user" as const }],
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0], 0)), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0], 0), state: "passage" as const, source: "user" as const }],
    ]);
    const result = resolvePresetPartnerAt([presetEndpoint([0, 0])], [1, 0], connections, { "1,0": [0] }, {});
    expect(result).toEqual(presetEndpoint([1, 0], 0));
  });

  it("falls back to a wall match when no candidate has a decided passage", () => {
    const connections = new Map([
      [presetEdgeKey(presetEndpoint([0, 0]), presetEndpoint([1, 0], 0)), { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0], 0), state: "wall" as const, source: "user" as const }],
    ]);
    const result = resolvePresetPartnerAt([presetEndpoint([0, 0])], [1, 0], connections, { "1,0": [0] }, {});
    expect(result).toEqual(presetEndpoint([1, 0], 0));
  });

  it("falls back to the active-slot resolution when the neighbor has no decided entry at all", () => {
    const result = resolvePresetPartnerAt([presetEndpoint([0, 0])], [1, 0], new Map(), { "1,0": [0] }, { "1,0": presetEndpoint([1, 0], 0) });
    expect(result).toEqual(presetEndpoint([1, 0], 0));
  });

  it("falls back to the neighbor's original node when nothing is decided and nothing is active", () => {
    const result = resolvePresetPartnerAt([presetEndpoint([0, 0])], [1, 0], new Map(), { "1,0": [0] }, {});
    expect(result).toEqual(presetEndpoint([1, 0]));
  });
});
