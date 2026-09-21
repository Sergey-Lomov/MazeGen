import { describe, it, expect } from "vitest";
import { compactPostEditCommands } from "../pixi/postEditCompaction";
import { replayPostEditCommands } from "../pixi/postEditReplay";
import type { PostEditBaseline, PostEditDerivedState, PostEditReplayContext } from "../pixi/postEditReplay";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import type { PostEditEdgeState } from "../store/postEditTypes";
import { nodeEndpoint, type PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { NodeDto, EdgeDto } from "../wasm/types";

const n = nodeEndpoint;

const es = (from: PostEditEndpoint, to: PostEditEndpoint, kind: PostEditEdgeState["kind"], id = "o1"): PostEditEdgeState =>
  kind === "one_way_forward" || kind === "one_way_backward" ? { kind, from, to, id } : { kind, from, to };

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

describe("compactPostEditCommands — edge group (GitHub issue #548)", () => {
  it("collapses a wall -> passage toggle to just the last plain command, but keeps a later one-way creation", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "wall") },
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic") },
      {
        kind: "setEdgePair", a: n(0), b: n(1),
        aToB: es(n(0), n(1), "one_way_forward", "o1"), bToA: es(n(1), n(0), "wall"),
      },
    ];
    // The wall->passage toggle collapses to just "passage" (the plain edge group); the one-way
    // creation belongs to its own `oneWay:o1` group and is never superseded by a plain toggle —
    // creating a one-way passage stays visible unless the entity itself is later destroyed.
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([commands[1], commands[2]]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });

  it("keeps commands touching two independent faces separate", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic") },
      { kind: "setEdgePair", a: n(2), b: n(3), aToB: es(n(2), n(3), "basic"), bToA: es(n(3), n(2), "basic") },
    ];
    expect(compactPostEditCommands(baseline, commands)).toEqual(commands);
  });
});

describe("compactPostEditCommands — one-way creation survives unless the entity is destroyed (user request)", () => {
  it("a lone one-way creation with no later destroy is kept as-is, even though a flip would be equivalent", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward", "o1"), bToA: es(n(1), n(0), "wall") },
    ];
    expect(compactPostEditCommands(baseline, commands)).toBe(commands);
  });

  it("two direction flips of the same one-way passage cancel out, but the creation itself survives", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward", "o1"), bToA: es(n(1), n(0), "wall") },
      {
        kind: "setEdgePair", a: n(0), b: n(1),
        aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "one_way_forward", "o1"), directionFlip: true,
      },
      {
        kind: "setEdgePair", a: n(0), b: n(1),
        aToB: es(n(0), n(1), "one_way_forward", "o1"), bToA: es(n(1), n(0), "wall"), directionFlip: true,
      },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([commands[0]]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });

  it("reverting a one-way passage back to wall destroys the entity, superseding its own creation", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward", "o1"), bToA: es(n(1), n(0), "wall") },
      {
        kind: "setEdgePair", a: n(0), b: n(1),
        aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "wall"), replacedOneWayIds: { aToB: "o1" },
      },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });

  it("replacing a one-way passage with a fresh one on the same face destroys the old id but keeps the new creation", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward", "o1"), bToA: es(n(1), n(0), "wall") },
      {
        kind: "setEdgePair", a: n(0), b: n(1),
        aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "one_way_forward", "o2"), replacedOneWayIds: { aToB: "o1" },
      },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([commands[1]]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });

  it("a one-way passage that already existed in the baseline: reverting it to wall keeps the remove (observable: baseline entity now gone)", () => {
    const baseline = makeBaseline({
      derived: {
        ...emptyDerived(),
        edges: { [`${"n0"}-${"n1"}`]: { kind: "one_way_forward", from: n(0), to: n(1), id: "o1" } },
      },
    });
    const commands: PostEditCommand[] = [
      {
        kind: "setEdgePair", a: n(0), b: n(1),
        aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "wall"), replacedOneWayIds: { aToB: "o1" },
      },
    ];
    expect(compactPostEditCommands(baseline, commands)).toBe(commands);
  });
});

describe("compactPostEditCommands — create/remove groups", () => {
  it("a removed teleport created earlier in the SAME log vanishes entirely (create+remove both stale)", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
      { kind: "removeTeleport", id: "t1", from: n(0), to: n(2), direction: "forward" },
    ];
    expect(compactPostEditCommands(baseline, commands)).toEqual([]);
  });

  it("removing a BASELINE entity keeps the remove command (it has an observable effect: baseline entity is gone)", () => {
    const baseline = makeBaseline({
      derived: { ...emptyDerived(), teleports: [{ id: "t1", from: n(0), to: n(1), direction: "forward" }] },
    });
    const commands: PostEditCommand[] = [
      { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
      { kind: "removeTeleport", id: "t1", from: n(0), to: n(2), direction: "forward" },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([{ kind: "removeTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" }]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });
});

describe("compactPostEditCommands — move chains", () => {
  it("collapses an intermediate move to only its predecessor, keeping create and a later direction change", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "forward" },
      { kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(3), from: n(2), to: n(3), direction: "forward" },
      { kind: "setVerticalPassageDirection", id: "v1", direction: "backward", from: n(0), to: n(3) },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
    // Create + the last move + the direction flip survive; the intermediate move is superseded.
    expect(compacted.map((c) => c.kind)).toEqual(["addVerticalPassage", "moveVerticalPassageEndpoint", "setVerticalPassageDirection"]);
  });
});

