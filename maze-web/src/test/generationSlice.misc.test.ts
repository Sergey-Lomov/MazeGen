import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, mockGenerateMazeResult, mockSnapshot, resetGenerationMocks, makeRule } from "./storeTestHelpers";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getAvailableRuleParams: vi.fn(() => []),
  getCartesianCoords: vi.fn((cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y])),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { generateMaze, computeAnalytics, getAvailableChecks, getAvailableStrategies } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";
import { resetNotifications, useNotificationStore } from "../notifications/notificationStore";
import { errorCards, errorDetails } from "./notificationTestHelpers";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  resetGenerationMocks(vi.mocked(generateMaze), vi.mocked(computeAnalytics), vi.mocked(initWasm));
});

describe("mazeStore seed history", () => {
  it("first generate() pushes the used seed into an empty history", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 42, randomSeed: false, rules: [] });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.seedHistory).toEqual([42]);
    expect(s.seedHistoryIndex).toBe(0);
    expect(s.seedAttachedToHistory).toBe(true);
  });

  it("consecutive generate() calls with new seeds append to history", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 1, randomSeed: false, rules: [] });
    useMazeStore.getState().generate();
    useMazeStore.setState({ seed: 2, seedAttachedToHistory: false });
    useMazeStore.getState().generate();
    useMazeStore.setState({ seed: 3, seedAttachedToHistory: false });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.seedHistory).toEqual([1, 2, 3]);
    expect(s.seedHistoryIndex).toBe(2);
  });

  it("seedHistoryBack/Forward navigate without triggering generation", () => {
    useMazeStore.setState({ seedHistory: [10, 20, 30], seedHistoryIndex: 2, seedAttachedToHistory: true });
    useMazeStore.getState().seedHistoryBack();
    expect(useMazeStore.getState().seed).toBe(20);
    expect(useMazeStore.getState().seedHistoryIndex).toBe(1);
    expect(generateMaze).not.toHaveBeenCalled();

    useMazeStore.getState().seedHistoryForward();
    expect(useMazeStore.getState().seed).toBe(30);
    expect(useMazeStore.getState().seedHistoryIndex).toBe(2);
    expect(generateMaze).not.toHaveBeenCalled();
  });

  it("seedHistoryBack is a no-op at the start of history", () => {
    useMazeStore.setState({ seedHistory: [10, 20], seedHistoryIndex: 0, seed: 10 });
    useMazeStore.getState().seedHistoryBack();
    expect(useMazeStore.getState().seedHistoryIndex).toBe(0);
    expect(useMazeStore.getState().seed).toBe(10);
  });

  it("seedHistoryForward is a no-op at the end of history", () => {
    useMazeStore.setState({ seedHistory: [10, 20], seedHistoryIndex: 1, seed: 20 });
    useMazeStore.getState().seedHistoryForward();
    expect(useMazeStore.getState().seedHistoryIndex).toBe(1);
    expect(useMazeStore.getState().seed).toBe(20);
  });

  it("seedHistoryJump sets seed and index directly, no-op out of range", () => {
    useMazeStore.setState({ seedHistory: [10, 20, 30], seedHistoryIndex: 2, seed: 30 });
    useMazeStore.getState().seedHistoryJump(0);
    expect(useMazeStore.getState().seed).toBe(10);
    expect(useMazeStore.getState().seedHistoryIndex).toBe(0);

    useMazeStore.getState().seedHistoryJump(99);
    expect(useMazeStore.getState().seedHistoryIndex).toBe(0); // unchanged, out of range
  });

  it("history navigation turns randomSeed off", () => {
    useMazeStore.setState({ seedHistory: [10, 20], seedHistoryIndex: 0, randomSeed: true });
    useMazeStore.getState().seedHistoryForward();
    expect(useMazeStore.getState().randomSeed).toBe(false);
  });

  it("repeat generate() on the exact seed just navigated to does not mutate history", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seedHistory: [10, 20, 30], seedHistoryIndex: 1, seed: 20, seedAttachedToHistory: true, randomSeed: false, rules: [] });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.seedHistory).toEqual([10, 20, 30]);
    expect(s.seedHistoryIndex).toBe(1);
  });

  it("generate() with a hand-edited seed truncates history from the current index (undo/redo branch)", () => {
    // history=[10,20,30,40,50] at index=4, back x2 -> index=2 (seed 30), then a manual seed edit to 99.
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seedHistory: [10, 20, 30, 40, 50], seedHistoryIndex: 4, seed: 50, seedAttachedToHistory: true, rules: [] });
    useMazeStore.getState().seedHistoryBack();
    useMazeStore.getState().seedHistoryBack();
    expect(useMazeStore.getState().seed).toBe(30);
    useMazeStore.getState().setSeed(99);
    expect(useMazeStore.getState().seedAttachedToHistory).toBe(false);
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.seedHistory).toEqual([10, 20, 30, 99]);
    expect(s.seedHistoryIndex).toBe(3);
  });

  it("history is capped at 20 entries, oldest dropped", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seedHistory: [], seedHistoryIndex: 0, rules: [] });
    for (let i = 1; i <= 21; i++) {
      useMazeStore.setState({ seed: i, seedAttachedToHistory: false });
      useMazeStore.getState().generate();
    }
    const s = useMazeStore.getState();
    expect(s.seedHistory).toHaveLength(20);
    expect(s.seedHistory[0]).toBe(2); // seed 1 dropped
    expect(s.seedHistory[19]).toBe(21);
    expect(s.seedHistoryIndex).toBe(19);
  });
});

