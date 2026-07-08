import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";
import { fieldConfigToWasm, buildExactGenerateCallPayload } from "../store/slices/generationSlice";
import { baseStoreState, emptyFreePoints, mockSnapshot, resetGenerationMocks } from "./storeTestHelpers";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getCartesianCoords: vi.fn((cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y])),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { generateMaze, computeAnalytics, getAvailableChecks, getAvailableStrategies } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  resetGenerationMocks(vi.mocked(generateMaze), vi.mocked(computeAnalytics), vi.mocked(initWasm));
});

describe("mazeStore.generate", () => {
  it("stores snapshot on success", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.nodes).toEqual(mockSnapshot.nodes);
    expect(s.edges).toEqual(mockSnapshot.edges);
    expect(s.start).toBe(0);
    expect(s.finish).toBe(1);
    expect(s.error).toBeNull();
    expect(s.selectedNode).toBeNull();
  });

  it("calls generateMaze with current seed and tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "square", width: 3, height: 4 },
      rules: [],
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: fieldConfigToWasm({ type: "square", width: 3, height: 4 }),
      stages: [{ id: "stage_1", name: "Stage 1", rules: [] }],
      repair_max_iterations: 10,
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0 },
      preset_connections: [],
      locked_nodes: [],
    });
  });

  it("calls generateMaze with hex_parallelogram tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 6, orientation: "flat_top" },
      rules: [],
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: fieldConfigToWasm({ type: "hex_parallelogram", cols: 5, rows: 6, orientation: "flat_top" }),
      stages: [{ id: "stage_1", name: "Stage 1", rules: [] }],
      repair_max_iterations: 10,
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0 },
      preset_connections: [],
      locked_nodes: [],
    });
  });

  it("calls generateMaze with hex_hexagon tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "hex_hexagon", radius: 3, orientation: "pointy_top" },
      rules: [],
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: fieldConfigToWasm({ type: "hex_hexagon", radius: 3, orientation: "pointy_top" }),
      stages: [{ id: "stage_1", name: "Stage 1", rules: [] }],
      repair_max_iterations: 10,
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0 },
      preset_connections: [],
      locked_nodes: [],
    });
  });

  it("uses buildFreeConfig when isEditingField", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState({
      seed: 5,
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), square: pts },
      hexOrientation: "flat_top",
      triOrientation: "r0",
      rules: [],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].tessellation.tessellation_type).toBe("square");
    expect(call[1].tessellation.points).toHaveLength(3);
  });

  it("sets error when isEditingField and fieldPoints.size < 2", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: new Set([encodePoint(0, 0)]),
      freeFieldPoints: { ...emptyFreePoints(), square: new Set([encodePoint(0, 0)]) },
    });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().error).toBeTruthy();
    expect(generateMaze).not.toHaveBeenCalled();
  });

  it("sets error when isEditingField and fieldPoints.size === 0", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "free",
      hexShape: "parallelogram",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: new Set<number>(),
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().error).toBeTruthy();
    expect(generateMaze).not.toHaveBeenCalled();
  });

  it("stores error string on Error throw", () => {
    vi.mocked(generateMaze).mockImplementation(() => { throw new Error("bad wasm"); });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().error).toBe("bad wasm");
  });

  it("stores string error when non-Error thrown", () => {
    vi.mocked(generateMaze).mockImplementation(() => { throw "raw error"; });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().error).toBe("raw error");
  });

  it("clears selectedNode on generate", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({ selectedNode: 5 });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().selectedNode).toBeNull();
  });

  it("passes strategyParams overrides to generateMaze", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 10, height: 10 },
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "missing_endpoints", params: {} }], nextLocalCheckId: 1, strategyId: "scored_endpoints", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false }],
      strategyParams: { scored_endpoints: { path_weight: "2", junction_weight: "6" } },
      availableStrategies: [{
        id: "scored_endpoints",
        handles: "missing_endpoints",
        params: [
          { id: "path_weight", label: "Path length weight", kind: { type: "float", default: 1, min: 0, max: 100 } },
          { id: "junction_weight", label: "Junction weight", kind: { type: "float", default: 3, min: 0, max: 100 } },
        ],
        experimental: false,
        nested_slots: [],
      }],
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(42, {
      tessellation: fieldConfigToWasm({ type: "square", width: 10, height: 10 }),
      stages: [{
        id: "stage_1",
        name: "Stage 1",
        rules: [{
          id: "g1",
          checks: [{ local_id: "0", type_id: "missing_endpoints", params: {} }],
          strategy: { id: "scored_endpoints", params: { path_weight: "2", junction_weight: "6" } },
        }],
      }],
      repair_max_iterations: 10,
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0 },
      preset_connections: [],
      locked_nodes: [],
    });
  });

  it("omits strategyParams not in descriptor from generateMaze call", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "missing_endpoints", params: {} }], nextLocalCheckId: 1, strategyId: "scored_endpoints", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false }],
      strategyParams: { scored_endpoints: { unknown_param: "99" } },
      availableStrategies: [{
        id: "scored_endpoints",
        handles: "missing_endpoints",
        params: [
          { id: "path_weight", label: "Path length weight", kind: { type: "float", default: 1, min: 0, max: 100 } },
        ],
        experimental: false,
        nested_slots: [],
      }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    const rule = call[1].stages.flatMap((s) => s.rules).find((g) => g.id === "g1")!;
    expect(rule.strategy!.params).not.toHaveProperty("unknown_param");
    expect(rule.strategy!.params).not.toHaveProperty("path_weight");
  });

  it("sends rules with no strategy or disabled as strategy: null, not omitted", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      rules: [
        { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
        { id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: "some_strategy", disabled: true, ruleDisabled: false, nestedStrategies: [] },
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].stages.flatMap((s) => s.rules)).toEqual([
      { id: "g1", checks: [{ local_id: "0", type_id: "check_a", params: {} }], strategy: null },
      { id: "g2", checks: [{ local_id: "0", type_id: "check_b", params: {} }], strategy: null },
    ]);
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
      error: "something",
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

  it("preserves rules on repeated call", async () => {
    const checks = [
      { id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [], allow_multiple_instances: false },
      { id: "check_b", label: "Check B", description: "", issue_kinds: ["kind_b"], params: [], allow_multiple_instances: false },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "kind_b", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
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

  it("names the default rule after its issue kind's label, not a counter", async () => {
    const checks = [{ id: "missing_endpoints", label: "Missing endpoints", description: "", issue_kinds: ["missing_endpoints"], params: [], allow_multiple_instances: false }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().rules[0].name).toBe("Endpoint presence");
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

  it("sets error when initWasm rejects", async () => {
    vi.mocked(initWasm).mockRejectedValueOnce(new Error("wasm load failed"));
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().error).toBe("wasm load failed");
  });

  it("sets error string when initWasm rejects with non-Error", async () => {
    vi.mocked(initWasm).mockRejectedValueOnce("fatal");
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().error).toBe("fatal");
  });
});

describe("mazeStore.setStrategyParam", () => {
  it("stores param value keyed by strategyId", () => {
    useMazeStore.setState({ strategyParams: {} });
    useMazeStore.getState().setStrategyParam("scored_endpoints", "path_weight", "2.5");
    expect(useMazeStore.getState().strategyParams["scored_endpoints"]["path_weight"]).toBe("2.5");
  });

  it("merges params for same strategyId", () => {
    useMazeStore.setState({ strategyParams: {} });
    useMazeStore.getState().setStrategyParam("scored_endpoints", "path_weight", "2");
    useMazeStore.getState().setStrategyParam("scored_endpoints", "junction_weight", "6");
    const params = useMazeStore.getState().strategyParams["scored_endpoints"];
    expect(params["path_weight"]).toBe("2");
    expect(params["junction_weight"]).toBe("6");
  });

  it("keeps params for different strategyIds independent", () => {
    useMazeStore.setState({ strategyParams: {} });
    useMazeStore.getState().setStrategyParam("scored_endpoints", "path_weight", "2");
    useMazeStore.getState().setStrategyParam("farthest_endpoints", "path_weight", "9");
    expect(useMazeStore.getState().strategyParams["scored_endpoints"]["path_weight"]).toBe("2");
    expect(useMazeStore.getState().strategyParams["farthest_endpoints"]["path_weight"]).toBe("9");
  });

  it("overrides existing param value", () => {
    useMazeStore.setState({ strategyParams: { scored_endpoints: { path_weight: "1" } } });
    useMazeStore.getState().setStrategyParam("scored_endpoints", "path_weight", "5");
    expect(useMazeStore.getState().strategyParams["scored_endpoints"]["path_weight"]).toBe("5");
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
});

describe("mazeStore.addCheck", () => {
  const paramKind = { type: "integer" as const, default: 3, min: 1, max: 100 };
  const descriptor = { id: "min_loops", label: "Min loops", description: "", issue_kinds: ["missing_loops"], params: [{ id: "min_loops", label: "Min loops", kind: paramKind }], allow_multiple_instances: false };
  // No real check type sets `allow_multiple_instances: true` any more (GitHub issue #60's
  // multi-instance design was retired) — this synthetic descriptor exercises the store's
  // multi-instance-allowed branch in isolation, independent of which (if any) real check uses it.
  const multiInstanceDescriptor = { id: "multi_instance_test_check", label: "Multi-instance test check", description: "", issue_kinds: ["missing_loops"], params: [{ id: "min_loops", label: "Min loops", kind: paramKind }], allow_multiple_instances: true };

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
      rules: [{ id: "g1", name: "Rule 1", kind: "missing_loops", checks: [{ localId: 0, typeId: "multi_instance_test_check", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().addCheck("multi_instance_test_check", "g1");
    const typeIds = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.map((c) => c.typeId);
    expect(typeIds).toEqual(["multi_instance_test_check", "multi_instance_test_check"]);
  });

  it("is a no-op when the type is already active and allow_multiple_instances is false", () => {
    useMazeStore.setState({
      availableChecks: [descriptor],
      rules: [{ id: "g1", name: "Rule 1", kind: "missing_loops", checks: [{ localId: 0, typeId: "min_loops", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().addCheck("min_loops");
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].checks).toHaveLength(1);
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
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }, { localId: 1, typeId: "check_b", params: {} }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().removeCheck("g1", 0);
    const typeIds = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.map((c) => c.typeId);
    expect(typeIds).toEqual(["check_b"]);
  });

  it("preserves the remaining check's params after removal", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: { p: "5" } }, { localId: 1, typeId: "check_b", params: {} }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().removeCheck("g1", 1);
    const checkA = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0);
    expect(checkA?.params).toEqual({ p: "5" });
  });

  it("is no-op for a non-matching localId", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().removeCheck("g1", 99);
    const typeIds = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.map((c) => c.typeId);
    expect(typeIds).toEqual(["check_b"]);
  });

  it("removes the check from its rule, leaving an empty rule rather than dropping it", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().removeCheck("g1", 0);
    expect(useMazeStore.getState().rules).toEqual([{ id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }]);
  });

  it("removes only the check from a multi-check rule, keeping the rule", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }, { localId: 1, typeId: "check_b", params: {} }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().removeCheck("g1", 0);
    expect(useMazeStore.getState().rules).toEqual([{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 1, typeId: "check_b", params: {} }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }]);
  });
});

describe("mazeStore.setCheckParam", () => {
  it("stores param value on the targeted instance", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "min_loops", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().setCheckParam("g1", 0, "min_loops", "5");
    const check = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0);
    expect(check?.params.min_loops).toBe("5");
  });

  it("merges params for the same instance", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "min_loops", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().setCheckParam("g1", 0, "param_a", "1");
    useMazeStore.getState().setCheckParam("g1", 0, "param_b", "2");
    const check = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0);
    expect(check?.params.param_a).toBe("1");
    expect(check?.params.param_b).toBe("2");
  });

  it("overrides existing param value", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "min_loops", params: { min_loops: "1" } }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().setCheckParam("g1", 0, "min_loops", "9");
    const check = useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0);
    expect(check?.params.min_loops).toBe("9");
  });

  it("keeps params for different instances independent, even within the same rule", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }, { localId: 1, typeId: "check_a", params: {} }], nextLocalCheckId: 2, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
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
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().addCheck("check_a", "g1");
    expect(useMazeStore.getState().rules).toEqual([
      { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }, { localId: 1, typeId: "check_a", params: {} }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] },
    ]);
  });

  it("addCheck with a ruleId whose kind differs from the check's kind falls back to a new singleton rule", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k2"], params: [], allow_multiple_instances: false }],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
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
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
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
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k1", "k2"], params: [], allow_multiple_instances: false }],
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
      availableChecks: [{ id: "check_a", label: "A", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      rules: [],
    });
    useMazeStore.getState().addCheck("check_a");
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].checks.map((c) => c.typeId)).toEqual(["check_a"]);
  });

  it("createRule drops a typeId whose allow_multiple_instances is false and is already active elsewhere", () => {
    useMazeStore.setState({
      availableChecks: [
        { id: "check_a", label: "A", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
        { id: "check_b", label: "B", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
      ],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().createRule(["check_a", "check_b"], null);
    const rules = useMazeStore.getState().rules;
    expect(rules).toHaveLength(2);
    const newRule = rules.find((g) => g.id !== "g1")!;
    expect(newRule.checks.map((c) => c.typeId)).toEqual(["check_b"]);
  });

  it("removeCheckFromRule moves the check into a fresh singleton rule", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }, { localId: 1, typeId: "check_b", params: {} }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
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
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().renameRule("g1", "My custom rule");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.name).toBe("My custom rule");
  });

  it("removeRule removes the rule and its checks", () => {
    useMazeStore.setState({
      rules: [
        { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
        { id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false }],
    });
    useMazeStore.getState().removeRule("g1");
    expect(useMazeStore.getState().rules).toEqual([
      { id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
    ]);
  });

  it("removeRule scrubs the rule's id from whichever stage held it", () => {
    useMazeStore.setState({
      rules: [
        { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
        { id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false }],
    });
    useMazeStore.getState().removeRule("g1");
    expect(useMazeStore.getState().stages).toEqual([{ id: "stage_1", name: "Stage 1", ruleIds: ["g2"], disabled: false }]);
  });

  it("removeRule is a no-op for an unknown rule id", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().removeRule("missing");
    expect(useMazeStore.getState().rules).toHaveLength(1);
  });

  it("toggleRuleDisabled flips ruleDisabled independent of disabled", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    useMazeStore.getState().toggleRuleDisabled("g1");
    const g = useMazeStore.getState().rules.find((g) => g.id === "g1")!;
    expect(g.ruleDisabled).toBe(true);
    expect(g.disabled).toBe(false);
  });
});

