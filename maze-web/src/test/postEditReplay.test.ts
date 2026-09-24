import { describe, it, expect } from "vitest";
import {
  applyPostEditCommand, replayPostEditCommands, replayPostEditCommandsFailClosed,
  filterCommandsForPoint, isCreateCommand, resetCommandsAt, deleteCommandAt,
  affectedIndicesForReset, affectedIndicesForDelete,
} from "../pixi/postEditReplay";
import type { PostEditBaseline, PostEditDerivedState, PostEditReplayContext } from "../pixi/postEditReplay";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import type { PostEditEdgeState } from "../store/postEditTypes";
import { nodeEndpoint, splitEndpoint, edgeKey, type PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { NodeDto, EdgeDto } from "../wasm/types";

const n = nodeEndpoint;

/** Builds a `PostEditEdgeState` (GitHub issue #564) — `id` required exactly when `kind` is a
 *  one-way variant, defaulting to "o1". */
const es = (from: PostEditEndpoint, to: PostEditEndpoint, kind: PostEditEdgeState["kind"], _id = "o1"): PostEditEdgeState => ({ kind, from, to });

function emptyDerived(): PostEditDerivedState {
  return {
    edges: {},
    teleports: [],
    meta: { start: null, finish: null },
    splitPoints: {},
    splitPointIds: {},
    verticalPassages: [],
    elevators: [],
  };
}

/** A baseline over two plain nodes (0, 1) at (0,0)/(1,0), no split points, no generation-time
 *  mesh edges — the minimal scenario most tests need. `resolveSplit` is `undefined` everywhere. */
function baseContext(nodes: NodeDto[] = [], edges: EdgeDto[] = []): PostEditReplayContext {
  return { nodes, edges, resolveSplit: () => undefined };
}

function makeBaseline(over: Partial<PostEditBaseline> = {}): PostEditBaseline {
  return { revision: 0, context: baseContext(), derived: emptyDerived(), ...over };
}

describe("applyPostEditCommand — exact sequence", () => {
  it("replays a small deterministic scenario step by step", () => {
    const context = baseContext();
    let state = emptyDerived();

    let r = applyPostEditCommand(context, state, { kind: "setEdge", edge: es(n(0), n(1), "basic") });
    expect(r.applied).toBe(true);
    state = r.state;
    expect(state.edges).toEqual({ [edgeKey(n(0), n(1))]: { from: n(0), to: n(1), kind: "basic" } });

    r = applyPostEditCommand(context, state, { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "two_way" });
    expect(r.applied).toBe(true);
    state = r.state;
    expect(state.teleports).toEqual([{ id: "t1", from: n(0), to: n(1), direction: "two_way" }]);

    r = applyPostEditCommand(context, state, { kind: "setMeta", slot: "start", endpoint: n(0) });
    expect(r.applied).toBe(true);
    state = r.state;
    expect(state.meta).toEqual({ start: n(0), finish: null });

    r = applyPostEditCommand(context, state, { kind: "removeTeleport", id: "t1", from: n(0), to: n(1), direction: "two_way" });
    expect(r.applied).toBe(true);
    state = r.state;
    expect(state.teleports).toEqual([]);

    r = applyPostEditCommand(context, state, { kind: "setEdge", edge: es(n(0), n(1), "wall") });
    expect(r.applied).toBe(true);
    state = r.state;
    expect(state.edges).toEqual({});
  });
});

describe("applyPostEditCommand — immutability", () => {
  it("never mutates the input state", () => {
    const context = baseContext();
    const before: PostEditDerivedState = {
      ...emptyDerived(),
      edges: { [edgeKey(n(0), n(1))]: { from: n(0), to: n(1), kind: "basic" } },
      teleports: [{ id: "t1", from: n(0), to: n(1), direction: "forward" }],
    };
    const snapshot = JSON.parse(JSON.stringify(before));
    applyPostEditCommand(context, before, { kind: "setEdge", edge: es(n(1), n(0), "basic") });
    applyPostEditCommand(context, before, { kind: "removeTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" });
    applyPostEditCommand(context, before, { kind: "setMeta", slot: "start", endpoint: n(0) });
    const after = JSON.parse(JSON.stringify(before));
    expect(after).toEqual(snapshot);
  });
});

describe("replayPostEditCommands — parity with incremental append", () => {
  it("gives the same result as folding the same commands one at a time", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setMeta", slot: "start", endpoint: n(0) },
      { kind: "setTeleportDirection", id: "t1", direction: "two_way", from: n(0), to: n(1) },
      { kind: "setEdge", edge: es(n(0), n(1), "wall") },
    ];

    const bulk = replayPostEditCommands(baseline, commands);

    let incremental = baseline.derived;
    for (const command of commands) {
      const result = applyPostEditCommand(baseline.context, incremental, command);
      expect(result.applied).toBe(true);
      incremental = result.state;
    }

    expect(incremental).toEqual(bulk);
  });
});

