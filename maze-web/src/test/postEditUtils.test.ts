import { describe, it, expect } from "vitest";
import {
  buildPostEditDraftEdgesFromGenerated, extractPostEditTeleports, postEditTeleportsToDto,
  floorScopedTeleportEdges,
  rotateSplitPointNodes, postEditVerticalToDto, postEditVerticalPassageDirectionToDto,
  findPostEditVerticalPassageForPair,
  cyclePostEditVerticalPassageDirection, removePostEditVerticalPassage, movePostEditVerticalPassageEndpoint,
  removePostEditElevator, elevatorComponent, pruneRemovedSplitNodes, rotateSplitPointBreaksNeighborShape,
} from "../pixi/postEditUtils";
import { canCompleteOppositePair, hasCompleteOppositePair } from "../pixi/splitFaceLayout";
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
      { id: "t1", from: nodeEndpoint(2), to: nodeEndpoint(3), direction: "forward" },
    ]);
  });

  it("collapses a forward+backward pair into one two_way entry", () => {
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "teleport" },
      { from: 1, to: 0, kind: "teleport" },
      { from: 2, to: 3, kind: "teleport" },
    ];
    expect(extractPostEditTeleports(edges).teleports).toEqual([
      { id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" },
      { id: "t2", from: nodeEndpoint(2), to: nodeEndpoint(3), direction: "forward" },
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
    expect(postEditTeleportsToDto([{ id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" }], noSplits))
      .toEqual([{ from: 0, to: 1, kind: "teleport" }]);
  });

  it("backward entry produces one edge reversed", () => {
    expect(postEditTeleportsToDto([{ id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward" }], noSplits))
      .toEqual([{ from: 1, to: 0, kind: "teleport" }]);
  });

  it("two_way entry produces both directions", () => {
    expect(postEditTeleportsToDto([{ id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" }], noSplits))
      .toEqual([{ from: 0, to: 1, kind: "teleport" }, { from: 1, to: 0, kind: "teleport" }]);
  });

  it("drops an entry whose split endpoint doesn't resolve yet", () => {
    const teleports = [{ id: "t1", from: splitEndpoint([1, 2], 0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(postEditTeleportsToDto(teleports, noSplits)).toEqual([]);
  });

  it("resolves a split endpoint via resolveSplit", () => {
    const teleports = [{ id: "t1", from: splitEndpoint([1, 2], 0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(postEditTeleportsToDto(teleports, () => 42)).toEqual([{ from: 42, to: 1, kind: "teleport" }]);
  });
});

// --- floorScopedTeleportEdges (GitHub issue #633) ---

describe("floorScopedTeleportEdges", () => {
  it("keeps a same-floor two-way teleport's both directions", () => {
    const edges = postEditTeleportsToDto([{ id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" }], noSplits);
    expect(floorScopedTeleportEdges(edges, new Set([0, 1]))).toEqual([
      { from: 0, to: 1, kind: "teleport" },
      { from: 1, to: 0, kind: "teleport" },
    ]);
  });

  it("keeps only the departure-side edge of a cross-floor two-way teleport, dropping the arrival-side one", () => {
    // Node 1 lives on the other floor (not in floorNodeIds) — resolved fully here (both real ids,
    // e.g. via an unscoped/all-floor resolveSplit), same as PostEditRenderer feeds this function.
    const edges = postEditTeleportsToDto([{ id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" }], noSplits);
    expect(floorScopedTeleportEdges(edges, new Set([0]))).toEqual([{ from: 0, to: 1, kind: "teleport" }]);
  });

  it("drops a one-way teleport entirely when its departure end is on the other floor", () => {
    const edges = postEditTeleportsToDto([{ id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" }], noSplits);
    expect(floorScopedTeleportEdges(edges, new Set([1]))).toEqual([]);
  });

  it("empty input returns empty array", () => {
    expect(floorScopedTeleportEdges([], new Set([0]))).toEqual([]);
  });
});

// --- rotateSplitPointNodes ---

const squareCfg = { type: "square" as const, width: 3, height: 3 };
// SQUARE_NEIGHBOR_OFFSETS order: [0]=E(1,0), [1]=N(0,1), [2]=W(-1,0), [3]=S(0,-1) — direction 1
// rotates E->N->W->S->E, direction -1 the reverse.
const centerCellSet = new Set(["0,0", "1,0", "-1,0", "0,1", "0,-1", "1,1", "-1,1", "1,-1", "-1,-1"]);

// One NodeDto per 3x3 cell, id = a stable encoding of (x,y) so tests can address nodes by
// coordinate without a separate lookup table.
const idOf = (x: number, y: number) => (x + 10) * 100 + (y + 10);
const gridNodes: NodeDto[] = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) gridNodes.push({ id: idOf(x, y), x, y, i: 0 });

/** Builds the `originalNode:`-equivalent entry `rotateSplitPointNodes` returns for the point's own
 * (non-split) node — `slotId: undefined`, one face per neighbor carrying a connection either way. */
function faceOf(neighbor: PostEditEndpoint, toNeighbor: PostEditEdge, fromNeighbor: PostEditEdge) {
  return { neighbor, toNeighbor, fromNeighbor };
}
const wallTo = (from: PostEditEndpoint, to: PostEditEndpoint): PostEditEdge => ({ kind: "wall", from, to });

describe("rotateSplitPointNodes — full-snapshot result (GitHub issue #548 compaction follow-up)", () => {
  it("no split slots — a one-way edge from the point moves from its E neighbor to its N neighbor (direction 1)", () => {
    const edges: Record<string, PostEditEdge> = {};
    const from = nodeEndpoint(idOf(0, 0));
    const to = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(from, to)] = { from, to, kind: "one_way_forward" };

    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, {}, {});
    const newTo = nodeEndpoint(idOf(0, 1));
    expect(result).toEqual([{
      slotId: undefined,
      faces: [faceOf(newTo, { kind: "one_way_forward", from, to: newTo }, wallTo(newTo, from))],
    }]);
  });

  it("preserves role (from vs to) — an edge pointing into the point keeps pointing in after rotation", () => {
    const edges: Record<string, PostEditEdge> = {};
    const outer = nodeEndpoint(idOf(1, 0)); // E neighbor
    const center = nodeEndpoint(idOf(0, 0));
    edges[edgeKey(outer, center)] = { from: outer, to: center, kind: "one_way_forward" };

    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, {}, {});
    const newOuter = nodeEndpoint(idOf(0, 1)); // N neighbor
    expect(result).toEqual([{
      slotId: undefined,
      faces: [faceOf(newOuter, wallTo(center, newOuter), { kind: "one_way_forward", from: newOuter, to: center })],
    }]);
  });

  it("bidirectional passage (both directed Record entries) rotates as one unit", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "basic" };
    edges[edgeKey(east, center)] = { from: east, to: center, kind: "basic" };

    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, {}, {});
    const north = nodeEndpoint(idOf(0, 1));
    expect(result).toEqual([{
      slotId: undefined,
      faces: [faceOf(north, { kind: "basic", from: center, to: north }, { kind: "basic", from: north, to: center })],
    }]);
  });

  it("split node's own connection rotates independently of the original node's", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const slot = splitEndpoint([0, 0], 0);
    const east = nodeEndpoint(idOf(1, 0));
    const west = nodeEndpoint(idOf(-1, 0));
    edges[edgeKey(slot, east)] = { from: slot, to: east, kind: "one_way_forward" };
    edges[edgeKey(center, west)] = { from: center, to: west, kind: "one_way_forward" };

    const result = rotateSplitPointNodes(edges, [0, 0], [0], 1, squareCfg, centerCellSet, gridNodes, {}, {});
    const north = nodeEndpoint(idOf(0, 1));
    const south = nodeEndpoint(idOf(0, -1));
    expect(result).toEqual(expect.arrayContaining([
      { slotId: undefined, faces: [faceOf(south, { kind: "one_way_forward", from: center, to: south }, wallTo(south, center))] },
      { slotId: 0, faces: [faceOf(north, { kind: "one_way_forward", from: slot, to: north }, wallTo(north, slot))] },
    ]));
    expect(result).toHaveLength(2);
  });

  it("rotation onto a field boundary is refused entirely — empty node list", () => {
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
    const result = rotateSplitPointNodes(edges, [-1, -1], [], 1, squareCfg, centerCellSet, cornerNodes, {}, {});
    expect(result).toEqual([]);
  });

  it("rotation onto a field cell with no node there is refused entirely — sparse field, not a boundary", () => {
    // (0,1) is in cellSet (in-field) but has no NodeDto — a sparse/partially-populated field.
    const sparseNodes: NodeDto[] = gridNodes.filter((n) => !(n.x === 0 && n.y === 1));
    const edges: Record<string, PostEditEdge> = {};
    const from = nodeEndpoint(idOf(0, 0));
    const to = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(from, to)] = { from, to, kind: "one_way_forward" };

    // Rotating by +1 moves the E-face connection to N (0,1), which is in-field but nodeless.
    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, centerCellSet, sparseNodes, {}, {});
    expect(result).toEqual([]);
  });

  it("moves to whichever node is active at the new neighbor, not always its original node", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "one_way_forward" };

    // North neighbor (0,1) has an active split node instead of its original node.
    const northSlot = splitEndpoint([0, 1], 0);
    const activeSplitNode: Record<string, PostEditEndpoint> = { "0,1": northSlot };

    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, centerCellSet, gridNodes, activeSplitNode, {});
    expect(result).toEqual([{
      slotId: undefined,
      faces: [faceOf(northSlot, { kind: "one_way_forward", from: center, to: northSlot }, wallTo(northSlot, center))],
    }]);
  });

  // Bridge geometry ring for the tests below: a 5x5 grid so the bridge neighbor at (0,1) has all
  // four of its own neighbors in-field ((1,1),(0,2),(-1,1),(0,0)).
  const ringNodes: NodeDto[] = [];
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) ringNodes.push({ id: idOf(x, y), x, y, i: 0 });
  // The neighbor (0,1)'s declared split slot 0 needs its own real NodeDto (i: 1) alongside its
  // original (i: 0) — otherwise `buildLogicalCandidates` only ever sees one candidate there.
  const bridgeSlotNodeId = 9001;
  ringNodes.push({ id: bridgeSlotNodeId, x: 0, y: 1, i: 1 });
  const ringCellSet = new Set(ringNodes.map((n) => `${n.x},${n.y}`));
  const bridgeSlot = splitEndpoint([0, 1], 0); // the neighbor's split node forming the bridge
  const bridgeOriginal = nodeEndpoint(idOf(0, 1));

  it("rotating onto a neighbor whose OTHER node already forms a finished bridge doesn't add a 3rd face to it, even when the bridge node is active (GitHub issue #580 rotation counterpart)", () => {
    // Square face order [E,N,W,S] = [0,1,2,3]. The rotate lands the new connection on neighbor
    // (0,1)'s S face (toward (0,0), face 3) — geometrically that can never be "opposite" a bridge
    // whose own pair occupies {E,W} = {0,2} (circularDist(3,0,4)=1, circularDist(3,2,4)=1), so the
    // geometry-evidence tier can't fire here at all; this exercises the fallback-tier guard instead.
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "one_way_forward" };
    // The neighbor's slot 0 already has a COMPLETE, unrelated opposite pair: E (toward (1,1)) and
    // W (toward (-1,1)) — a finished bridge that must not gain a 3rd face.
    const eastOfNeighbor = nodeEndpoint(idOf(1, 1));
    const westOfNeighbor = nodeEndpoint(idOf(-1, 1));
    edges[edgeKey(bridgeSlot, eastOfNeighbor)] = { from: bridgeSlot, to: eastOfNeighbor, kind: "basic" };
    edges[edgeKey(bridgeSlot, westOfNeighbor)] = { from: bridgeSlot, to: westOfNeighbor, kind: "basic" };
    // Active slot deliberately points AT the finished bridge — the exact condition the user
    // described ("reproduces with any active node, as long as the bridge sits on a different side
    // than the active node's own passages"): the bug picked this active node regardless.
    const activeSplitNode: Record<string, PostEditEndpoint> = { "0,1": bridgeSlot };
    const splitPoints: Record<string, number[]> = { "0,1": [0] };

    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, ringCellSet, ringNodes, activeSplitNode, splitPoints);
    // The neighbor's ORIGINAL node (0 decided faces, safe to extend) gets the new connection
    // instead of the finished bridge slot.
    expect(result).toEqual([{
      slotId: undefined,
      faces: [faceOf(bridgeOriginal, { kind: "one_way_forward", from: center, to: bridgeOriginal }, wallTo(bridgeOriginal, center))],
    }]);
  });

  it("control: no finished bridge on the neighbor — active slot is honored as usual", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "one_way_forward" };
    // Neighbor's slot 0 has only ONE decided face — not a finished pair, safe to extend, so the
    // guard doesn't exclude it and active is honored normally.
    const eastOfNeighbor = nodeEndpoint(idOf(1, 1));
    edges[edgeKey(bridgeSlot, eastOfNeighbor)] = { from: bridgeSlot, to: eastOfNeighbor, kind: "basic" };
    const activeSplitNode: Record<string, PostEditEndpoint> = { "0,1": bridgeSlot };
    const splitPoints: Record<string, number[]> = { "0,1": [0] };

    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, ringCellSet, ringNodes, activeSplitNode, splitPoints);
    expect(result).toEqual([{
      slotId: undefined,
      faces: [faceOf(bridgeSlot, { kind: "one_way_forward", from: center, to: bridgeSlot }, wallTo(bridgeSlot, center))],
    }]);
  });

  it("control: neighbor's finished bridge sits on a DIFFERENT split slot than the one active — still not disturbed, active slot (itself safe) is honored", () => {
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "one_way_forward" };
    const eastOfNeighbor = nodeEndpoint(idOf(1, 1));
    const westOfNeighbor = nodeEndpoint(idOf(-1, 1));
    edges[edgeKey(bridgeSlot, eastOfNeighbor)] = { from: bridgeSlot, to: eastOfNeighbor, kind: "basic" };
    edges[edgeKey(bridgeSlot, westOfNeighbor)] = { from: bridgeSlot, to: westOfNeighbor, kind: "basic" };
    // Active is the ORIGINAL node this time (itself has 0 decided faces, safe) — the finished
    // bridge sits on the (inactive) slot instead. Active should be honored as-is.
    const activeSplitNode: Record<string, PostEditEndpoint> = { "0,1": bridgeOriginal };
    const splitPoints: Record<string, number[]> = { "0,1": [0] };

    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, ringCellSet, ringNodes, activeSplitNode, splitPoints);
    expect(result).toEqual([{
      slotId: undefined,
      faces: [faceOf(bridgeOriginal, { kind: "one_way_forward", from: center, to: bridgeOriginal }, wallTo(bridgeOriginal, center))],
    }]);
  });

  it("every candidate at the neighbor already holds a finished bridge — the new face is refused outright (stays wall), not wired onto the least-bad option", () => {
    // Both of the neighbor's nodes (original AND slot 0) already hold a complete opposite pair.
    // There is no safe node to hand the new face to — picking either would corrupt it, so the
    // rotate must leave this face disconnected rather than guess (this is the actual GitHub #580
    // rotation-counterpart repro: a bridge tile rotated onto a neighbor that's itself a finished
    // two-node bridge, where every one of the neighbor's own nodes is already fully wired).
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "one_way_forward" };
    const eastOfNeighbor = nodeEndpoint(idOf(1, 1));
    const westOfNeighbor = nodeEndpoint(idOf(-1, 1));
    edges[edgeKey(bridgeSlot, eastOfNeighbor)] = { from: bridgeSlot, to: eastOfNeighbor, kind: "basic" };
    edges[edgeKey(bridgeSlot, westOfNeighbor)] = { from: bridgeSlot, to: westOfNeighbor, kind: "basic" };
    // The neighbor's ORIGINAL node also already holds its own complete opposite pair (a different
    // finished bridge, unrelated to the slot's and to `point`) — its own E/W faces, toward (1,1)
    // and (-1,1) as seen from (0,1)... no: reuse N/S (toward (0,2) and (0,0)) would collide with
    // `point` itself, so use the original's E face (toward (1,1)) paired with its W face (toward
    // (-1,1)) instead — same opposite pair the slot already occupies is fine, they're different
    // nodes of the same point; what matters is the ORIGINAL, not just the slot, is unsafe too.
    edges[edgeKey(bridgeOriginal, eastOfNeighbor)] = { from: bridgeOriginal, to: eastOfNeighbor, kind: "basic" };
    edges[edgeKey(bridgeOriginal, westOfNeighbor)] = { from: bridgeOriginal, to: westOfNeighbor, kind: "basic" };
    const activeSplitNode: Record<string, PostEditEndpoint> = { "0,1": bridgeSlot };
    const splitPoints: Record<string, number[]> = { "0,1": [0] };

    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, ringCellSet, ringNodes, activeSplitNode, splitPoints);
    // (0,0)'s own E-face one-way move is refused (no safe owner at the neighbor) — the point ends
    // up with no connection to (0,1) at all (absence reads as wall, same "nothing to draw" contract
    // `currentSplitNodeFaces` already uses for a neighbor with no edge in either direction).
    expect(result).toEqual([{ slotId: undefined, faces: [] }]);
  });

  it("multi-move rotate: two moves land on the same finished-bridge neighbor — both avoid the bridge slot", () => {
    // Point (0,0) has an original node and slot 0, both with a connection on their E face; rotating
    // moves both onto the N face, landing on the same neighbor (0,1) which has a finished bridge on
    // its own slot 0. Neither move should wire onto the finished bridge — both independently fall
    // back to the one remaining safe candidate (the neighbor's original node); reusing the same
    // safe candidate for two different point-side nodes is legitimate (a node can have more than
    // one face pointing at the same neighbor's original node) and is not what `assignedThisRotation`
    // guards against (that guard is for the geometry tier only, see its own doc comment).
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const slot = splitEndpoint([0, 0], 0);
    const east = nodeEndpoint(idOf(1, 0));
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "one_way_forward" };
    edges[edgeKey(slot, east)] = { from: slot, to: east, kind: "one_way_forward" };

    const eastOfNeighbor = nodeEndpoint(idOf(1, 1));
    const westOfNeighbor = nodeEndpoint(idOf(-1, 1));
    edges[edgeKey(bridgeSlot, eastOfNeighbor)] = { from: bridgeSlot, to: eastOfNeighbor, kind: "basic" };
    edges[edgeKey(bridgeSlot, westOfNeighbor)] = { from: bridgeSlot, to: westOfNeighbor, kind: "basic" };
    const activeSplitNode: Record<string, PostEditEndpoint> = { "0,1": bridgeSlot };
    const splitPoints: Record<string, number[]> = { "0,1": [0] };

    const result = rotateSplitPointNodes(edges, [0, 0], [0], 1, squareCfg, ringCellSet, ringNodes, activeSplitNode, splitPoints);
    const originalFace = result.find((r) => r.slotId === undefined)!;
    const slotFace = result.find((r) => r.slotId === 0)!;
    // Neither move ever wires onto the finished bridge slot.
    expect(originalFace.faces[0].neighbor).not.toEqual(bridgeSlot);
    expect(slotFace.faces[0].neighbor).not.toEqual(bridgeSlot);
    expect(originalFace.faces[0].neighbor).toEqual(bridgeOriginal);
    expect(slotFace.faces[0].neighbor).toEqual(bridgeOriginal);
  });

  it("rotating a bridge tile re-stitches the static neighbor's existing bridge partner onto the corridor node that lands on the shared face, and drops the old bridge-to-bridge edge (GitHub issue #580 user repro)", () => {
    // Mirrors the exact reported scenario: two adjacent "bridge" tiles, one above the other, bridges
    // wired to each other. Rotating the point's bridge tile (both its corridor node E/W face and its
    // bridge slot's N face move by one step) makes the corridor land on the face shared with the
    // static neighbor — the neighbor's bridge slot (still pointing at `point`, unchanged) must now
    // connect to `point`'s corridor node instead of `point`'s (now moved-away) bridge slot, and the
    // old bridge-to-bridge edge must be gone, not left dangling alongside the new one.
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    const slot = splitEndpoint([0, 0], 0);
    const east = nodeEndpoint(idOf(1, 0));
    const west = nodeEndpoint(idOf(-1, 0));
    // Point's corridor (original node): E/W through-passage — unrelated to the neighbor.
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "basic" };
    edges[edgeKey(east, center)] = { from: east, to: center, kind: "basic" };
    edges[edgeKey(center, west)] = { from: center, to: west, kind: "basic" };
    edges[edgeKey(west, center)] = { from: west, to: center, kind: "basic" };
    // Point's bridge (slot 0): N face, bidirectional bridge-to-bridge with the static neighbor's own
    // bridge slot at (0,1).
    edges[edgeKey(slot, bridgeSlot)] = { from: slot, to: bridgeSlot, kind: "basic" };
    edges[edgeKey(bridgeSlot, slot)] = { from: bridgeSlot, to: slot, kind: "basic" };
    const splitPoints: Record<string, number[]> = { "0,1": [0] };

    // Rotate direction 1: E(0)->N(1), N(1)->W(2) — the corridor's E face moves onto N (now facing the
    // static neighbor at (0,1)), the bridge's N face moves onto W (now facing (-1,0), unrelated).
    const result = rotateSplitPointNodes(edges, [0, 0], [0], 1, squareCfg, ringCellSet, ringNodes, {}, splitPoints);

    const originalFace = result.find((r) => r.slotId === undefined)!;
    const slotFace = result.find((r) => r.slotId === 0)!;
    // `resolveFaceOwner` resolves the neighbor's existing partner to its canonical form — the `split`
    // form here, since the partner is itself a split slot.
    const newNorthFace = originalFace.faces.find((f) => JSON.stringify(f.neighbor) === JSON.stringify(bridgeSlot));
    expect(newNorthFace).toBeDefined();
    expect(newNorthFace!.toNeighbor).toEqual({ kind: "basic", from: center, to: bridgeSlot });
    expect(newNorthFace!.fromNeighbor).toEqual({ kind: "basic", from: bridgeSlot, to: center });
    // The stale bridge-to-bridge edge on `slot`'s own side must become an explicit wall, not vanish —
    // `slot` itself is split (has more than one declared node), so its stale face must be protected.
    const staleSlotFace = slotFace.faces.find((f) => JSON.stringify(f.neighbor) === JSON.stringify(bridgeSlot));
    expect(staleSlotFace?.toNeighbor).toEqual({ kind: "wall", from: slot, to: bridgeSlot });
    expect(staleSlotFace?.fromNeighbor).toEqual({ kind: "wall", from: bridgeSlot, to: slot });
  });

  it("old neighbor losing its partner becomes an explicit wall, not a missing/undecided face, when the old neighbor is itself split (GitHub issue #580 wall-compensation counterpart)", () => {
    // `point`'s original starts connected to the neighbor's bridge slot on its N face (toward (0,1)).
    // The neighbor's bridge slot ALSO already has a complete, unrelated opposite pair (E/W, toward
    // (1,1)/(-1,1)) — a finished bridge. Rotating `point`'s N face away (to W) makes the bridge slot
    // lose its partner on that face entirely (no move of `point`'s claims it back) — merely deleting
    // that stale edge would leave the bridge slot with one decided face short of its recognized shape
    // and the vacated face reading as undecided/optional in the UI; it must become an explicit wall.
    const edges: Record<string, PostEditEdge> = {};
    const center = nodeEndpoint(idOf(0, 0));
    edges[edgeKey(center, bridgeSlot)] = { from: center, to: bridgeSlot, kind: "basic" };
    edges[edgeKey(bridgeSlot, center)] = { from: bridgeSlot, to: center, kind: "basic" };
    const eastOfNeighbor = nodeEndpoint(idOf(1, 1));
    const westOfNeighbor = nodeEndpoint(idOf(-1, 1));
    edges[edgeKey(bridgeSlot, eastOfNeighbor)] = { from: bridgeSlot, to: eastOfNeighbor, kind: "basic" };
    edges[edgeKey(bridgeSlot, westOfNeighbor)] = { from: bridgeSlot, to: westOfNeighbor, kind: "basic" };
    const splitPoints: Record<string, number[]> = { "0,1": [0] };

    // Rotate direction 1: original's N face (toward the bridge) moves to W (unrelated) — the bridge
    // slot's own partner face is vacated, and nothing in this rotation claims the bridge slot back.
    const result = rotateSplitPointNodes(edges, [0, 0], [], 1, squareCfg, ringCellSet, ringNodes, {}, splitPoints);

    const originalFace = result.find((r) => r.slotId === undefined)!;
    const staleFace = originalFace.faces.find((f) => JSON.stringify(f.neighbor) === JSON.stringify(bridgeSlot));
    expect(staleFace).toBeDefined();
    expect(staleFace!.toNeighbor).toEqual({ kind: "wall", from: center, to: bridgeSlot });
    expect(staleFace!.fromNeighbor).toEqual({ kind: "wall", from: bridgeSlot, to: center });
  });
});

describe("canCompleteOppositePair", () => {
  it("matches when the opposite face is decided and the target face is free", () => {
    expect(canCompleteOppositePair(new Set([2]), 0, 4)).toBe(true);
    expect(canCompleteOppositePair(new Set([1]), 3, 4)).toBe(true);
  });

  it("does not match when no decided face is opposite the target", () => {
    expect(canCompleteOppositePair(new Set([1]), 2, 4)).toBe(false);
    expect(canCompleteOppositePair(new Set(), 0, 4)).toBe(false);
  });

  it("does not match when the target face itself is already decided", () => {
    expect(canCompleteOppositePair(new Set([0, 2]), 0, 4)).toBe(false);
  });

  it("odd degree (triangle) never matches", () => {
    expect(canCompleteOppositePair(new Set([0]), 1, 3)).toBe(false);
    expect(canCompleteOppositePair(new Set([0, 1, 2]), 0, 3)).toBe(false);
  });

  it("degree 6 (hex) opposite pair", () => {
    expect(canCompleteOppositePair(new Set([2]), 5, 6)).toBe(true);
    expect(canCompleteOppositePair(new Set([2]), 4, 6)).toBe(false);
  });
});

describe("hasCompleteOppositePair", () => {
  it("matches a finished opposite pair", () => {
    expect(hasCompleteOppositePair(new Set([0, 2]), 4)).toBe(true);
    expect(hasCompleteOppositePair(new Set([1, 3]), 4)).toBe(true);
  });

  it("does not match two decided faces that aren't opposite", () => {
    expect(hasCompleteOppositePair(new Set([0, 1]), 4)).toBe(false);
  });

  it("does not match fewer or more than exactly 2 decided faces", () => {
    expect(hasCompleteOppositePair(new Set(), 4)).toBe(false);
    expect(hasCompleteOppositePair(new Set([0]), 4)).toBe(false);
    expect(hasCompleteOppositePair(new Set([0, 1, 2]), 4)).toBe(false);
  });

  it("odd degree (triangle) never matches", () => {
    expect(hasCompleteOppositePair(new Set([0, 1]), 3)).toBe(false);
  });

  it("degree 6 (hex) opposite pair", () => {
    expect(hasCompleteOppositePair(new Set([1, 4]), 6)).toBe(true);
    expect(hasCompleteOppositePair(new Set([1, 3]), 6)).toBe(false);
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
    { id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const },
    { id: "v2", from: nodeEndpoint(5), to: nodeEndpoint(0), direction: "two_way" as const },
  ];

  it("matches a pair in either argument order", () => {
    expect(findPostEditVerticalPassageForPair(passages, nodeEndpoint(0), nodeEndpoint(1))?.id).toBe("v1");
    expect(findPostEditVerticalPassageForPair(passages, nodeEndpoint(1), nodeEndpoint(0))?.id).toBe("v1");
  });

  it("matches regardless of which end of the entry each id sits on", () => {
    expect(findPostEditVerticalPassageForPair(passages, nodeEndpoint(0), nodeEndpoint(5))?.id).toBe("v2");
  });

  it("returns undefined when no entry connects the pair", () => {
    expect(findPostEditVerticalPassageForPair(passages, nodeEndpoint(1), nodeEndpoint(5))).toBeUndefined();
    expect(findPostEditVerticalPassageForPair(passages, nodeEndpoint(0), nodeEndpoint(9))).toBeUndefined();
    expect(findPostEditVerticalPassageForPair([], nodeEndpoint(0), nodeEndpoint(1))).toBeUndefined();
  });

  it("matches a split-addressed endpoint too (GitHub issue #550 ninth follow-up)", () => {
    const withSplit = [{ id: "v3", from: splitEndpoint([0, 0], 0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(findPostEditVerticalPassageForPair(withSplit, splitEndpoint([0, 0], 0), nodeEndpoint(1))?.id).toBe("v3");
    expect(findPostEditVerticalPassageForPair(withSplit, nodeEndpoint(1), splitEndpoint([0, 0], 0))?.id).toBe("v3");
  });
});

// --- cyclePostEditVerticalPassageDirection ---

describe("cyclePostEditVerticalPassageDirection", () => {
  it("forward becomes backward", () => {
    const passages = [{ id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(cyclePostEditVerticalPassageDirection(passages, "v1")[0].direction).toBe("backward");
  });

  it("backward becomes forward", () => {
    const passages = [{ id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward" as const }];
    expect(cyclePostEditVerticalPassageDirection(passages, "v1")[0].direction).toBe("forward");
  });

  it("two_way is left unchanged (only meaningful for the one-way tool)", () => {
    const passages = [{ id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" as const }];
    expect(cyclePostEditVerticalPassageDirection(passages, "v1")[0].direction).toBe("two_way");
  });

  it("leaves passages with a different id untouched", () => {
    const passages = [{ id: "v2", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(cyclePostEditVerticalPassageDirection(passages, "v1")).toEqual(passages);
  });
});

// --- removePostEditVerticalPassage / removePostEditElevator ---

describe("removePostEditVerticalPassage", () => {
  it("removes the entry with the given id, keeps the rest", () => {
    const passages = [
      { id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const },
      { id: "v2", from: nodeEndpoint(2), to: nodeEndpoint(3), direction: "forward" as const },
    ];
    expect(removePostEditVerticalPassage(passages, "v1")).toEqual([passages[1]]);
  });
});

describe("removePostEditElevator", () => {
  it("removes the entry with the given id, keeps the rest", () => {
    const elevators = [
      { id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1)] },
      { id: "e2", floors: [nodeEndpoint(2), nodeEndpoint(3)] },
    ];
    expect(removePostEditElevator(elevators, "e1")).toEqual([elevators[1]]);
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
    const passages = [{ id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    const result = movePostEditVerticalPassageEndpoint(passages, { id: "v1", end: "to" }, nodeEndpoint(5));
    expect(result[0]).toEqual({ id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(5), direction: "forward" });
  });

  it("leaves entries with a different id untouched", () => {
    const passages = [{ id: "v2", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(movePostEditVerticalPassageEndpoint(passages, { id: "v1", end: "to" }, nodeEndpoint(5))).toEqual(passages);
  });
});

// --- postEditVerticalToDto ---

describe("postEditVerticalToDto", () => {
  it("forward vertical passage produces one from->to edge", () => {
    const passages = [{ id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(postEditVerticalToDto(passages, [], noSplits)).toEqual([{ from: 0, to: 1, kind: "vertical_passage" }]);
  });

  it("backward vertical passage produces one to->from edge", () => {
    const passages = [{ id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward" as const }];
    expect(postEditVerticalToDto(passages, [], noSplits)).toEqual([{ from: 1, to: 0, kind: "vertical_passage" }]);
  });

  it("two_way vertical passage produces both directions", () => {
    const passages = [{ id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" as const }];
    expect(postEditVerticalToDto(passages, [], noSplits)).toEqual([
      { from: 0, to: 1, kind: "vertical_passage" },
      { from: 1, to: 0, kind: "vertical_passage" },
    ]);
  });

  it("drops a vertical passage whose endpoint doesn't resolve", () => {
    const passages = [{ id: "v1", from: splitEndpoint([1, 2], 0), to: nodeEndpoint(1), direction: "forward" as const }];
    expect(postEditVerticalToDto(passages, [], noSplits)).toEqual([]);
  });

  it("elevator with 2 floors produces a bidirectional pair", () => {
    const elevators = [{ id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1)] }];
    const result = postEditVerticalToDto([], elevators, noSplits);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([
      { from: 0, to: 1, kind: "elevator" },
      { from: 1, to: 0, kind: "elevator" },
    ]));
  });

  it("elevator with 3 floors produces a full 6-edge mesh (every ordered pair)", () => {
    const elevators = [{ id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1), nodeEndpoint(2)] }];
    const result = postEditVerticalToDto([], elevators, noSplits);
    expect(result).toHaveLength(6);
    const pairs = new Set(result.map((e) => `${e.from}->${e.to}`));
    expect(pairs).toEqual(new Set(["0->1", "1->0", "0->2", "2->0", "1->2", "2->1"]));
  });

  it("elevator floor that doesn't resolve is excluded from the mesh, not dropped entirely", () => {
    const elevators = [{ id: "e1", floors: [nodeEndpoint(0), splitEndpoint([1, 2], 0), nodeEndpoint(1)] }];
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

// --- rotateSplitPointBreaksNeighborShape (GitHub issue #588) ---

describe("rotateSplitPointBreaksNeighborShape", () => {
  // 5x5 grid so a split point one step off-center still has all 4 of its own neighbors in-field
  // (unlike the 3x3 `gridNodes`/`centerCellSet` above, which only fits a split point AT the
  // center).
  const wideCellSet = new Set<string>();
  const wideNodes: NodeDto[] = [];
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      wideCellSet.add(`${x},${y}`);
      wideNodes.push({ id: idOf(x, y), x, y, i: 0 });
    }
  }

  it("rotating an unsplit point breaks a split neighbor's recognized bridge shape", () => {
    // Neighbor [1,0] is a degree-4 bridge: original node E-W (E=[2,0], W=[0,0] — the rotating
    // point), slot 0 N-S (N=[1,1], S=[1,-1]).
    const neighborOriginal = nodeEndpoint(idOf(1, 0));
    const neighborSlot = splitEndpoint([1, 0], 0);
    const center = nodeEndpoint(idOf(0, 0));
    const edges: Record<string, PostEditEdge> = {};
    edges[edgeKey(neighborOriginal, nodeEndpoint(idOf(2, 0)))] = { from: neighborOriginal, to: nodeEndpoint(idOf(2, 0)), kind: "basic" };
    edges[edgeKey(nodeEndpoint(idOf(2, 0)), neighborOriginal)] = { from: nodeEndpoint(idOf(2, 0)), to: neighborOriginal, kind: "basic" };
    edges[edgeKey(neighborOriginal, center)] = { from: neighborOriginal, to: center, kind: "basic" };
    edges[edgeKey(center, neighborOriginal)] = { from: center, to: neighborOriginal, kind: "basic" };
    edges[edgeKey(neighborSlot, nodeEndpoint(idOf(1, 1)))] = { from: neighborSlot, to: nodeEndpoint(idOf(1, 1)), kind: "basic" };
    edges[edgeKey(nodeEndpoint(idOf(1, 1)), neighborSlot)] = { from: nodeEndpoint(idOf(1, 1)), to: neighborSlot, kind: "basic" };
    edges[edgeKey(neighborSlot, nodeEndpoint(idOf(1, -1)))] = { from: neighborSlot, to: nodeEndpoint(idOf(1, -1)), kind: "basic" };
    edges[edgeKey(nodeEndpoint(idOf(1, -1)), neighborSlot)] = { from: nodeEndpoint(idOf(1, -1)), to: neighborSlot, kind: "basic" };
    const splitPoints = { "1,0": [0] };

    // Rotating the (unsplit) center by +1 moves its E-face passage to N — [1,0]'s original node
    // loses its W-face connection to `center` and, being itself split, gets it wall-compensated
    // instead of just vanishing, dropping it to 1 connected face (E only) — no longer a bridge.
    const broken = rotateSplitPointBreaksNeighborShape(edges, [0, 0], [], 1, squareCfg, wideCellSet, wideNodes, {}, splitPoints);
    expect(broken).toBe(true);

    // The reverse direction (-1) moves the E-face passage to S instead — same outcome, opposite
    // rotation.
    const brokenOtherDirection = rotateSplitPointBreaksNeighborShape(edges, [0, 0], [], -1, squareCfg, wideCellSet, wideNodes, {}, splitPoints);
    expect(brokenOtherDirection).toBe(true);
  });

  it("no-op rotation (nothing wired at the rotating point) never reports a break", () => {
    const splitPoints = { "1,0": [0] };
    const broken = rotateSplitPointBreaksNeighborShape({}, [0, 0], [], 1, squareCfg, wideCellSet, wideNodes, {}, splitPoints);
    expect(broken).toBe(false);
  });

  it("rotating next to a plain (non-split) neighbor never reports a break", () => {
    const center = nodeEndpoint(idOf(0, 0));
    const east = nodeEndpoint(idOf(1, 0));
    const edges: Record<string, PostEditEdge> = {};
    edges[edgeKey(center, east)] = { from: center, to: east, kind: "one_way_forward" };
    const broken = rotateSplitPointBreaksNeighborShape(edges, [0, 0], [], 1, squareCfg, wideCellSet, wideNodes, {}, {});
    expect(broken).toBe(false);
  });
});
