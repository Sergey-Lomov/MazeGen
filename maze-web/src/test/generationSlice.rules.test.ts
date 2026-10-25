import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, mockGenerateMazeResult, resetGenerationMocks, makeRule } from "./storeTestHelpers";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { generateMaze, computeAnalytics } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";
import { ruleStrategyToConfig } from "../store/slices/generateConfigBuilder";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  resetGenerationMocks(vi.mocked(generateMaze), vi.mocked(computeAnalytics), vi.mocked(initWasm));
});

describe("mazeStore.setStrategyParam", () => {
  it("keeps same strategy params independent between rules", () => {
    useMazeStore.setState({ rules: [makeRule({ id: "a", strategyId: "scored_endpoints", strategyParams: { path_weight: "1" } }), makeRule({ id: "b", strategyId: "scored_endpoints", strategyParams: { path_weight: "2" } })] });
    useMazeStore.getState().setStrategyParam("a", "path_weight", "5");
    expect(useMazeStore.getState().rules.map((r) => r.strategyParams.path_weight)).toEqual(["5", "2"]);
  });

  it("builds distinct configs for two rules using the same strategy", () => {
    const rules = [
      makeRule({ id: "a", strategyId: "scored_endpoints", strategyParams: { path_weight: "2" } }),
      makeRule({ id: "b", strategyId: "scored_endpoints", strategyParams: { path_weight: "9" } }),
    ];
    useMazeStore.setState({
      rules,
      availableStrategies: [{ id: "scored_endpoints", handles: "k1", experimental: false, nested_slots: [], params: [{ id: "path_weight", label: "", kind: { type: "float", default: 1, min: 0, max: 10 } }] }],
    });
    const state = useMazeStore.getState();
    expect(rules.map((rule) => ruleStrategyToConfig(state, rule)?.params.path_weight)).toEqual(["2", "9"]);
  });
});

describe("mazeStore.setGenerationParam", () => {
  it("updates single param in initialConfig", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 } });
    useMazeStore.getState().setGenerationParam("depth_first", 0.3);
    const cfg = useMazeStore.getState().initialConfig;
    expect(cfg.method).toBe("custom_vertex_based");
    if (cfg.method === "custom_vertex_based") {
      expect(cfg.depth_first).toBe(0.3);
    }
  });

  it("preserves other params when updating one", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 } });
    useMazeStore.getState().setGenerationParam("branching", 0.1);
    const cfg = useMazeStore.getState().initialConfig;
    if (cfg.method === "custom_vertex_based") {
      expect(cfg.depth_first).toBe(0.9);
      expect(cfg.corridor_chance).toBe(0.7);
      expect(cfg.branching).toBe(0.1);
      expect(cfg.directionality).toBe(0.0);
    }
  });

  it("preserves method after param update", () => {
    useMazeStore.getState().setGenerationParam("directionality", 0.5);
    expect(useMazeStore.getState().initialConfig.method).toBe("custom_vertex_based");
  });

  it("is no-op when method is recursive_backtracker", () => {
    useMazeStore.setState({ initialConfig: { method: "recursive_backtracker" } });
    useMazeStore.getState().setGenerationParam("depth_first", 0.5);
    expect(useMazeStore.getState().initialConfig).toEqual({ method: "recursive_backtracker" });
  });
});

