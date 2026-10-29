import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { n, es, seedPostEdit, resetPostEditStore, key01 } from "./postEditSliceKit";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
import { compactPostEditCommands } from "../pixi/postEditCompaction";
import { computeAnalyticsAsync as computeAnalytics } from "../wasm/mazeService";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

beforeEach(resetPostEditStore);

describe("mazeStore post-edit tools and settings", () => {
  it("setPostEditAutoConfirm / setPostEditTool update their fields", () => {
    useMazeStore.getState().setPostEditAutoConfirm(true);
    useMazeStore.getState().setPostEditTool("passage");
    const s = useMazeStore.getState();
    expect(s.postEditAutoConfirm).toBe(true);
    expect(s.postEditTool).toBe("passage");
  });

  it("clears the split-node panel selection when another tool becomes active", () => {
    useMazeStore.setState({
      postEditTool: "manage_split_nodes",
      postEditFocusedPoint: [1, 1],
      postEditFocusedPointCovered: true,
    });
    useMazeStore.getState().setPostEditTool("passage");
    const s = useMazeStore.getState();
    expect(s.postEditFocusedPoint).toBeNull();
    expect(s.postEditFocusedPointCovered).toBe(false);

    useMazeStore.setState({ postEditFocusedPoint: [2, 2], postEditFocusedPointCovered: true });
    useMazeStore.getState().setPostEditTool("manage_split_nodes");
    expect(useMazeStore.getState().postEditFocusedPoint).toEqual([2, 2]);
    expect(useMazeStore.getState().postEditFocusedPointCovered).toBe(true);
  });

  it("setPostEditAutoCompact updates its field, off by default", () => {
    expect(useMazeStore.getState().postEditAutoCompact).toBe(false);
    useMazeStore.getState().setPostEditAutoCompact(true);
    expect(useMazeStore.getState().postEditAutoCompact).toBe(true);
  });

  it("setPostEditAutoCompact(true) compacts the log immediately, not just after the next command", () => {
    useMazeStore.setState({ postEditAutoCompact: false, postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    useMazeStore.setState({ postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1)); // create
    useMazeStore.getState().applyPostEditToolAt("one_way_flip", key01, n(0), n(1)); // flip 1
    useMazeStore.getState().applyPostEditToolAt("one_way_flip", key01, n(0), n(1)); // flip 2 (cancels flip 1)
    const beforeToggle = useMazeStore.getState().postEditCommands;
    const baseline = useMazeStore.getState().postEditBaseline;
    if (baseline === null) throw new Error("expected a baseline");
    const compactedNow = compactPostEditCommands(baseline, beforeToggle);

    useMazeStore.getState().setPostEditAutoCompact(true);
    // The toggle itself runs the same compaction pass right away — matches what manually compacting
    // the pre-toggle log would produce, no further command needed to trigger it.
    expect(useMazeStore.getState().postEditCommands).toEqual(compactedNow);
    expect(useMazeStore.getState().postEditCommands.length).toBeLessThan(beforeToggle.length);
  });

  it("postEditAutoCompact off: two direction-cancelling one-way flips stay in the log uncompacted", () => {
    useMazeStore.setState({ postEditAutoCompact: false, postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const afterWall = useMazeStore.getState().postEditCommands.length;

    useMazeStore.setState({ postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1)); // create
    useMazeStore.getState().applyPostEditToolAt("one_way_flip", key01, n(0), n(1)); // flip 1
    useMazeStore.getState().applyPostEditToolAt("one_way_flip", key01, n(0), n(1)); // flip 2 (would cancel flip 1)
    // With auto-compact off, all three one_way clicks stay in the log uncompacted — the two
    // cancelling flips are NOT dropped just because compaction (GitHub issue #548) could drop them.
    expect(useMazeStore.getState().postEditCommands.length).toBe(afterWall + 3);
  });

  it("postEditAutoCompact on: appending a command auto-compacts the log right away (GitHub issue #548 follow-up)", () => {
    // Start from a plain wall (not the seeded two-way passage) so `one_way` clicks are: 1) create a
    // fresh one-way, 2) flip it, 3) flip it back — the second and third clicks form a cancelling
    // pair (GitHub issue #548), while the creation itself always survives (GitHub issue #548
    // follow-up: creation is only dropped if the entity is later actually destroyed). The setup
    // wall is obsolete once the one-way replaces it. Auto-compact
    // is on from the very first click, so every intermediate count below is already compacted.
    seedPostEdit({ edges: [] }, { postEditAutoCompact: true, postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const afterWall = useMazeStore.getState().postEditCommands.length;

    useMazeStore.setState({ postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const afterCreate = useMazeStore.getState().postEditCommands.length;
    useMazeStore.getState().applyPostEditToolAt("one_way_flip", key01, n(0), n(1));
    const afterFirstFlip = useMazeStore.getState().postEditCommands.length;
    // Second flip cancels the first — auto-compact drops both right after this append, leaving only
    // the original creation on top of the wall command.
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const afterSecondFlip = useMazeStore.getState().postEditCommands.length;

    expect(afterCreate).toBeGreaterThan(afterWall);
    expect(afterFirstFlip).toBe(afterCreate);
    expect(afterSecondFlip).toBe(afterCreate);
  });

  it("applyPostEditTool('wall') deletes the draft edge entry and marks postEditDirty", () => {
    useMazeStore.setState({ postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.[key01]).toBeUndefined();
    expect(s.postEditDirty).toBe(true);
  });

  it("applyPostEditTool('passage') sets a basic edge entry", () => {
    // Generation left the two nodes unconnected, so the draft starts with no 0-1 entry at all.
    seedPostEdit({ edges: [] }, { postEditTool: "passage" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("basic");
  });

  it("applyPostEditTool('reset') restores the edge from _generatedEdges, not the current (edited) state.edges (GitHub issue #323)", () => {
    // Simulates state after a confirmed manual edit: state.edges no longer has 0-1 (a wall was
    // confirmed there), while _generatedEdges still holds the original generation output.
    seedPostEdit(
      { liveEdges: [], commands: [{ kind: "setEdge", edge: es(n(0), n(1), "wall") }] },
      { postEditTool: "reset" },
    );
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]).toBeUndefined();
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("one_way_forward");
  });

  it("applyPostEditTool('reset') removes the command(s) that touched this edge instead of appending a restoring command, and repeat clicks stay a no-op (GitHub issue #545)", () => {
    // A wall set via `setEdge` (single-direction command, the shape the delete/legacy paths can
    // still produce) must be REMOVED by reset, not countered with a new `setEdgePair`.
    seedPostEdit(
      { commands: [{ kind: "setEdge", edge: es(n(0), n(1), "wall") }] },
      { postEditTool: "reset" },
    );
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([]);
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("one_way_forward");

    // Clicking reset again on the now-already-generation-state edge must not append anything either
    // - repeated resets used to keep piling up duplicate "restore" commands.
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([]);
  });

  it("applyPostEditTool('reset') removes a setEdgePair (wall/passage/one_way tool click) that touched this edge (GitHub issue #545)", () => {
    seedPostEdit(
      { commands: [{ kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic") }] },
      { postEditTool: "reset" },
    );
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([]);
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("one_way_forward");
  });

  it("applyPostEditTool('reset') is a genuine no-op (no command touched, log unchanged by reference) on an edge that was never edited", () => {
    seedPostEdit({ commands: [] }, { postEditTool: "reset" });
    const before = useMazeStore.getState().postEditCommands;
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toBe(before);
  });

  it("applyPostEditTool records wall/passage/one_way edge-tool clicks as a single setEdgePair command, not two setEdge commands (GitHub issue #545)", () => {
    // Untouched face already reads as wall - seed it as a passage first so the wall click below is
    // an actual change, not the no-op GitHub issue #545 now blocks.
    seedPostEdit(
      { edges: [], commands: [{ kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic") }] },
      { postEditTool: "wall" },
    );
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands[1]).toEqual({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "wall"),
    });

    seedPostEdit({ edges: [] }, { postEditTool: "passage" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([
      {
        kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic"),
      },
    ]);

    seedPostEdit({ edges: [] }, { postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([
      {
        kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
      },
    ]);
  });

  it("applyPostEditTool is a no-op when the face is already (effectively) wall/passage (GitHub issue #545)", () => {
    // An untouched face has no draft record at all, but reads as wall (a generation-time wall) -
    // clicking wall on it changes nothing and must not log anything either.
    seedPostEdit({ edges: [] }, { postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(0);

    // Passage click changes it, then a second passage click on the now-passage face is a no-op too.
    useMazeStore.getState().setPostEditTool("passage");
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(1);
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(1);

    // Wall click now changes it back (from passage to wall) - not a no-op.
    useMazeStore.getState().setPostEditTool("wall");
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(2);
  });

  it("the one-way tool reverses an existing one-way edge; one_way_flip rewrites the face state on repeated flips (GitHub issue #748)", () => {
    seedPostEdit({ edges: [] }, { postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([
      {
        kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
      },
    ]);

    // A repeated one-way click reverses the edge.
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands[1]).toEqual({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "one_way_forward"),
    });

    // Third click swaps back to `aToB: one_way_forward`, not re-emit the same
    // `bToA: one_way_forward` the second click already produced (GitHub issue #575: the flip branch
    // used to always normalize its result to `bToA: one_way_forward` regardless of which side was
    // one-way going in, so every flip after the first was a no-op on the actual edge state while
    // still appending a new command. Face states have no identity or minting lifecycle.
    useMazeStore.getState().applyPostEditToolAt("one_way_flip", key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands[2]).toEqual({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
    });
  });

  it("applyPostEditTool('one_way') on an already-two-way passage creates a fresh forward one-way instead of flipping (GitHub issue #545)", () => {
    // A `basic` face has a record on BOTH sides, same as a one-way face does on one side - the
    // branch must key off which side is actually one-way, not just "does a record exist here".
    seedPostEdit(
      { edges: [], commands: [{ kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic") }] },
      { postEditTool: "one_way" },
    );
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands[1]).toEqual({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
    });
  });

  it("applyPostEditTool is no-op when there is no draft yet", () => {
    useMazeStore.setState({ postEditBaseline: null, postEditDraftEdges: null, postEditDirty: false });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDirty).toBe(false);
  });

  it("applyPostEditToolAt triggers confirmPostEdit when postEditAutoConfirm is on (GitHub issue #241)", async () => {
    seedPostEdit({ edges: [] }, { postEditAutoConfirm: true });
    useMazeStore.getState().applyPostEditToolAt("passage", key01, n(0), n(1));
    await Promise.resolve();
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("applyPostEditToolAt does not call confirmPostEdit when postEditAutoConfirm is off", () => {
    seedPostEdit({ edges: [] }, { postEditAutoConfirm: false });
    useMazeStore.getState().applyPostEditToolAt("passage", key01, n(0), n(1));
    expect(computeAnalytics).not.toHaveBeenCalled();
  });

  it("setPostEditEndpoint updates draft meta and marks dirty", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().setPostEditEndpoint("start", n(5));
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.start).toEqual(n(5));
    expect(s.postEditDirty).toBe(true);
  });

  it("setPostEditEndpoint triggers confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().setPostEditEndpoint("finish", n(1));
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("clearPostEditEndpoint sets the endpoint to null and marks dirty", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().clearPostEditEndpoint("finish");
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.finish).toBeNull();
    expect(s.postEditDirty).toBe(true);
  });

  it("creates finish with id f after the existing finish was removed", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().clearPostEditEndpoint("finish");
    useMazeStore.getState().setPostEditEndpoint("finish", n(5));
    const commands = useMazeStore.getState().postEditCommands;
    expect(commands.at(-1)).toEqual({ kind: "addMeta", slot: "finish", id: "f", endpoint: n(5) });
  });
});

describe("mazeStore setPostEditDragOverride dedup (GitHub issue #739)", () => {
  it("skips the store write when the override is structurally unchanged", () => {
    useMazeStore.setState({ postEditDragOverride: null });
    const listener = vi.fn();
    const unsubscribe = useMazeStore.subscribe(listener);
    try {
      const set = useMazeStore.getState().setPostEditDragOverride;
      set({ kind: "teleportEndpoint", id: "t1", end: "to", endpoint: nodeEndpoint(3) });
      expect(listener).toHaveBeenCalledTimes(1);
      set({ kind: "teleportEndpoint", id: "t1", end: "to", endpoint: nodeEndpoint(3) });
      expect(listener).toHaveBeenCalledTimes(1);
      set({ kind: "teleportEndpoint", id: "t1", end: "to", endpoint: nodeEndpoint(4) });
      expect(listener).toHaveBeenCalledTimes(2);
      set({ kind: "teleportEndpoint", id: "t1", end: "from", endpoint: nodeEndpoint(4) });
      expect(listener).toHaveBeenCalledTimes(3);
      set({ kind: "marker", marker: "start", endpoint: splitEndpoint([1, 1], 2) });
      set({ kind: "marker", marker: "start", endpoint: splitEndpoint([1, 1], 2) });
      expect(listener).toHaveBeenCalledTimes(4);
      set({ kind: "marker", marker: "finish", endpoint: splitEndpoint([1, 1], 2) });
      expect(listener).toHaveBeenCalledTimes(5);
      set({ kind: "elevatorEndpoint", id: "e1", level: 1, endpoint: nodeEndpoint(5) });
      set({ kind: "elevatorEndpoint", id: "e1", level: 1, endpoint: nodeEndpoint(5) });
      expect(listener).toHaveBeenCalledTimes(6);
      set({ kind: "elevatorEndpoint", id: "e1", level: 2, endpoint: nodeEndpoint(5) });
      expect(listener).toHaveBeenCalledTimes(7);
      set(null);
      set(null);
      expect(listener).toHaveBeenCalledTimes(8);
      expect(useMazeStore.getState().postEditDragOverride).toBeNull();
    } finally {
      unsubscribe();
    }
  });
});

describe("post-edit move and settings tools (GitHub issue #748)", () => {
  beforeEach(() => {
    useMazeStore.setState({ postEditEntityPickPrompt: null, postEditMoveRequest: null, postEditConnectionSettingsPrompt: null });
  });

  it("requestPostEditEntityPick hands a single movable element to the move request and opens the picker for several", () => {
    seedPostEdit({ start: 0, finish: 1 });
    useMazeStore.getState().requestPostEditEntityPick([0, 0], undefined, "move");
    expect(useMazeStore.getState().postEditMoveRequest).toMatchObject({ kind: "start" });
    expect(useMazeStore.getState().takePostEditMoveRequest()).toMatchObject({ kind: "start" });
    expect(useMazeStore.getState().postEditMoveRequest).toBeNull();

    useMazeStore.getState().addPostEditTeleport(n(0), n(1), "forward");
    useMazeStore.getState().requestPostEditEntityPick([0, 0], undefined, "move");
    expect(useMazeStore.getState().postEditEntityPickPrompt).toEqual({ point: [0, 0], level: undefined, purpose: "move" });
  });

  it("the settings purpose skips start/finish and opens a teleport's connection dialog", () => {
    seedPostEdit({ start: 0, finish: 1 });
    useMazeStore.getState().addPostEditTeleport(n(0), n(1), "forward");
    useMazeStore.getState().requestPostEditEntityPick([0, 0], undefined, "settings");
    const s = useMazeStore.getState();
    expect(s.postEditEntityPickPrompt).toBeNull();
    expect(s.postEditConnectionSettingsPrompt).toEqual({ kind: "teleport", id: "t1" });
  });

  it("setPostEditTeleportDirection appends one absolute command, and nothing when the direction is unchanged", () => {
    seedPostEdit();
    useMazeStore.getState().addPostEditTeleport(n(0), n(1), "forward");
    useMazeStore.getState().setPostEditTeleportDirection("t1", "two_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftTeleports[0].direction).toBe("two_way");
    expect(s.postEditCommands.at(-1)).toEqual({ kind: "setTeleportDirection", id: "t1", direction: "two_way", from: n(0), to: n(1), absolute: true });
    useMazeStore.getState().setPostEditTeleportDirection("t1", "two_way");
    expect(useMazeStore.getState().postEditCommands).toHaveLength(2);
  });

  it("setPostEditVerticalPassageDirection switches a one-way passage to two-way", () => {
    seedPostEdit({ commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" }] }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().setPostEditVerticalPassageDirection("v1", "backward");
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("backward");
    useMazeStore.getState().setPostEditVerticalPassageDirection("v1", "two_way");
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("two_way");
  });
});