describe("mazeStore.reset", () => {
  it("clears nodes, edges, start, finish, selectedNode, error", () => {
    useMazeStore.setState({
      nodes: mockSnapshot.nodes,
      edges: mockSnapshot.edges,
      start: 0,
      finish: 1,
      selectedNode: 0,
      error: { kind: "run_failed", message: "something" },
    });
    useMazeStore.getState().reset();
    const s = useMazeStore.getState();
    expect(s.nodes).toEqual([]);
    expect(s.edges).toEqual([]);
    expect(s.start).toBeNull();
    expect(s.finish).toBeNull();
    expect(s.selectedNode).toBeNull();
    expect(s.error).toBeNull();
  });
});

describe("mazeStore.setDebugFlag", () => {
  it("sets showNodeIds", () => {
    useMazeStore.getState().setDebugFlag("showNodeIds", true);
    expect(useMazeStore.getState().showNodeIds).toBe(true);
  });

  it("sets showCoords", () => {
    useMazeStore.getState().setDebugFlag("showCoords", true);
    expect(useMazeStore.getState().showCoords).toBe(true);
  });

  it("sets showMaze", () => {
    useMazeStore.getState().setDebugFlag("showMaze", false);
    expect(useMazeStore.getState().showMaze).toBe(false);
  });
});

describe("mazeStore.selectNode", () => {
  it("sets selectedNode", () => {
    useMazeStore.getState().selectNode(3);
    expect(useMazeStore.getState().selectedNode).toBe(3);
  });

  it("clears selectedNode with null", () => {
    useMazeStore.setState({ selectedNode: 3 });
    useMazeStore.getState().selectNode(null);
    expect(useMazeStore.getState().selectedNode).toBeNull();
  });
});

