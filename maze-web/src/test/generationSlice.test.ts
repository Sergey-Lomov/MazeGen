import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";
import { baseStoreState, emptyFreePoints, mockSnapshot } from "./storeTestHelpers";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { generateMaze, computeAnalytics, getAvailableChecks, getAvailableStrategies } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  vi.mocked(generateMaze).mockReset();
  vi.mocked(computeAnalytics).mockReset();
  vi.mocked(computeAnalytics).mockReturnValue(mockSnapshot);
  vi.mocked(initWasm).mockResolvedValue(undefined);
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
      selectedChecks: [],
      selectedStrategies: {},
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: { type: "square", width: 3, height: 4 },
      checks: [],
      strategies: {},
      check_params: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
      preset_connections: [],
    });
  });

  it("calls generateMaze with hex_parallelogram tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 6, orientation: "flat_top" },
      selectedChecks: [],
      selectedStrategies: {},
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: { type: "hex_parallelogram", cols: 5, rows: 6, orientation: "flat_top" },
      checks: [],
      strategies: {},
      check_params: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
      preset_connections: [],
    });
  });

  it("calls generateMaze with hex_hexagon tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "hex_hexagon", radius: 3, orientation: "pointy_top" },
      selectedChecks: [],
      selectedStrategies: {},
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: { type: "hex_hexagon", radius: 3, orientation: "pointy_top" },
      checks: [],
      strategies: {},
      check_params: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
      preset_connections: [],
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
      selectedChecks: [],
      selectedStrategies: {},
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
      selectedChecks: ["missing_endpoints"],
      selectedStrategies: { missing_endpoints: "scored_endpoints" },
      strategyParams: { scored_endpoints: { path_weight: "2", junction_weight: "6" } },
      availableStrategies: [{
        id: "scored_endpoints",
        handles: "missing_endpoints",
        params: [
          { id: "path_weight", label: "Path length weight", kind: { type: "float", default: 1, min: 0, max: 100 } },
          { id: "junction_weight", label: "Junction weight", kind: { type: "float", default: 3, min: 0, max: 100 } },
        ],
      }],
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(42, {
      tessellation: { type: "square", width: 10, height: 10 },
      checks: ["missing_endpoints"],
      strategies: {
        missing_endpoints: {
          id: "scored_endpoints",
          params: { path_weight: "2", junction_weight: "6" },
        },
      },
      check_params: {},
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04 },
      preset_connections: [],
    });
  });

  it("omits strategyParams not in descriptor from generateMaze call", () => {
    vi.mocked(generateMaze).mockReturnValue(mockSnapshot);
    useMazeStore.setState({
      selectedChecks: [],
      selectedStrategies: { missing_endpoints: "scored_endpoints" },
      strategyParams: { scored_endpoints: { unknown_param: "99" } },
      availableStrategies: [{
        id: "scored_endpoints",
        handles: "missing_endpoints",
        params: [
          { id: "path_weight", label: "Path length weight", kind: { type: "float", default: 1, min: 0, max: 100 } },
        ],
      }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    const strategies = call[1].strategies;
    expect(strategies["missing_endpoints"].params).not.toHaveProperty("unknown_param");
    expect(strategies["missing_endpoints"].params).not.toHaveProperty("path_weight");
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
    const checks = [{ id: "missing_endpoints", label: "Missing endpoints", description: "", issue_kinds: ["missing_endpoints"], params: [] }];
    const strategies = [{ id: "farthest_endpoints", handles: "missing_endpoints", params: [] }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().availableChecks).toEqual(checks);
    expect(useMazeStore.getState().availableStrategies).toEqual(strategies);
  });

  it("auto-selects checks without params", async () => {
    const checks = [
      { id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [] },
      { id: "check_b", label: "Check B", description: "", issue_kinds: ["kind_b"], params: [] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_a", "check_b"]);
  });

  it("does not auto-select checks with params", async () => {
    const paramKind = { type: "integer" as const, default: 1, min: 1, max: 100 };
    const checks = [
      { id: "check_no_params", label: "No params", description: "", issue_kinds: ["kind_a"], params: [] },
      { id: "check_with_params", label: "Has params", description: "", issue_kinds: ["kind_b"], params: [{ id: "p", label: "P", kind: paramKind }] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_no_params"]);
  });

  it("preserves selectedChecks on repeated call", async () => {
    const checks = [
      { id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [] },
      { id: "check_b", label: "Check B", description: "", issue_kinds: ["kind_b"], params: [] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    useMazeStore.setState({ selectedChecks: ["check_b"] });
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_b"]);
  });

  it("auto-selects first matching strategy per issue kind", async () => {
    const checks = [{ id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a"], params: [] }];
    const strategies = [
      { id: "strategy_first", handles: "kind_a", params: [] },
      { id: "strategy_second", handles: "kind_a", params: [] },
    ];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedStrategies["kind_a"]).toBe("strategy_first");
  });

  it("leaves issue kind without strategy unselected", async () => {
    const checks = [{ id: "check_a", label: "Check A", description: "", issue_kinds: ["kind_a", "kind_b"], params: [] }];
    const strategies = [{ id: "strategy_a", handles: "kind_a", params: [] }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue(strategies);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().selectedStrategies["kind_a"]).toBe("strategy_a");
    expect(useMazeStore.getState().selectedStrategies["kind_b"]).toBeUndefined();
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
  const descriptor = { id: "min_loops", label: "Min loops", description: "", issue_kinds: ["min_loops_count"], params: [{ id: "min_loops", label: "Min loops", kind: paramKind }] };

  it("adds check id to selectedChecks", () => {
    useMazeStore.setState({ availableChecks: [descriptor], selectedChecks: [] });
    useMazeStore.getState().addCheck("min_loops");
    expect(useMazeStore.getState().selectedChecks).toContain("min_loops");
  });

  it("is idempotent — does not add duplicate", () => {
    useMazeStore.setState({ availableChecks: [descriptor], selectedChecks: ["min_loops"] });
    useMazeStore.getState().addCheck("min_loops");
    expect(useMazeStore.getState().selectedChecks.filter((id) => id === "min_loops")).toHaveLength(1);
  });

  it("initializes checkParams from descriptor defaults when no prior entry", () => {
    useMazeStore.setState({ availableChecks: [descriptor], selectedChecks: [], checkParams: {} });
    useMazeStore.getState().addCheck("min_loops");
    expect(useMazeStore.getState().checkParams["min_loops"]["min_loops"]).toBe("3");
  });

  it("preserves existing checkParams when re-adding", () => {
    useMazeStore.setState({ availableChecks: [descriptor], selectedChecks: [], checkParams: { min_loops: { min_loops: "7" } } });
    useMazeStore.getState().addCheck("min_loops");
    expect(useMazeStore.getState().checkParams["min_loops"]["min_loops"]).toBe("7");
  });

  it("is no-op for unknown check id", () => {
    useMazeStore.setState({ availableChecks: [], selectedChecks: [] });
    useMazeStore.getState().addCheck("nonexistent");
    expect(useMazeStore.getState().selectedChecks).toEqual([]);
  });
});

describe("mazeStore.removeCheck", () => {
  it("removes check id from selectedChecks", () => {
    useMazeStore.setState({ selectedChecks: ["check_a", "check_b"] });
    useMazeStore.getState().removeCheck("check_a");
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_b"]);
  });

  it("preserves checkParams after removal", () => {
    useMazeStore.setState({ selectedChecks: ["check_a"], checkParams: { check_a: { p: "5" } } });
    useMazeStore.getState().removeCheck("check_a");
    expect(useMazeStore.getState().checkParams["check_a"]).toEqual({ p: "5" });
  });

  it("is no-op for non-selected id", () => {
    useMazeStore.setState({ selectedChecks: ["check_b"] });
    useMazeStore.getState().removeCheck("check_a");
    expect(useMazeStore.getState().selectedChecks).toEqual(["check_b"]);
  });
});

describe("mazeStore.setCheckParam", () => {
  it("stores param value keyed by checkId", () => {
    useMazeStore.setState({ checkParams: {} });
    useMazeStore.getState().setCheckParam("min_loops", "min_loops", "5");
    expect(useMazeStore.getState().checkParams["min_loops"]["min_loops"]).toBe("5");
  });

  it("merges params for same checkId", () => {
    useMazeStore.setState({ checkParams: {} });
    useMazeStore.getState().setCheckParam("min_loops", "param_a", "1");
    useMazeStore.getState().setCheckParam("min_loops", "param_b", "2");
    expect(useMazeStore.getState().checkParams["min_loops"]["param_a"]).toBe("1");
    expect(useMazeStore.getState().checkParams["min_loops"]["param_b"]).toBe("2");
  });

  it("overrides existing param value", () => {
    useMazeStore.setState({ checkParams: { min_loops: { min_loops: "1" } } });
    useMazeStore.getState().setCheckParam("min_loops", "min_loops", "9");
    expect(useMazeStore.getState().checkParams["min_loops"]["min_loops"]).toBe("9");
  });

  it("keeps params for different checkIds independent", () => {
    useMazeStore.setState({ checkParams: {} });
    useMazeStore.getState().setCheckParam("check_a", "p", "1");
    useMazeStore.getState().setCheckParam("check_b", "p", "2");
    expect(useMazeStore.getState().checkParams["check_a"]["p"]).toBe("1");
    expect(useMazeStore.getState().checkParams["check_b"]["p"]).toBe("2");
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

describe("mazeStore generation misc actions", () => {
  it("setStrategy sets a strategy for an issue kind", () => {
    useMazeStore.getState().setStrategy("missing_endpoints", "scored_endpoints");
    expect(useMazeStore.getState().selectedStrategies.missing_endpoints).toBe("scored_endpoints");
  });

  it("clearStrategy removes a strategy for an issue kind", () => {
    useMazeStore.setState({ selectedStrategies: { missing_endpoints: "scored_endpoints" } });
    useMazeStore.getState().clearStrategy("missing_endpoints");
    expect(useMazeStore.getState().selectedStrategies).not.toHaveProperty("missing_endpoints");
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
    useMazeStore.setState({ lastUsedSeed: 123, selectedChecks: [], selectedStrategies: {} });
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
