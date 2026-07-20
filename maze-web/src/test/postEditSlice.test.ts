import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, mockSnapshot } from "./storeTestHelpers";

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

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  vi.mocked(computeAnalytics).mockReset();
  vi.mocked(computeAnalytics).mockReturnValue(mockSnapshot);
  useMazeStore.setState({
    edges: [{ from: 0, to: 1, kind: "basic" }],
    nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }],
    start: 0,
    finish: 1,
    activeTessellationConfig: { type: "square", width: 2, height: 1 },
    postEditDraftEdges: { "0-1": { from: 0, to: 1, kind: "basic" } },
    postEditDraftMeta: { start: 0, finish: 1 },
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
    useMazeStore.getState().applyPostEditTool("0-1", 0, 1);
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.["0-1"]).toBeUndefined();
    expect(s.postEditDirty).toBe(true);
  });

  it("applyPostEditTool('passage') sets a basic edge entry", () => {
    useMazeStore.setState({ postEditTool: "passage", postEditDraftEdges: {} });
    useMazeStore.getState().applyPostEditTool("0-1", 0, 1);
    expect(useMazeStore.getState().postEditDraftEdges?.["0-1"]?.kind).toBe("basic");
  });

  it("applyPostEditTool is no-op when there is no draft yet", () => {
    useMazeStore.setState({ postEditDraftEdges: null, postEditDirty: false });
    useMazeStore.getState().applyPostEditTool("0-1", 0, 1);
    expect(useMazeStore.getState().postEditDirty).toBe(false);
  });

  it("confirmPostEdit computes analytics from the current draft and stores a snapshot", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const s = useMazeStore.getState();
    expect(computeAnalytics).toHaveBeenCalled();
    expect(s.postEditAnalytics).not.toBeNull();
    expect(s.postEditEdges).toEqual({ "0-1": { from: 0, to: 1, kind: "basic" } });
    expect(s.postEditMeta).toEqual({ start: 0, finish: 1 });
  });

  it("confirmPostEdit passes non-wall edges and excludes wall edges to computeAnalytics", async () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        "0-1": { from: 0, to: 1, kind: "basic" },
        "1-2": { from: 1, to: 2, kind: "wall" },
      },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.edges).toEqual([{ from: 0, to: 1, kind: "basic" }]);
  });

  it("confirmPostEdit sends teleport edges to computeAnalytics with kind \"teleport\", separate from postEditDraftEdges", async () => {
    useMazeStore.setState({
      postEditDraftEdges: { "0-1": { from: 0, to: 1, kind: "basic" } },
      postEditDraftTeleports: [{ id: 1, from: 0, to: 2, direction: "forward" }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.edges).toEqual([
      { from: 0, to: 1, kind: "basic" },
      { from: 0, to: 2, kind: "teleport" },
    ]);
    expect(useMazeStore.getState().postEditTeleportEdges).toEqual([{ from: 0, to: 2, kind: "teleport" }]);
  });

  it("resetPostEdit repopulates postEditDraftTeleports from generated edges", () => {
    useMazeStore.setState({
      edges: [{ from: 0, to: 1, kind: "basic" }, { from: 2, to: 3, kind: "teleport" }],
      postEditDraftTeleports: [],
    });
    useMazeStore.getState().resetPostEdit();
    expect(useMazeStore.getState().postEditDraftTeleports).toEqual([{ id: 1, from: 2, to: 3, direction: "forward" }]);
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
      postEditDraftEdges: { "0-1": { from: 0, to: 1, kind: "wall" } },
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta).toEqual({ start: 0, finish: 1 });
    expect(s.postEditDirty).toBe(false);
  });

  it("setPostEditEndpoint updates draft meta and marks dirty", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().setPostEditEndpoint("start", 5);
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.start).toBe(5);
    expect(s.postEditDirty).toBe(true);
  });

  it("setPostEditEndpoint triggers confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().setPostEditEndpoint("finish", 7);
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
