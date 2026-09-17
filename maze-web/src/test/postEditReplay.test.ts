import { describe, it, expect } from "vitest";
import {
  applyPostEditCommand, replayPostEditCommands, replayPostEditCommandsFailClosed,
  filterCommandsForPoint, suppressionPairKey,
} from "../pixi/postEditReplay";
import type { PostEditBaseline, PostEditDerivedState, PostEditReplayContext } from "../pixi/postEditReplay";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import { nodeEndpoint, splitEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import type { NodeDto, EdgeDto } from "../wasm/types";

const n = nodeEndpoint;

function emptyDerived(): PostEditDerivedState {
  return {
    edges: {},
    teleports: [],
    meta: { start: null, finish: null },
    splitPoints: {},
    verticalPassages: [],
    elevators: [],
    suppressedVerticalPassagePairs: new Set(),
    suppressedElevatorPairs: new Set(),
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

    let r = applyPostEditCommand(context, state, { kind: "setEdge", from: n(0), to: n(1), edgeKind: "basic" });
    expect(r.applied).toBe(true);
    state = r.state;
    expect(state.edges).toEqual({ [edgeKey(n(0), n(1))]: { from: n(0), to: n(1), kind: "basic" } });

    r = applyPostEditCommand(context, state, { kind: "addTeleport", id: 1, from: n(0), to: n(1), direction: "two_way" });
    expect(r.applied).toBe(true);
    state = r.state;
    expect(state.teleports).toEqual([{ id: 1, from: n(0), to: n(1), direction: "two_way" }]);

    r = applyPostEditCommand(context, state, { kind: "setMeta", slot: "start", endpoint: n(0) });
    expect(r.applied).toBe(true);
    state = r.state;
    expect(state.meta).toEqual({ start: n(0), finish: null });

    r = applyPostEditCommand(context, state, { kind: "removeTeleport", id: 1 });
    expect(r.applied).toBe(true);
    state = r.state;
    expect(state.teleports).toEqual([]);

    r = applyPostEditCommand(context, state, { kind: "setEdge", from: n(0), to: n(1), edgeKind: "wall" });
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
      teleports: [{ id: 1, from: n(0), to: n(1), direction: "forward" }],
    };
    const snapshot = JSON.parse(JSON.stringify({ ...before, suppressedVerticalPassagePairs: [], suppressedElevatorPairs: [] }));
    applyPostEditCommand(context, before, { kind: "setEdge", from: n(1), to: n(0), edgeKind: "basic" });
    applyPostEditCommand(context, before, { kind: "removeTeleport", id: 1 });
    applyPostEditCommand(context, before, { kind: "setMeta", slot: "start", endpoint: n(0) });
    const after = JSON.parse(JSON.stringify({ ...before, suppressedVerticalPassagePairs: [], suppressedElevatorPairs: [] }));
    expect(after).toEqual(snapshot);
  });
});