describe("compactPostEditCommands — direction-flip pairing", () => {
  it("two flips cancel out entirely, leaving the entity at its original direction", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(1), to: n(0) },
      { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(1) },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" }]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });

  it("three flips collapse the first pair, keeping the trailing unpaired flip", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(1), to: n(0) },
      { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(1) },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(1), to: n(0) },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    // `setTeleportDirection`'s own denormalized `from`/`to` is renormalized against the state right
    // before it — after collapsing, that's the just-created `t1` at its original n(0)->n(1), so the
    // surviving flip carries THAT pair (the outcome — `backward` — is unaffected, only the
    // denormalized snapshot fields change).
    expect(compacted).toEqual([
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(0), to: n(1) },
    ]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });

  it("a flip pair with a move in between still cancels, and the move survives", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setVerticalPassageDirection", id: "v1", direction: "backward", from: n(0), to: n(1) },
      { kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "backward" },
      { kind: "setVerticalPassageDirection", id: "v1", direction: "forward", from: n(0), to: n(2) },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
    expect(compacted.map((c) => c.kind)).toEqual(["addVerticalPassage", "moveVerticalPassageEndpoint"]);
  });

  it("deleting the fixed-point way: removing what makes a flip pair stale makes the earlier flip useful again", () => {
    // Regression for the user's own example: A->B->A->B (four flips = two pairs) collapses
    // completely: request explicitly says a cascaded remove restoring the entity makes its whole
    // lifeline relevant again — simulated here by re-running compaction after appending a further
    // command that depends on the teleport surviving (a removeTeleport last, which makes every
    // flip before it moot regardless of parity).
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(1), to: n(0) },
      { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(1) },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(1), to: n(0) },
      { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(1) },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" }]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });
});

describe("compactPostEditCommands — split point rebuild", () => {
  it("a later applySplitBlueprint supersedes an earlier addSplitNode/updateSplitNodeFaces on the same point", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, faces: [], pointId: "s1" },
      { kind: "applySplitBlueprint", point: [0, 0], resolvedSlots: [{ slotId: 0, faces: [] }], pointId: "s1" },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([commands[2]]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });

  it("a later updateSplitNodeFaces on the same node supersedes an earlier one with no rebuild in between", () => {
    // Each updateSplitNodeFaces carries the node's FULL face list (a snapshot, not a diff), so the
    // second call fully overwrites what the first one set — same "move supersedes only its
    // immediate predecessor" collapsing a moveTeleportEndpoint/updateElevatorFloors chain gets.
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, faces: [], pointId: "s1" },
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, faces: [{ neighbor: n(1), toNeighbor: es(n(0), n(1), "basic"), fromNeighbor: es(n(1), n(0), "basic") }], pointId: "s1" },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([commands[0], commands[2]]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });

  it("a later rotateSplitPoint never supersedes an earlier addSplitNode — rotate only re-wires the slots it's given, it never re-registers slot existence (replay's rotateSplitPoint case never touches splitPoints/splitPointIds), so dropping the addSplitNode would orphan the slot's rotated wiring with no slot left to attach it to", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "rotateSplitPoint", point: [0, 0], nodes: [{ slotId: 0, faces: [] }] },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual(commands);
    const replayed = replayPostEditCommands(baseline, compacted);
    expect(replayed.splitPoints).toEqual({ "0,0": [0] });
    expect(replayed.splitPointIds).toEqual({ "0,0": "s1" });
  });

  it("a later applySplitBlueprint still supersedes an earlier addSplitNode even with a rotateSplitPoint in between", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "rotateSplitPoint", point: [0, 0], nodes: [{ slotId: 0, faces: [] }] },
      { kind: "applySplitBlueprint", point: [0, 0], resolvedSlots: [{ slotId: 0, faces: [] }], pointId: "s1" },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual([commands[2]]);
    expect(replayPostEditCommands(baseline, compacted)).toEqual(replayPostEditCommands(baseline, commands));
  });

  it("a later rotateSplitPoint never supersedes an earlier applySplitBlueprint — applySplitBlueprint registers the point's whole slot list (its replay case writes splitPoints/splitPointIds), rotateSplitPoint's replay never does, so dropping the blueprint would leave the rotated wiring with no slot list to attach to (the real bug this reproduces: a split tile created via a blueprint, then rotated once, then compacted, lost its slot entirely)", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "applySplitBlueprint", point: [0, 0], resolvedSlots: [{ slotId: 0, faces: [] }], pointId: "s1" },
      { kind: "rotateSplitPoint", point: [0, 0], nodes: [{ slotId: 0, faces: [] }] },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted).toEqual(commands);
    const replayed = replayPostEditCommands(baseline, compacted);
    expect(replayed.splitPoints).toEqual({ "0,0": [0] });
    expect(replayed.splitPointIds).toEqual({ "0,0": "s1" });
  });

  it("a later rotateSplitPoint DOES supersede an earlier rotateSplitPoint — both are pure wiring rebuilds, neither registers slot existence, so the earlier one is redundant once the later snapshot covers the same slot", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, faces: [] },
      { kind: "rotateSplitPoint", point: [0, 0], nodes: [{ slotId: 0, faces: [] }] },
      { kind: "rotateSplitPoint", point: [0, 0], nodes: [{ slotId: 0, faces: [] }] },
    ];
    const compacted = compactPostEditCommands(baseline, commands);
    expect(compacted.map((c) => c.kind)).toEqual(["addSplitNode", "rotateSplitPoint"]);
  });
});

describe("compactPostEditCommands — idempotence and no-op", () => {
  it("returns the same array reference when nothing is superseded", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
    ];
    expect(compactPostEditCommands(baseline, commands)).toBe(commands);
  });

  it("compacting an already-compacted log is a no-op", () => {
    const baseline = makeBaseline();
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
      { kind: "setTeleportDirection", id: "t1", direction: "backward", from: n(1), to: n(0) },
      { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(1) },
    ];
    const once = compactPostEditCommands(baseline, commands);
    const twice = compactPostEditCommands(baseline, once);
    expect(twice).toEqual(once);
  });
});
