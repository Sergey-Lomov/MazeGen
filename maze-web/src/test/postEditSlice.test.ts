import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, mockSnapshot, TEST_FLOOR_ID } from "./storeTestHelpers";
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
    _generatedEdges: [{ from: 0, to: 1, kind: "basic" }],
    _generatedNodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
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

  it("applyPostEditTool('reset') restores the edge from _generatedEdges, not the current (edited) state.edges (GitHub issue #323)", () => {
    // Simulates state after a confirmed manual edit: state.edges no longer has 0-1 (a wall was
    // confirmed there), while _generatedEdges still holds the original generation output.
    useMazeStore.setState({
      postEditTool: "reset",
      edges: [],
      postEditDraftEdges: {},
    });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("one_way_forward");
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

  it("confirmPostEdit excludes individually disabled checks even when their rule is enabled (GitHub issue #264)", async () => {
    useMazeStore.setState({
      rules: [{
        id: "r1",
        name: "Rule 1",
        kind: "missing_endpoints",
        checks: [
          { localId: 0, typeId: "missing_endpoints", params: {}, disabled: false },
          { localId: 1, typeId: "unreachable_finish", params: {}, disabled: true },
        ],
        nextLocalCheckId: 2,
        strategyId: null,
        disabled: false,
        ruleDisabled: false,
        params: {}, nestedStrategies: [], collapsed: false,
      }],
      stages: [{ id: "s1", name: "Stage 1", ruleIds: ["r1"], disabled: false, collapsed: false }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.rule_groups).toEqual([{ checks: [{ local_id: "0", type_id: "missing_endpoints", params: {} }], params: {} }]);
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

  it("confirmPostEdit strips the \"@level\" suffix from postEditDraftSplitPoints keys before building split_points (GitHub issue #358)", async () => {
    useMazeStore.setState({
      postEditDraftSplitPoints: { "3,4": [0], "3,4@1": [2] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.split_points).toEqual(expect.arrayContaining([[[3, 4], 0], [[3, 4], 2]]));
  });

  it("confirmPostEdit sends every floor's preset connections/split points, not just floor 0's (GitHub issue #358)", async () => {
    useMazeStore.setState({
      presetSplitPoints: { "5,6": [0], "5,6@1": [0] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.preset_split_points).toEqual(expect.arrayContaining([[[5, 6], 0], [[5, 6], 0]]));
    expect(call?.preset_split_points).toHaveLength(2);
  });

  it("confirmPostEdit prunes a non-floor-0 split node whose slot was removed client-side, keyed by its own \"@level\" point (GitHub issue #358)", async () => {
    useMazeStore.setState({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 3, x: 0, y: 0, i: 0, level: 1 },
        { id: 6, x: 0, y: 0, i: 1, level: 1 }, // removed client-side: no "0,0@1" entry below
      ],
      postEditDraftSplitPoints: {},
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.nodes.map((n: { id: number }) => n.id)).toEqual([0, 1, 3]);
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
      _generatedNodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: 2, y: 0, i: 0 }, { id: 3, x: 3, y: 0, i: 0 }],
      _generatedEdges: [{ from: 0, to: 1, kind: "basic" }, { from: 2, to: 3, kind: "teleport" }],
      postEditDraftTeleports: [],
    });
    useMazeStore.getState().resetPostEdit();
    expect(useMazeStore.getState().postEditDraftTeleports).toEqual([{ id: 1, from: n(2), to: n(3), direction: "forward" }]);
  });

  it("resetPostEdit restores nodes/edges/draft from _generatedNodes/_generatedEdges, not the current (edited) state.nodes/edges (GitHub issue #323)", () => {
    // Simulates state after a confirmed manual edit: state.edges/nodes reflect the edited graph
    // (edge 0-1 removed by a wall), while _generatedNodes/_generatedEdges still hold the original
    // generation output — GenerationRenderer must show the latter, and reset must restore from it.
    useMazeStore.setState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [],
      postEditDraftEdges: {},
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.nodes).toEqual(s._generatedNodes);
    expect(s.edges).toEqual(s._generatedEdges);
    expect(s.postEditDraftEdges).toEqual({ [key01]: { from: n(0), to: n(1), kind: "one_way_forward" } });
    expect(s.postEditDirty).toBe(false);
  });

  it("resetPostEdit keeps floor-1 nodes/edges and doesn't conflate a floor-1 node with a same-(x,y) floor-0 node into a split point (GitHub issue #358)", () => {
    // A floor-1 node at the same (x,y) as floor-0's node 1 must not be treated as a second split
    // slot at that point (GitHub issue #337's original conflation risk) — post-edit is now
    // floor-aware, so both floors' nodes/edges survive the reset, just grouped separately.
    useMazeStore.setState({
      _generatedNodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 2, x: 1, y: 0, i: 0, level: 1 },
      ],
      _generatedEdges: [
        { from: 0, to: 1, kind: "basic" },
      ],
      postEditDraftEdges: {},
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s._generatedNodes.map((n) => n.id).sort()).toEqual([0, 1, 2]);
    expect(s.postEditDraftEdges).toEqual({ [key01]: { from: n(0), to: n(1), kind: "one_way_forward" } });
    expect(s.postEditDraftSplitPoints).toEqual({});
  });

  it("resetPostEdit derives separate split points for same-(x,y) split nodes on different floors, each stamped with its own level (GitHub issue #358)", () => {
    // Point (0,0) is split on both floor 0 (extra node id 2) and floor 1 (extra node id 5) —
    // each floor's own slot must land in the flat postEditDraftSplitPoints under its own
    // "@level"-suffixed key, and the draft edges referencing each slot must carry that same level.
    useMazeStore.setState({
      _generatedNodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 2, x: 0, y: 0, i: 1, level: 0 },
        { id: 3, x: 0, y: 0, i: 0, level: 1 },
        { id: 4, x: 1, y: 0, i: 0, level: 1 },
        { id: 5, x: 0, y: 0, i: 1, level: 1 },
      ],
      _generatedEdges: [
        { from: 2, to: 1, kind: "basic" },
        { from: 5, to: 4, kind: "basic" },
      ],
      postEditDraftEdges: {},
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints).toEqual({ "0,0": [0], "0,0@1": [0] });
    const floor0Key = edgeKey(splitEndpoint([0, 0], 0), n(1));
    const floor1Key = edgeKey(splitEndpoint([0, 0], 0, 1), n(4));
    expect(s.postEditDraftEdges?.[floor0Key]).toEqual({ from: splitEndpoint([0, 0], 0), to: n(1), kind: "one_way_forward" });
    expect(s.postEditDraftEdges?.[floor1Key]).toEqual({ from: splitEndpoint([0, 0], 0, 1), to: n(4), kind: "one_way_forward" });
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
        { id: "rule_1", name: "Rule 1", kind: "unreachable", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false },
        { id: "rule_2", name: "Rule 2", kind: "unreachable", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false },
      ],
      stages: [
        { id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false, collapsed: false },
        { id: "stage_2", name: "Stage 2", ruleIds: ["rule_2"], disabled: true, collapsed: false },
      ],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.rule_groups).toEqual([{ checks: [{ local_id: "0", type_id: "check_a", params: {} }], params: {} }]);
  });

  it("confirmPostEdit forwards a rule's protect_route param onto its rule_groups entry (GitHub issue #245)", async () => {
    useMazeStore.setState({
      availableRuleParams: [{ id: "protect_route", label: "Protect route", kind: { type: "bool", default: true }, applies_to: ["teleport_duplicates_connection"] }],
      rules: [{
        id: "r1",
        name: "Rule 1",
        kind: "teleport",
        checks: [{ localId: 0, typeId: "teleport_duplicates_connection", params: {}, disabled: false }],
        nextLocalCheckId: 1,
        strategyId: null,
        disabled: false,
        ruleDisabled: false,
        params: { protect_route: "false" },
        nestedStrategies: [],
        collapsed: false,
      }],
      stages: [{ id: "s1", name: "Stage 1", ruleIds: ["r1"], disabled: false, collapsed: false }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.rule_groups).toEqual([{
      checks: [{ local_id: "0", type_id: "teleport_duplicates_connection", params: {} }],
      params: { protect_route: "false" },
    }]);
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

  it("confirmPostEdit prunes a node whose split slot was removed client-side, so it's not resent to WASM (GitHub issue #327)", async () => {
    // (0,0) was auto-split at generation into original (i=0, id 0) + one extra node (i=1, id 2) —
    // removeSplitNode already dropped slot 0 from postEditDraftSplitPoints, but state.nodes still
    // carries the removed node's NodeDto (see confirmPostEdit's own pruning comment).
    useMazeStore.setState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 2, x: 0, y: 0, i: 1 }, { id: 1, x: 1, y: 0, i: 0 }],
      postEditDraftSplitPoints: {},
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.nodes).toEqual([{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }]);
  });

  it("confirmPostEdit keeps a node whose split slot is still declared", async () => {
    useMazeStore.setState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 2, x: 0, y: 0, i: 1 }, { id: 1, x: 1, y: 0, i: 0 }],
      postEditDraftSplitPoints: { "0,0": [0] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.nodes).toEqual(expect.arrayContaining([{ id: 2, x: 0, y: 0, i: 1 }]));
  });

  it("resetPostEditPoint resets one point's draft edges to generation-time state and marks dirty", () => {
    useMazeStore.setState({
      postEditDraftEdges: {},
      postEditAutoConfirm: false,
    });
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "one_way_forward" });
    expect(s.postEditDirty).toBe(true);
  });

  it("resetPostEditPoint excludes a floor-1 node sharing the reset point's (x,y) when the active floor is floor 0 (GitHub issue #337, #358)", () => {
    // beforeEach's floor-0 nodes are (0,0)->id 0 and (1,0)->id 1. Add a floor-1 node also at (0,0)
    // (id 2) — resetting point (0,0) on the active floor (floor 0 here) must never pull that
    // floor-1 node's edges/teleports in, even though post-edit tools now work on any floor.
    useMazeStore.setState({
      _generatedNodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 2, x: 0, y: 0, i: 0, level: 1 },
      ],
      _generatedEdges: [{ from: 0, to: 1, kind: "basic" }, { from: 2, to: 1, kind: "vertical_passage" }],
      postEditDraftEdges: {},
      postEditAutoConfirm: false,
    });
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "one_way_forward" });
    expect(Object.keys(s.postEditDraftEdges ?? {})).toHaveLength(1);
  });

  it("resetPostEditPoint bumps _nextPostEditTeleportId past a restored teleport's freshly minted id, so a later addPostEditTeleport can't collide (GitHub issue #327)", () => {
    useMazeStore.setState({
      _generatedEdges: [{ from: 0, to: 1, kind: "basic" }, { from: 0, to: 5, kind: "teleport" }],
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 5, x: 5, y: 5, i: 0 }],
      _generatedNodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 5, x: 5, y: 5, i: 0 }],
      postEditDraftTeleports: [],
      _nextPostEditTeleportId: 1,
      postEditAutoConfirm: false,
    });
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftTeleports).toHaveLength(1);
    const restoredId = s.postEditDraftTeleports[0].id;
    expect(s._nextPostEditTeleportId).toBeGreaterThan(restoredId);

    useMazeStore.getState().addPostEditTeleport(n(1), n(5), "forward");
    const ids = useMazeStore.getState().postEditDraftTeleports.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // no id collision
  });

  it("resetPostEditPoint calls confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    expect(computeAnalytics).toHaveBeenCalled();
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