describe("mazeStore.setGenerationMethod", () => {
  it("switches initialConfig to defaults for new method", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_vertex_based", depth_first: 0.1, corridor_chance: 0.1, branching: 0.1, directionality: 0.1 } });
    useMazeStore.getState().setGenerationMethod("custom_vertex_based");
    const cfg = useMazeStore.getState().initialConfig;
    expect(cfg.method).toBe("custom_vertex_based");
    if (cfg.method === "custom_vertex_based") {
      expect(cfg.depth_first).toBe(0.9);
    }
  });

  it("does not update store for unknown method", () => {
    const before = useMazeStore.getState().initialConfig;
    useMazeStore.getState().setGenerationMethod("nonexistent_method");
    expect(useMazeStore.getState().initialConfig).toBe(before);
  });

  it("switches to recursive_backtracker", () => {
    useMazeStore.getState().setGenerationMethod("recursive_backtracker");
    expect(useMazeStore.getState().initialConfig.method).toBe("recursive_backtracker");
  });

  it("switches to wilson_algorithm", () => {
    useMazeStore.getState().setGenerationMethod("wilson_algorithm");
    expect(useMazeStore.getState().initialConfig.method).toBe("wilson_algorithm");
  });

  it("switches to kruskal_algorithm", () => {
    useMazeStore.getState().setGenerationMethod("kruskal_algorithm");
    expect(useMazeStore.getState().initialConfig.method).toBe("kruskal_algorithm");
  });

  it("closes the vertex settings panel when switching away from custom_vertex_based", () => {
    useMazeStore.setState({
      initialConfig: { method: "custom_vertex_based", depth_first: 0.1, corridor_chance: 0.1, branching: 0.1, directionality: 0.1 },
      vertexSettingsPanelOpen: true,
    });
    useMazeStore.getState().setGenerationMethod("recursive_backtracker");
    expect(useMazeStore.getState().vertexSettingsPanelOpen).toBe(false);
  });

  it("leaves the vertex settings panel open when switching to custom_vertex_based", () => {
    useMazeStore.setState({
      initialConfig: { method: "recursive_backtracker" },
      vertexSettingsPanelOpen: true,
    });
    useMazeStore.getState().setGenerationMethod("custom_vertex_based");
    expect(useMazeStore.getState().vertexSettingsPanelOpen).toBe(true);
  });
});

describe("mazeStore.addCheck", () => {
  const paramKind = { type: "integer" as const, default: 3, min: 1, max: 100 };
  const descriptor = { id: "min_loops", label: "Min loops", description: "", issue_kinds: ["missing_loops"], params: [{ id: "min_loops", label: "Min loops", kind: paramKind }] };
  // No real check type sets `allow_multiple_instances: true` any more (GitHub issue #60's
  // multi-instance design was retired) — this synthetic descriptor exercises the store's
  // multi-instance-allowed branch in isolation, independent of which (if any) real check uses it.
  const multiInstanceDescriptor = { id: "multi_instance_test_check", label: "Multi-instance test check", description: "", issue_kinds: ["missing_loops"], params: [{ id: "min_loops", label: "Min loops", kind: paramKind }] };

  it("adds the check as a new rule's instance", () => {
    useMazeStore.setState({ availableChecks: [descriptor], rules: [] });
    useMazeStore.getState().addCheck("min_loops");
    const typeIds = useMazeStore.getState().rules.flatMap((r) => r.checks.map((c) => c.typeId));
    expect(typeIds).toContain("min_loops");
  });

  it("creates a fresh stage for the new rule when stages is empty (no minimum-stage invariant)", () => {
    useMazeStore.setState({ availableChecks: [descriptor], rules: [], stages: [] });
    useMazeStore.getState().addCheck("min_loops");
    const state = useMazeStore.getState();
    expect(state.stages).toHaveLength(1);
    expect(state.stages[0].ruleIds).toEqual([state.rules[0].id]);
  });

  // No "already active" guard for `allow_multiple_instances` types (see GitHub issue #60) — each
  // call mints an independent instance, even for a type that's already active, instead of being
  // a no-op.
  it("mints an independent instance on each call, even for an already-active type", () => {
    useMazeStore.setState({
      availableChecks: [multiInstanceDescriptor],
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "missing_loops", checks: [{ localId: 0, typeId: "multi_instance_test_check", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().addCheck("multi_instance_test_check", "g1");
    const typeIds = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.map((c) => c.typeId);
    expect(typeIds).toEqual(["multi_instance_test_check", "multi_instance_test_check"]);
  });

  it("allows the same type to be added to another rule", () => {
    useMazeStore.setState({
      availableChecks: [descriptor],
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "missing_loops", checks: [{ localId: 0, typeId: "min_loops", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().addCheck("min_loops");
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(2);
    expect(rules[1].checks).toHaveLength(1);
  });

  it("initializes the new instance's params from descriptor defaults when not given", () => {
    useMazeStore.setState({ availableChecks: [descriptor], rules: [] });
    useMazeStore.getState().addCheck("min_loops");
    const rule = useMazeStore.getState().rules[0];
    expect(rule.checks[0].params.min_loops).toBe("3");
  });

  it("uses initialParams override instead of descriptor defaults when given", () => {
    useMazeStore.setState({ availableChecks: [descriptor], rules: [] });
    useMazeStore.getState().addCheck("min_loops", undefined, { min_loops: "7" });
    const rule = useMazeStore.getState().rules[0];
    expect(rule.checks[0].params.min_loops).toBe("7");
  });

  it("is no-op for unknown check id", () => {
    useMazeStore.setState({ availableChecks: [], rules: [] });
    useMazeStore.getState().addCheck("nonexistent");
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("creates a new singleton rule for the added check", () => {
    useMazeStore.setState({ availableChecks: [descriptor], rules: [] });
    useMazeStore.getState().addCheck("min_loops");
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].checks.map((c) => c.typeId)).toEqual(["min_loops"]);
    expect(rules[0].strategyId).toBeNull();
  });
});

describe("mazeStore.removeCheck", () => {
  it("removes the check instance from its rule", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }, { localId: 1, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().removeCheck("g1", 0);
    const typeIds = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.map((c) => c.typeId);
    expect(typeIds).toEqual(["check_b"]);
  });

  it("preserves the remaining check's params after removal", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: { p: "5" }, disabled: false }, { localId: 1, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().removeCheck("g1", 1);
    const checkA = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0);
    expect(checkA?.params).toEqual({ p: "5" });
  });

  it("is no-op for a non-matching localId", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().removeCheck("g1", 99);
    const typeIds = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.map((c) => c.typeId);
    expect(typeIds).toEqual(["check_b"]);
  });

  it("removes the check from its rule, leaving an empty rule rather than dropping it", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().removeCheck("g1", 0);
    expect(useMazeStore.getState().rules).toEqual([makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {} })]);
  });

  it("removes only the check from a multi-check rule, keeping the rule", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }, { localId: 1, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().removeCheck("g1", 0);
    expect(useMazeStore.getState().rules).toEqual([makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 1, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", strategyParams: {} })]);
  });
});

describe("mazeStore.setCheckParam", () => {
  it("stores param value on the targeted instance", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "min_loops", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().setCheckParam("g1", 0, "min_loops", "5");
    const check = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0);
    expect(check?.params.min_loops).toBe("5");
  });

  it("merges params for the same instance", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "min_loops", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().setCheckParam("g1", 0, "param_a", "1");
    useMazeStore.getState().setCheckParam("g1", 0, "param_b", "2");
    const check = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0);
    expect(check?.params.param_a).toBe("1");
    expect(check?.params.param_b).toBe("2");
  });

  it("overrides existing param value", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "min_loops", params: { min_loops: "1" }, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().setCheckParam("g1", 0, "min_loops", "9");
    const check = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0);
    expect(check?.params.min_loops).toBe("9");
  });

  it("keeps params for different instances independent, even within the same rule", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }, { localId: 1, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().setCheckParam("g1", 0, "p", "1");
    useMazeStore.getState().setCheckParam("g1", 1, "p", "2");
    const rule = useMazeStore.getState().rules.find((r) => r.id === "g1")!;
    expect(rule.checks.find((c) => c.localId === 0)?.params.p).toBe("1");
    expect(rule.checks.find((c) => c.localId === 1)?.params.p).toBe("2");
  });
});

