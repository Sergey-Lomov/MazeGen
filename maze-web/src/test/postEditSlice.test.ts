import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, mockSnapshot } from "./storeTestHelpers";
import { nodeEndpoint, splitEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import type { SplitNodeBlueprint } from "../pixi/splitBlueprints";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { computeAnalytics } from "../wasm/mazeService";

const n = nodeEndpoint;
const key01 = edgeKey(n(0), n(1));

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  vi.mocked(computeAnalytics).mockReset();
  vi.mocked(computeAnalytics).mockReturnValue(mockSnapshot);
  useMazeStore.setState({
    edges: [{ from: 0, to: 1, kind: "basic" }],
    nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
    start: 0,
    finish: 1,
    activeTessellationConfig: { type: "square", width: 2, height: 1 },
    postEditDraftEdges: { [key01]: { from: n(0), to: n(1), kind: "basic" } },
    postEditDraftMeta: { start: n(0), finish: n(1) },
    postEditDraftSplitPoints: {},
    postEditActiveSplitNode: {},
    postEditEdges: null,
    postEditMeta: null,
    postEditAnalytics: null,
    postEditDirty: false,
    postEditAutoConfirm: false,
    _generatedStart: 0,
    _generatedFinish: 1,
  });
});

describe("mazeStore post-edit actions", () => {
  it("setPostEditAutoConfirm / setPostEditTool update their fields", () => {
    useMazeStore.getState().setPostEditAutoConfirm(true);
    useMazeStore.getState().setPostEditTool("passage");
    const s = useMazeStore.getState();
    expect(s.postEditAutoConfirm).toBe(true);
    expect(s.postEditTool).toBe("passage");
  });

  it("applyPostEditTool('wall') deletes the draft edge entry and marks postEditDirty", () => {
    useMazeStore.setState({ postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.[key01]).toBeUndefined();
    expect(s.postEditDirty).toBe(true);
  });

  it("applyPostEditTool('passage') sets a basic edge entry", () => {
    useMazeStore.setState({ postEditTool: "passage", postEditDraftEdges: {} });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("basic");
  });

  it("applyPostEditTool is no-op when there is no draft yet", () => {
    useMazeStore.setState({ postEditDraftEdges: null, postEditDirty: false });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDirty).toBe(false);
  });

  it("applyPostEditToolAt triggers confirmPostEdit when postEditAutoConfirm is on (GitHub issue #241)", async () => {
    useMazeStore.setState({ postEditAutoConfirm: true, postEditDraftEdges: {} });
    useMazeStore.getState().applyPostEditToolAt("passage", key01, n(0), n(1));
    await Promise.resolve();
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("applyPostEditToolAt does not call confirmPostEdit when postEditAutoConfirm is off", () => {
    useMazeStore.setState({ postEditAutoConfirm: false, postEditDraftEdges: {} });
    useMazeStore.getState().applyPostEditToolAt("passage", key01, n(0), n(1));
    expect(computeAnalytics).not.toHaveBeenCalled();
  });

  it("confirmPostEdit computes analytics from the current draft and stores a snapshot", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const s = useMazeStore.getState();
    expect(computeAnalytics).toHaveBeenCalled();
    expect(s.postEditAnalytics).not.toBeNull();
    expect(s.postEditEdges).toEqual({ [key01]: { from: n(0), to: n(1), kind: "basic" } });
    expect(s.postEditMeta).toEqual({ start: n(0), finish: n(1) });
  });

  it("confirmPostEdit refreshes state.nodes from the snapshot (a confirmed split node must become resolvable on the next confirm)", async () => {
    const nodesWithSplit = [...mockSnapshot.nodes, { id: 2, x: 0, y: 0, i: 1 }];
    vi.mocked(computeAnalytics).mockReturnValueOnce({ ...mockSnapshot, nodes: nodesWithSplit });
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState().nodes).toEqual(nodesWithSplit);
  });

  it("confirmPostEdit resolves start/finish endpoints to plain node ids on the wire", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.start).toBe(0);
    expect(call?.finish).toBe(1);
  });

  it("confirmPostEdit passes non-wall edges and excludes wall edges to computeAnalytics", async () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        [key01]: { from: n(0), to: n(1), kind: "basic" },
        [edgeKey(n(1), n(2))]: { from: n(1), to: n(2), kind: "wall" },
      },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.edges).toEqual([{ from: { kind: "node", id: 0 }, to: { kind: "node", id: 1 }, kind: "basic" }]);
  });

  it("confirmPostEdit sends teleport edges to computeAnalytics with kind \"teleport\", separate from postEditDraftEdges", async () => {
    useMazeStore.setState({
      postEditDraftEdges: { [key01]: { from: n(0), to: n(1), kind: "basic" } },
      postEditDraftTeleports: [{ id: 1, from: n(0), to: n(2), direction: "forward" }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.edges).toEqual([
      { from: { kind: "node", id: 0 }, to: { kind: "node", id: 1 }, kind: "basic" },
      { from: { kind: "node", id: 0 }, to: { kind: "node", id: 2 }, kind: "teleport" },
    ]);
    expect(useMazeStore.getState().postEditTeleportEdges).toEqual([{ from: 0, to: 2, kind: "teleport" }]);
  });

  it("confirmPostEdit sends split_points built from postEditDraftSplitPoints", async () => {
    useMazeStore.setState({
      postEditDraftSplitPoints: { "3,4": [0, 1] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.split_points).toEqual(expect.arrayContaining([[[3, 4], 0], [[3, 4], 1]]));
  });

  it("confirmPostEdit sends a passage edge drawn to a split node's own endpoint, not the original node's", () => {
    // Reproduces the reported flow: add a split node at (0,0) (auto-activates it — addSplitNode's
    // own behavior), then draw a passage from node 1 to whatever is "active" at (0,0) — exactly
    // what PostEditController's edge-tool click does via `resolveActiveEndpointAt`/`applyPostEditTool`.
    useMazeStore.getState().addSplitNode([0, 0]);
    const active = useMazeStore.getState().postEditActiveSplitNode["0,0"];
    expect(active).toEqual(splitEndpoint([0, 0], 0));

    useMazeStore.setState({ postEditTool: "passage" });
    const key = edgeKey(n(1), active!);
    useMazeStore.getState().applyPostEditTool(key, n(1), active!);

    const draftEdge = useMazeStore.getState().postEditDraftEdges?.[key];
    expect(draftEdge?.to).toEqual(splitEndpoint([0, 0], 0));
    expect(draftEdge?.to).not.toEqual(n(0)); // must not silently fall back to the original node

    void useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    // Wire DTO uses `slot_id` (snake_case, matching Rust's `PostEditEndpointDto`), not the
    // TS-side `PostEditEndpoint`'s `slotId` — this mismatch was the actual bug (serde rejected
    // the whole config with "missing field `slot_id`"), so pin the wire shape explicitly here.
    const sentEdge = call?.edges.find((e: { to: unknown }) =>
      JSON.stringify(e.to) === JSON.stringify({ kind: "split", point: [0, 0], slot_id: 0 }));
    expect(sentEdge).toBeDefined();
  });

  it("resetPostEdit repopulates postEditDraftTeleports from generated edges", () => {
    useMazeStore.setState({
      edges: [{ from: 0, to: 1, kind: "basic" }, { from: 2, to: 3, kind: "teleport" }],
      postEditDraftTeleports: [],
    });
    useMazeStore.getState().resetPostEdit();
    expect(useMazeStore.getState().postEditDraftTeleports).toEqual([{ id: 1, from: n(2), to: n(3), direction: "forward" }]);
  });

  it("resetPostEdit clears split-point draft state", () => {
    useMazeStore.setState({
      postEditDraftSplitPoints: { "0,0": [0] },
      postEditActiveSplitNode: { "0,0": splitEndpoint([0, 0], 0) },
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints).toEqual({});
    expect(s.postEditActiveSplitNode).toEqual({});
  });

  it("confirmPostEdit excludes rules belonging to a disabled stage from checks", async () => {
    useMazeStore.setState({
      rules: [
        { id: "rule_1", name: "Rule 1", kind: "unreachable", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
        { id: "rule_2", name: "Rule 2", kind: "unreachable", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
      ],
      stages: [
        { id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false },
        { id: "stage_2", name: "Stage 2", ruleIds: ["rule_2"], disabled: true },
      ],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.checks).toEqual([{ local_id: "0", type_id: "check_a", params: {} }]);
  });

  it("confirmPostEdit is no-op when there is no draft", async () => {
    useMazeStore.setState({ postEditDraftEdges: null });
    await useMazeStore.getState().confirmPostEdit();
    expect(computeAnalytics).not.toHaveBeenCalled();
  });

  it("confirmPostEdit stores error message when computeAnalytics throws", async () => {
    vi.mocked(computeAnalytics).mockImplementation(() => { throw new Error("analytics failed"); });
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState().error).toBe("analytics failed");
  });

  it("confirmPostEdit increments the request id on every call", async () => {
    vi.mocked(computeAnalytics).mockReturnValue(mockSnapshot);
    const before = useMazeStore.getState()._postEditRequestId;
    await useMazeStore.getState().confirmPostEdit();
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState()._postEditRequestId).toBe(before + 2);
  });

  it("resetPostEdit rebuilds draft from generated edges and restores generated endpoints", () => {
    useMazeStore.setState({
      postEditDraftEdges: { [key01]: { from: n(0), to: n(1), kind: "wall" } },
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta).toEqual({ start: n(0), finish: n(1) });
    expect(s.postEditDirty).toBe(false);
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
    useMazeStore.getState().setPostEditEndpoint("finish", n(7));
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("clearPostEditEndpoint sets the endpoint to null and marks dirty", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().clearPostEditEndpoint("finish");
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.finish).toBeNull();
    expect(s.postEditDirty).toBe(true);
  });
});

describe("mazeStore split-node actions", () => {
  it("addSplitNode mints slot 0 for a fresh point and makes it active", () => {
    useMazeStore.getState().addSplitNode([2, 2]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([0]);
    expect(s.postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 0));
    expect(s.postEditDirty).toBe(true);
  });

  it("addSplitNode mints max(existing)+1 for a point that already has slots", () => {
    useMazeStore.setState({ postEditDraftSplitPoints: { "2,2": [0, 3] } });
    useMazeStore.getState().addSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 3, 4]);
  });

  it("removeSplitNode removes the slot and any edges/teleports referencing it", () => {
    const target = splitEndpoint([2, 2], 0);
    useMazeStore.setState({
      postEditDraftSplitPoints: { "2,2": [0] },
      postEditDraftEdges: { [edgeKey(n(0), target)]: { from: n(0), to: target, kind: "basic" } },
      postEditDraftTeleports: [{ id: 1, from: target, to: n(1), direction: "forward" }],
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toBeUndefined();
    expect(Object.keys(s.postEditDraftEdges ?? {})).toEqual([]);
    expect(s.postEditDraftTeleports).toEqual([]);
  });

  it("removeSplitNode rejects removal when the target is assigned as start", () => {
    const target = splitEndpoint([2, 2], 0);
    useMazeStore.setState({
      postEditDraftSplitPoints: { "2,2": [0] },
      postEditDraftMeta: { start: target, finish: null },
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([0]);
    expect(s.error).toContain("start/finish");
  });

  it("removeSplitNode resets the active node to the original when the removed slot was active", () => {
    const target = splitEndpoint([2, 2], 0);
    useMazeStore.setState({
      postEditDraftSplitPoints: { "2,2": [0] },
      postEditActiveSplitNode: { "2,2": target },
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("removeSplitNode does not disturb a sibling slot's edges", () => {
    const target = splitEndpoint([2, 2], 0);
    const sibling = splitEndpoint([2, 2], 1);
    useMazeStore.setState({
      postEditDraftSplitPoints: { "2,2": [0, 1] },
      postEditDraftEdges: {
        [edgeKey(n(0), target)]: { from: n(0), to: target, kind: "basic" },
        [edgeKey(n(0), sibling)]: { from: n(0), to: sibling, kind: "basic" },
      },
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([1]);
    expect(s.postEditDraftEdges?.[edgeKey(n(0), sibling)]).toBeDefined();
  });

  it("cycleActiveSplitNode cycles original -> slot0 -> slot1 -> original", () => {
    useMazeStore.setState({ postEditDraftSplitPoints: { "2,2": [0, 1] } });
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
    useMazeStore.setState({ postEditDraftSplitPoints: { "2,2": [0, 1] } });
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
});

describe("mazeStore applySplitBlueprint", () => {
  const square: SplitNodeBlueprint = { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]] };

  // `activeTessellationConfig` square field is centered on the origin (`ox = floor(width/2)`,
  // see `configAllCells`) — width 9 covers x,y in [-4, 4], comfortably wide enough for a point
  // at the origin plus every one of its 4 neighbors.
  const wideField = { type: "square" as const, width: 9, height: 9 };

  it("mints one slot per extra blueprint node and wires passages to existing neighbors", () => {
    useMazeStore.setState({
      activeTessellationConfig: wideField,
      postEditDraftMeta: null,
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 },
        { id: 2, x: -1, y: 0, i: 0 }, { id: 3, x: 0, y: 1, i: 0 }, { id: 4, x: 0, y: -1, i: 0 },
      ],
    });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0]);
    const original = n(0);
    const slot0 = splitEndpoint([0, 0], 0);
    // node0 faces [0,2] = E,W -> neighbors (1,0)=id1, (-1,0)=id2
    expect(s.postEditDraftEdges?.[edgeKey(original, n(1))]).toBeDefined();
    expect(s.postEditDraftEdges?.[edgeKey(original, n(2))]).toBeDefined();
    // node1 (slot0) faces [1,3] = N,S -> neighbors (0,1)=id3, (0,-1)=id4
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(3))]).toBeDefined();
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(4))]).toBeDefined();
    expect(s.postEditDirty).toBe(true);
  });

  it("replaces an existing split point entirely, dropping stale slots/edges", () => {
    const staleTarget = splitEndpoint([0, 0], 5);
    useMazeStore.setState({
      activeTessellationConfig: wideField,
      postEditDraftMeta: null,
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      postEditDraftSplitPoints: { "0,0": [5] },
      postEditDraftEdges: { [edgeKey(n(0), staleTarget)]: { from: n(0), to: staleTarget, kind: "basic" } },
    });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0]);
    expect(s.postEditDraftEdges?.[edgeKey(n(0), staleTarget)]).toBeUndefined();
  });

  it("rejects applying a blueprint while an existing slot is assigned as start/finish", () => {
    const target = splitEndpoint([0, 0], 0);
    useMazeStore.setState({
      activeTessellationConfig: wideField,
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      postEditDraftSplitPoints: { "0,0": [0] },
      postEditDraftMeta: { start: target, finish: null },
    });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0]);
    expect(s.error).toContain("start/finish");
  });

  it("skips a face index beyond the tile's real degree instead of throwing (blueprint authored for a different degree)", () => {
    // Square tiles have 4 faces (offsets.length === 4) — a hex blueprint's face index 5 has
    // nothing to destructure from `offsets[5]` on a square tile.
    const oversized: SplitNodeBlueprint = { id: 0, degree: 6, nodeFaces: [[0, 5]] };
    useMazeStore.setState({
      activeTessellationConfig: wideField,
      postEditDraftMeta: null,
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
    });
    expect(() => useMazeStore.getState().applySplitBlueprint([0, 0], oversized)).not.toThrow();
    const s = useMazeStore.getState();
    // Face 0 (in range) still wires normally; face 5 (out of range) is silently skipped.
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(1))]).toBeDefined();
  });

  it("wires a newly-blueprinted split cell to its neighbor's real connecting slot, not the neighbor's active one (GitHub issue #243)", () => {
    // C1 at (0,0) is already split: id0 = original, id10 = slot0 — and id10 is the one with the
    // real (pre-existing) connection east, toward C2. C2 at (1,0) is still a plain point (id1),
    // about to be blueprinted with a slot of its own that requires a passage west, toward C1.
    useMazeStore.setState({
      activeTessellationConfig: wideField,
      postEditDraftMeta: null,
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 10, x: 0, y: 0, i: 1 },
        { id: 1, x: 1, y: 0, i: 0 },
      ],
      postEditDraftSplitPoints: { "0,0": [0] },
      postEditActiveSplitNode: {},
      postEditDraftEdges: {
        [edgeKey(n(10), n(1))]: { from: n(10), to: n(1), kind: "basic" },
        [edgeKey(n(1), n(10))]: { from: n(1), to: n(10), kind: "basic" },
      },
    });

    // Square offsets: index0=E(1,0) index2=W(-1,0). node0(original) has no faces here; node1(slot0)
    // requires the west face — the one actually facing C1.
    const westOnly: SplitNodeBlueprint = { id: 0, degree: 4, nodeFaces: [[], [2]] };
    useMazeStore.getState().applySplitBlueprint([1, 0], westOnly);
    const s = useMazeStore.getState();

    // C1's slot0 already has a real confirmed id (10) — the partner resolves to `nodeEndpoint(10)`,
    // not an unresolved `splitEndpoint`, since a confirmed node is always addressed by its real id.
    const c2Slot0 = splitEndpoint([1, 0], 0);
    expect(s.postEditDraftEdges?.[edgeKey(n(10), c2Slot0)]).toBeDefined();
    expect(s.postEditDraftEdges?.[edgeKey(c2Slot0, n(10))]).toBeDefined();
    // The original nodes on either side must not end up wrongly linked to each other.
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(1))]).toBeUndefined();
    expect(s.postEditDraftEdges?.[edgeKey(n(0), c2Slot0)]).toBeUndefined();
  });
});