describe("mazeStore.loadRegistry", () => {
  it("stores available checks and strategies", async () => {
    const checks = [{ id: "missing_endpoints", label: "Missing endpoints", description: "", issue_kinds: ["missing_endpoints"], params: [], allow_multiple_instances: false }];
    const strategies = [{ id: "farthest_endpoints", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [] }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().availableChecks).toEqual(checks);
    expect(useMazeStore.getState().availableStrategies).toEqual(strategies);
  });

  it("auto-selects checks without params", async () => {
    const checks = [
      { id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [], allow_multiple_instances: false },
      { id: "check_b", label: "Check B", description: "", issue_kinds: ["kind_b"], params: [], allow_multiple_instances: false },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    const selectedChecks = useMazeStore.getState().rules.flatMap((r) => r.checks.map((c) => c.typeId));
    expect(selectedChecks).toEqual(["check_a", "check_b"]);
  });

  it("does not auto-select checks with params", async () => {
    const paramKind = { type: "integer" as const, default: 1, min: 1, max: 100 };
    const checks = [
      { id: "check_no_params", label: "No params", description: "", issue_kinds: ["kind_a"], params: [], allow_multiple_instances: false },
      { id: "check_with_params", label: "Has params", description: "", issue_kinds: ["kind_b"], params: [{ id: "p", label: "P", kind: paramKind }], allow_multiple_instances: false },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    const selectedChecks = useMazeStore.getState().rules.flatMap((r) => r.checks.map((c) => c.typeId));
    expect(selectedChecks).toEqual(["check_no_params"]);
  });

  it("excludes teleport checks from the default set even when they have no params", async () => {
    // teleport_duplicates_connection has params: [] just like any other auto-selected check, but
    // must not be pre-populated: teleport validation isn't relevant until the user actually
    // enables teleports.
    const checks = [
      { id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [], allow_multiple_instances: false },
      { id: "teleport_duplicates_connection", label: "Teleport dup", description: "", issue_kinds: ["invalid_teleport"], params: [], allow_multiple_instances: false },
      { id: "some_group_check", label: "Group check", description: "", issue_kinds: ["invalid_teleport_group"], params: [], allow_multiple_instances: false },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    const selectedChecks = useMazeStore.getState().rules.flatMap((r) => r.checks.map((c) => c.typeId));
    expect(selectedChecks).toEqual(["check_a"]);
  });

  it("preserves rules on repeated call", async () => {
    const checks = [
      { id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [], allow_multiple_instances: false },
      { id: "check_b", label: "Check B", description: "", issue_kinds: ["kind_b"], params: [], allow_multiple_instances: false },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "kind_b", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null })],
    });
    await useMazeStore.getState().loadRegistry();
    const selectedChecks = useMazeStore.getState().rules.flatMap((r) => r.checks.map((c) => c.typeId));
    expect(selectedChecks).toEqual(["check_b"]);
  });

  it("auto-creates one singleton rule per default-selected check, with first matching strategy", async () => {
    const checks = [{ id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [], allow_multiple_instances: false }];
    const strategies = [
      { id: "strategy_first", handles: "kind_a", params: [], experimental: false, nested_slots: [] },
      { id: "strategy_second", handles: "kind_a", params: [], experimental: false, nested_slots: [] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].checks.map((c) => c.typeId)).toEqual(["check_a"]);
    expect(rules[0].strategyId).toBe("strategy_first");
  });

  // A fresh rule's `name` is `null` (no custom name) — the VM resolves it to the issue kind's
  // own live-locale label, not a counter, so it re-translates on a locale switch instead of
  // freezing whatever text was current at creation time (GitHub issue #556).
  it("leaves the default rule's name null so the VM resolves it to the issue kind's label, not a counter", async () => {
    const checks = [{ id: "missing_endpoints", label: "Missing endpoints", description: "", issue_kinds: ["missing_endpoints"], params: [], allow_multiple_instances: false }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().rules[0].name).toBeNull();
  });

  it("prefers scored_endpoints over earlier-listed strategies for the missing_endpoints kind", async () => {
    const checks = [{ id: "missing_endpoints", label: "Missing endpoints", description: "", issue_kinds: ["missing_endpoints"], params: [], allow_multiple_instances: false }];
    const strategies = [
      { id: "random_endpoints", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [] },
      { id: "farthest_endpoints", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [] },
      { id: "scored_endpoints", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().rules[0].strategyId).toBe("scored_endpoints");
  });

  it("leaves rule without a matching strategy unassigned", async () => {
    const checks = [{ id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [], allow_multiple_instances: false }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    const rules = useMazeStore.getState().rules;
    expect(rules[0].strategyId).toBeNull();
  });

  it("sets registryError and raises an error toast when initWasm rejects (GitHub issue #769)", async () => {
    resetNotifications();
    vi.mocked(initWasm).mockRejectedValueOnce(new Error("wasm load failed"));
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().registryError).toBe("wasm load failed");
    expect(useMazeStore.getState().error).toBeNull();
    expect(errorCards()).toEqual(["generation/generation.registry_load_failed"]);
    expect(errorDetails("generation.registry_load_failed")).toBe("wasm load failed");
  });

  it("sets registryError string when initWasm rejects with non-Error", async () => {
    vi.mocked(initWasm).mockRejectedValueOnce("fatal");
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().registryError).toBe("fatal");
  });

  it("adds a retry failure to the existing registry error card", async () => {
    resetNotifications();
    vi.mocked(initWasm)
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("retry failure"));

    await useMazeStore.getState().loadRegistry();
    await useMazeStore.getState().loadRegistry();

    expect(errorCards()).toEqual(["generation/generation.registry_load_failed"]);
    expect(useNotificationStore.getState().errors[0].occurrences).toHaveLength(2);
    expect(errorDetails("generation.registry_load_failed")).toBe("retry failure");
  });

  it("keeps registryError across seed changes", async () => {
    vi.mocked(initWasm).mockRejectedValueOnce(new Error("wasm load failed"));
    await useMazeStore.getState().loadRegistry();
    useMazeStore.getState().setSeed(123);
    expect(useMazeStore.getState().registryError).toBe("wasm load failed");
  });

  it("clears registryError without a toast on a successful load", async () => {
    resetNotifications();
    useMazeStore.setState({ registryError: "old" });
    vi.mocked(getAvailableChecks).mockReturnValue([]);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().registryError).toBeNull();
    expect(errorCards()).toEqual([]);
  });

  it("shares one in-flight load between overlapping calls and allows a retry after it settles", async () => {
    resetNotifications();
    vi.mocked(initWasm).mockClear();
    vi.mocked(initWasm).mockRejectedValueOnce(new Error("wasm load failed"));
    const first = useMazeStore.getState().loadRegistry();
    const second = useMazeStore.getState().loadRegistry();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(initWasm).toHaveBeenCalledTimes(1);
    expect(useNotificationStore.getState().errors[0].occurrences).toHaveLength(1);

    await useMazeStore.getState().loadRegistry();
    expect(initWasm).toHaveBeenCalledTimes(2);
    expect(useMazeStore.getState().registryError).toBeNull();
  });
});