describe("filterCommandsForPoint — fixed-point pruning", () => {
  it("cascades through a multi-level dependency chain in one call (slot -> edge on slot -> move another lifeline through that slot)", () => {
    // Point A (0,0) gets a split slot 0 minted via addSplitNode; an edge is drawn from that slot to
    // node 5 at point B (1,0); a teleport, originally unrelated to A or B, is then moved so its
    // `to` endpoint lands on that same slot. Resetting point A must remove all three: the slot
    // itself, the edge hung off it, and the teleport move that later referenced it — a single
    // validation pass over the original command list would only catch the slot (the direct
        // point-A touch) and the edge (references A's point directly) but not the teleport move,
    // which touches A only *through* the slot lifeline, not directly.
    const pointA: [number, number] = [0, 0];
    const slotAEndpoint = splitEndpoint(pointA, 0);
    const context = baseContext([{ id: 5, x: 1, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });

    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: pointA, slotId: 0, pointId: "s1" },
      { kind: "setEdge", edge: es(slotAEndpoint, n(5), "basic") },
      { kind: "addTeleport", id: "t9", from: n(5), to: n(5), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: "t9", end: "to", endpoint: slotAEndpoint, from: n(5), to: slotAEndpoint, direction: "forward" },
    ];

    const filtered = filterCommandsForPoint(baseline, commands, pointA);
    expect(filtered).toEqual([]);
  });

  it("leaves commands touching an unrelated point untouched", () => {
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0 },
      { id: 1, x: 1, y: 0, i: 0 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "setEdge", edge: es(n(0), n(1), "basic") },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [5, 5]);
    expect(filtered).toEqual(commands);
  });
});

describe("filterCommandsForPoint — add split -> attach entity -> reset split point", () => {
  it("removes both the split node and the entity attached to it", () => {
    const point: [number, number] = [2, 2];
    const slot = splitEndpoint(point, 0);
    const context = baseContext([{ id: 7, x: 3, y: 2, i: 0 }]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point, slotId: 0, pointId: "s1" },
      { kind: "addTeleport", id: "t1", from: slot, to: n(7), direction: "forward" },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, point);
    expect(filtered).toEqual([]);
  });
});