describe("mazeStore.setElementsParam", () => {
  it("updates one_way_chance in elementsConfig", () => {
    useMazeStore.setState({ elementsConfig: { one_way_chance: 0.04 } });
    useMazeStore.getState().setElementsParam("one_way_chance", 0.2);
    expect(useMazeStore.getState().elementsConfig.one_way_chance).toBe(0.2);
  });

  it("last call wins when called twice for same key", () => {
    useMazeStore.setState({ elementsConfig: { one_way_chance: 0.1 } });
    useMazeStore.getState().setElementsParam("one_way_chance", 0.3);
    useMazeStore.getState().setElementsParam("one_way_chance", 0.7);
    expect(useMazeStore.getState().elementsConfig.one_way_chance).toBe(0.7);
  });
});

describe("mazeStore.addCheck with ruleId / removeCheckFromRule", () => {
  it("addCheck with a ruleId activates the check directly into that rule, not a new one", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k1"], params: [] }],
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().addCheck("check_a", "g1");
    expect(useMazeStore.getState().rules).toEqual([
      makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }, { localId: 1, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", strategyParams: {} }),
    ]);
  });

  it("addCheck with a ruleId whose kind differs from the check's kind falls back to a new singleton rule", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k2"], params: [] }],
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().addCheck("check_a", "g1");
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(2);
    expect(rules.find((g) => g.id === "g1")?.checks.map((c) => c.typeId)).toEqual(["check_b"]);
    const newRule = rules.find((g) => g.id !== "g1")!;
    expect(newRule.checks.map((c) => c.typeId)).toEqual(["check_a"]);
    expect(newRule.kind).toBe("k2");
  });

  it("addCheck with a stale/unknown ruleId falls back to creating a new singleton rule", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k1"], params: [] }],
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().addCheck("check_a", "does_not_exist");
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(2);
    expect(rules.find((g) => g.id === "g1")?.checks.map((c) => c.typeId)).toEqual(["check_b"]);
    const newRule = rules.find((g) => g.id !== "g1")!;
    expect(newRule.checks.map((c) => c.typeId)).toEqual(["check_a"]);
  });

  it("addCheck warns and uses the first kind for a check producing multiple issue kinds", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useMazeStore.setState({
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k1", "k2"], params: [] }],
      rules: [],
    });
    useMazeStore.getState().addCheck("check_a");
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].kind).toBe("k1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("check_a"));
    errorSpy.mockRestore();
  });

  it("addCheck creates a new singleton rule when ruleId is omitted", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k1"], params: [] }],
      rules: [],
    });
    useMazeStore.getState().addCheck("check_a");
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].checks.map((c) => c.typeId)).toEqual(["check_a"]);
  });

  it("keeps every known typeId even when it is already active elsewhere", () => {
    useMazeStore.setState({
      availableChecks: [
        { id: "check_a", label: "A", description: "", issue_kinds: ["k1"], params: [] },
        { id: "check_b", label: "B", description: "", issue_kinds: ["k1"], params: [] },
      ],
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().createRule(["check_a", "check_b"], null);
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(2);
    const newRule = rules.find((g) => g.id !== "g1")!;
    expect(newRule.checks.map((c) => c.typeId)).toEqual(["check_a", "check_b"]);
  });

  it("removeCheckFromRule moves the check into a fresh singleton rule", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }, { localId: 1, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().removeCheckFromRule("g1", 0);
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(2);
    expect(rules.find((g) => g.id === "g1")?.checks.map((c) => c.typeId)).toEqual(["check_b"]);
    const newRule = rules.find((g) => g.id !== "g1")!;
    expect(newRule.checks.map((c) => c.typeId)).toEqual(["check_a"]);
    expect(newRule.strategyId).toBeNull();
  });
});

