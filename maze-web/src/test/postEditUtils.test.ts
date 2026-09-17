import { describe, it, expect } from "vitest";
import {
  buildPostEditDraftEdgesFromGenerated, extractPostEditTeleports, postEditTeleportsToDto,
  rotateSplitPointMoves, postEditVerticalToDto, postEditVerticalPassageDirectionToDto,
  findPostEditVerticalPassageForPair,
  cyclePostEditVerticalPassageDirection, removePostEditVerticalPassage, movePostEditVerticalPassageEndpoint,
  removePostEditElevator, elevatorComponent, pruneRemovedSplitNodes,
} from "../pixi/postEditUtils";
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

  it("ignores vertical_passage and elevator edges entirely (GitHub issue #370)", () => {
    // A generated VerticalPassage/Elevator edge must not also be resent as a "basic"/
    // "one_way_forward" draft edge — confirmPostEdit resends vertical/elevator edges separately
    // (restore_vertical_edges) from `_generatedEdges`, so leaking them into this Record too
    // creates a parallel Basic edge alongside the real VerticalPassage edge, which desyncs
    // `link_reverse_edges`'s pairing and gets misread as a phantom cycle.
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" },
      { from: 0, to: 2, kind: "vertical_passage" }, { from: 2, to: 0, kind: "vertical_passage" },
      { from: 0, to: 3, kind: "elevator" },
    ];
    const result = buildPostEditDraftEdgesFromGenerated(edges);
    const fwdKey = edgeKey(nodeEndpoint(0), nodeEndpoint(1));
    const bwdKey = edgeKey(nodeEndpoint(1), nodeEndpoint(0));
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

// --- rotateSplitPointMoves ---

const squareCfg = { type: "square" as const, width: 3, height: 3 };
// SQUARE_NEIGHBOR_OFFSETS order: [0]=E(1,0), [1]=N(0,1), [2]=W(-1,0), [3]=S(0,-1) — direction 1
// rotates E->N->W->S->E, direction -1 the reverse.
const centerCellSet = new Set(["0,0", "1,0", "-1,0", "0,1", "0,-1", "1,1", "-1,1", "1,-1", "-1,-1"]);

// One NodeDto per 3x3 cell, id = a stable encoding of (x,y) so tests can address nodes by
// coordinate without a separate lookup table.
const idOf = (x: number, y: number) => (x + 10) * 100 + (y + 10);
const gridNodes: NodeDto[] = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) gridNodes.push({ id: idOf(x, y), x, y, i: 0 });