describe("mazeStore.moveRule", () => {
  function makeRules() {
    return [
      { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
      { id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
      { id: "g3", name: "Rule 3", kind: "k1", checks: [{ localId: 0, typeId: "check_c", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
    ];
  }

  it("moves a rule up within its stage, swapping with its predecessor", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false }] });
    useMazeStore.getState().moveRule("g2", "up");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g2", "g1", "g3"]);
  });

  it("moves a rule down within its stage, swapping with its successor", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false }] });
    useMazeStore.getState().moveRule("g2", "down");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g1", "g3", "g2"]);
  });

  it("is a no-op moving the first rule of the first stage up", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false }] });
    useMazeStore.getState().moveRule("g1", "up");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g1", "g2", "g3"]);
  });

  it("is a no-op moving the last rule of the last stage down", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false }] });
    useMazeStore.getState().moveRule("g3", "down");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g1", "g2", "g3"]);
  });

  it("is a no-op for an unknown rule id", () => {
    useMazeStore.setState({ rules: makeRules(), stages: [{ id: "s1", name: "Stage 1", ruleIds: ["g1", "g2", "g3"], disabled: false }] });
    useMazeStore.getState().moveRule("missing", "up");
    expect(useMazeStore.getState().stages[0].ruleIds).toEqual(["g1", "g2", "g3"]);
  });

  it("moving down at a stage's end crosses into the next stage's front", () => {
    useMazeStore.setState({
      rules: makeRules(),
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false },
        { id: "s2", name: "Stage 2", ruleIds: ["g3"], disabled: false },
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
        { id: "s1", name: "Stage 1", ruleIds: ["g1"], disabled: false },
        { id: "s2", name: "Stage 2", ruleIds: ["g2", "g3"], disabled: false },
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
        { id: "s1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false },
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
        { id: "s1", name: "Stage 1", ruleIds: [], disabled: false },
        { id: "s2", name: "Stage 2", ruleIds: ["g1"], disabled: false },
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
    useMazeStore.setState({ stages: [{ id: "s1", name: "Stage 1", ruleIds: [], disabled: false }] });
    useMazeStore.getState().addStage();
    const stages = useMazeStore.getState().stages;
    expect(stages).toHaveLength(2);
    expect(stages[1].name).toBe("Stage 2");
    expect(stages[1].ruleIds).toEqual([]);
  });

  it("addStage does not reuse a name still present after a middle stage was removed", () => {
    useMazeStore.setState({
      stages: [
        { id: "s1", name: "Waypoints", ruleIds: [], disabled: false },
        { id: "s3", name: "Stage 3", ruleIds: [], disabled: false },
      ],
    });
    useMazeStore.getState().addStage();
    const stages = useMazeStore.getState().stages;
    expect(stages).toHaveLength(3);
    expect(stages[2].name).toBe("Stage 4");
  });

  it("renameStage sets the stage's name", () => {
    useMazeStore.setState({ stages: [{ id: "s1", name: "Stage 1", ruleIds: [], disabled: false }] });
    useMazeStore.getState().renameStage("s1", "My stage");
    expect(useMazeStore.getState().stages[0].name).toBe("My stage");
  });

  it("removeStage removes an empty stage when another stage remains", () => {
    useMazeStore.setState({
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: [], disabled: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false },
      ],
    });
    useMazeStore.getState().removeStage("s1");
    expect(useMazeStore.getState().stages.map((s) => s.id)).toEqual(["s2"]);
  });

  it("removeStage cascades: removes a non-empty stage along with its member rules", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: ["g1"], disabled: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false },
      ],
    });
    useMazeStore.getState().removeStage("s1");
    expect(useMazeStore.getState().stages.map((s) => s.id)).toEqual(["s2"]);
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("removeStage removes the sole remaining stage when empty (no minimum-stage invariant)", () => {
    useMazeStore.setState({ stages: [{ id: "s1", name: "Stage 1", ruleIds: [], disabled: false }] });
    useMazeStore.getState().removeStage("s1");
    expect(useMazeStore.getState().stages).toEqual([]);
  });

  it("moveStage swaps adjacent stages", () => {
    useMazeStore.setState({
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: [], disabled: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false },
      ],
    });
    useMazeStore.getState().moveStage("s2", "up");
    expect(useMazeStore.getState().stages.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("moveStage is a no-op at the global boundary", () => {
    useMazeStore.setState({
      stages: [
        { id: "s1", name: "Stage 1", ruleIds: [], disabled: false },
        { id: "s2", name: "Stage 2", ruleIds: [], disabled: false },
      ],
    });
    useMazeStore.getState().moveStage("s1", "up");
    expect(useMazeStore.getState().stages.map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});

describe("buildGenerateConfig — ruleDisabled exclusion", () => {
  it("excludes a ruleDisabled rule's checks entirely from its stage's rules", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      rules: [
        { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: true, nestedStrategies: [] },
        { id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].stages.flatMap((s) => s.rules)).toEqual([{ id: "g2", checks: [{ local_id: "0", type_id: "check_b", params: {} }], strategy: null }]);
  });
});

describe("buildGenerateConfig — preset_start/preset_finish", () => {
  it("includes preset_start and preset_finish when set inside the field", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 3, height: 3 },
      presetStart: [0, 0],
      presetFinish: [1, 1],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].preset_start).toEqual([0, 0]);
    expect(call[1].preset_finish).toEqual([1, 1]);
  });

  it("omits preset_start and preset_finish when unset", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 3, height: 3 },
      presetStart: null,
      presetFinish: null,
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].preset_start).toBeUndefined();
    expect(call[1].preset_finish).toBeUndefined();
  });

  it("omits preset_start and preset_finish when they fall outside the field", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 1, height: 1 },
      presetStart: [5, 5],
      presetFinish: [9, 9],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].preset_start).toBeUndefined();
    expect(call[1].preset_finish).toBeUndefined();
  });
});