describe("updateSplitNodeFaces (GitHub issue #545)", () => {
  it("wires the slot's edges to every listed neighbor in both directions, clearing any face left out", () => {
    const point: [number, number] = [0, 0];
    const slot = splitEndpoint(point, 0);
    const context = baseContext([{ id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: -1, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    let state = baseline.derived;
    state = applyPostEditCommand(context, state, { kind: "addSplitNode", point, slotId: 0, pointId: "s1" }).state;
    state = applyPostEditCommand(context, state, {
      kind: "updateSplitNodeFaces", point, slotId: 0, pointId: "s1",
      faces: [{ neighbor: n(1), toNeighbor: es(slot, n(1), "basic"), fromNeighbor: es(n(1), slot, "one_way_backward") }],
    }).state;
    expect(state.edges[edgeKey(slot, n(1))]).toEqual({ from: slot, to: n(1), kind: "basic" });
    expect(state.edges[edgeKey(n(1), slot)]).toEqual({ from: n(1), to: slot, kind: "one_way_backward" });

    // A later command with a different face list replaces the first entirely — the removed
    // neighbor's edges are gone, not left stale from the previous command.
    state = applyPostEditCommand(context, state, {
      kind: "updateSplitNodeFaces", point, slotId: 0, pointId: "s1",
      faces: [{ neighbor: n(2), toNeighbor: es(slot, n(2), "wall"), fromNeighbor: es(n(2), slot, "basic") }],
    }).state;
    expect(state.edges[edgeKey(slot, n(1))]).toBeUndefined();
    expect(state.edges[edgeKey(n(1), slot)]).toBeUndefined();
    expect(state.edges[edgeKey(slot, n(2))]).toBeUndefined();
    expect(state.edges[edgeKey(n(2), slot)]).toEqual({ from: n(2), to: slot, kind: "basic" });
  });

  it("fails when the slot isn't currently registered (pruned by a prior removeSplitNode)", () => {
    const point: [number, number] = [0, 0];
    const context = baseContext([{ id: 1, x: 1, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    const result = applyPostEditCommand(context, baseline.derived, {
      kind: "updateSplitNodeFaces", point, slotId: 0, pointId: "s1", faces: [{ neighbor: n(1), toNeighbor: es(splitEndpoint(point, 0), n(1), "basic"), fromNeighbor: es(n(1), splitEndpoint(point, 0), "basic") }],
    });
    expect(result.applied).toBe(false);
  });

  it("shares its lifeline with addSplitNode — resetting the slot's own point drops both from the log", () => {
    const point: [number, number] = [0, 0];
    const slot = splitEndpoint(point, 0);
    const context = baseContext([{ id: 1, x: 1, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point, slotId: 0, pointId: "s1" },
      { kind: "updateSplitNodeFaces", point, slotId: 0, pointId: "s1", faces: [{ neighbor: n(1), toNeighbor: es(slot, n(1), "basic"), fromNeighbor: es(n(1), slot, "basic") }] },
    ];
    expect(filterCommandsForPoint(baseline, commands, point)).toEqual([]);
  });

  it("wires the ORIGINAL node's edges when slotId is undefined (GitHub issue #564 follow-up), resolving it via nodeAt(...,0)", () => {
    const point: [number, number] = [0, 0];
    const original = n(0);
    const context = baseContext([{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    let state = baseline.derived;
    state = applyPostEditCommand(context, state, { kind: "addSplitNode", point, slotId: 0, pointId: "s1" }).state;
    state = applyPostEditCommand(context, state, {
      kind: "updateSplitNodeFaces", point, slotId: undefined, pointId: "s1",
      faces: [{ neighbor: n(1), toNeighbor: es(original, n(1), "basic"), fromNeighbor: es(n(1), original, "basic") }],
    }).state;
    expect(state.edges[edgeKey(original, n(1))]).toEqual({ from: original, to: n(1), kind: "basic" });
    expect(state.edges[edgeKey(n(1), original)]).toEqual({ from: n(1), to: original, kind: "basic" });
  });

  it("cascades: resetting a neighbor point drops the whole (0,0) slot lifeline, since its updateSplitNodeFaces references the reset slot", () => {
    // Slot at (0,0) has a face wired to a split node at (2,0) — resetting (2,0) removes that
    // split node's own lifeline (via endpointsReferencedBy), and since updateSplitNodeFaces(0,0)
    // shares its own lifeline with addSplitNode(0,0) (same slot), the whole (0,0) slot goes too —
    // same "one entity, one lifeline" cascade `addElevator`/`updateElevatorFloors` already has.
    const pointA: [number, number] = [0, 0];
    const pointB: [number, number] = [2, 0];
    const slotB = splitEndpoint(pointB, 0);
    const context = baseContext([]);
    const baseline = makeBaseline({ context });
    const slotA = splitEndpoint(pointA, 0);
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: pointA, slotId: 0, pointId: "s1" },
      { kind: "addSplitNode", point: pointB, slotId: 0, pointId: "s2" },
      { kind: "updateSplitNodeFaces", point: pointA, slotId: 0, pointId: "s1", faces: [{ neighbor: slotB, toNeighbor: es(slotA, slotB, "basic"), fromNeighbor: es(slotB, slotA, "basic") }] },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, pointB);
    expect(filtered).toEqual([]);
  });
});

describe("filterCommandsForPoint — cascades through a removed/edited entity's own denormalized from/to (GitHub issue #564 follow-up)", () => {
  // `endpointsReferencedBy` (postEditReplay.ts) drives this cascade — a lifeline whose only mention
  // of a reset split slot is through a denormalized field (not `commandTouchesPoint`'s own live-state
  // check) must still be found, or resetting that slot leaves a dangling reference in the log.
  it("cascades a removeTeleport referencing a reset slot only through its own denormalized from/to", () => {
    const pointB: [number, number] = [2, 0];
    const slotB = splitEndpoint(pointB, 0);
    const context = baseContext([{ id: 0, x: 0, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: pointB, slotId: 0, pointId: "s1" },
      { kind: "removeTeleport", id: "t1", from: n(0), to: slotB, direction: "forward" },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, pointB);
    expect(filtered).toEqual([]);
  });

  it("cascades a setVerticalPassageDirection/removeVerticalPassage/removeElevator referencing a reset slot only through their own denormalized fields", () => {
    const point: [number, number] = [2, 0];
    const slot = splitEndpoint(point, 0);
    const context = baseContext([{ id: 0, x: 0, y: 0, i: 0 }]);
    const testCommands: PostEditCommand[] = [
      { kind: "setVerticalPassageDirection", id: "v1", direction: "two_way", from: n(0), to: slot },
      { kind: "removeVerticalPassage", id: "v1", from: n(0), to: slot, direction: "forward" },
      { kind: "removeElevator", id: "e1", floors: [n(0), slot] },
    ];
    for (const command of testCommands) {
      const baseline = makeBaseline({ context });
      const commands: PostEditCommand[] = [{ kind: "addSplitNode", point, slotId: 0, pointId: "s1" }, command];
      const filtered = filterCommandsForPoint(baseline, commands, point);
      expect(filtered).toEqual([]);
    }
  });
});

describe("filterCommandsForPoint — cross-point lifeline", () => {
  it("removes a whole entity lifeline when reset at its origin point, including edits made at the other end", () => {
    // Generation-time teleport A<->B (A = node 0, B = node 1); user moves B's end to node 2 (point
    // C), then edits the teleport again at C. Resetting A must drop the whole lifeline (the move
    // and the edit), since the entity's own identity/root is the teleport id created touching A.
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0 },
      { id: 1, x: 1, y: 0, i: 0 },
      { id: 2, x: 2, y: 0, i: 0 },
    ]);
    const baseline = makeBaseline({
      context,
      derived: {
        ...emptyDerived(),
        teleports: [{ id: "t1", from: n(0), to: n(1), direction: "forward" }],
      },
    });
    const commands: PostEditCommand[] = [
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "two_way", from: n(0), to: n(2) },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [0, 0]);
    expect(filtered).toEqual([]);
  });
});

describe("filterCommandsForPoint — vertical passage / elevator lifelines", () => {
  it("removes a vertical passage lifeline touching the reset point (addVerticalPassage + a later move)", () => {
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0 },
      { id: 1, x: 1, y: 0, i: 0 },
      { id: 2, x: 2, y: 0, i: 0 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [0, 0]);
    expect(filtered).toEqual([]);
  });

  it("leaves a vertical passage untouched when reset at an unrelated point", () => {
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0 },
      { id: 1, x: 1, y: 0, i: 0 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [9, 9]);
    expect(filtered).toEqual(commands);
  });

  it("removes an elevator lifeline touching the reset point (addElevator + a later floors update)", () => {
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0, level: 0 },
      { id: 1, x: 0, y: 0, i: 0, level: 1 },
      { id: 2, x: 0, y: 0, i: 0, level: 2 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addElevator", id: "e1", floors: [n(0), n(1)] },
      { kind: "updateElevatorFloors", id: "e1", floors: [n(0), n(1), n(2)] },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [0, 0]);
    expect(filtered).toEqual([]);
  });

  it("leaves an elevator untouched when none of its floors are at the reset point", () => {
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0, level: 0 },
      { id: 1, x: 0, y: 0, i: 0, level: 1 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addElevator", id: "e1", floors: [n(0), n(1)] },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [9, 9]);
    expect(filtered).toEqual(commands);
  });

  it("removes an elevator lifeline touching the reset point even when that floor was dropped by a later updateElevatorFloors (GitHub issue #564)", () => {
    // Re-editing a 3-floor elevator down to 2 floors — the reset point's node is still part of the
    // lifeline via `commandTouchesPoint`'s own multi-floor elevator reasoning, no suppression
    // bookkeeping needed (generation-baked elevators are full baseline draft entries now).
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0, level: 0 },
      { id: 1, x: 0, y: 0, i: 0, level: 1 },
      { id: 2, x: 0, y: 0, i: 0, level: 2 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addElevator", id: "e1", floors: [n(0), n(1), n(2)] },
      { kind: "updateElevatorFloors", id: "e1", floors: [n(0), n(1)] },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [0, 0], 2);
    expect(filtered).toEqual([]);
  });

  it("removes a vertical passage lifeline touching the reset point through setVerticalPassageDirection's own denormalized from/to (GitHub issue #564)", () => {
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0, level: 0 },
      { id: 1, x: 0, y: 0, i: 0, level: 1 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setVerticalPassageDirection", id: "v1", direction: "backward", from: n(0), to: n(1) },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [0, 0], 1);
    expect(filtered).toEqual([]);
  });
});

describe("delete -> point reset restores", () => {
  it("the individual commands the Delete tool emits for a point are pruned by a reset of that point", () => {
    // GitHub issue #545: the Delete tool no longer emits one bundled `deletePoint` command — it
    // appends ordinary per-entity commands instead (`setMeta`/`removeTeleport`/etc.), each with its
    // own lifeline. A point reset must still undo every one of them via the ordinary per-lifeline
    // cascade, with no dedicated "deletePoint" lifeline involved.
    const point: [number, number] = [4, 4];
    const nodeAtPoint = { id: 3, x: 4, y: 4, i: 0 };
    const other = { id: 5, x: 9, y: 9, i: 0 };
    const context = baseContext([nodeAtPoint, other]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "setMeta", slot: "start", endpoint: n(3) },
      { kind: "addTeleport", id: "t1", from: n(3), to: n(5), direction: "forward" },
      { kind: "removeTeleport", id: "t1", from: n(3), to: n(5), direction: "forward" },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, point);
    expect(filtered).toEqual([]);
  });
});

