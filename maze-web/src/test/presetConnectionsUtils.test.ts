import { describe, it, expect } from "vitest";
import {
  canonicalize,
  edgeKey,
  computeInvalidKeysFromCells,
  computeAutoLockedNodes,
  applyTool,
  computeInvalidTeleportIds,
  cycleTeleportDirection,
  removeTeleport,
  moveTeleportEndpoint,
  presetTeleportEntryToState,
} from "../pixi/presetConnectionsUtils";
import type { PresetConnectionEntry, FieldEdge, PresetTeleportEntry } from "../pixi/presetConnectionsUtils";

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
  from: [fx, fy],
  to: [tx, ty],
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
  it("sets edge to undefined state with user source", () => {
    const connections = new Map([[edgeKey([0, 0], [1, 0]), entry(0, 0, 1, 0)]]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "reset");
    expect(result.get(edgeKey([0, 0], [1, 0]))).toMatchObject({ state: "undefined", source: "user" });
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
      { from: [0, 0] as [number, number], to: [1, 0] as [number, number], state: "one_way_forward" as const, source: "user" as const },
    ]]);
    const result = applyTool(connections, fe(0, 0, 1, 0), "one_way");
    expect(result.get(edgeKey([0, 0], [1, 0]))?.state).toBe("one_way_backward");
  });

  it("one_way_backward → one_way_forward", () => {
    const connections = new Map([[
      edgeKey([0, 0], [1, 0]),
      { from: [0, 0] as [number, number], to: [1, 0] as [number, number], state: "one_way_backward" as const, source: "user" as const },
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
});

// --- teleport helpers ---

const teleport = (id: number, from: [number, number], to: [number, number], direction: PresetTeleportEntry["direction"] = "forward"): PresetTeleportEntry => ({
  id, from, to, direction,
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
    expect(result[0].from).toEqual([5, 5]);
    expect(result[0].to).toEqual([1, 1]);
  });

  it("moves the 'to' endpoint of the matching entry", () => {
    const result = moveTeleportEndpoint([teleport(1, [0, 0], [1, 1])], { id: 1, end: "to" }, [5, 5]);
    expect(result[0].to).toEqual([5, 5]);
    expect(result[0].from).toEqual([0, 0]);
  });
});

describe("presetTeleportEntryToState", () => {
  it("maps forward/backward/two_way to wire states", () => {
    expect(presetTeleportEntryToState("forward")).toBe("teleport_forward");
    expect(presetTeleportEntryToState("backward")).toBe("teleport_backward");
    expect(presetTeleportEntryToState("two_way")).toBe("teleport_two_way");
  });
});