describe("mazeStore generation misc actions", () => {
  it("setStrategy sets a strategy for a rule", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "missing_endpoints", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }] });
    useMazeStore.getState().setStrategy("g1", "scored_endpoints");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.strategyId).toBe("scored_endpoints");
  });

  it("setStrategy auto-fills a mandatory nested slot with the first compatible candidate", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "excessive_scc_count", checks: [{ localId: 0, typeId: "scc_count", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
      availableStrategies: [
        {
          id: "reduce_scc_count",
          handles: "excessive_scc_count",
          params: [{ id: "merge_priority", label: "Merge priority", kind: { type: "enum", options: ["smallest", "largest", "random"], default: "smallest" } }],
          experimental: false,
          nested_slots: [{ slot_id: "merge_target", kind: "region_needs_expansion", min: 1, max: 1 }],
        },
        {
          id: "expand_region_passage",
          handles: "region_needs_expansion",
          params: [{ id: "target_mode", label: "Target mode", kind: { type: "enum", options: ["largest", "smallest"], default: "largest" } }],
          experimental: false,
          nested_slots: [],
        },
      ],
    });
    useMazeStore.getState().setStrategy("g1", "reduce_scc_count");
    const rule = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(rule?.nestedStrategies).toEqual([
      { slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "largest" }, nested: [] },
    ]);
  });

  it("clearStrategy removes a strategy for a rule", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "missing_endpoints", params: {} }], nextLocalCheckId: 1, strategyId: "scored_endpoints", disabled: false, ruleDisabled: false, nestedStrategies: [] }] });
    useMazeStore.getState().clearStrategy("g1");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.strategyId).toBeNull();
  });

  const nestedTestStrategies = [
    {
      id: "reduce_scc_count",
      handles: "excessive_scc_count",
      params: [{ id: "merge_priority", label: "Merge priority", kind: { type: "enum" as const, options: ["smallest", "largest"], default: "smallest" } }],
      experimental: false,
      nested_slots: [{ slot_id: "merge_target", kind: "region_needs_expansion", min: 1, max: 1 }],
    },
    {
      id: "expand_region_passage",
      handles: "region_needs_expansion",
      params: [{ id: "target_mode", label: "Target mode", kind: { type: "enum" as const, options: ["largest", "smallest"], default: "largest" } }],
      experimental: false,
      nested_slots: [],
    },
    {
      id: "other_expand_strategy",
      handles: "region_needs_expansion",
      params: [],
      experimental: false,
      nested_slots: [],
    },
  ];

  function ruleWithReduceSccCount() {
    return {
      id: "g1", name: "Rule 1", kind: "excessive_scc_count",
      checks: [{ localId: 0, typeId: "scc_count", params: {} }], nextLocalCheckId: 1,
      strategyId: "reduce_scc_count", disabled: false, ruleDisabled: false,
      nestedStrategies: [{ slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "largest" }, nested: [] }],
    };
  }

  it("setNestedStrategy replaces the strategy filling a top-level slot with fresh defaults", () => {
    useMazeStore.setState({ rules: [ruleWithReduceSccCount()], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategy("g1", ["merge_target"], "other_expand_strategy");
    const rule = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(rule?.nestedStrategies).toEqual([
      { slotId: "merge_target", strategyId: "other_expand_strategy", params: {}, nested: [] },
    ]);
  });

  it("setNestedStrategy with null removes the slot's assignment entirely", () => {
    useMazeStore.setState({ rules: [ruleWithReduceSccCount()], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategy("g1", ["merge_target"], null);
    const rule = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(rule?.nestedStrategies).toEqual([]);
  });

  it("setNestedStrategy at an unknown path is a no-op (no matching parent to update)", () => {
    const rule = ruleWithReduceSccCount();
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategy("g1", ["no_such_slot", "deeper"], "other_expand_strategy");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.nestedStrategies).toEqual(rule.nestedStrategies);
  });

  it("setNestedStrategyParam updates a param on the nested strategy at the given path", () => {
    useMazeStore.setState({ rules: [ruleWithReduceSccCount()], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategyParam("g1", ["merge_target"], "target_mode", "smallest");
    const rule = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(rule?.nestedStrategies).toEqual([
      { slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "smallest" }, nested: [] },
    ]);
  });

  it("setNestedStrategyParam at a depth-2 path updates the correct nested node", () => {
    const rule = {
      id: "g1", name: "Rule 1", kind: "excessive_scc_count",
      checks: [{ localId: 0, typeId: "scc_count", params: {} }], nextLocalCheckId: 1,
      strategyId: "reduce_scc_count", disabled: false, ruleDisabled: false,
      nestedStrategies: [{
        slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "largest" },
        nested: [{ slotId: "inner_slot", strategyId: "other_expand_strategy", params: { foo: "bar" }, nested: [] }],
      }],
    };
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategyParam("g1", ["merge_target", "inner_slot"], "foo", "baz");
    const updated = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(updated?.nestedStrategies[0]?.nested).toEqual([
      { slotId: "inner_slot", strategyId: "other_expand_strategy", params: { foo: "baz" }, nested: [] },
    ]);
    // Sibling data at the parent level must be untouched by a deeper update.
    expect(updated?.nestedStrategies[0]?.params).toEqual({ target_mode: "largest" });
  });

  it("setNestedStrategyParam at an unknown slot id is a no-op", () => {
    const rule = ruleWithReduceSccCount();
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategyParam("g1", ["no_such_slot"], "target_mode", "smallest");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.nestedStrategies).toEqual(rule.nestedStrategies);
  });

  it("setEdgeBasedParam updates param when method is custom_edge_based", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_edge_based", corridor_length: 0.5, branching: 0.5, depth_first: 0.5, directionality: 0, cyclicity: 0 } });
    useMazeStore.getState().setEdgeBasedParam("corridor_length", 0.9);
    const cfg = useMazeStore.getState().initialConfig;
    expect(cfg.method).toBe("custom_edge_based");
    if (cfg.method === "custom_edge_based") expect(cfg.corridor_length).toBe(0.9);
  });

  it("setEdgeBasedParam is no-op when method is not custom_edge_based", () => {
    useMazeStore.setState({ initialConfig: { method: "recursive_backtracker" } });
    useMazeStore.getState().setEdgeBasedParam("corridor_length", 0.9);
    expect(useMazeStore.getState().initialConfig.method).toBe("recursive_backtracker");
  });

  it("setRandomSeed toggles flag", () => {
    useMazeStore.getState().setRandomSeed(true);
    expect(useMazeStore.getState().randomSeed).toBe(true);
  });

  it("setOpenCard switches card and clears preset highlights when leaving preset_connections", () => {
    useMazeStore.setState({ openCard: "preset_connections", highlightInvalidPresets: true, highlightIsolatedNodes: true });
    useMazeStore.getState().setOpenCard("generation");
    const s = useMazeStore.getState();
    expect(s.openCard).toBe("generation");
    expect(s.highlightInvalidPresets).toBe(false);
    expect(s.highlightIsolatedNodes).toBe(false);
  });

  it("setOpenCard keeps highlights when not leaving preset_connections", () => {
    useMazeStore.setState({ openCard: "generation", highlightInvalidPresets: true });
    useMazeStore.getState().setOpenCard("quality");
    expect(useMazeStore.getState().highlightInvalidPresets).toBe(true);
  });

  it("setDebugMode(false) clears debugStale", () => {
    useMazeStore.setState({ debugMode: true, debugStale: true });
    useMazeStore.getState().setDebugMode(false);
    const s = useMazeStore.getState();
    expect(s.debugMode).toBe(false);
    expect(s.debugStale).toBe(false);
  });

  it("setDebugMode(true) does not touch debugStale", () => {
    useMazeStore.setState({ debugMode: false, debugStale: true });
    useMazeStore.getState().setDebugMode(true);
    expect(useMazeStore.getState().debugStale).toBe(true);
  });

  it("setDebugStep / setDebugAutoPlayDelay / setShowDebugFrontier update their fields", () => {
    useMazeStore.getState().setDebugStep(3);
    useMazeStore.getState().setDebugAutoPlayDelay(500);
    useMazeStore.getState().setShowDebugFrontier(false);
    const s = useMazeStore.getState();
    expect(s.debugStep).toBe(3);
    expect(s.debugAutoPlayDelay).toBe(500);
    expect(s.showDebugFrontier).toBe(false);
  });

  it("regenerate is a no-op when lastUsedSeed is null", () => {
    useMazeStore.setState({ lastUsedSeed: null });
    useMazeStore.getState().regenerate();
    expect(generateMaze).not.toHaveBeenCalled();
  });

  it("regenerate calls generateMaze with the last used seed", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({ lastUsedSeed: 123, rules: [] });
    useMazeStore.getState().regenerate();
    expect(generateMaze).toHaveBeenCalledWith(123, expect.anything());
  });

  it("setError sets and clears the error message", () => {
    useMazeStore.getState().setError("boom");
    expect(useMazeStore.getState().error).toBe("boom");
    useMazeStore.getState().setError(null);
    expect(useMazeStore.getState().error).toBeNull();
  });
});