describe("reset independent of confirmed state / untouched entities", () => {
  it("resetting one point does not affect an entity that never touched it", () => {
    const context = baseContext([
      { id: 10, x: 9, y: 9, i: 0 },
      { id: 11, x: 8, y: 8, i: 0 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(10), to: n(11), direction: "forward" },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [0, 0]);
    expect(filtered).toEqual(commands);
  });

  it("reset all (empty command list) equals the pristine baseline", () => {
    const baseline = makeBaseline({
      derived: { ...emptyDerived(), edges: { [edgeKey(n(0), n(1))]: { from: n(0), to: n(1), kind: "basic" } } },
    });
    const derived = replayPostEditCommands(baseline, []);
    expect(derived).toEqual(baseline.derived);
  });
});

describe("load — fail-closed", () => {
  it("rejects the entire log the moment one command doesn't resolve", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      { kind: "removeTeleport", id: "t999", from: n(0), to: n(1), direction: "forward" }, // no such teleport — invalid reference
      { kind: "setMeta", slot: "start", endpoint: n(0) },
    ];
    const result = replayPostEditCommandsFailClosed(baseline, commands);
    expect(result).toBeUndefined();
  });

  it("accepts a fully-resolving log", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      { kind: "setMeta", slot: "start", endpoint: n(0) },
    ];
    const result = replayPostEditCommandsFailClosed(baseline, commands);
    expect(result).toBeDefined();
    expect(result?.meta.start).toEqual(n(0));
  });
});

