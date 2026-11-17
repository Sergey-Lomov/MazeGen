import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { TEST_FLOOR_ID } from "./storeTestHelpers";
import { n, es, node, bridgeFace, seedPostEdit, resetPostEditStore, key01 } from "./postEditSliceKit";
import { splitEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import { noticeCodes } from "./notificationTestHelpers";
import { SPLIT_FACE_OWNER_AMBIGUOUS, SPLIT_ROTATION_OUTSIDE_FIELD } from "../notifications/editRefusalNotifications";
import { fieldOf } from "./fieldConfigFixtures";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

beforeEach(resetPostEditStore);

describe("mazeStore split-node actions", () => {
  it("addSplitNode mints slot 0 for a fresh point and makes it active", () => {
    useMazeStore.getState().addSplitNode([2, 2]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([0]);
    expect(s.postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 0));
    expect(s.postEditDirty).toBe(true);
  });

  it("addSplitNode on a non-floor-0 active floor stamps the slot's level and keys it with an \"@level\" suffix (GitHub issue #358)", () => {
    useMazeStore.setState({
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      activeFloorId: "floor_2",
    });
    useMazeStore.getState().addSplitNode([2, 2]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2@1"]).toEqual([0]);
    expect(s.postEditDraftSplitPoints["2,2"]).toBeUndefined();
    expect(s.postEditActiveSplitNode["2,2@1"]).toEqual(splitEndpoint([2, 2], 0, 1));
  });

  it("addSplitNode mints from the point's next-slot high-water mark, never reusing an id", () => {
    // Slot ids come from `_nextSplitSlotId` (GitHub issue #543 plan section 7), not "max existing
    // + 1" — a point that has already issued ids up to 3 (two of which the user has since removed)
    // mints 4, not 1, so a pruned high id can never be reissued to a different node.
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 3, pointId: "s1" },
      ],
    }, { _nextSplitSlotId: { "2,2": 4 } });
    useMazeStore.getState().addSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 3, 4]);
    expect(useMazeStore.getState()._nextSplitSlotId["2,2"]).toBe(5);
  });

  it("addSplitNode on a GENERATION-BAKED split point (GitHub issue #569) mints past the baseline's own slot, not slot 0 again", () => {
    // No `addSplitNode` command in the log at all — the point's slot 0 came straight from
    // generation (`i: 1` on the node, see `deriveSplitPointsFromNodes`), the same way a real
    // generator-produced split tile arrives. Before the fix, `_nextSplitSlotId` started empty
    // regardless, so this call minted slotId 0 again, collided with the baseline's own slot 0, and
    // `appendPostEditCommand` silently failed (`applied: false`) — "Add node" did nothing.
    seedPostEdit({
      nodes: [
        node(0, 0, 0), node(1, 1, 0), node(2, 0, 0, 1),
      ],
      edges: [],
    });
    useMazeStore.getState().addSplitNode([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0, 1]);
    expect(s.postEditCommands).toEqual([{ kind: "addSplitNode", point: [0, 0], level: undefined, slotId: 1, pointId: "s1" }]);
  });

  it("reconfiguring a GENERATION-BAKED split node's face logs updateSplitNodeFaces, not a plain setEdgePair (GitHub issue #569)", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0), node(1, 1, 0), node(2, 0, 0, 1),
      ],
      edges: [],
    });
    // The point's original node (slot undefined) is post-edit's default active node for an
    // untouched split point — reconfiguring its face to neighbor n(1) must be recorded against the
    // split node's own lifeline (`updateSplitNodeFaces`), not as an independent edge-pair command.
    useMazeStore.getState().applyPostEditToolAt("passage", key01, n(0), n(1));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toEqual([
      { kind: "updateSplitNodeFaces", point: [0, 0], level: undefined, slotId: undefined, pointId: "s1", faces: [bridgeFace(n(0), n(1))] },
    ]);
  });

  it("removeSplitNode removes the slot and any edges/teleports referencing it", () => {
    const target = splitEndpoint([2, 2], 0);
    seedPostEdit({
      edges: [],
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "setEdge", edge: es(n(0), target, "basic") },
        { kind: "addTeleport", id: "t1", from: target, to: n(1), direction: "forward" },
      ],
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toBeUndefined();
    expect(Object.keys(s.postEditDraftEdges ?? {})).toEqual([]);
    expect(s.postEditDraftTeleports).toEqual([]);
  });

  it("removeSplitNode rejects removal when the target is assigned as start", () => {
    const target = splitEndpoint([2, 2], 0);
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "setMeta", slot: "start", endpoint: target },
      ],
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([0]);
    expect(noticeCodes()).toEqual(["post_edit/post_edit.remove_endpoint_node_rejected"]);
  });

  it("removeSplitNode raises no notice when the target is not an endpoint", () => {
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 1, pointId: "s1" },
      ],
    });
    useMazeStore.getState().removeSplitNode([2, 2], 1);
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0]);
    expect(noticeCodes()).toEqual([]);
  });

  it("removeSplitNode resets the active node to the original when the removed slot was active", () => {
    const target = splitEndpoint([2, 2], 0);
    seedPostEdit(
      { commands: [{ kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" }] },
      { postEditActiveSplitNode: { "2,2": target } },
    );
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("removeSplitNode does not disturb a sibling slot's edges", () => {
    const target = splitEndpoint([2, 2], 0);
    const sibling = splitEndpoint([2, 2], 1);
    seedPostEdit({
      edges: [],
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 1, pointId: "s1" },
        { kind: "setEdge", edge: es(n(0), target, "basic") },
        { kind: "setEdge", edge: es(n(0), sibling, "basic") },
      ],
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([1]);
    expect(s.postEditDraftEdges?.[edgeKey(n(0), sibling)]).toBeDefined();
  });

  it("cycleActiveSplitNode cycles original -> slot0 -> slot1 -> original", () => {
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 1, pointId: "s1" },
      ],
    });
    const store = useMazeStore.getState();

    store.cycleActiveSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 0));

    store.cycleActiveSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 1));

    store.cycleActiveSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("cycleActiveSplitNode is a no-op for a point with no split nodes", () => {
    useMazeStore.getState().cycleActiveSplitNode([9, 9]);
    expect(useMazeStore.getState().postEditActiveSplitNode["9,9"]).toBeUndefined();
  });

  it("setActiveSplitNode sets a specific split endpoint active", () => {
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 1, pointId: "s1" },
      ],
    });
    useMazeStore.getState().setActiveSplitNode([2, 2], splitEndpoint([2, 2], 1));
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 1));
  });

  it("setActiveSplitNode with a node endpoint clears the active entry (means original)", () => {
    useMazeStore.setState({ postEditActiveSplitNode: { "2,2": splitEndpoint([2, 2], 0) } });
    useMazeStore.getState().setActiveSplitNode([2, 2], n(5));
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("setPostEditFocusedPoint sets and clears the focused point", () => {
    useMazeStore.getState().setPostEditFocusedPoint([1, 1]);
    expect(useMazeStore.getState().postEditFocusedPoint).toEqual([1, 1]);
    useMazeStore.getState().setPostEditFocusedPoint(null);
    expect(useMazeStore.getState().postEditFocusedPoint).toBeNull();
  });

  // GitHub issue #629: `postEditFocusedPoint` ("Manage split nodes") and `postEditChangesOpen`
  // ("Changes") are independent toggles — either setter used to force-clear the other so only one
  // could ever be true. Now both may be open at once; which panel is actually visible is decided
  // by `SidePanel`'s own mount-order stack (`SidePanel.test.tsx`), not by this store coupling.
  it("setPostEditFocusedPoint and setPostEditChangesOpen no longer clobber each other", () => {
    useMazeStore.getState().setPostEditFocusedPoint([1, 1]);
    useMazeStore.getState().setPostEditChangesOpen(true);
    expect(useMazeStore.getState().postEditFocusedPoint).toEqual([1, 1]);
    expect(useMazeStore.getState().postEditChangesOpen).toBe(true);
  });

  // Reproduces the reported flow (GitHub issue #548 rotate/compaction follow-up): create a split
  // node, rotate it, then compact — the slot's `addSplitNode` must survive compaction, since
  // `rotateSplitPoint`'s replay case only re-wires edges, it never re-registers `splitPoints`/
  // `splitPointIds` (only `applySplitBlueprint` recreates a point's slot list from scratch).
  it("addSplitNode -> rotateSplitPoint -> compactPostEditLog keeps the slot registered", () => {
    const gridNodes = [];
    for (let x = 0; x <= 4; x++) for (let y = 0; y <= 4; y++) gridNodes.push({ id: (x + 1) * 100 + y, x, y, i: 0 });
    seedPostEdit({
      nodes: gridNodes,
      edges: [],
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        {
          kind: "setEdgePair", a: n(301), b: splitEndpoint([2, 2], 0),
          aToB: es(n(301), splitEndpoint([2, 2], 0), "basic"),
          bToA: es(splitEndpoint([2, 2], 0), n(301), "basic"),
        },
      ],
    }, { activeFieldConfig: fieldOf("square", { shape: "rect", cols: 5, rows: 5 }) });

    useMazeStore.getState().rotateSplitPoint([2, 2], 1);
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0]);

    useMazeStore.getState().compactPostEditLog();
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([0]);
    expect(s.postEditDraftSplitPointIds["2,2"]).toBe("s1");
  });

  it("a boundary-refused split rotation emits one notice and no command", () => {
    seedPostEdit({
      nodes: [
        node(0, -1, -1),
        node(1, -1, 0),
      ],
      edges: [{ from: 0, to: 1, kind: "basic" }],
      start: null,
      finish: null,
    }, { activeFieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) });

    useMazeStore.getState().rotateSplitPoint([-1, -1], 1);
    useMazeStore.getState().rotateSplitPoint([-1, -1], 1);

    expect(useMazeStore.getState().postEditCommands).toEqual([]);
    expect(noticeCodes()).toEqual([`post_edit/${SPLIT_ROTATION_OUTSIDE_FIELD}`]);
  });

  it("an ambiguous face-owner rotation emits its dedicated notice and no command", () => {
    const idOf = (x: number, y: number) => (x + 10) * 100 + (y + 10);
    const nodes = [];
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) nodes.push({ id: idOf(x, y), x, y, i: 0 });
    }
    nodes.push(node(9001, 0, 1, 1));
    const center = idOf(0, 0);
    const east = idOf(1, 0);
    const north = idOf(0, 1);
    const northEast = idOf(1, 1);
    const northWest = idOf(-1, 1);
    seedPostEdit({
      nodes,
      edges: [
        { from: center, to: east, kind: "basic" },
        { from: north, to: northEast, kind: "basic" },
        { from: north, to: northWest, kind: "basic" },
        { from: 9001, to: northEast, kind: "basic" },
        { from: 9001, to: northWest, kind: "basic" },
      ],
      start: null,
      finish: null,
    }, {
      activeFieldConfig: fieldOf("square", { shape: "rect", cols: 5, rows: 5 }),
      postEditActiveSplitNode: { "0,1": splitEndpoint([0, 1], 0) },
    });

    useMazeStore.getState().rotateSplitPoint([0, 0], 1);

    expect(useMazeStore.getState().postEditCommands).toEqual([]);
    expect(noticeCodes()).toEqual([`post_edit/${SPLIT_FACE_OWNER_AMBIGUOUS}`]);
  });
});
