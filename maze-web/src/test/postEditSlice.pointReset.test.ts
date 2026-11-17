import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { n, es, node, seedPostEdit, resetPostEditStore, key01 } from "./postEditSliceKit";
import { splitEndpoint } from "../pixi/postEditEndpoint";
import { parsePostEditIdNumber } from "../pixi/postEditIdFormat";
import { computeAnalyticsAsync as computeAnalytics } from "../wasm/mazeService";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

beforeEach(resetPostEditStore);

describe("mazeStore post-edit point reset and delete", () => {
  it("resetPostEditPoint resets one point's draft edges to generation-time state and marks dirty", () => {
    // The user walled off the generated 0-1 passage; resetting (0,0) must prune that edit out of
    // the log, leaving the generation-time `one_way_forward` edge the baseline carries.
    seedPostEdit({ commands: [{ kind: "setEdge", edge: es(n(0), n(1), "wall") }] });
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]).toBeUndefined();
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "one_way_forward" });
    expect(s.postEditDirty).toBe(true);
  });

  it("resetPostEditPoint excludes a floor-1 node sharing the reset point's (x,y) when the active floor is floor 0 (GitHub issue #337, #358)", () => {
    // Floor-0 nodes are (0,0)->id 0 and (1,0)->id 1, plus a floor-1 node also at (0,0) (id 2) -
    // resetting point (0,0) on the active floor (floor 0 here) must never pull that floor-1 node's
    // edges/teleports in, even though post-edit tools now work on any floor.
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 1, 0, 0, 0),
        node(2, 0, 0, 0, 1),
      ],
      edges: [{ from: 0, to: 1, kind: "basic" }, { from: 2, to: 1, kind: "vertical_passage" }],
      commands: [{ kind: "setEdge", edge: es(n(0), n(1), "wall") }],
    });
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "one_way_forward" });
    expect(Object.keys(s.postEditDraftEdges ?? {})).toHaveLength(1);
  });

  it("resetPostEditPoint restores a generation-time teleport the user had removed, and a later addPostEditTeleport can't collide with its id (GitHub issue #327)", () => {
    // Generation put a teleport 0->5 at the reset point; the user removed it. The reset must prune
    // that `removeTeleport` command out of the log (restoring the baseline teleport), and the next
    // `addPostEditTeleport` must still mint a free id.
    seedPostEdit({
      nodes: [node(0, 0, 0), node(1, 1, 0), node(5, 5, 5)],
      edges: [{ from: 0, to: 1, kind: "basic" }, { from: 0, to: 5, kind: "teleport" }],
      commands: [{ kind: "removeTeleport", id: "t1", from: n(0), to: n(5), direction: "two_way" }],
    }, { _nextPostEditTeleportId: 2 });
    expect(useMazeStore.getState().postEditDraftTeleports).toHaveLength(0);

    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftTeleports).toHaveLength(1);
    const restoredId = s.postEditDraftTeleports[0].id;
    expect(s._nextPostEditTeleportId).toBeGreaterThan(parsePostEditIdNumber("teleport", restoredId));

    useMazeStore.getState().addPostEditTeleport(n(1), n(5), "forward");
    const ids = useMazeStore.getState().postEditDraftTeleports.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // no id collision
  });

  it("resetPostEditPoint calls confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("resetPostEditPoint restores a generation-baked elevator mesh removed by the Delete tool, with its original id (GitHub issue #564)", () => {
    // A three-floor generation-time elevator mesh at (0,0) is a full baseline draft entry (single
    // id) from the start — the Delete tool, clicked on floor 2 (activeFloorId "f1", level 1, node
    // 11), removes it with exactly one `removeElevator` command (the issue's own follow-up fix, no
    // more per-pair `suppressGenerationPair` flood). Resetting that same point must prune that one
    // command back out, restoring the whole mesh under its original baseline id.
    seedPostEdit({
      nodes: [
        node(10, 0, 0, 0, 0),
        node(11, 0, 0, 0, 1),
        node(12, 0, 0, 0, 2),
      ],
      edges: [
        { from: 10, to: 11, kind: "elevator" }, { from: 11, to: 10, kind: "elevator" },
        { from: 10, to: 12, kind: "elevator" }, { from: 12, to: 10, kind: "elevator" },
        { from: 11, to: 12, kind: "elevator" }, { from: 12, to: 11, kind: "elevator" },
      ],
      start: null, finish: null,
    }, {
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }, { id: "f2", title: "Floor 3" }],
      activeFloorId: "f1",
    });
    expect(useMazeStore.getState().postEditDraftElevators).toHaveLength(1);
    const originalId = useMazeStore.getState().postEditDraftElevators[0].id;

    useMazeStore.getState().deletePostEditPoint([0, 0]);
    expect(useMazeStore.getState().postEditDraftElevators).toHaveLength(0);
    expect(useMazeStore.getState().postEditCommands).toHaveLength(1);
    expect(useMazeStore.getState().postEditCommands[0]).toMatchObject({ kind: "removeElevator", id: originalId });

    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(1);
    expect(s.postEditDraftElevators[0].id).toBe(originalId);
  });

  it("deletePostEditPoint clears start/finish, teleports, vertical passages and elevators touching the point, but leaves draft edges untouched (GitHub issue #386)", () => {
    seedPostEdit({
      commands: [
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
        { kind: "addElevator", id: "e1", floors: [n(0), n(1)] },
      ],
    });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.start).toBeNull();
    expect(s.postEditDraftMeta?.finish).toEqual(n(1));
    expect(s.postEditDraftTeleports).toHaveLength(0);
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditDraftElevators).toHaveLength(0);
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "basic" });
    expect(s.postEditDirty).toBe(true);
  });

  it("deletePostEditPoint clears finish alone when only finish addresses the point", () => {
    seedPostEdit({ start: 1, finish: 0 });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.start).toEqual(n(1));
    expect(s.postEditDraftMeta?.finish).toBeNull();
  });

  it("deletePostEditPoint records deletion events for co-located start and finish", () => {
    seedPostEdit({ start: 0, finish: 0 });
    useMazeStore.getState().requestPostEditEntityDelete([0, 0], undefined, true);
    const commands = useMazeStore.getState().postEditCommands;

    expect(commands).toEqual([
      { kind: "removeMeta", slot: "start", id: "s", endpoint: n(0) },
      { kind: "removeMeta", slot: "finish", id: "f", endpoint: n(0) },
    ]);
  });

  it("delete tool ignores one-way face state and does not open the entity picker", () => {
    seedPostEdit({ commands: [{
      kind: "setEdgePair", a: n(0), b: n(1),
      aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
    }] });
    useMazeStore.getState().requestPostEditEntityDelete([0, 0], undefined, false);
    const s = useMazeStore.getState();
    expect(s.postEditEntityDeletePrompt).toBeNull();
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "one_way_forward" });
  });

  it("deletePostEditPoint suppresses a generation-time vertical passage/elevator touching the point, so it isn't resent on confirm", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0), node(1, 1, 0),
        node(5, 0, 0, 0, 1), node(6, 0, 0, 0, 2),
      ],
      edges: [
        { from: 0, to: 1, kind: "basic" },
        { from: 0, to: 5, kind: "vertical_passage" },
        { from: 0, to: 6, kind: "elevator" }, { from: 6, to: 0, kind: "elevator" },
      ],
    });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditDraftElevators).toHaveLength(0);
    const kinds = s.postEditCommands.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["removeVerticalPassage", "removeElevator"]));
    // One command per entity (GitHub issue #564's own follow-up fix), not a per-pair flood.
    expect(kinds.filter((k) => k === "removeVerticalPassage")).toHaveLength(1);
    expect(kinds.filter((k) => k === "removeElevator")).toHaveLength(1);
  });

  it("deletePostEditPoint removes a generation-baked vertical passage/elevator the same way regardless of which side the generated edge names first (reversed from/to)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0), node(1, 1, 0),
        node(5, 0, 0, 0, 1), node(6, 0, 0, 0, 2),
      ],
      edges: [
        { from: 5, to: 0, kind: "vertical_passage" },
        { from: 6, to: 0, kind: "elevator" },
      ],
    });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditDraftElevators).toHaveLength(0);
  });

  it("deletePostEditPoint clears content on an unconfirmed split slot too, not just the point's live nodes (GitHub issue #221's unresolved-endpoint window)", () => {
    const slot0 = splitEndpoint([0, 0], 0);
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        { kind: "addTeleport", id: "t1", from: n(1), to: slot0, direction: "forward" },
        { kind: "setMeta", slot: "start", endpoint: slot0 },
      ],
    });
    expect(useMazeStore.getState().postEditDraftSplitPoints["0,0"]).toEqual([0]);
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftTeleports).toHaveLength(0);
    expect(s.postEditDraftMeta?.start).toBeNull();
  });

  it("deletePostEditPoint calls confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    expect(computeAnalytics).toHaveBeenCalled();
  });
});