describe("id no-reuse", () => {
  it("a point-reset that prunes high-id commands does not make those ids reusable by itself — high-water marks are the caller's separate responsibility", () => {
    // filterCommandsForPoint only prunes the log; it has no opinion on id counters (those are
    // persisted separately per the plan, see ProjectFilePostEdit.nextTeleportId & co.). This test
    // documents that the pruned log alone doesn't reintroduce id 5 as available — a fresh replay
    // of the pruned list simply has no teleport id 5 in it any more, one way or another.
    const point: [number, number] = [0, 0];
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0 },
      { id: 1, x: 1, y: 0, i: 0 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t5", from: n(0), to: n(1), direction: "forward" },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, point);
    expect(filtered).toEqual([]);
    const derived = replayPostEditCommands(baseline, filtered);
    expect(derived.teleports.some((t) => t.id === "t5")).toBe(false);
  });
});

describe("setEdgePair one-way lifelines (GitHub issue #564)", () => {
  it("resetting the point that owns a fresh one-way's id prunes it; an unrelated point leaves it", () => {
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0 },
      { id: 1, x: 1, y: 0, i: 0 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward", "o7"), bToA: es(n(1), n(0), "wall") },
    ];
    expect(filterCommandsForPoint(baseline, commands, [0, 0])).toEqual([]);
    expect(filterCommandsForPoint(baseline, commands, [9, 9])).toEqual(commands);
  });

  it("a setEdgePair that both destroys an old one-way and creates a new one cascades both lifelines", () => {
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0 },
      { id: 1, x: 1, y: 0, i: 0 },
    ]);
    const baseline = makeBaseline({ context });
    // aToB flips from an old one-way (id 3, destroyed) to a fresh one-way on the other side isn't
    // representable directly here — instead exercise the plainer case: aToB stays wall (nothing new),
    // bToA replaces an old one-way (id 3) with a fresh one (id 8) — both ids must cascade.
    const commands: PostEditCommand[] = [
      {
        kind: "setEdgePair", a: n(0), b: n(1),
        aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "one_way_forward", "o8"),
      },
    ];
    // Any point on the a/b face touches both the destroyed and the created lifeline.
    expect(filterCommandsForPoint(baseline, commands, [0, 0])).toEqual([]);
  });
});

