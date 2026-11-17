import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { n, node, floorsExtra, seedPostEdit, resetPostEditStore } from "./postEditSliceKit";
import { splitEndpoint } from "../pixi/postEditEndpoint";
import { noticeCodes, noticeParams } from "./notificationTestHelpers";
import { ELEVATOR_DRAG_FAILED, VERTICAL_PASSAGE_DRAG_FAILED, VERTICAL_PASSAGE_NO_ADJACENT_CELL } from "../notifications/editRefusalNotifications";
import { formatTargetLabel } from "../pixi/targetLabel";
import { computeAnalyticsAsync as computeAnalytics } from "../wasm/mazeService";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

beforeEach(resetPostEditStore);

describe("mazeStore post-edit vertical-passage/elevator actions (GitHub issue #341)", () => {
  it("startPostEditVerticalPassagePlacement explains when neither adjacent floor has a cell", () => {
    seedPostEdit({ nodes: [node(0, 0, 0)], edges: [], start: null, finish: null });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    expect(useMazeStore.getState().postEditVerticalPassagePending).toBeNull();
    expect(noticeCodes()).toEqual([`post_edit/${VERTICAL_PASSAGE_NO_ADJACENT_CELL}`]);
  });

  it("a generation-time vertical passage is already a baseline draft entry with its own id, immediately after generate (GitHub issue #564)", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0, 0, 0), node(1, 0, 0, 0, 1)],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: n(1), direction: "forward" });
    expect(typeof s.postEditDraftVerticalPassages[0].id).toBe("string");
  });

  it("startPostEditVerticalPassagePlacement adds a second passage beside a generation-time one (GitHub issue #748)", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0, 0, 0), node(1, 0, 0, 0, 1)],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    }, { ...floorsExtra(2, 0), _nextPostEditVerticalPassageId: 2 });
    const original = useMazeStore.getState().postEditDraftVerticalPassages[0];
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(2);
    expect(s.postEditDraftVerticalPassages[0]).toEqual(original);
    expect(s.postEditDraftVerticalPassages[1]).toMatchObject({ from: n(0), to: n(1), direction: "forward" });
  });

  it("startPostEditVerticalPassagePlacement detects a bidirectional generation-time pair (both directed edges present) as two_way", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0, 0, 0), node(1, 0, 0, 0, 1)],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }, { from: 1, to: 0, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("two_way");
  });

  it("startPostEditVerticalPassagePlacement detects a bidirectional pair as two_way even when the reverse edge is the one matched first (GitHub issue #385)", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0, 0, 0), node(1, 0, 0, 0, 1)],
      edges: [{ from: 1, to: 0, kind: "vertical_passage" }, { from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("two_way");
  });

  it("startPostEditVerticalPassagePlacement calls confirmPostEdit after adding a passage when postEditAutoConfirm is true", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0, 0, 0), node(1, 0, 0, 0, 1)],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    }, { ...floorsExtra(2, 0), postEditAutoConfirm: true });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("startPostEditVerticalPassagePlacement offers every available direction even when one is already drafted (GitHub issue #748)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 1),
        node(1, 0, 0, 0, 2),
        node(2, 0, 0, 0, 0),
      ],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    }, { ...floorsExtra(3, 1), _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    useMazeStore.getState().choosePostEditVerticalPassageDirection("down");
    const s = useMazeStore.getState();
    expect(s.postEditVerticalPassagePending).toBeNull();
    expect(s.postEditDraftVerticalPassages).toHaveLength(2);
    expect(s.postEditDraftVerticalPassages[1]).toMatchObject({ from: n(0), to: n(2), direction: "two_way" });
  });

  it("startPostEditVerticalPassagePlacement defers to a split-target prompt when the destination is split, ignoring any active slot (GitHub issue #567 second follow-up, supersedes #546 fifth follow-up's silent active-node resolve)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 0, 0, 1, 1), // level 1's split slot
      ],
      edges: [],
      start: null, finish: null,
    }, { ...floorsExtra(3, 0), postEditActiveSplitNode: { "0,0@1": n(2) } });
    // Origin is level 0 — only "up" (level 1) is available (`originLevel > 0` gates "down"), so
    // this would have committed directly instead of opening the direction dialog. The active slot
    // (node 2) no longer silently decides the destination — `postEditActiveSplitNode` must not
    // decide which of a split point's nodes a connection attaches to (Specs/post-edit.md), so the
    // split-target prompt opens instead, same as if nothing had ever been picked there.
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    let s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.nodeIds).toEqual([1, 2]);

    // Picking the slot node commits with a proper `splitEndpoint(...)` `to` (GitHub issue #550
    // ninth follow-up round-trip contract), matching what a confirmed extraction already produces.
    useMazeStore.getState().applyPostEditSplitTargetPick(2);
    s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: splitEndpoint([0, 0], 0, 1), direction: "forward" });
  });

  it("startPostEditVerticalPassagePlacement commits directly when the destination isn't split", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
    }, floorsExtra(3, 0));
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: n(1), direction: "forward" });
  });

  it("startPostEditVerticalPassagePlacement opens the direction dialog on a cell with drafted up and down passages (GitHub issue #748)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 1),
        node(1, 0, 0, 0, 2),
        node(2, 0, 0, 0, 0),
      ],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
        { kind: "addVerticalPassage", id: "v2", from: n(0), to: n(2), direction: "forward" },
      ],
    }, { ...floorsExtra(3, 1), _nextPostEditVerticalPassageId: 3 });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages.map((p) => p.direction)).toEqual(["forward", "forward"]);
    expect(s.postEditVerticalPassagePending?.availableDirections.sort()).toEqual(["down", "up"]);
  });

  it("movePostEditVerticalPassageEndpoint appends exactly one command and syncs both ends (GitHub issue #546 sixth follow-up, GitHub issue #566)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 1, 0, 0, 1),
        node(3, 1, 0, 0, 0),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().movePostEditVerticalPassageEndpoint("v1", "to", n(2));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(2);
    expect(s.postEditCommands[1]).toMatchObject({
      kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(2), from: n(3), to: n(2),
    });
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(3), to: n(2) });
  });

  it("movePostEditVerticalPassageEndpoint reverts the whole move and emits one notice when the other end's floor has no node", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 1, 0, 0, 1),
        node(3, 2, 0, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().movePostEditVerticalPassageEndpoint("v1", "to", n(2));
    useMazeStore.getState().movePostEditVerticalPassageEndpoint("v1", "to", n(3));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: n(1) });
    expect(noticeCodes()).toEqual([`post_edit/${VERTICAL_PASSAGE_DRAG_FAILED}`]);
    expect(noticeParams(VERTICAL_PASSAGE_DRAG_FAILED)).toEqual({ coords: formatTargetLabel([2, 0], 0, true, undefined) });
  });

  it("a single-direction generation-time vertical passage is extracted into the baseline as forward, from its edge's own from/to", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0, 0, 0), node(1, 0, 0, 0, 1)],
      edges: [{ from: 1, to: 0, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    const vp = useMazeStore.getState().postEditDraftVerticalPassages[0];
    expect(vp).toMatchObject({ from: n(1), to: n(0), direction: "forward" });
  });

  it("removePostEditVerticalPassage removes the draft entry and marks dirty", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0, 0, 0), node(1, 0, 0, 0, 1)],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().removePostEditVerticalPassage("v1");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditDirty).toBe(true);
  });

  it("editPostEditElevator on a generation-time elevator mesh edits that baseline draft entry (editingId set), since it's already a full draft entry with its own id (GitHub issue #564)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 0, 0, 0, 2),
      ],
      edges: [
        { from: 0, to: 1, kind: "elevator" }, { from: 1, to: 0, kind: "elevator" },
        { from: 0, to: 2, kind: "elevator" }, { from: 2, to: 0, kind: "elevator" },
        { from: 1, to: 2, kind: "elevator" }, { from: 2, to: 1, kind: "elevator" },
      ],
      start: null, finish: null,
    });
    const baselineId = useMazeStore.getState().postEditDraftElevators[0].id;
    useMazeStore.getState().editPostEditElevator(baselineId, n(0));
    const pending = useMazeStore.getState().postEditElevatorPending;
    expect(pending).not.toBeNull();
    expect(pending!.floors).toEqual(new Set([0, 1, 2]));
    expect(pending!.editingId).toBe(baselineId);
  });

  it("startPostEditElevatorPlacement on a node already in a draft elevator starts a new elevator (GitHub issue #748)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e7", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 8 });
    useMazeStore.getState().startPostEditElevatorPlacement(n(0));
    const pending = useMazeStore.getState().postEditElevatorPending;
    expect(pending!.editingId).toBeUndefined();
    expect(pending!.floors).toEqual(new Set([0]));
  });

  it("confirmPostEditElevatorPlacement on a generation-baked mesh's editingId updates that baseline entry in place with exactly one command", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 0, 0, 0, 2),
      ],
      edges: [
        { from: 0, to: 1, kind: "elevator" }, { from: 1, to: 0, kind: "elevator" },
        { from: 0, to: 2, kind: "elevator" }, { from: 2, to: 0, kind: "elevator" },
        { from: 1, to: 2, kind: "elevator" }, { from: 2, to: 1, kind: "elevator" },
      ],
      start: null, finish: null,
    });
    const baselineId = useMazeStore.getState().postEditDraftElevators[0].id;
    useMazeStore.setState({ postEditElevatorPending: { origin: n(0), floors: new Set([0, 1]), editingId: baselineId } });
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(1);
    expect(s.postEditDraftElevators[0]).toMatchObject({ id: baselineId, floors: [n(0), n(1)] });
    expect(s.postEditElevatorPending).toBeNull();
    // One floor edit is one log entry (GitHub issue #545) — editing an existing draft entry
    // (baseline-seeded or not), not a bundled create + N-pair suppression.
    expect(s.postEditCommands).toHaveLength(1);
    expect(s.postEditCommands[0]).toMatchObject({ kind: "updateElevatorFloors", id: baselineId, floors: [n(0), n(1)] });
  });

  it("confirmPostEditElevatorPlacement defers to a split-target prompt for a split floor, ignoring any active slot (GitHub issue #567 second follow-up, supersedes #546 fifth follow-up's silent active-node resolve)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 0, 0, 1, 1), // level 1's split slot
      ],
      edges: [],
      start: null, finish: null,
    }, {
      postEditElevatorPending: { origin: n(0), floors: new Set([0, 1]) },
      postEditActiveSplitNode: { "0,0@1": n(2) },
    });
    // The active slot (node 2) no longer silently decides the floor — the split-target prompt
    // opens instead, same as if nothing had ever been picked there.
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    let s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(0);
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.nodeIds).toEqual([1, 2]);

    // Picking the slot node commits `floors[1]` as a proper `splitEndpoint(...)` (GitHub issue #550
    // ninth follow-up round-trip contract), matching what a confirmed extraction already produces.
    useMazeStore.getState().applyPostEditSplitTargetPick(2);
    s = useMazeStore.getState();
    expect(s.postEditCommands[0]).toMatchObject({ kind: "addElevator", floors: [n(0), splitEndpoint([0, 0], 0, 1)] });
  });

  it("confirmPostEditElevatorPlacement commits directly when no selected floor is split", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
    }, {
      postEditElevatorPending: { origin: n(0), floors: new Set([0, 1]) },
    });
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditCommands[0]).toMatchObject({ kind: "addElevator", floors: [n(0), n(1)] });
  });

  it("confirmPostEditElevatorPlacement with fewer than 2 selected floors is a no-op", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0, 0, 0)],
      edges: [],
      start: null, finish: null,
    }, { postEditElevatorPending: { origin: n(0), floors: new Set([0]) } });
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(0);
    expect(s.postEditElevatorPending).not.toBeNull();
  });

  it("removePostEditElevator removes the draft entry and marks dirty", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().removePostEditElevator("e1");
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(0);
    expect(s.postEditDirty).toBe(true);
  });

  it("movePostEditElevatorEndpoint moves EVERY floor endpoint to the dragged node's (x, y) (GitHub issue #566)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 1, 1, 0, 0),
        node(3, 1, 1, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().movePostEditElevatorEndpoint("e1", 0, n(2));
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators[0].floors).toEqual([n(2), n(3)]);
  });

  it("movePostEditElevatorEndpoint reverts and reports a failure when an OTHER floor has no node at the dragged point", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 1, 1, 0, 0),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().movePostEditElevatorEndpoint("e1", 0, n(2));
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators[0].floors).toEqual([n(0), n(1)]);
    expect(noticeCodes()).toEqual([`post_edit/${ELEVATOR_DRAG_FAILED}`]);
    expect(noticeParams(ELEVATOR_DRAG_FAILED)).toEqual({ coords: formatTargetLabel([1, 1], 1, true, undefined) });
  });

  it("movePostEditElevatorEndpoint moves a split-addressed OTHER floor instead of leaving it stale (GitHub issue #566, split-floor regression)", () => {
    // Level 1 at (0,0) is a split point (nodes 1 and 2 share that point/level) — floor 1 of the
    // elevator is split-addressed (`splitEndpoint([0, 0], 0, 1)`, pointing at node 2, the non-original
    // slot). Before this fix, `resolveElevatorMove` filtered out non-"node"-kind floors entirely, so
    // this floor was never validated against the new point and never updated — desyncing the
    // elevator exactly like the original issue #566 bug, just for the split-floor case.
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 0, 0, 0, 1),
        node(2, 0, 0, 1, 1),
        node(3, 1, 1, 0, 0),
        node(4, 1, 1, 0, 1),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), splitEndpoint([0, 0], 0, 1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().movePostEditElevatorEndpoint("e1", 0, n(3));
    const s = useMazeStore.getState();
    // Floor 1 must move to (1, 1) — not stay pinned to the old (0, 0) split endpoint.
    expect(s.postEditDraftElevators[0].floors).toEqual([n(3), n(4)]);
  });
});