describe("mazeStore.renameRule / removeRule / toggleRuleDisabled", () => {
  it("renameRule updates the rule's name", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().renameRule("g1", "My custom rule");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.name).toBe("My custom rule");
  });

  // GitHub issue #556: a name matching the current-locale default text collapses back to `null`,
  // so it still tracks locale changes like a never-renamed rule instead of freezing that locale's
  // text as a permanent custom name.
  it("renameRule collapses to null when the input matches the current default label", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "My custom rule", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().renameRule("g1", "k1");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.name).toBeNull();
  });

  it("removeRule removes the rule and its checks", () => {
    useMazeStore.setState({
      rules: [
        makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
        makeRule({ id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false, collapsed: false }],
    });
    useMazeStore.getState().removeRule("g1");
    expect(useMazeStore.getState().rules).toEqual([
      makeRule({ id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
    ]);
  });

  it("removeRule scrubs the rule's id from whichever stage held it", () => {
    useMazeStore.setState({
      rules: [
        makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
        makeRule({ id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false, collapsed: false }],
    });
    useMazeStore.getState().removeRule("g1");
    expect(useMazeStore.getState().stages).toEqual([{ id: "stage_1", name: "Stage 1", ruleIds: ["g2"], disabled: false, collapsed: false }]);
  });

  it("removeRule is a no-op for an unknown rule id", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
    });
    useMazeStore.getState().removeRule("missing");
    expect(useMazeStore.getState().rules).toHaveLength(1);
  });

  it("toggleRuleDisabled flips ruleDisabled independent of disabled", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().toggleRuleDisabled("g1");
    const g = useMazeStore.getState().rules.find((g) => g.id === "g1")!;
    expect(g.ruleDisabled).toBe(true);
    expect(g.disabled).toBe(false);
  });

  it("toggleRuleCollapsed flips collapsed independent of disabled/ruleDisabled", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().toggleRuleCollapsed("g1");
    let g = useMazeStore.getState().rules.find((g) => g.id === "g1")!;
    expect(g.collapsed).toBe(true);
    expect(g.disabled).toBe(false);
    expect(g.ruleDisabled).toBe(false);
    useMazeStore.getState().toggleRuleCollapsed("g1");
    g = useMazeStore.getState().rules.find((g) => g.id === "g1")!;
    expect(g.collapsed).toBe(false);
  });

  it("toggleCheckDisabled flips a single check's disabled, other checks and the rule untouched", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }, { localId: 1, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", strategyParams: {} })],
    });
    useMazeStore.getState().toggleCheckDisabled("g1", 0);
    const g = useMazeStore.getState().rules.find((g) => g.id === "g1")!;
    expect(g.checks.find((c) => c.localId === 0)?.disabled).toBe(true);
    expect(g.checks.find((c) => c.localId === 1)?.disabled).toBe(false);
    expect(g.disabled).toBe(false);
    expect(g.ruleDisabled).toBe(false);
  });
});