describe("isCreateCommand (GitHub issue #547)", () => {
  it("every add*/applySplitBlueprint is a create", () => {
    expect(isCreateCommand({ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" })).toBe(true);
    expect(isCreateCommand({ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" })).toBe(true);
    expect(isCreateCommand({ kind: "addElevator", id: "e1", floors: [n(0)] })).toBe(true);
    expect(isCreateCommand({ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" })).toBe(true);
    expect(isCreateCommand({ kind: "applySplitBlueprint", point: [0, 0], resolvedSlots: [], pointId: "s1" })).toBe(true);
  });

  it("edge state commands are not entity creation commands", () => {
    expect(isCreateCommand({ kind: "setEdge", edge: es(n(0), n(1), "one_way_forward", "o1") })).toBe(false);
    expect(isCreateCommand({ kind: "setEdge", edge: es(n(0), n(1), "basic") })).toBe(false);
    expect(isCreateCommand({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward", "o1"), bToA: es(n(1), n(0), "wall"),
    })).toBe(false);
    expect(isCreateCommand({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "wall"),
    })).toBe(false);
    // Flipping an already-one-way face reuses its id — same entity, new direction, not a create.
    expect(isCreateCommand({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_backward", "o1"), bToA: es(n(1), n(0), "wall"),
    })).toBe(false);
  });

  it("every non-create/non-mint command kind is not a create", () => {
    expect(isCreateCommand({ kind: "setTeleportDirection", id: "t1", direction: "two_way", from: n(0), to: n(1) })).toBe(false);
    expect(isCreateCommand({ kind: "removeTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" })).toBe(false);
    expect(isCreateCommand({ kind: "setMeta", slot: "start", endpoint: n(0) })).toBe(false);
    expect(isCreateCommand({ kind: "rotateSplitPoint", point: [0, 0], nodes: [] })).toBe(false);
  });
});

describe("resetCommandsAt (GitHub issue #547)", () => {
  it("truncates the log to keep the target command and drop everything after it", () => {
    const commands: PostEditCommand[] = [
      { kind: "setMeta", slot: "start", endpoint: n(0) },
      { kind: "setMeta", slot: "finish", endpoint: n(1) },
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
    ];
    expect(resetCommandsAt(commands, 1)).toEqual(commands.slice(0, 2));
    expect(resetCommandsAt(commands, 0)).toEqual(commands.slice(0, 1));
  });

  it("is a no-op on the last index and returns the input unchanged (by reference) for an out-of-range index", () => {
    const commands: PostEditCommand[] = [{ kind: "setMeta", slot: "start", endpoint: n(0) }];
    expect(resetCommandsAt(commands, 0)).toEqual(commands);
    expect(resetCommandsAt(commands, 5)).toBe(commands);
    expect(resetCommandsAt(commands, -1)).toBe(commands);
  });
});

describe("deleteCommandAt — collapse (GitHub issue #547)", () => {
  it("deleting an intermediate teleport move collapses the chain (P1->P2, P2->P3 becomes just P1->P3)", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(3), from: n(2), to: n(3), direction: "forward" },
    ];
    const next = deleteCommandAt(baseline, commands, 1);
    expect(next).toEqual([
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      // Denormalized from/to re-resolved against the post-deletion state: this move now starts
      // from the teleport's ACTUAL prior endpoint (n(0), the add's own `to`), not the deleted
      // step's n(2) — the resulting derived state (t1: n(0) -> n(3)) is preserved either way.
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(3), from: n(0), to: n(3), direction: "forward" },
    ]);
    const derived = replayPostEditCommands(baseline, next);
    expect(derived.teleports).toEqual([{ id: "t1", from: n(0), to: n(3), direction: "forward" }]);
  });

  it("deleting a removeTeleport command restores the teleport (a deletion command is itself undoable)", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "removeTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
    ];
    const next = deleteCommandAt(baseline, commands, 1);
    expect(next).toEqual([{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" }]);
    const derived = replayPostEditCommands(baseline, next);
    expect(derived.teleports).toEqual([{ id: "t1", from: n(0), to: n(1), direction: "forward" }]);
  });

  it("re-resolves setMeta's denormalized previousEndpoint after deleting an earlier setMeta on the same slot", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setMeta", slot: "start", endpoint: n(0) },
      { kind: "setMeta", slot: "start", endpoint: n(1) },
      { kind: "setMeta", slot: "start", endpoint: null, previousEndpoint: n(1) },
    ];
    // Deleting the middle setMeta (n(0) -> n(1)) leaves the clear's own previousEndpoint stale
    // (still n(1)) unless re-resolved against the new preceding state (n(0), from the first command).
    const next = deleteCommandAt(baseline, commands, 1);
    expect(next).toEqual([
      { kind: "setMeta", slot: "start", endpoint: n(0) },
      { kind: "setMeta", slot: "start", endpoint: null, previousEndpoint: n(0) },
    ]);
  });

  it("re-resolves a surviving removeTeleport's denormalized from/to/direction after deleting an earlier move of the same teleport", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
      { kind: "removeTeleport", id: "t1", from: n(0), to: n(2), direction: "forward" },
    ];
    // Deleting the move leaves the removeTeleport's own denormalized from/to stale (still n(2))
    // unless re-resolved against the new preceding state (the teleport's original n(0)->n(1)).
    const next = deleteCommandAt(baseline, commands, 1);
    expect(next).toEqual([
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "removeTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
    ]);
  });

  it("collapses a vertical-passage move chain and re-resolves a surviving removeVerticalPassage's denormalized fields", () => {
    const baseline = makeBaseline();
    const collapseCommands: PostEditCommand[] = [
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
      { kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(3), from: n(2), to: n(3), direction: "forward" },
    ];
    expect(deleteCommandAt(baseline, collapseCommands, 1)).toEqual([
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(3), from: n(0), to: n(3), direction: "forward" },
    ]);

    // A non-direction move collapsed ahead of a surviving setVerticalPassageDirection re-resolves
    // that flip's own denormalized from/to too (renormalizeCommand's setVerticalPassageDirection
    // branch, distinct from the direction-pair-cascade tests above, which never collapse — they
    // always delete a flip itself, not a move preceding one).
    const directionCommands: PostEditCommand[] = [
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
      { kind: "setVerticalPassageDirection", id: "v1", direction: "backward", from: n(0), to: n(2) },
    ];
    expect(deleteCommandAt(baseline, directionCommands, 1)).toEqual([
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setVerticalPassageDirection", id: "v1", direction: "backward", from: n(0), to: n(1) },
    ]);

    const removeCommands: PostEditCommand[] = [
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
      { kind: "removeVerticalPassage", id: "v1", from: n(0), to: n(2), direction: "forward" },
    ];
    expect(deleteCommandAt(baseline, removeCommands, 1)).toEqual([
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "removeVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
    ]);
  });

  it("re-resolves a surviving removeElevator's denormalized floors after deleting an earlier updateElevatorFloors", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addElevator", id: "e1", floors: [n(0), n(1)] },
      { kind: "updateElevatorFloors", id: "e1", floors: [n(0), n(1), n(2)] },
      { kind: "removeElevator", id: "e1", floors: [n(0), n(1), n(2)] },
    ];
    // Deleting the floors update leaves the removeElevator's own denormalized floors stale (still
    // includes n(2)) unless re-resolved against the new preceding state (the elevator's original
    // two floors).
    const next = deleteCommandAt(baseline, commands, 1);
    expect(next).toEqual([
      { kind: "addElevator", id: "e1", floors: [n(0), n(1)] },
      { kind: "removeElevator", id: "e1", floors: [n(0), n(1)] },
    ]);
  });
});