describe("mazeStore.qcExperiment toggle", () => {
  it("generate() calls generateMaze with qc_experiment true and locked_nodes cleared when qcExperiment is on", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      seed: 7,
      randomSeed: false,
      rules: [],
      qcExperiment: true,
      lockedNodes: new Map([["0,0", "both"]]),
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, expect.objectContaining({
      qc_experiment: true,
      locked_nodes: [],
    }));
  });

  it("setQcExperiment persists the toggle across generate() calls", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [] });
    useMazeStore.getState().setQcExperiment(true);
    expect(useMazeStore.getState().qcExperiment).toBe(true);
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().qcExperiment).toBe(true);
  });

  it("regenerate() also honors qcExperiment", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], lastUsedSeed: 7, qcExperiment: true });
    useMazeStore.getState().regenerate();
    expect(generateMaze).toHaveBeenCalledWith(7, expect.objectContaining({ qc_experiment: true }));
  });

  it("generate()/regenerate() record lastUsedQcExperiment from the toggle at call time", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], qcExperiment: true });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().lastUsedQcExperiment).toBe(true);

    useMazeStore.setState({ qcExperiment: false });
    useMazeStore.getState().regenerate();
    expect(useMazeStore.getState().lastUsedQcExperiment).toBe(false);
  });

  it("setQcExperiment marks debugStale when a debug snapshot exists", () => {
    useMazeStore.setState({ debugSnapshot: { nodes: [], steps: [] } });
    useMazeStore.getState().setQcExperiment(true);
    expect(useMazeStore.getState().debugStale).toBe(true);
  });

  it("setQcExperiment does not mark debugStale when there is no debug snapshot", () => {
    useMazeStore.setState({ debugSnapshot: null, debugStale: false });
    useMazeStore.getState().setQcExperiment(true);
    expect(useMazeStore.getState().debugStale).toBe(false);
  });
});