describe("replayPostEditCommands — parity with incremental append", () => {
  it("gives the same result as folding the same commands one at a time", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdge", from: n(0), to: n(1), edgeKind: "basic" },
      { kind: "addTeleport", id: 1, from: n(0), to: n(1), direction: "forward" },
      { kind: "setMeta", slot: "start", endpoint: n(0) },
      { kind: "setTeleportDirection", id: 1, direction: "two_way" },
      { kind: "setEdge", from: n(0), to: n(1), edgeKind: "wall" },
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
      { kind: "addSplitNode", point: pointA, slotId: 0 },
      { kind: "setEdge", from: slotAEndpoint, to: n(5), edgeKind: "basic" },
      { kind: "addTeleport", id: 9, from: n(5), to: n(5), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: 9, end: "to", endpoint: slotAEndpoint },
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
      { kind: "setEdge", from: n(0), to: n(1), edgeKind: "basic" },
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
      { kind: "addSplitNode", point, slotId: 0 },
      { kind: "addTeleport", id: 1, from: slot, to: n(7), direction: "forward" },
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
    state = applyPostEditCommand(context, state, { kind: "addSplitNode", point, slotId: 0 }).state;
    state = applyPostEditCommand(context, state, {
      kind: "updateSplitNodeFaces", point, slotId: 0,
      faces: [{ neighbor: n(1), toNeighbor: "basic", fromNeighbor: "one_way_backward" }],
    }).state;
    expect(state.edges[edgeKey(slot, n(1))]).toEqual({ from: slot, to: n(1), kind: "basic" });
    expect(state.edges[edgeKey(n(1), slot)]).toEqual({ from: n(1), to: slot, kind: "one_way_backward" });

    // A later command with a different face list replaces the first entirely — the removed
    // neighbor's edges are gone, not left stale from the previous command.
    state = applyPostEditCommand(context, state, {
      kind: "updateSplitNodeFaces", point, slotId: 0,
      faces: [{ neighbor: n(2), toNeighbor: "wall", fromNeighbor: "basic" }],
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
      kind: "updateSplitNodeFaces", point, slotId: 0, faces: [{ neighbor: n(1), toNeighbor: "basic", fromNeighbor: "basic" }],
    });
    expect(result.applied).toBe(false);
  });

  it("shares its lifeline with addSplitNode — resetting the slot's own point drops both from the log", () => {
    const point: [number, number] = [0, 0];
    const context = baseContext([{ id: 1, x: 1, y: 0, i: 0 }]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point, slotId: 0 },
      { kind: "updateSplitNodeFaces", point, slotId: 0, faces: [{ neighbor: n(1), toNeighbor: "basic", fromNeighbor: "basic" }] },
    ];
    expect(filterCommandsForPoint(baseline, commands, point)).toEqual([]);
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
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: pointA, slotId: 0 },
      { kind: "addSplitNode", point: pointB, slotId: 0 },
      { kind: "updateSplitNodeFaces", point: pointA, slotId: 0, faces: [{ neighbor: slotB, toNeighbor: "basic", fromNeighbor: "basic" }] },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, pointB);
    expect(filtered).toEqual([]);
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
        teleports: [{ id: 1, from: n(0), to: n(1), direction: "forward" }],
      },
    });
    const commands: PostEditCommand[] = [
      { kind: "moveTeleportEndpoint", id: 1, end: "to", endpoint: n(2) },
      { kind: "setTeleportDirection", id: 1, direction: "two_way" },
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
      { kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" },
      { kind: "moveVerticalPassageEndpoint", id: 1, end: "to", endpoint: n(2) },
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
      { kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" },
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
      { kind: "addElevator", id: 1, floors: [n(0), n(1)] },
      { kind: "updateElevatorFloors", id: 1, floors: [n(0), n(1), n(2)] },
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
      { kind: "addElevator", id: 1, floors: [n(0), n(1)] },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [9, 9]);
    expect(filtered).toEqual(commands);
  });

  it("removes an elevator lifeline touching the reset point through its command's own suppressPairs, even when that node left the current floors set (GitHub issue #545)", () => {
    // Re-editing a 3-floor elevator down to 2 floors folds the dropped floor's suppression into
    // `updateElevatorFloors.suppressPairs` (GitHub issue #545) instead of a separate
    // `suppressGenerationPair` command — the lifeline check must still see that node through the
    // command's own payload, not just its current `floors`.
    const context = baseContext([
      { id: 0, x: 0, y: 0, i: 0, level: 0 },
      { id: 1, x: 0, y: 0, i: 0, level: 1 },
      { id: 2, x: 0, y: 0, i: 0, level: 2 },
    ]);
    const baseline = makeBaseline({ context });
    const commands: PostEditCommand[] = [
      {
        kind: "updateElevatorFloors", id: 1, floors: [n(0), n(1)],
        suppressPairs: [[n(0), n(2)], [n(1), n(2)]],
      },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, [0, 0], 2);
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
      { kind: "addTeleport", id: 1, from: n(3), to: n(5), direction: "forward" },
      { kind: "removeTeleport", id: 1 },
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
      { kind: "addTeleport", id: 1, from: n(10), to: n(11), direction: "forward" },
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
      { kind: "setEdge", from: n(0), to: n(1), edgeKind: "basic" },
      { kind: "removeTeleport", id: 999 }, // no such teleport — invalid reference
      { kind: "setMeta", slot: "start", endpoint: n(0) },
    ];
    const result = replayPostEditCommandsFailClosed(baseline, commands);
    expect(result).toBeUndefined();
  });

  it("accepts a fully-resolving log", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdge", from: n(0), to: n(1), edgeKind: "basic" },
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
      { kind: "addTeleport", id: 5, from: n(0), to: n(1), direction: "forward" },
    ];
    const filtered = filterCommandsForPoint(baseline, commands, point);
    expect(filtered).toEqual([]);
    const derived = replayPostEditCommands(baseline, filtered);
    expect(derived.teleports.some((t) => t.id === 5)).toBe(false);
  });
});

describe("lifelineKeyOf", () => {
  it("gives suppressGenerationPair its own stable, order-independent key", () => {
    const a = lifelineKeyOfSuppress(n(1), n(2));
    const b = lifelineKeyOfSuppress(n(2), n(1));
    expect(a).toBe(b);
  });
});

function lifelineKeyOfSuppress(a: ReturnType<typeof n>, b: ReturnType<typeof n>): string {
  return `suppress:elevator:${suppressionPairKey(a, b)}`;
}