describe("deleteCommandAt — create cascade (GitHub issue #547)", () => {
  it("deleting an addSplitNode cascades every command that added to or moved within that slot's node", () => {
    const context = baseContext([{ id: 0, x: 0, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "setEdge", edge: es(splitEndpoint([0, 0], 0), n(5), "basic") },
      { kind: "setMeta", slot: "start", endpoint: n(9) },
      { kind: "setMeta", slot: "finish", endpoint: splitEndpoint([0, 0], 0) },
    ];
    const next = deleteCommandAt(baseline, commands, 0);
    // The slot itself, the edge hung off it, and the later command referencing it are all gone —
    // only the unrelated setMeta survives, same cascade shape filterCommandsForPoint gives.
    expect(next).toEqual([{ kind: "setMeta", slot: "start", endpoint: n(9) }]);
  });

  it("cascades within a single entity's own lifeline too: a moveTeleportEndpoint onto a removed slot takes the WHOLE teleport lifeline with it (same lifeline-granularity rule filterCommandsForPoint already applies)", () => {
    const context = baseContext([{ id: 0, x: 0, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "addTeleport", id: "t1", from: n(9), to: n(9), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: splitEndpoint([0, 0], 0), from: n(9), to: splitEndpoint([0, 0], 0), direction: "forward" },
    ];
    expect(deleteCommandAt(baseline, commands, 0)).toEqual([]);
  });

  it("deleting a fresh one-way mint (setEdgePair) removes only that lifeline, leaving an unrelated later edit", () => {
    const context = baseContext([{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward", "o1"), bToA: es(n(1), n(0), "wall") },
      { kind: "setMeta", slot: "start", endpoint: n(0) },
    ];
    const next = deleteCommandAt(baseline, commands, 0);
    expect(next).toEqual([{ kind: "setMeta", slot: "start", endpoint: n(0) }]);
  });
});

describe("deleteCommandAt — direction-flip pair cascade (GitHub issue #547 second follow-up)", () => {
  it("deleting the middle flip of ->,<-,-> also drops the very next flip, leaving a single -> instead of two consecutive ones", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(0), to: n(1) },
      { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(1) },
    ];
    const next = deleteCommandAt(baseline, commands, 1);
    expect(next).toEqual([{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" }]);
    expect(replayPostEditCommands(baseline, next).teleports).toEqual([{ id: "t1", from: n(0), to: n(1), direction: "forward" }]);
  });

  it("deleting a flip with no later flip in the same lifeline is a plain single-entry collapse", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(0), to: n(1) },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "backward" },
    ];
    const next = deleteCommandAt(baseline, commands, 1);
    expect(next).toEqual([
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
    ]);
  });

  it("a non-direction command of the same lifeline in between doesn't break the pairing (next flip still found)", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(0), to: n(1) },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "backward" },
      { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(2) },
    ];
    const next = deleteCommandAt(baseline, commands, 1);
    // The next flip search skips over the non-direction moveTeleportEndpoint (same lifeline, not a
    // flip) and finds the later setTeleportDirection (index 3) as the deleted flip's own pair —
    // that one is cascaded too, leaving just the create and the move.
    expect(next).toEqual([
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
    ]);
  });

  it("a direction flip of a DIFFERENT lifeline in between is ignored — only the same lifeline's own next flip counts", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "addTeleport", id: "t2", from: n(2), to: n(3), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(0), to: n(1) },
      { kind: "setTeleportDirection", id: "t2", direction: "backward", from: n(2), to: n(3) },
      { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(1) },
    ];
    const next = deleteCommandAt(baseline, commands, 2);
    expect(next).toEqual([
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "addTeleport", id: "t2", from: n(2), to: n(3), direction: "forward" },
      { kind: "setTeleportDirection", id: "t2", direction: "backward", from: n(2), to: n(3) },
    ]);
  });

  it("applies to vertical-passage direction cycles", () => {
    const context = baseContext([{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    const vpCommands: PostEditCommand[] = [
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setVerticalPassageDirection", id: "v1", direction: "backward", from: n(0), to: n(1) },
      { kind: "setVerticalPassageDirection", id: "v1", direction: "forward", from: n(0), to: n(1) },
    ];
    expect(deleteCommandAt(baseline, vpCommands, 1)).toEqual([
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
    ]);

  });

  it("a bare setEdge one-way is a face-state update", () => {
    const baseline = makeBaseline();
    const cascadeCommands: PostEditCommand[] = [
      { kind: "setEdge", edge: es(n(0), n(1), "one_way_forward", "o1") },
      { kind: "setEdge", edge: es(n(0), n(1), "one_way_backward", "o1") },
      { kind: "setEdge", edge: es(n(0), n(1), "one_way_forward", "o1") },
    ];
    expect(deleteCommandAt(baseline, cascadeCommands, 1)).toEqual([cascadeCommands[0], cascadeCommands[2]]);
  });

  it("edge state deletion does not use direction lifelines", () => {
    // `nextDirectionCommandIndex`'s search loop classifies every intervening command via
    // `isDirectionCommand`, including a plain `setEdge` candidate (not just the delete target) —
    // this is the only way `isDirectionCommand`'s own `setEdge` branch is reachable, since a
    // `setEdge` one-way is always a create when it's the delete TARGET (see the test above).
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward", "o1"), bToA: es(n(1), n(0), "wall") },
      {
        kind: "setEdgePair", a: n(0), b: n(1),
        aToB: es(n(0), n(1), "one_way_backward", "o1"), bToA: es(n(1), n(0), "wall"),
      },
      { kind: "setEdge", edge: es(n(0), n(1), "one_way_forward", "o1") },
    ];
    expect(deleteCommandAt(baseline, commands, 1)).toEqual([commands[0], commands[2]]);
  });
});