describe("buildExactGenerateCallPayload", () => {
  it("includes qc_experiment/locked_nodes overrides when lastUsedQcExperiment is true", () => {
    useMazeStore.setState({
      seed: 7,
      lastUsedSeed: 7,
      lastUsedQcExperiment: true,
      rules: [],
      lockedNodes: new Map([["0,0", "both"]]),
    });
    const payload = buildExactGenerateCallPayload(useMazeStore.getState);
    expect(payload?.config.qc_experiment).toBe(true);
    expect(payload?.config.locked_nodes).toEqual([]);
  });

  it("omits qc_experiment override when lastUsedQcExperiment is false", () => {
    useMazeStore.setState({
      seed: 7,
      lastUsedSeed: 7,
      lastUsedQcExperiment: false,
      rules: [],
    });
    const payload = buildExactGenerateCallPayload(useMazeStore.getState);
    expect(payload?.config.qc_experiment).toBeUndefined();
  });

  it("ignores a live qcExperiment toggle flipped after the last actual run", () => {
    useMazeStore.setState({
      seed: 7,
      lastUsedSeed: 7,
      lastUsedQcExperiment: false,
      qcExperiment: true,
      rules: [],
    });
    const payload = buildExactGenerateCallPayload(useMazeStore.getState);
    expect(payload?.config.qc_experiment).toBeUndefined();
  });
});