describe("mazeStore.moveRule", () => {
  function makeRules() {
    return [
      makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
      makeRule({ id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
      makeRule({ id: "g3", name: "Rule 3", kind: "k1", checks: [{ localId: 0, typeId: "check_c", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
    ];
  }

  it("moves a rule up within its stage, swapping with its predecessor", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false, collapsed: false }] });
    useMazeStore.getState().moveRule("g2", "up");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g2", "g1", "g3"]);
  });

  it("moves a rule down within its stage, swapping with its successor", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false, collapsed: false }] });
    useMazeStore.getState().moveRule("g2", "down");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g1", "g3", "g2"]);
  });

  it("is a no-op moving the first rule of the first stage up", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false, collapsed: false }] });
    useMazeStore.getState().moveRule("g1", "up");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g1", "g2", "g3"]);
  });

  it("is a no-op moving the last rule of the last stage down", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false, collapsed: false }] });
    useMazeStore.getState().moveRule("g3", "down");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g1", "g2", "g3"]);
  });

  it("is a no-op for an unknown rule id", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false, collapsed: false }] });
    useMazeStore.getState().moveRule("missing", "up");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g1", "g2", "g3"]);
  });

  it("moving down at a stage's end crosses into the next stage's front", () => {
    useMazeStore.setState({
      rules: makeRules(),
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false, collapsed: false },
        { id: "s2", name: "Stage 2", ruleIds: ["g3"], disabled: false, collapsed: false },
      ],
    });
    useMazeStore.getState().moveRule("g2", "down");
    const stages = useMazeStore.getState().stages;
    expect(stages[0].ruleIds).toEqual(["g1"]);
    expect(stages[1].ruleIds).toEqual(["g2", "g3"]);
  });

  it("moving up at a stage's start crosses into the previous stage's back", () => {
    useMazeStore.setState({
      rules: makeRules(),
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: ["g1"], disabled: false, collapsed: false },
        { id: "s2", name: "Stage 2", ruleIds: ["g2", "g3"], disabled: false, collapsed: false },
      ],
    });
    useMazeStore.getState().moveRule("g2", "up");
    const stages = useMazeStore.getState().stages;
    expect(stages[0].ruleIds).toEqual(["g1", "g2"]);
    expect(stages[1].ruleIds).toEqual(["g3"]);
  });

  it("moving down crosses into an empty next stage", () => {
    useMazeStore.setState({
      rules: makeRules(),
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false, collapsed: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false, collapsed: false },
      ],
    });
    useMazeStore.getState().moveRule("g2", "down");
    const stages = useMazeStore.getState().stages;
    expect(stages[0].ruleIds).toEqual(["g1"]);
    expect(stages[1].ruleIds).toEqual(["g2"]);
  });

  it("is a no-op moving down at the last rule of the last stage even with an empty stage before it", () => {
    useMazeStore.setState({
      rules: makeRules(),
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false },
        { id: "s2", name: "Stage 2", ruleIds: ["g1"], disabled: false, collapsed: false },
      ],
    });
    useMazeStore.getState().moveRule("g1", "down");
    const stages = useMazeStore.getState().stages;
    expect(stages[0].ruleIds).toEqual([]);
    expect(stages[1].ruleIds).toEqual(["g1"]);
  });
});