describe("rotateSplitPointMoves", () => {
  it("no split slots — a one-way edge from the point moves from its E neighbor to its N neighbor (direction 1)", () => {
    const edges: Record<string, PostEditEdge> = {};
    const from = nodeEndpoint(idOf(0, 0));
    const to = nodeEndpoint(idOf(1, 0));
    const oldKey = edgeKey(from, to);
    edges[oldKey] = { from, to, kind: "one_way_forward" };

    const result = rotateSplitPointMoves(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, {});
    const newTo = nodeEndpoint(idOf(0, 1));
    expect(result).toEqual([{ oldKey, from, to: newTo, edgeKind: "one_way_forward" }]);
  });

  it("preserves role (from vs to) — an edge pointing into the point keeps pointing in after rotation", () => {
    const edges: Record<string, PostEditEdge> = {};
    const outer = nodeEndpoint(idOf(1, 0)); // E neighbor
    const center = nodeEndpoint(idOf(0, 0));
    const oldKey = edgeKey(outer, center);
    edges[oldKey] = { from: outer, to: center, kind: "one_way_forward" };

    const result = rotateSplitPointMoves(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, {});
    const newOuter = nodeEndpoint(idOf(0, 1)); // N neighbor
    expect(result).toEqual([{ oldKey, from: newOuter, to: center, edgeKind: "one_way_forward" }]);
  });

  it("bidirectional passage (both directed Record entries) rotates as one unit", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    const fwdKey = edgeKey(center, east);
    const bwdKey = edgeKey(east, center);
    edges[fwdKey] = { from: center, to: east, kind: "basic" };
    edges[bwdKey] = { from: east, to: center, kind: "basic" };

    const result = rotateSplitPointMoves(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, {});
    const north = nodeEndpoint(idOf(0, 1));
    expect(result).toEqual(expect.arrayContaining([
      { oldKey: fwdKey, from: center, to: north, edgeKind: "basic" },
      { oldKey: bwdKey, from: north, to: center, edgeKind: "basic" },
    ]));
    expect(result).toHaveLength(2);
  });

  it("split node's own connection rotates independently of the original node's", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const slot = splitEndpoint([0, 0], 0);
    const east = nodeEndpoint(idOf(1, 0));
    const west = nodeEndpoint(idOf(-1, 0));
    const slotKey = edgeKey(slot, east);
    const centerKey = edgeKey(center, west);
    edges[slotKey] = { from: slot, to: east, kind: "one_way_forward" };
    edges[centerKey] = { from: center, to: west, kind: "one_way_forward" };

    const result = rotateSplitPointMoves(edges, [0, 0], [0], 1, squareCfg, centerCellSet, gridNodes, {});
    const north = nodeEndpoint(idOf(0, 1));
    const south = nodeEndpoint(idOf(0, -1));
    expect(result).toEqual(expect.arrayContaining([
      { oldKey: slotKey, from: slot, to: north, edgeKind: "one_way_forward" },
      { oldKey: centerKey, from: center, to: south, edgeKind: "one_way_forward" },
    ]));
  });

  it("rotation onto a field boundary is refused entirely — empty move list", () => {
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
    const result = rotateSplitPointMoves(edges, [-1, -1], [], 1, squareCfg, centerCellSet, cornerNodes, {});
    expect(result).toEqual([]);
  });

  it("moves to whichever node is active at the new neighbor, not always its original node", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    const oldKey = edgeKey(center, east);
    edges[oldKey] = { from: center, to: east, kind: "one_way_forward" };

    // North neighbor (0,1) has an active split node instead of its original node.
    const northSlot = splitEndpoint([0, 1], 0);
    const activeSplitNode: Record<string, PostEditEndpoint> = { "0,1": northSlot };

    const result = rotateSplitPointMoves(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, activeSplitNode);
    expect(result).toEqual([{ oldKey, from: center, to: northSlot, edgeKind: "one_way_forward" }]);
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

// --- findPostEditVerticalPassageForPair ---

describe("findPostEditVerticalPassageForPair", () => {
  const passages = [
    { id: 1, from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const },
    { id: 2, from: nodeEndpoint(5), to: nodeEndpoint(0), direction: "two_way" as const },
  ];

  it("matches a pair in either argument order", () => {
    expect(findPostEditVerticalPassageForPair(passages, 0, 1)?.id).toBe(1);
    expect(findPostEditVerticalPassageForPair(passages, 1, 0)?.id).toBe(1);
  });

  it("matches regardless of which end of the entry each id sits on", () => {
    expect(findPostEditVerticalPassageForPair(passages, 0, 5)?.id).toBe(2);
  });

  it("returns undefined when no entry connects the pair", () => {
    expect(findPostEditVerticalPassageForPair(passages, 1, 5)).toBeUndefined();
    expect(findPostEditVerticalPassageForPair(passages, 0, 9)).toBeUndefined();
    expect(findPostEditVerticalPassageForPair([], 0, 1)).toBeUndefined();
  });

  it("never matches a split-addressed endpoint (vertical passages are node-addressed)", () => {
    const withSplit = [{ id: 3, from: splitEndpoint([0, 0], 0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(findPostEditVerticalPassageForPair(withSplit, 0, 1)).toBeUndefined();
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

describe("elevatorComponent", () => {
  const mesh = [
    { from: 0, to: 1, kind: "elevator" }, { from: 1, to: 0, kind: "elevator" },
    { from: 0, to: 2, kind: "elevator" }, { from: 2, to: 0, kind: "elevator" },
    { from: 1, to: 2, kind: "elevator" }, { from: 2, to: 1, kind: "elevator" },
  ];

  it("returns every node reachable from a single start id", () => {
    expect(elevatorComponent(mesh, [0])).toEqual(new Set([0, 1, 2]));
  });

  it("merges components from multiple start ids into one result, not seeding from only the first", () => {
    const disjoint = [
      { from: 0, to: 1, kind: "elevator" }, { from: 1, to: 0, kind: "elevator" },
      { from: 10, to: 11, kind: "elevator" }, { from: 11, to: 10, kind: "elevator" },
    ];
    // Two unconnected elevators; starting from one node of each must yield both components, not
    // just the first start's — this is the multi-start behavior the reset-point caller relies on
    // for a split point with several nodes on the same floor.
    expect(elevatorComponent(disjoint, [0, 10])).toEqual(new Set([0, 1, 10, 11]));
  });

  it("two elevators sharing no edge stay separate even if a caller only starts from one", () => {
    // Mirrors the Rust regression (GitHub issue #346): a same-point disjoint elevator must not
    // leak into the result just because it exists elsewhere in `edges`.
    const disjoint = [
      { from: 0, to: 1, kind: "elevator" }, { from: 1, to: 0, kind: "elevator" },
      { from: 10, to: 11, kind: "elevator" }, { from: 11, to: 10, kind: "elevator" },
    ];
    expect(elevatorComponent(disjoint, [0])).toEqual(new Set([0, 1]));
  });

  it("ignores non-elevator edges", () => {
    const edges = [{ from: 0, to: 1, kind: "vertical_passage" }, { from: 0, to: 2, kind: "teleport" }];
    expect(elevatorComponent(edges, [0])).toEqual(new Set([0]));
  });

  it("empty start set yields an empty component", () => {
    expect(elevatorComponent(mesh, [])).toEqual(new Set());
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

// --- pruneRemovedSplitNodes ---

describe("pruneRemovedSplitNodes", () => {
  it("keeps a point's original node (i === 0) even with no split entry at all", () => {
    const nodes = [{ id: 0, x: 0, y: 0, i: 0 }];
    expect(pruneRemovedSplitNodes(nodes, {})).toEqual(nodes);
  });

  it("drops an extra node whose slotId is no longer declared in splitPoints (GitHub issue #388)", () => {
    const nodes = [
      { id: 0, x: 2, y: 2, i: 0 },
      { id: 1, x: 2, y: 2, i: 1 },
    ];
    // slot 0 (i === 1) was removed client-side — splitPoints no longer lists it.
    const result = pruneRemovedSplitNodes(nodes, { "2,2": [] });
    expect(result).toEqual([{ id: 0, x: 2, y: 2, i: 0 }]);
  });

  it("keeps an extra node whose slotId is still declared", () => {
    const nodes = [
      { id: 0, x: 2, y: 2, i: 0 },
      { id: 1, x: 2, y: 2, i: 1 },
      { id: 2, x: 2, y: 2, i: 2 },
    ];
    // slot 0 (i === 1) removed, slot 1 (i === 2) still declared.
    const result = pruneRemovedSplitNodes(nodes, { "2,2": [1] });
    expect(result).toEqual([{ id: 0, x: 2, y: 2, i: 0 }, { id: 2, x: 2, y: 2, i: 2 }]);
  });

  it("supports a custom pointKey for multi-floor callers (@level suffix)", () => {
    const nodes = [
      { id: 0, x: 1, y: 1, i: 0, level: 1 },
      { id: 1, x: 1, y: 1, i: 1, level: 1 },
    ];
    const pointKey = (n: { x: number; y: number; level?: number }) =>
      (n.level ?? 0) === 0 ? `${n.x},${n.y}` : `${n.x},${n.y}@${n.level}`;
    expect(pruneRemovedSplitNodes(nodes, { "1,1@1": [] }, pointKey)).toEqual([nodes[0]]);
    expect(pruneRemovedSplitNodes(nodes, { "1,1@1": [0] }, pointKey)).toEqual(nodes);
  });
});
