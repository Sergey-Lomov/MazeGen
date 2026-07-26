import { describe, it, expect } from "vitest";
import { buildPostEditDraftEdgesFromGenerated, applyPostEditEdgeTool, extractPostEditTeleports, postEditTeleportsToDto, rotatePostEditSplitPoint } from "../pixi/postEditUtils";
import { nodeEndpoint, splitEndpoint, edgeKey, type PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { EdgeDto, NodeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";

const noSplits = () => undefined;

// --- buildPostEditDraftEdgesFromGenerated ---

describe("buildPostEditDraftEdgesFromGenerated", () => {
  it("bidirectional edges become basic", () => {
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" }];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    expect(result[edgeKey(nodeEndpoint(0), nodeEndpoint(1))].kind).toBe("basic");
    expect(result[edgeKey(nodeEndpoint(1), nodeEndpoint(0))].kind).toBe("basic");
  });

  it("single directed edge becomes one_way_forward", () => {
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    expect(result[edgeKey(nodeEndpoint(0), nodeEndpoint(1))].kind).toBe("one_way_forward");
    expect(result[edgeKey(nodeEndpoint(1), nodeEndpoint(0))]).toBeUndefined();
  });

  it("empty edges returns empty record", () => {
    expect(buildPostEditDraftEdgesFromGenerated([])).toEqual({});
  });

  it("preserves from/to on each entry as node endpoints", () => {
    const edges: EdgeDto[] = [{ from: 3, to: 7, kind: "basic" }];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    const key = edgeKey(nodeEndpoint(3), nodeEndpoint(7));
    expect(result[key].from).toEqual(nodeEndpoint(3));
    expect(result[key].to).toEqual(nodeEndpoint(7));
  });

  it("mix of one-way and bidirectional", () => {
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" },
      { from: 2, to: 3, kind: "basic" },
    ];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    expect(result[edgeKey(nodeEndpoint(0), nodeEndpoint(1))].kind).toBe("basic");
    expect(result[edgeKey(nodeEndpoint(1), nodeEndpoint(0))].kind).toBe("basic");
    expect(result[edgeKey(nodeEndpoint(2), nodeEndpoint(3))].kind).toBe("one_way_forward");
  });

  it("ignores teleport edges entirely, even parallel to a Basic edge in the same direction", () => {
    // A Teleport and a Basic edge can coexist in the same direction between the same pair —
    // teleport must not appear in this Record at all (it's tracked separately, see
    // extractPostEditTeleports), and must not shadow or be shadowed by the Basic entry.
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" },
      { from: 0, to: 1, kind: "teleport" },
    ];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    const fwdKey = edgeKey(nodeEndpoint(0), nodeEndpoint(1));
    const bwdKey = edgeKey(nodeEndpoint(1), nodeEndpoint(0));
    expect(result[fwdKey]).toEqual({ from: nodeEndpoint(0), to: nodeEndpoint(1), kind: "basic" });
    expect(Object.keys(result).sort()).toEqual([fwdKey, bwdKey].sort());
  });
});

// --- extractPostEditTeleports ---

describe("extractPostEditTeleports", () => {
  it("returns only teleport-kind edges as forward entries", () => {
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "basic" },
      { from: 2, to: 3, kind: "teleport" },
    ];
    expect(extractPostEditTeleports(edges).teleports).toEqual([
      { id: 1, from: nodeEndpoint(2), to: nodeEndpoint(3), direction: "forward" },
    ]);
  });

  it("collapses a forward+backward pair into one two_way entry", () => {
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "teleport" },
      { from: 1, to: 0, kind: "teleport" },
      { from: 2, to: 3, kind: "teleport" },
    ];
    expect(extractPostEditTeleports(edges).teleports).toEqual([
      { id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" },
      { id: 2, from: nodeEndpoint(2), to: nodeEndpoint(3), direction: "forward" },
    ]);
  });

  it("empty input returns empty array", () => {
    expect(extractPostEditTeleports([]).teleports).toEqual([]);
  });

  it("no teleport edges returns empty array", () => {
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }];
    expect(extractPostEditTeleports(edges).teleports).toEqual([]);
  });
});

