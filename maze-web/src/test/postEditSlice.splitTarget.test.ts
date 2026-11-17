import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig } from "./storeTestHelpers";
import { n, node, floorsExtra, seedPostEdit, resetPostEditStore } from "./postEditSliceKit";
import { splitEndpoint } from "../pixi/postEditEndpoint";
import { noticeCodes } from "./notificationTestHelpers";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

beforeEach(resetPostEditStore);

describe("mazeStore applyPostEditSplitTargetPick (GitHub issue #474)", () => {
  const openPrompt = (action: NonNullable<ReturnType<typeof useMazeStore.getState>["postEditSplitTargetPrompt"]>["action"]) =>
    useMazeStore.getState().requestPostEditSplitTarget({ point: [0, 0], nodeIds: [0, 1], action });

  it("set_start dispatches setPostEditEndpoint('start') to the picked node and clears the prompt", () => {
    openPrompt({ tool: "set_start" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftMeta?.start).toEqual(n(1));
  });

  it("set_finish dispatches setPostEditEndpoint('finish') to the picked node", () => {
    openPrompt({ tool: "set_finish" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    expect(useMazeStore.getState().postEditDraftMeta?.finish).toEqual(n(1));
  });

  it("elevator opens an elevator placement anchored on the picked node", () => {
    openPrompt({ tool: "elevator" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    expect(useMazeStore.getState().postEditElevatorPending?.origin).toEqual(n(1));
  });

  it("teleport first pick sets the pending origin, second pick completes the link", () => {
    openPrompt({ tool: "teleport_two_way" });
    useMazeStore.getState().applyPostEditSplitTargetPick(0);
    expect(useMazeStore.getState().postEditTeleportPendingFrom).toBe(0);

    openPrompt({ tool: "teleport_two_way" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    const s = useMazeStore.getState();
    expect(s.postEditTeleportPendingFrom).toBeNull();
    expect(s.postEditDraftTeleports).toHaveLength(1);
    expect(s.postEditDraftTeleports[0]).toMatchObject({ from: n(0), to: n(1), direction: "two_way" });
  });

  it("vertical passage dispatches startPostEditVerticalPassagePlacement to the picked node", () => {
    // Seed a generation-time vertical passage from node 1 (a split slot) — a full baseline draft
    // entry from the start (GitHub issue #564), addressed via its split endpoint since that's what
    // `endpointFor` resolves a non-zero-`i` node to. `applyPostEditSplitTargetPick` correctly
    // resolves the dispatched `origin` to that same split endpoint too (GitHub issue #550 ninth
    // follow-up) — but this test's minimal seed never sets up `state.floors`/multi-floor field config, so
    // `cellExistsAt` finds no up/down direction available regardless, and the click is a no-op for
    // that unrelated reason — the baseline entry is left exactly as extracted.
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 1, 0),
        node(2, 0, 0, 0, 1),
      ],
      edges: [{ from: 1, to: 2, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    const before = useMazeStore.getState().postEditDraftVerticalPassages;
    openPrompt({ tool: "vertical_passage_one_way" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftVerticalPassages).toEqual(before);
  });

  it("vertical passage placed on a split slot records a splitEndpoint origin, not the resolved node id (GitHub issue #550 ninth follow-up)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 1, 0),
        node(2, 0, 0, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
    }, floorsExtra(2, 0));
    openPrompt({ tool: "vertical_passage_one_way" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: splitEndpoint([0, 0], 0), to: n(2), direction: "forward" });
  });

  it("is a no-op when no prompt is open", () => {
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    expect(useMazeStore.getState().postEditDraftMeta?.start).toEqual(n(0));
  });

  it("cancelPostEditSplitTarget drops the prompt without placing anything", () => {
    openPrompt({ tool: "set_start" });
    useMazeStore.getState().cancelPostEditSplitTarget();
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftMeta?.start).toEqual(n(0));
  });
});

describe("mazeStore applyPostEditSplitTargetPick move_* actions (GitHub issue #567)", () => {
  it("move_teleport_endpoint: single-target queue resolves and dispatches movePostEditTeleportEndpoint on the one pick", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0),
        node(1, 1, 0),
        node(2, 2, 0),
        node(3, 2, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "two_way" }],
    }, { _nextPostEditTeleportId: 2, postEditDraftTeleports: [{ id: "t1", from: n(0), to: n(1), direction: "two_way" }] });
    useMazeStore.getState().requestPostEditSplitTarget({
      point: [2, 0], nodeIds: [2, 3],
      action: { tool: "move_teleport_endpoint", id: "t1", end: "to" },
      queue: [{ targetIndex: 0, point: [2, 0], nodeIds: [2, 3] }],
      picks: [undefined],
    });
    useMazeStore.getState().applyPostEditSplitTargetPick(3);
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftTeleports[0]).toMatchObject({ from: n(0), to: splitEndpoint([2, 0], 0) });
  });

  it("move_vertical_passage_endpoint: two queued targets both resolve before movePostEditVerticalPassageEndpoint dispatches", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 1, 1, 0, 0),
        node(3, 1, 1, 1, 0),
        node(4, 1, 1, 0, 1),
        node(5, 1, 1, 1, 1),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "two_way" }],
    }, {
      _nextPostEditVerticalPassageId: 2,
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }],
    });
    // Both the dragged end's landing point (level 0) and the other end's own point (level 1) are
    // split — queued as two separate targets, targetIndex 0 and 1, resolved one dialog at a time.
    useMazeStore.getState().requestPostEditSplitTarget({
      point: [1, 1], level: 0, nodeIds: [2, 3],
      action: { tool: "move_vertical_passage_endpoint", id: "v1", end: "from" },
      queue: [
        { targetIndex: 0, point: [1, 1], level: 0, nodeIds: [2, 3] },
        { targetIndex: 1, point: [1, 1], level: 1, nodeIds: [4, 5] },
      ],
      picks: [undefined, undefined],
    });
    // First pick advances the prompt to the second queued target instead of dispatching yet.
    useMazeStore.getState().applyPostEditSplitTargetPick(3);
    let s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.point).toEqual([1, 1]);
    expect(s.postEditSplitTargetPrompt?.level).toBe(1);

    // Second pick fills the last slot and dispatches the deferred move with both resolved endpoints.
    useMazeStore.getState().applyPostEditSplitTargetPick(5);
    s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({
      from: splitEndpoint([1, 1], 0, undefined),
      to: splitEndpoint([1, 1], 0, 1),
    });
  });

  it("movePostEditVerticalPassageEndpoint succeeds when the OTHER end is already split-addressed (not just node-kind)", () => {
    // Regression: dragging `from` on floor 0 used to always fail once `entry.to` (floor 1) was
    // already a `split`-kind endpoint — `resolveVerticalPassageMove` bailed out on
    // `otherEp.kind !== "node"` before ever consulting `otherEndpoint`, even on a plain,
    // non-split landing point that needs no dialog at all.
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 1, 1, 0, 1),
        node(2, 1, 1, 1, 1),
        node(3, 2, 2, 0, 0),
        node(4, 2, 2, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: splitEndpoint([1, 1], 1, 1), direction: "two_way" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().movePostEditVerticalPassageEndpoint("v1", "from", n(3));
    const s = useMazeStore.getState();
    expect(noticeCodes()).toEqual([]);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(3), to: n(4) });
  });

  it("move_elevator_endpoint: multiple split floors each queue their own dialog, in ascending level order", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 1, 1, 0, 0),
        node(3, 1, 1, 1, 0),
        node(4, 1, 1, 0, 1),
        node(5, 1, 1, 1, 1),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().requestPostEditSplitTarget({
      point: [1, 1], level: 0, nodeIds: [2, 3],
      action: { tool: "move_elevator_endpoint", id: "e1", levels: [0, 1] },
      queue: [
        { targetIndex: 0, point: [1, 1], level: 0, nodeIds: [2, 3] },
        { targetIndex: 1, point: [1, 1], level: 1, nodeIds: [4, 5] },
      ],
      picks: [undefined, undefined],
    });
    useMazeStore.getState().applyPostEditSplitTargetPick(3);
    expect(useMazeStore.getState().postEditSplitTargetPrompt).not.toBeNull();

    useMazeStore.getState().applyPostEditSplitTargetPick(5);
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftElevators[0].floors).toEqual([
      splitEndpoint([1, 1], 0, undefined),
      splitEndpoint([1, 1], 0, 1),
    ]);
  });

  it("startPostEditVerticalPassagePlacement opens a split-target prompt instead of silently placing when the target floor is split (GitHub issue #567 second follow-up)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 0, 0, 1, 1),
      ],
      edges: [],
      start: null, finish: null,
    }, {
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }],
      floorFields: { f0: baseFloorFieldConfig(), f1: baseFloorFieldConfig() },
    });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    let s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.action).toMatchObject({ tool: "place_vertical_passage", direction: "up" });
    expect(s.postEditSplitTargetPrompt?.nodeIds).toEqual([1, 2]);

    useMazeStore.getState().applyPostEditSplitTargetPick(2);
    s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: splitEndpoint([0, 0], 0, 1), direction: "forward" });
  });

  it("confirmPostEditElevatorPlacement opens a split-target prompt for a split pending floor instead of silently placing (GitHub issue #567 second follow-up)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 0, 0, 1, 1),
      ],
      edges: [],
      start: null, finish: null,
    }, { postEditElevatorPending: { origin: n(0), floors: new Set([0, 1]) } });
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    let s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(0);
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.action).toMatchObject({ tool: "place_elevator", levels: [0, 1] });

    useMazeStore.getState().applyPostEditSplitTargetPick(2);
    s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftElevators).toHaveLength(1);
    expect(s.postEditDraftElevators[0].floors).toEqual([n(0), splitEndpoint([0, 0], 0, 1)]);
  });
});
