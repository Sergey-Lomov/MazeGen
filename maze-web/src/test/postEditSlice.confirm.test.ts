import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, mockSnapshot, TEST_FLOOR_ID, makeRule, makeCheck } from "./storeTestHelpers";
import { n, node, lastAnalyticsCall, seedPostEdit, resetPostEditStore, key01 } from "./postEditSliceKit";
import { splitEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import { configAllCells } from "../pixi/tessellationCells";
import { errorCards, errorDetails } from "./notificationTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";
import { computeAnalyticsAsync as computeAnalytics } from "../wasm/mazeService";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

beforeEach(resetPostEditStore);

describe("mazeStore confirmPostEdit", () => {
  it("confirmPostEdit computes analytics from the current draft and stores a snapshot", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const s = useMazeStore.getState();
    expect(computeAnalytics).toHaveBeenCalled();
    expect(s.postEditAnalytics).not.toBeNull();
    // A two-way `basic` passage is two directed draft entries (see `applyPostEditEdgeTool`'s
    // "passage" branch) — the snapshot carries both, unchanged from the draft.
    expect(s.postEditEdges).toEqual({
      [key01]: { from: n(0), to: n(1), kind: "basic" },
      [edgeKey(n(1), n(0))]: { from: n(1), to: n(0), kind: "basic" },
    });
    expect(s.postEditMeta).toEqual({ start: n(0), finish: n(1) });
  });

  it("confirmPostEdit refreshes state.nodes from the snapshot (a confirmed split node must become resolvable on the next confirm)", async () => {
    const nodesWithSplit = [...mockSnapshot.nodes, node(2, 0, 0, 1)];
    vi.mocked(computeAnalytics).mockResolvedValueOnce({ ...mockSnapshot, nodes: nodesWithSplit });
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState().nodes).toEqual(nodesWithSplit);
  });

  it("confirmPostEdit resolves start/finish endpoints to plain node ids on the wire", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
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
    const call = lastAnalyticsCall();
    expect(call?.edges).toEqual([{ from: { kind: "node", id: 0 }, to: { kind: "node", id: 1 }, kind: "basic" }]);
  });

  it("confirmPostEdit excludes individually disabled checks even when their rule is enabled (GitHub issue #264)", async () => {
    useMazeStore.setState({
      rules: [makeRule({
        id: "r1",
        kind: "missing_endpoints",
        checks: [
          makeCheck({ localId: 0, typeId: "missing_endpoints" }),
          makeCheck({ localId: 1, typeId: "unreachable_finish", disabled: true }),
        ],
        nextLocalCheckId: 2,
      })],
      stages: [{ id: "s1", name: "Stage 1", ruleIds: ["r1"], disabled: false, collapsed: false }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.rule_groups).toEqual([{ checks: [{ local_id: "0", type_id: "missing_endpoints", params: {} }], params: {} }]);
  });

  it("confirmPostEdit sends teleport edges to computeAnalytics with kind \"teleport\", separate from postEditDraftEdges", async () => {
    useMazeStore.setState({
      postEditDraftEdges: { [key01]: { from: n(0), to: n(1), kind: "basic" } },
      postEditDraftTeleports: [{ id: "t1", from: n(0), to: n(2), direction: "forward" }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
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
    const call = lastAnalyticsCall();
    expect(call?.split_points).toEqual(expect.arrayContaining([[[3, 4], 0, 0], [[3, 4], 1, 0]]));
  });

  it("confirmPostEdit parses the \"@level\" suffix from postEditDraftSplitPoints keys into split_points' own level entry (GitHub issue #359)", async () => {
    useMazeStore.setState({
      postEditDraftSplitPoints: { "3,4": [0], "3,4@1": [2] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.split_points).toEqual(expect.arrayContaining([[[3, 4], 0, 0], [[3, 4], 2, 1]]));
  });

  it("confirmPostEdit sends level_fields derived from state.floors (GitHub issue #359)", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.level_fields).toEqual([configAllCells(fieldOf("square", { shape: "rect", cols: 10, rows: 10 }))]);
  });

  it("confirmPostEdit sends one level_fields entry per floor, in floors order (GitHub issue #359)", async () => {
    const SECOND_FLOOR_ID = "floor-2";
    useMazeStore.setState({
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: SECOND_FLOOR_ID, title: "Floor 2" }],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 2, rows: 1 }) }),
        [SECOND_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 4 }) }),
      },
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.level_fields).toEqual([
      configAllCells(fieldOf("square", { shape: "rect", cols: 2, rows: 1 })),
      configAllCells(fieldOf("square", { shape: "rect", cols: 3, rows: 4 })),
    ]);
  });

  it("confirmPostEdit sends every floor's preset connections/split points with their own level (GitHub issue #359)", async () => {
    useMazeStore.setState({
      presetSplitPoints: { "5,6": [0], "5,6@1": [0] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.preset_split_points).toEqual(expect.arrayContaining([[[5, 6], 0, 0], [[5, 6], 0, 1]]));
    expect(call?.preset_split_points).toHaveLength(2);
  });

  it("confirmPostEdit prunes a non-floor-0 split node whose slot was removed client-side, keyed by its own \"@level\" point (GitHub issue #358)", async () => {
    useMazeStore.setState({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 1, 0, 0, 0),
        node(3, 0, 0, 0, 1),
        node(6, 0, 0, 1, 1), // removed client-side: no "0,0@1" entry below
      ],
      postEditDraftSplitPoints: {},
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.nodes.map((n: { id: number }) => n.id)).toEqual([0, 1, 3]);
  });

  it("confirmPostEdit sends a passage edge drawn to a split node's own endpoint, not the original node's", () => {
    // Reproduces the reported flow: add a split node at (0,0) (auto-activates it - addSplitNode's
    // own behavior), then draw a passage from node 1 to whatever is "active" at (0,0) - exactly
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
    const call = lastAnalyticsCall();
    // Wire DTO uses `slot_id` (snake_case, matching Rust's `PostEditEndpointDto`), not the
    // TS-side `PostEditEndpoint`'s `slotId` - this mismatch was the actual bug (serde rejected
    // the whole config with "missing field `slot_id`"), so pin the wire shape explicitly here.
    const sentEdge = call?.edges.find((e: { to: unknown }) =>
      JSON.stringify(e.to) === JSON.stringify({ kind: "split", point: [0, 0], slot_id: 0, level: 0 }));
    expect(sentEdge).toBeDefined();
  });

  it("confirmPostEdit excludes rules belonging to a disabled stage from checks", async () => {
    useMazeStore.setState({
      rules: [
        makeRule({ id: "rule_1", kind: "unreachable", checks: [makeCheck({ typeId: "check_a" })], nextLocalCheckId: 1 }),
        makeRule({ id: "rule_2", name: "Rule 2", kind: "unreachable", checks: [makeCheck({ typeId: "check_b" })], nextLocalCheckId: 1 }),
      ],
      stages: [
        { id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false, collapsed: false },
        { id: "stage_2", name: "Stage 2", ruleIds: ["rule_2"], disabled: true, collapsed: false },
      ],
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.rule_groups).toEqual([{ checks: [{ local_id: "0", type_id: "check_a", params: {} }], params: {} }]);
  });

  it("confirmPostEdit forwards a rule's protect_route param onto its rule_groups entry (GitHub issue #245)", async () => {
    useMazeStore.setState({
      availableRuleParams: [{ id: "protect_route", label: "Protect route", kind: { type: "bool", default: true }, applies_to: ["teleport_duplicates_connection"] }],
      rules: [makeRule({
        id: "r1",
        kind: "teleport",
        checks: [makeCheck({ typeId: "teleport_duplicates_connection" })],
        nextLocalCheckId: 1,
        params: { protect_route: "false" },
      })],
      stages: [{ id: "s1", name: "Stage 1", ruleIds: ["r1"], disabled: false, collapsed: false }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
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

  it("confirmPostEdit stores postEditRefreshError and raises an error toast when computeAnalytics throws (GitHub issue #769)", async () => {
    vi.mocked(computeAnalytics).mockImplementation(() => { throw new Error("analytics failed"); });
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState().postEditRefreshError).toBe("analytics failed");
    expect(useMazeStore.getState().error).toBeNull();
    expect(errorCards()).toEqual(["post_edit/post_edit.refresh_failed"]);
    expect(errorDetails("post_edit.refresh_failed")).toBe("analytics failed");
  });

  it("confirmPostEdit clears postEditRefreshError without a toast on the next successful refresh", async () => {
    useMazeStore.setState({ postEditRefreshError: "analytics failed" });
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState().postEditRefreshError).toBeNull();
    expect(errorCards()).toEqual([]);
  });

  it("confirmPostEdit ignores a stale failure superseded by a newer request", async () => {
    let rejectFirst: (err: Error) => void = () => {};
    vi.mocked(computeAnalytics).mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }));
    const first = useMazeStore.getState().confirmPostEdit();
    await useMazeStore.getState().confirmPostEdit();
    rejectFirst(new Error("stale"));
    await first;
    expect(useMazeStore.getState().postEditRefreshError).toBeNull();
    expect(errorCards()).toEqual([]);
  });

  it("confirmPostEdit increments the request id on every call", async () => {
    vi.mocked(computeAnalytics).mockResolvedValue(mockSnapshot);
    const before = useMazeStore.getState()._postEditRequestId;
    await useMazeStore.getState().confirmPostEdit();
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState()._postEditRequestId).toBe(before + 2);
  });

  it("confirmPostEdit prunes a node whose split slot was removed client-side, so it's not resent to WASM (GitHub issue #327)", async () => {
    // (0,0) was auto-split at generation into original (i=0, id 0) + one extra node (i=1, id 2) -
    // removeSplitNode already dropped slot 0 from postEditDraftSplitPoints, but state.nodes still
    // carries the removed node's NodeDto (see confirmPostEdit's own pruning comment).
    useMazeStore.setState({
      nodes: [node(0, 0, 0), node(2, 0, 0, 1), node(1, 1, 0)],
      postEditDraftSplitPoints: {},
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.nodes).toEqual([node(0, 0, 0), node(1, 1, 0)]);
  });

  it("confirmPostEdit keeps a node whose split slot is still declared", async () => {
    useMazeStore.setState({
      nodes: [node(0, 0, 0), node(2, 0, 0, 1), node(1, 1, 0)],
      postEditDraftSplitPoints: { "0,0": [0] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.nodes).toEqual(expect.arrayContaining([node(2, 0, 0, 1)]));
  });

  it("confirmPostEdit sends a generation-baked vertical passage/elevator through as an ordinary draft entry (GitHub issue #564)", async () => {
    // VerticalPassage/Elevator edges are only user-editable via their own post-edit tools (GitHub
    // issue #341) - a generation-time one is a full baseline draft entry (its own stable id) from
    // the start, and `confirmPostEdit` sends the whole merged draft list, so compute_analytics
    // doesn't silently drop it from the rebuilt graph.
    seedPostEdit({
      nodes: [
        node(0, 0, 0, 0, 0),
        node(1, 1, 0, 0, 0),
        node(2, 1, 0, 0, 1),
        node(3, 0, 0, 0, 1),
      ],
      edges: [
        { from: 0, to: 1, kind: "basic" },
        { from: 1, to: 2, kind: "vertical_passage" },
        { from: 3, to: 0, kind: "elevator" }, { from: 0, to: 3, kind: "elevator" },
      ],
      start: null, finish: null,
    });
    await useMazeStore.getState().confirmPostEdit();
    const call = lastAnalyticsCall();
    expect(call?.vertical_edges).toEqual(expect.arrayContaining([
      { from: 1, to: 2, kind: "vertical_passage" },
      { from: 3, to: 0, kind: "elevator" }, { from: 0, to: 3, kind: "elevator" },
    ]));
    expect(call?.vertical_edges).toHaveLength(3);
  });
});