describe("affectedIndicesForReset / affectedIndicesForDelete — blast-radius preview (GitHub issue #547 second follow-up)", () => {
  it("affectedIndicesForReset returns every index strictly after the target", () => {
    const commands: PostEditCommand[] = [
      { kind: "setMeta", slot: "start", endpoint: n(0) },
      { kind: "setMeta", slot: "finish", endpoint: n(1) },
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
    ];
    expect(affectedIndicesForReset(commands, 0)).toEqual(new Set([1, 2]));
    expect(affectedIndicesForReset(commands, 2)).toEqual(new Set());
    expect(affectedIndicesForReset(commands, 5)).toBeUndefined();
  });

  it("affectedIndicesForDelete matches deleteCommandAt exactly for a collapse, a create cascade, and a direction-flip pair", () => {
    const collapseCommands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
    ];
    expect(affectedIndicesForDelete(collapseCommands, 1)).toEqual(new Set([1]));

    const context = baseContext([{ id: 0, x: 0, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    const cascadeCommands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "setEdge", edge: es(splitEndpoint([0, 0], 0), n(5), "basic") },
      { kind: "setMeta", slot: "start", endpoint: n(9) },
    ];
    expect(affectedIndicesForDelete(cascadeCommands, 0)).toEqual(new Set([0, 1]));
    expect(deleteCommandAt(baseline, cascadeCommands, 0)).toEqual(
      cascadeCommands.filter((_, i) => !affectedIndicesForDelete(cascadeCommands, 0)!.has(i)),
    );

    const flipPairCommands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(0), to: n(1) },
      { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(1) },
    ];
    expect(affectedIndicesForDelete(flipPairCommands, 1)).toEqual(new Set([1, 2]));
  });

  it("both return undefined for an out-of-range index", () => {
    const commands: PostEditCommand[] = [{ kind: "setMeta", slot: "start", endpoint: n(0) }];
    expect(affectedIndicesForReset(commands, -1)).toBeUndefined();
    expect(affectedIndicesForDelete(commands, 5)).toBeUndefined();
  });
});