// --- postEditTeleportsToDto ---

describe("postEditTeleportsToDto", () => {
  it("forward entry produces one edge in the stored direction", () => {
    expect(postEditTeleportsToDto([{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" }], noSplits))
      .toEqual([{ from: 0, to: 1, kind: "teleport" }]);
  });

  it("backward entry produces one edge reversed", () => {
    expect(postEditTeleportsToDto([{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward" }], noSplits))
      .toEqual([{ from: 1, to: 0, kind: "teleport" }]);
  });

  it("two_way entry produces both directions", () => {
    expect(postEditTeleportsToDto([{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" }], noSplits))
      .toEqual([{ from: 0, to: 1, kind: "teleport" }, { from: 1, to: 0, kind: "teleport" }]);
  });

  it("drops an entry whose split endpoint doesn't resolve yet", () => {
    const teleports = [{ id: 1, from: splitEndpoint([1, 2], 0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(postEditTeleportsToDto(teleports, noSplits)).toEqual([]);
  });

  it("resolves a split endpoint via resolveSplit", () => {
    const teleports = [{ id: 1, from: splitEndpoint([1, 2], 0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(postEditTeleportsToDto(teleports, () => 42)).toEqual([{ from: 42, to: 1, kind: "teleport" }]);
  });
});

// --- applyPostEditEdgeTool ---

const fwd = (from: number, to: number): PostEditEdge => ({ from: nodeEndpoint(from), to: nodeEndpoint(to), kind: "one_way_forward" });
const basic = (from: number, to: number): PostEditEdge => ({ from: nodeEndpoint(from), to: nodeEndpoint(to), kind: "basic" });
const key = (from: number, to: number) => edgeKey(nodeEndpoint(from), nodeEndpoint(to));

describe("applyPostEditEdgeTool — wall", () => {
  it("removes both directions", () => {
    const edges = { [key(0, 1)]: basic(0, 1), [key(1, 0)]: basic(1, 0) };
    const result = applyPostEditEdgeTool(edges, "wall", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), []);
    expect(result[key(0, 1)]).toBeUndefined();
    expect(result[key(1, 0)]).toBeUndefined();
  });

  it("no-op on already empty edge", () => {
    const result = applyPostEditEdgeTool({}, "wall", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), []);
    expect(result).toEqual({});
  });
});

describe("applyPostEditEdgeTool — passage", () => {
  it("adds both directions as basic", () => {
    const result = applyPostEditEdgeTool({}, "passage", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), []);
    expect(result[key(0, 1)]).toEqual({ from: nodeEndpoint(0), to: nodeEndpoint(1), kind: "basic" });
    expect(result[key(1, 0)]).toEqual({ from: nodeEndpoint(1), to: nodeEndpoint(0), kind: "basic" });
  });

  it("overwrites existing one_way with basic", () => {
    const edges = { [key(0, 1)]: fwd(0, 1) };
    const result = applyPostEditEdgeTool(edges, "passage", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), []);
    expect(result[key(0, 1)].kind).toBe("basic");
    expect(result[key(1, 0)].kind).toBe("basic");
  });
});

describe("applyPostEditEdgeTool — one_way", () => {
  it("fwd edge → bwd", () => {
    const edges = { [key(0, 1)]: fwd(0, 1) };
    const result = applyPostEditEdgeTool(edges, "one_way", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), []);
    expect(result[key(0, 1)]).toBeUndefined();
    expect(result[key(1, 0)]).toEqual({ from: nodeEndpoint(1), to: nodeEndpoint(0), kind: "one_way_backward" });
  });

  it("no fwd edge → sets fwd", () => {
    const result = applyPostEditEdgeTool({}, "one_way", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), []);
    expect(result[key(0, 1)]).toEqual({ from: nodeEndpoint(0), to: nodeEndpoint(1), kind: "one_way_forward" });
    expect(result[key(1, 0)]).toBeUndefined();
  });

  it("bwd edge present, clicking fwd key → replaces with fwd", () => {
    const edges = { [key(1, 0)]: { from: nodeEndpoint(1), to: nodeEndpoint(0), kind: "one_way_backward" as const } };
    const result = applyPostEditEdgeTool(edges, "one_way", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), []);
    expect(result[key(0, 1)]).toEqual({ from: nodeEndpoint(0), to: nodeEndpoint(1), kind: "one_way_forward" });
    expect(result[key(1, 0)]).toBeUndefined();
  });
});

describe("applyPostEditEdgeTool — reset", () => {
  it("restores bidirectional when original had both", () => {
    const orig: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" }];
    const edges = {};
    const result = applyPostEditEdgeTool(edges, "reset", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), orig);
    expect(result[key(0, 1)]).toEqual({ from: nodeEndpoint(0), to: nodeEndpoint(1), kind: "basic" });
    expect(result[key(1, 0)]).toEqual({ from: nodeEndpoint(1), to: nodeEndpoint(0), kind: "basic" });
  });

  it("restores one_way_forward when original had only forward", () => {
    const orig: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }];
    const result = applyPostEditEdgeTool({ [key(1, 0)]: basic(1, 0) }, "reset", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), orig);
    expect(result[key(0, 1)]).toEqual({ from: nodeEndpoint(0), to: nodeEndpoint(1), kind: "one_way_forward" });
    expect(result[key(1, 0)]).toBeUndefined();
  });

  it("restores one_way_forward (bwd slot) when original had only backward", () => {
    const orig: EdgeDto[] = [{ from: 1, to: 0, kind: "basic" }];
    const result = applyPostEditEdgeTool({ [key(0, 1)]: basic(0, 1) }, "reset", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), orig);
    expect(result[key(1, 0)]).toEqual({ from: nodeEndpoint(1), to: nodeEndpoint(0), kind: "one_way_forward" });
    expect(result[key(0, 1)]).toBeUndefined();
  });

  it("deletes both entries when edge was wall in original", () => {
    const orig: EdgeDto[] = [];
    const edges = { [key(0, 1)]: basic(0, 1), [key(1, 0)]: basic(1, 0) };
    const result = applyPostEditEdgeTool(edges, "reset", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), orig);
    expect(result[key(0, 1)]).toBeUndefined();
    expect(result[key(1, 0)]).toBeUndefined();
  });

  it("does not mutate input edges", () => {
    const edges = { [key(0, 1)]: basic(0, 1) };
    applyPostEditEdgeTool(edges, "wall", key(0, 1), nodeEndpoint(0), nodeEndpoint(1), []);
    expect(edges[key(0, 1)]).toBeDefined();
  });

  it("a split endpoint (not yet in originalEdges) is never matched by reset", () => {
    const orig: EdgeDto[] = [{ from: 0, to: 1, kind: "basic" }];
    const from = splitEndpoint([5, 5], 0);
    const to = nodeEndpoint(1);
    const result = applyPostEditEdgeTool({}, "reset", edgeKey(from, to), from, to, orig);
    expect(result[edgeKey(from, to)]).toBeUndefined();
    expect(result[edgeKey(to, from)]).toBeUndefined();
  });
});

// --- rotatePostEditSplitPoint ---

const squareCfg = { type: "square" as const, width: 3, height: 3 };
// SQUARE_NEIGHBOR_OFFSETS order: [0]=E(1,0), [1]=N(0,1), [2]=W(-1,0), [3]=S(0,-1) — direction 1
// rotates E->N->W->S->E, direction -1 the reverse.
const centerCellSet = new Set(["0,0", "1,0", "-1,0", "0,1", "0,-1", "1,1", "-1,1", "1,-1", "-1,-1"]);

// One NodeDto per 3x3 cell, id = a stable encoding of (x,y) so tests can address nodes by
// coordinate without a separate lookup table.
const idOf = (x: number, y: number) => (x + 10) * 100 + (y + 10);
const gridNodes: NodeDto[] = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) gridNodes.push({ id: idOf(x, y), x, y, i: 0 });

describe("rotatePostEditSplitPoint", () => {
  it("no split slots — a one-way edge from the point moves from its E neighbor to its N neighbor (direction 1)", () => {
    const edges: Record<string, PostEditEdge> = {};
    const from = nodeEndpoint(idOf(0, 0));
    const to = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(from, to)] = { from, to, kind: "one_way_forward" };

    const result = rotatePostEditSplitPoint(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, {});
    expect(result[edgeKey(from, to)]).toBeUndefined();
    const newTo = nodeEndpoint(idOf(0, 1));
    expect(result[edgeKey(from, newTo)]).toEqual({ from, to: newTo, kind: "one_way_forward" });
  });

  it("preserves role (from vs to) — an edge pointing into the point keeps pointing in after rotation", () => {
    const edges: Record<string, PostEditEdge> = {};
    const outer = nodeEndpoint(idOf(1, 0)); // E neighbor
    const center = nodeEndpoint(idOf(0, 0));
    edges[edgeKey(outer, center)] = { from: outer, to: center, kind: "one_way_forward" };

    const result = rotatePostEditSplitPoint(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, {});
    const newOuter = nodeEndpoint(idOf(0, 1)); // N neighbor
    expect(result[edgeKey(newOuter, center)]).toEqual({ from: newOuter, to: center, kind: "one_way_forward" });
  });

  it("bidirectional passage (both directed Record entries) rotates as one unit", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "basic" };
    edges[edgeKey(east, center)] = { from: east, to: center, kind: "basic" };

    const result = rotatePostEditSplitPoint(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, {});
    const north = nodeEndpoint(idOf(0, 1));
    expect(result[edgeKey(center, north)]).toEqual({ from: center, to: north, kind: "basic" });
    expect(result[edgeKey(north, center)]).toEqual({ from: north, to: center, kind: "basic" });
    expect(result[edgeKey(center, east)]).toBeUndefined();
    expect(result[edgeKey(east, center)]).toBeUndefined();
  });

  it("split node's own connection rotates independently of the original node's", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const slot = splitEndpoint([0, 0], 0);
    const east = nodeEndpoint(idOf(1, 0));
    const west = nodeEndpoint(idOf(-1, 0));
    edges[edgeKey(slot, east)] = { from: slot, to: east, kind: "one_way_forward" };
    edges[edgeKey(center, west)] = { from: center, to: west, kind: "one_way_forward" };

    const result = rotatePostEditSplitPoint(edges, [0, 0], [0], 1, squareCfg, centerCellSet, gridNodes, {});
    const north = nodeEndpoint(idOf(0, 1));
    const south = nodeEndpoint(idOf(0, -1));
    expect(result[edgeKey(slot, north)]).toEqual({ from: slot, to: north, kind: "one_way_forward" });
    expect(result[edgeKey(center, south)]).toEqual({ from: center, to: south, kind: "one_way_forward" });
  });

  it("rotation onto a field boundary is refused entirely — edges unchanged", () => {
    // Corner (-1,-1): only E(0,-1) and N(-1,0) are in-field; W(-2,-1) and S(-1,-2) are boundary.
    const cornerNodes: NodeDto[] = [
      { id: 1, x: -1, y: -1, i: 0 },
      { id: 2, x: -1, y: 0, i: 0 }, // N neighbor
      { id: 3, x: 0, y: -1, i: 0 }, // E neighbor
    ];
    const edges: Record<string, PostEditEdge> = {};
    const corner = nodeEndpoint(1);
    const northNeighbor = nodeEndpoint(2);
    edges[edgeKey(corner, northNeighbor)] = { from: corner, to: northNeighbor, kind: "basic" };

    // Rotating by +1 moves the N-face connection to W, which is outside the field.
    const result = rotatePostEditSplitPoint(edges, [-1, -1], [], 1, squareCfg, centerCellSet, cornerNodes, {});
    expect(result).toBe(edges); // same reference — untouched
  });

  it("moves to whichever node is active at the new neighbor, not always its original node", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "one_way_forward" };

    // North neighbor (0,1) has an active split node instead of its original node.
    const northSlot = splitEndpoint([0, 1], 0);
    const activeSplitNode: Record<string, PostEditEndpoint> = { "0,1": northSlot };

    const result = rotatePostEditSplitPoint(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, activeSplitNode);
    expect(result[edgeKey(center, northSlot)]).toEqual({ from: center, to: northSlot, kind: "one_way_forward" });
  });
});
