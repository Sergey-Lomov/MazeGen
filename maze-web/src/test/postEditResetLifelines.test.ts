import { describe, it, expect } from "vitest";
import { collectAffectedLifelineKeys } from "../pixi/postEditLifelines";
import type { PostEditBaseline, PostEditDerivedState, PostEditReplayContext } from "../pixi/postEditReplay";
import { buildPostEditResetLifelines } from "../pixi/postEditResetLifelines";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import { nodeEndpoint, edgeKey, type PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { PostEditEdgeState } from "../store/postEditTypes";
import type { NodeDto, EdgeDto } from "../wasm/types";

const n = nodeEndpoint;

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

function baseContext(nodes: NodeDto[] = [], edges: EdgeDto[] = []): PostEditReplayContext {
  return { nodes, edges, resolveSplit: () => undefined };
}

function makeBaseline(over: Partial<PostEditBaseline> = {}): PostEditBaseline {
  return { revision: 0, context: baseContext(), derived: emptyDerived(), ...over };
}

describe("collectAffectedLifelineKeys", () => {
  it("returns every lifeline key filterCommandsForPoint would prune, without mutating the input list", () => {
    const point: [number, number] = [0, 0];
    const baseline = makeBaseline({
      context: baseContext([{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }]),
    });
    const commands: PostEditCommand[] = [
      { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      { kind: "addTeleport", id: "t1", from: n(2), to: n(3), direction: "forward" },
    ];
    const keys = collectAffectedLifelineKeys(baseline, commands, point);
    expect(keys).toEqual(new Set([`edge:${edgeKey(n(0), n(1))}`]));
    // Input list is untouched — the function filters an internal copy only.
    expect(commands).toHaveLength(2);
  });

  it("expands transitively: removing a slot lifeline also pulls in a dependent addTeleport hung off that slot", () => {
    const point: [number, number] = [2, 2];
    const context = baseContext([{ id: 7, x: 3, y: 2, i: 0 }]);
    const baseline = makeBaseline({ context });
    const splitSlot: PostEditEndpoint = { kind: "split", point, level: undefined, slotId: 0 };
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point, slotId: 0, pointId: "s1" },
      { kind: "addTeleport", id: "t1", from: splitSlot, to: n(7), direction: "forward" },
    ];
    const keys = collectAffectedLifelineKeys(baseline, commands, point);
    expect(keys).toEqual(new Set(["slot:2,2:0", "teleport:t1"]));
  });

  it("returns an empty set when nothing in the log touches the point", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [{ kind: "setEdge", edge: es(n(5), n(6), "basic") }];
    expect(collectAffectedLifelineKeys(baseline, commands, [0, 0])).toEqual(new Set());
  });
});

describe("buildPostEditResetLifelines", () => {
  it("returns [] when the point has no affected lifeline", () => {
    const baseline = makeBaseline();
    const rows = buildPostEditResetLifelines(baseline, [], [0, 0], undefined, new Map(), false, null);
    expect(rows).toEqual([]);
  });

  it("builds one row per lifeline when each has its own distinct latest command", () => {
    const point: [number, number] = [0, 0];
    const baseline = makeBaseline({
      context: baseContext([{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 9, x: 9, y: 9, i: 0 }]),
    });
    const commands: PostEditCommand[] = [
      { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      { kind: "addTeleport", id: "t1", from: n(0), to: n(9), direction: "forward" },
    ];
    const rows = buildPostEditResetLifelines(baseline, commands, point, undefined, new Map(), false, null);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.commandIndex)).toEqual([0, 1]);
    expect(rows.map((r) => r.keys)).toEqual([[`edge:${edgeKey(n(0), n(1))}`], ["teleport:t1"]]);
  });

  // Regression test: a single `removeSplitPoint` command can name several removed slots at once
  // (`removedSlotIds`), so several lifeline keys share the exact same latest `commandIndex`. Before
  // the fix, the row builder produced one row per key — two rows pointing at the same command —
  // so clicking either row deleted the shared command and un-removed BOTH slots instead of one.
  it("collapses multiple lifeline keys sharing one removeSplitPoint command into a single row", () => {
    const point: [number, number] = [3, 3];
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      {
        kind: "removeSplitPoint", point, pointId: "p1",
        removedSlotIds: [0, 1],
      },
    ];
    const keys = collectAffectedLifelineKeys(baseline, commands, point);
    expect(keys).toEqual(new Set(["slot:3,3:0", "slot:3,3:1"]));

    const rows = buildPostEditResetLifelines(baseline, commands, point, undefined, new Map(), false, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].commandIndex).toBe(0);
    expect(rows[0].keys.sort()).toEqual(["slot:3,3:0", "slot:3,3:1"]);
  });

  it("splits into two rows once a later updateSplitNodeFaces gives one of the shared slots its own distinct latest command", () => {
    const point: [number, number] = [3, 3];
    const baseline = makeBaseline({ context: baseContext([{ id: 9, x: 4, y: 3, i: 0 }]) });
    const splitSlot0: PostEditEndpoint = { kind: "split", point, level: undefined, slotId: 0 };
    const commands: PostEditCommand[] = [
      { kind: "removeSplitPoint", point, pointId: "p1", removedSlotIds: [0, 1] },
      {
        kind: "updateSplitNodeFaces", point, slotId: 0, pointId: "p1",
        faces: [{ neighbor: n(9), toNeighbor: es(splitSlot0, n(9), "basic"), fromNeighbor: es(n(9), splitSlot0, "basic") }],
      },
    ];
    // Both slot keys stay affected: slot:3,3:1 only through the removeSplitPoint, slot:3,3:0
    // through both the removeSplitPoint and the later updateSplitNodeFaces on the same slot.
    const keys = collectAffectedLifelineKeys(baseline, commands, point);
    expect(keys).toEqual(new Set(["slot:3,3:0", "slot:3,3:1"]));

    const rows = buildPostEditResetLifelines(baseline, commands, point, undefined, new Map(), false, null);
    // slot:3,3:0's own latest command is now the updateSplitNodeFaces (index 1), so it splits off
    // into its own row; slot:3,3:1 stays on the original removeSplitPoint (index 0) — deleting
    // slot 0's row undoes just its face update, leaving slot 1's removal untouched.
    expect(rows).toHaveLength(2);
    const byIndex = new Map(rows.map((r) => [r.commandIndex, r.keys.sort()]));
    expect(byIndex.get(0)).toEqual(["slot:3,3:1"]);
    expect(byIndex.get(1)).toEqual(["slot:3,3:0"]);
  });

  it("sorts rows by command log order regardless of Set/Map iteration order", () => {
    const point: [number, number] = [0, 0];
    const baseline = makeBaseline({
      context: baseContext([{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 9, x: 9, y: 9, i: 0 }]),
    });
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(9), direction: "forward" },
      { kind: "setEdge", edge: es(n(0), n(1), "basic") },
    ];
    const rows = buildPostEditResetLifelines(baseline, commands, point, undefined, new Map(), false, null);
    expect(rows.map((r) => r.commandIndex)).toEqual([0, 1]);
  });
});