describe("mazeStore stage actions", () => {
  it("addStage appends a new empty stage with a default name", () => {
    useMazeStore.setState({ stages: [{ id: "s1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false }] });
    useMazeStore.getState().addStage();
    const stages = useMazeStore.getState().stages;
    expect(stages).toHaveLength(2);
    expect(stages[1].name).toBe("Stage 2");
    expect(stages[1].ruleIds).toEqual([]);
  });

  it("addStage does not reuse a name still present after a middle stage was removed", () => {
    useMazeStore.setState({
      stages: [
        { id: "s1", name: "Waypoints", ruleIds: [], disabled: false, collapsed: false },
        { id: "s3", name: "Stage 3", ruleIds: [], disabled: false, collapsed: false },
      ],
    });
    useMazeStore.getState().addStage();
    const stages = useMazeStore.getState().stages;
    expect(stages).toHaveLength(3);
    expect(stages[2].name).toBe("Stage 4");
  });

  it("renameStage sets the stage's name", () => {
    useMazeStore.setState({ stages: [{ id: "s1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false }] });
    useMazeStore.getState().renameStage("s1", "My stage");
    expect(useMazeStore.getState().stages[0].name).toBe("My stage");
  });

  it("removeStage removes an empty stage when another stage remains", () => {
    useMazeStore.setState({
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false, collapsed: false },
      ],
    });
    useMazeStore.getState().removeStage("s1");
    expect(useMazeStore.getState().stages.map((s) => s.id)).toEqual(["s2"]);
  });

  it("removeStage cascades: removes a non-empty stage along with its member rules", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} })],
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: ["g1"], disabled: false, collapsed: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false, collapsed: false },
      ],
    });
    useMazeStore.getState().removeStage("s1");
    expect(useMazeStore.getState().stages.map((s) => s.id)).toEqual(["s2"]);
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("removeStage removes the sole remaining stage when empty (no minimum-stage invariant)", () => {
    useMazeStore.setState({ stages: [{ id: "s1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false }] });
    useMazeStore.getState().removeStage("s1");
    expect(useMazeStore.getState().stages).toEqual([]);
  });

  it("moveStage swaps adjacent stages", () => {
    useMazeStore.setState({
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false, collapsed: false },
      ],
    });
    useMazeStore.getState().moveStage("s2", "up");
    expect(useMazeStore.getState().stages.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("moveStage is a no-op at the global boundary", () => {
    useMazeStore.setState({
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false, collapsed: false },
      ],
    });
    useMazeStore.getState().moveStage("s1", "up");
    expect(useMazeStore.getState().stages.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("toggleStageCollapsed flips collapsed independent of disabled", () => {
    useMazeStore.setState({ stages: [{ id: "s1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false }] });
    useMazeStore.getState().toggleStageCollapsed("s1");
    let stage = useMazeStore.getState().stages.find((s) => s.id === "s1")!;
    expect(stage.collapsed).toBe(true);
    expect(stage.disabled).toBe(false);
    useMazeStore.getState().toggleStageCollapsed("s1");
    stage = useMazeStore.getState().stages.find((s) => s.id === "s1")!;
    expect(stage.collapsed).toBe(false);
  });
});

describe("buildGenerateConfig — ruleDisabled exclusion", () => {
  it("excludes a ruleDisabled rule's checks entirely from its stage's rules", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      rules: [
        { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {}, disabled: false, ruleDisabled: true, params: {}, nestedStrategies: [], collapsed: false },
        makeRule({ id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false, collapsed: false }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].stages.flatMap((s) => s.rules)).toEqual([{ id: "g2", checks: [{ local_id: "0", type_id: "check_b", params: {} }], strategy: null, params: {} }]);
  });

  it("excludes a disabled check from its rule's checks, keeping the rule and its other checks", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      rules: [
        makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: true }, { localId: 1, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: null, strategyParams: {} }),
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false, collapsed: false }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].stages.flatMap((s) => s.rules)).toEqual([{ id: "g1", checks: [{ local_id: "1", type_id: "check_b", params: {} }], strategy: null, params: {} }]);
  });

  it("omits a rule entirely when every one of its checks is disabled (core rejects an empty checks array)", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      rules: [
        makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: true }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
        makeRule({ id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, strategyParams: {} }),
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false, collapsed: false }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].stages.flatMap((s) => s.rules)).toEqual([{ id: "g2", checks: [{ local_id: "0", type_id: "check_b", params: {} }], strategy: null, params: {} }]);
  });

  it("omits a rule entirely when its checks array is already empty (pre-existing 'no checks' guard)", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      rules: [
        makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 0, strategyId: null, strategyParams: {} }),
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false, collapsed: false }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].stages.flatMap((s) => s.rules)).toEqual([]);
  });
});