describe("mazeStore reset-dialog actions (GitHub issue #549)", () => {
  it("requestPostEditReset is a no-op when nothing touches the point", () => {
    useMazeStore.getState().requestPostEditReset([5, 5], undefined, false);
    expect(useMazeStore.getState().postEditResetPrompt).toBeNull();
  });

  it("requestPostEditReset resets the single command directly, without opening the dialog, when exactly one lifeline is affected", () => {
    seedPostEdit({ commands: [{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" }] });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    const s = useMazeStore.getState();
    expect(s.postEditResetPrompt).toBeNull();
    expect(s.postEditCommands).toHaveLength(0);
  });

  it("requestPostEditReset opens the dialog when more than one lifeline is affected, and cancelPostEditReset closes it without changing the log", () => {
    seedPostEdit({
      commands: [
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    const before = useMazeStore.getState().postEditCommands;
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    expect(useMazeStore.getState().postEditResetPrompt).toMatchObject({ point: [0, 0], level: undefined });
    expect(useMazeStore.getState().postEditResetPrompt?.lifelines).toHaveLength(2);
    useMazeStore.getState().cancelPostEditReset();
    expect(useMazeStore.getState().postEditResetPrompt).toBeNull();
    expect(useMazeStore.getState().postEditCommands).toBe(before);
  });

  it("requestPostEditReset with bulk (held Shift) skips the dialog and resets the whole point directly", () => {
    seedPostEdit({
      commands: [
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, true);
    const s = useMazeStore.getState();
    expect(s.postEditResetPrompt).toBeNull();
    expect(s.postEditCommands.map((c) => c.kind)).toEqual(["addTeleport", "removeTeleport"]);
    expect(s.postEditDraftTeleports).toHaveLength(0);
  });

  it("resetPostEditPointLifeline resets only the clicked row's own command, leaving the other lifeline's command intact (Delete semantics, not truncate-after)", () => {
    seedPostEdit({
      commands: [
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    const rows = useMazeStore.getState().postEditCommands;
    const teleportIndex = rows.findIndex((c) => c.kind === "addTeleport");
    useMazeStore.getState().resetPostEditPointLifeline(teleportIndex);
    const s = useMazeStore.getState();
    expect(s.postEditCommands.some((c) => c.kind === "addTeleport")).toBe(false);
    expect(s.postEditCommands.some((c) => c.kind === "setEdge")).toBe(true);
    // The other lifeline still touches the point, so the dialog stays open for it.
    expect(s.postEditResetPrompt).toMatchObject({ point: [0, 0], level: undefined });
    expect(s.postEditResetPrompt?.lifelines.map((row) => row.command.kind)).toEqual(["setEdge"]);
  });

  it("keeps the reset dialog snapshot instead of promoting an older command from the same lifeline", () => {
    seedPostEdit({
      commands: [
        { kind: "addMeta", slot: "start", id: "s", endpoint: n(0) },
        { kind: "setMeta", slot: "start", id: "s", endpoint: n(1), previousEndpoint: n(0) },
        { kind: "removeMeta", slot: "start", id: "s", endpoint: n(1) },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    const prompt = useMazeStore.getState().postEditResetPrompt!;
    expect(prompt.lifelines.map((row) => row.command.kind)).toEqual(["removeMeta", "setEdge"]);

    const removeStart = prompt.lifelines.find((row) => row.command.kind === "removeMeta")!;
    useMazeStore.getState().resetPostEditPointLifeline(removeStart.commandIndex, removeStart.command, removeStart.keys);

    expect(useMazeStore.getState().postEditResetPrompt?.lifelines.map((row) => row.command.kind)).toEqual(["setEdge"]);
  });

  it("resetPostEditPointLifeline auto-closes the dialog once no lifeline is left at the point", () => {
    seedPostEdit({ commands: [{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" }] });
    // Force the dialog open directly (bypassing the single-lifeline auto-resolve in requestPostEditReset)
    // to exercise resetPostEditPointLifeline's own closing check in isolation.
    useMazeStore.setState({ postEditResetPrompt: { point: [0, 0], level: undefined, lifelines: [] } });
    useMazeStore.getState().resetPostEditPointLifeline(0);
    expect(useMazeStore.getState().postEditResetPrompt).toBeNull();
  });

  it("resetAllPostEditPointLifelines closes the dialog and resets every lifeline touching the point at once", () => {
    seedPostEdit({
      commands: [
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    useMazeStore.getState().resetAllPostEditPointLifelines();
    const s = useMazeStore.getState();
    expect(s.postEditResetPrompt).toBeNull();
    expect(s.postEditCommands.map((c) => c.kind)).toEqual(["addTeleport", "removeTeleport"]);
    expect(s.postEditDraftTeleports).toHaveLength(0);
  });

  // Regression test for the multi-slot removeSplitPoint dedup bug found during review: two
  // lifelines whose latest command is the SAME shared removeSplitPoint must collapse into one
  // dialog row, so resetting one doesn't secretly also un-remove the other slot.
  it("clicking the single row for a shared removeSplitPoint command restores both of its slots at once, not just one", () => {
    seedPostEdit({
      commands: [{ kind: "removeSplitPoint", point: [0, 0], pointId: "p1", removedSlotIds: [0, 1] }],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    const s0 = useMazeStore.getState();
    // A single shared command means exactly one lifeline reaches the dialog-opening threshold from
    // the caller's point of view only when there'd be >1 DISTINCT rows — here there's exactly one
    // row (one command), so requestPostEditReset resolves it directly without opening a dialog.
    expect(s0.postEditResetPrompt).toBeNull();
    expect(s0.postEditCommands).toHaveLength(0);
  });
});
