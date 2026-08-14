import { describe, it, expect } from "vitest";
import {
  buildPostEditDraftEdgesFromGenerated, applyPostEditEdgeTool, extractPostEditTeleports, postEditTeleportsToDto,
  rotatePostEditSplitPoint, resetPostEditPoint, postEditVerticalToDto, postEditVerticalPassageDirectionToDto,
  cyclePostEditVerticalPassageDirection, removePostEditVerticalPassage, movePostEditVerticalPassageEndpoint,
  removePostEditElevator,
} from "../pixi/postEditUtils";
import { nodeEndpoint, splitEndpoint, edgeKey, type PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { EdgeDto, NodeDto } from "../wasm/types";
import type { PostEditEdge, PostEditMeta } from "../store/mazeStore";

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

// --- resetPostEditPoint ---

describe("resetPostEditPoint", () => {
  const emptyMeta: PostEditMeta = { start: null, finish: null };
  const center = nodeEndpoint(idOf(0, 0));
  const east = nodeEndpoint(idOf(1, 0));
  const north = nodeEndpoint(idOf(0, 1));

  it("restores a manually walled-off generated edge", () => {
    // Generation had a passage center<->east; the draft has since walled it off (no entries).
    const generatedEdges: EdgeDto[] = [
      { from: idOf(0, 0), to: idOf(1, 0), kind: "basic" },
      { from: idOf(1, 0), to: idOf(0, 0), kind: "basic" },
    ];
    const result = resetPostEditPoint(
      [0, 0], {}, [], {}, {}, emptyMeta, gridNodes, generatedEdges, null, null,
    );
    expect(result.draftEdges[edgeKey(center, east)]).toEqual({ from: center, to: east, kind: "basic" });
    expect(result.draftEdges[edgeKey(east, center)]).toEqual({ from: east, to: center, kind: "basic" });
  });

  it("removes a manually added edge that generation never had", () => {
    const draftEdges: Record<string, PostEditEdge> = {
      [edgeKey(center, north)]: { from: center, to: north, kind: "basic" },
      [edgeKey(north, center)]: { from: north, to: center, kind: "basic" },
    };
    const result = resetPostEditPoint(
      [0, 0], draftEdges, [], {}, {}, emptyMeta, gridNodes, [], null, null,
    );
    expect(result.draftEdges[edgeKey(center, north)]).toBeUndefined();
    expect(result.draftEdges[edgeKey(north, center)]).toBeUndefined();
  });

  it("removes a manually addSplitNode-added slot never present at generation", () => {
    const draftSplitPoints = { "0,0": [0] };
    const slot = splitEndpoint([0, 0], 0);
    const draftEdges: Record<string, PostEditEdge> = {
      [edgeKey(slot, east)]: { from: slot, to: east, kind: "basic" },
    };
    const result = resetPostEditPoint(
      [0, 0], draftEdges, [], draftSplitPoints, { "0,0": slot }, emptyMeta, gridNodes, [], null, null,
    );
    expect(result.splitPoints["0,0"]).toBeUndefined();
    expect(result.activeSplitNode["0,0"]).toBeUndefined();
    expect(result.draftEdges[edgeKey(slot, east)]).toBeUndefined();
  });

  it("restores a generation-time split point (auto-split), rebuilding each slot's own edges", () => {
    // (0,0) was auto-split at generation into original (i=0) + one extra node (i=1).
    const splitGeneratedNodes: NodeDto[] = [
      ...gridNodes.filter((n) => !(n.x === 0 && n.y === 0)),
      { id: 500, x: 0, y: 0, i: 0 },
      { id: 501, x: 0, y: 0, i: 1 },
    ];
    const generatedEdges: EdgeDto[] = [
      { from: 500, to: idOf(1, 0), kind: "basic" }, { from: idOf(1, 0), to: 500, kind: "basic" },
      { from: 501, to: idOf(0, 1), kind: "basic" }, { from: idOf(0, 1), to: 501, kind: "basic" },
    ];
    const result = resetPostEditPoint(
      [0, 0], {}, [], {}, {}, emptyMeta, splitGeneratedNodes, generatedEdges, null, null,
    );
    expect(result.splitPoints["0,0"]).toEqual([0]);
    const originalEp = nodeEndpoint(500);
    const slotEp = splitEndpoint([0, 0], 0);
    expect(result.draftEdges[edgeKey(originalEp, east)]).toEqual({ from: originalEp, to: east, kind: "basic" });
    expect(result.draftEdges[edgeKey(slotEp, north)]).toEqual({ from: slotEp, to: north, kind: "basic" });
  });

  it("restores start to this point when generation had it here, overriding wherever it was manually moved to", () => {
    const meta: PostEditMeta = { start: north, finish: null };
    const result = resetPostEditPoint(
      [0, 0], {}, [], {}, {}, meta, gridNodes, [], idOf(0, 0), null,
    );
    expect(result.draftMeta.start).toEqual(center);
    expect(result.draftMeta.finish).toBeNull();
  });

  it("leaves start untouched when generation's start was on a different point entirely", () => {
    const meta: PostEditMeta = { start: north, finish: null };
    const result = resetPostEditPoint(
      [0, 0], {}, [], {}, {}, meta, gridNodes, [], idOf(0, 1), null,
    );
    expect(result.draftMeta.start).toEqual(north);
  });

  it("clears start/finish if it addressed one of this point's nodes and generation had none there", () => {
    const meta: PostEditMeta = { start: center, finish: null };
    const result = resetPostEditPoint(
      [0, 0], {}, [], {}, {}, meta, gridNodes, [], null, null,
    );
    expect(result.draftMeta.start).toBeNull();
  });

  it("restores a generation-time teleport touching the point", () => {
    const generatedEdges: EdgeDto[] = [{ from: idOf(0, 0), to: idOf(1, 1), kind: "teleport" }];
    const teleportNodes: NodeDto[] = [...gridNodes, { id: 999, x: 5, y: 5, i: 0 }];
    const result = resetPostEditPoint(
      [0, 0], {}, [], {}, {}, emptyMeta, teleportNodes, generatedEdges, null, null,
    );
    expect(result.draftTeleports).toHaveLength(1);
    expect(result.draftTeleports[0]).toMatchObject({ from: center, to: nodeEndpoint(idOf(1, 1)), direction: "forward" });
  });

  it("removes a manually added teleport from this point that generation never had", () => {
    const draftTeleports = [{ id: 1, from: center, to: east, direction: "forward" as const }];
    const result = resetPostEditPoint(
      [0, 0], {}, draftTeleports, {}, {}, emptyMeta, gridNodes, [], null, null,
    );
    expect(result.draftTeleports).toHaveLength(0);
  });

  it("does not touch edges/teleports/split points of a different point", () => {
    const other = nodeEndpoint(idOf(-1, -1));
    const draftEdges: Record<string, PostEditEdge> = {
      [edgeKey(other, nodeEndpoint(idOf(-1, 0)))]: { from: other, to: nodeEndpoint(idOf(-1, 0)), kind: "basic" },
    };
    const result = resetPostEditPoint(
      [0, 0], draftEdges, [], {}, {}, emptyMeta, gridNodes, [], null, null,
    );
    expect(result.draftEdges[edgeKey(other, nodeEndpoint(idOf(-1, 0)))]).toEqual(draftEdges[edgeKey(other, nodeEndpoint(idOf(-1, 0)))]);
  });
});

// --- postEditVerticalPassageDirectionToDto ---

describe("postEditVerticalPassageDirectionToDto", () => {
  it("two_way maps to undefined (wire DTO has no two_way variant)", () => {
    expect(postEditVerticalPassageDirectionToDto("two_way")).toBeUndefined();
  });

  it("forward/backward pass through unchanged", () => {
    expect(postEditVerticalPassageDirectionToDto("forward")).toBe("forward");
    expect(postEditVerticalPassageDirectionToDto("backward")).toBe("backward");
  });
});

// --- cyclePostEditVerticalPassageDirection ---

describe("cyclePostEditVerticalPassageDirection", () => {
  it("forward becomes backward", () => {
    const passages = [{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(cyclePostEditVerticalPassageDirection(passages, 1)[0].direction).toBe("backward");
  });

  it("backward becomes forward", () => {
    const passages = [{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward" as const }];
    expect(cyclePostEditVerticalPassageDirection(passages, 1)[0].direction).toBe("forward");
  });

  it("two_way is left unchanged (only meaningful for the one-way tool)", () => {
    const passages = [{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" as const }];
    expect(cyclePostEditVerticalPassageDirection(passages, 1)[0].direction).toBe("two_way");
  });

  it("leaves passages with a different id untouched", () => {
    const passages = [{ id: 2, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(cyclePostEditVerticalPassageDirection(passages, 1)).toEqual(passages);
  });
});

// --- removePostEditVerticalPassage / removePostEditElevator ---

describe("removePostEditVerticalPassage", () => {
  it("removes the entry with the given id, keeps the rest", () => {
    const passages = [
      { id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const },
      { id: 2, from: nodeEndpoint(2), to: nodeEndpoint(3), direction: "forward" as const },
    ];
    expect(removePostEditVerticalPassage(passages, 1)).toEqual([passages[1]]);
  });
});

describe("removePostEditElevator", () => {
  it("removes the entry with the given id, keeps the rest", () => {
    const elevators = [
      { id: 1, floors: [nodeEndpoint(0), nodeEndpoint(1)] },
      { id: 2, floors: [nodeEndpoint(2), nodeEndpoint(3)] },
    ];
    expect(removePostEditElevator(elevators, 1)).toEqual([elevators[1]]);
  });
});

// --- movePostEditVerticalPassageEndpoint ---

describe("movePostEditVerticalPassageEndpoint", () => {
  it("replaces only the given end of the matching entry", () => {
    const passages = [{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    const result = movePostEditVerticalPassageEndpoint(passages, { id: 1, end: "to" }, nodeEndpoint(5));
    expect(result[0]).toEqual({ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(5), direction: "forward" });
  });

  it("leaves entries with a different id untouched", () => {
    const passages = [{ id: 2, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(movePostEditVerticalPassageEndpoint(passages, { id: 1, end: "to" }, nodeEndpoint(5))).toEqual(passages);
  });
});

// --- postEditVerticalToDto ---

describe("postEditVerticalToDto", () => {
  it("forward vertical passage produces one from->to edge", () => {
    const passages = [{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(postEditVerticalToDto(passages, [], noSplits)).toEqual([{ from: 0, to: 1, kind: "vertical_passage" }]);
  });

  it("backward vertical passage produces one to->from edge", () => {
    const passages = [{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward" as const }];
    expect(postEditVerticalToDto(passages, [], noSplits)).toEqual([{ from: 1, to: 0, kind: "vertical_passage" }]);
  });

  it("two_way vertical passage produces both directions", () => {
    const passages = [{ id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" as const }];
    expect(postEditVerticalToDto(passages, [], noSplits)).toEqual([
      { from: 0, to: 1, kind: "vertical_passage" },
      { from: 1, to: 0, kind: "vertical_passage" },
    ]);
  });

  it("drops a vertical passage whose endpoint doesn't resolve", () => {
    const passages = [{ id: 1, from: splitEndpoint([1, 2], 0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(postEditVerticalToDto(passages, [], noSplits)).toEqual([]);
  });

  it("elevator with 2 floors produces a bidirectional pair", () => {
    const elevators = [{ id: 1, floors: [nodeEndpoint(0), nodeEndpoint(1)] }];
    const result = postEditVerticalToDto([], elevators, noSplits);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([
      { from: 0, to: 1, kind: "elevator" },
      { from: 1, to: 0, kind: "elevator" },
    ]));
  });

  it("elevator with 3 floors produces a full 6-edge mesh (every ordered pair)", () => {
    const elevators = [{ id: 1, floors: [nodeEndpoint(0), nodeEndpoint(1), nodeEndpoint(2)] }];
    const result = postEditVerticalToDto([], elevators, noSplits);
    expect(result).toHaveLength(6);
    const pairs = new Set(result.map((e) => `${e.from}->${e.to}`));
    expect(pairs).toEqual(new Set(["0->1", "1->0", "0->2", "2->0", "1->2", "2->1"]));
  });

  it("elevator floor that doesn't resolve is excluded from the mesh, not dropped entirely", () => {
    const elevators = [{ id: 1, floors: [nodeEndpoint(0), splitEndpoint([1, 2], 0), nodeEndpoint(1)] }];
    const result = postEditVerticalToDto([], elevators, noSplits);
    expect(result).toEqual(expect.arrayContaining([
      { from: 0, to: 1, kind: "elevator" },
      { from: 1, to: 0, kind: "elevator" },
    ]));
    expect(result).toHaveLength(2);
  });
});
