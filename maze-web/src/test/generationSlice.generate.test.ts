import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";
import { fieldConfigToWasm, resolveAlgorithmKind } from "../store/slices/generationSlice";
import { baseStoreState, emptyFreePoints, mockSnapshot, mockGenerateMazeResult, resetGenerationMocks, makeRule } from "./storeTestHelpers";
import type { DebugArenaHandle } from "../store/storeTypes";

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

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  resetGenerationMocks(vi.mocked(generateMaze), vi.mocked(computeAnalytics), vi.mocked(initWasm));
});

function source(kind: DebugArenaHandle["algorithmKind"]): DebugArenaHandle["sources"][number] {
  return { scopeName: kind, kind, nodeIndex: 0, startStep: 0, endStep: 0, checkpointFroms: [] };
}

describe("resolveAlgorithmKind", () => {
  it("returns the only source's kind when there's no preset setup or QC", () => {
    expect(resolveAlgorithmKind([source("kruskal")])).toBe("kruskal");
  });

  it("GitHub issue #227: skips a preceding preset_setup source and returns generation's own kind", () => {
    expect(resolveAlgorithmKind([source("preset_setup"), source("kruskal")])).toBe("kruskal");
  });

  it("skips both a preceding preset_setup source and a trailing QC source", () => {
    expect(resolveAlgorithmKind([source("preset_setup"), source("wilson"), source("quality_control")])).toBe("wilson");
  });

  it("qc_experiment run (GitHub issue #173, no generation source): falls back to quality_control, not the first source", () => {
    expect(resolveAlgorithmKind([source("preset_setup"), source("quality_control")])).toBe("quality_control");
  });

  it("qc_experiment run with no preset setup either: single quality_control source", () => {
    expect(resolveAlgorithmKind([source("quality_control")])).toBe("quality_control");
  });
});

describe("mazeStore.generate", () => {
  it("stores snapshot on success", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.nodes).toEqual(mockSnapshot.nodes);
    expect(s.edges).toEqual(mockSnapshot.edges);
    expect(s.start).toBe(0);
    expect(s.finish).toBe(1);
    expect(s.error).toBeNull();
    expect(s.selectedNode).toBeNull();
  });

  it("derives postEditDraftSplitPoints from a snapshot with an auto-split point (GitHub issue #222)", () => {
    vi.mocked(generateMaze).mockReturnValue({
      snapshot: {
        ...mockSnapshot,
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: 1, y: 0, i: 1 }],
      },
      debugTape: undefined,
    });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints).toEqual({ "1,0": [0] });
  });

  it("calls generateMaze with current seed and tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "square", width: 3, height: 4 },
      rules: [],
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: fieldConfigToWasm({ type: "square", width: 3, height: 4 }),
      stages: [{ id: "stage_1", name: "Stage 1", rules: [] }],
      repair_max_iterations: 100,
      repair_time_budget_secs: 10,
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0, split_chance: 0 },
      preset_connections: [],
      locked_nodes: [],
      split_points: [],
      split_generation: { pattern_mode: false, max_split_nodes: 2, patterns: [] },
    });
  });

  it("sends a locked node as a PresetEndpointDto-shaped point, not a nested object", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "square", width: 3, height: 4 },
      rules: [],
      lockedNodes: new Map([["1,2", "both"]]),
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, expect.objectContaining({
      locked_nodes: [{ point: { point: [1, 2] }, kind: "both" }],
    }));
    useMazeStore.setState({ lockedNodes: new Map() });
  });

  it("calls generateMaze with hex_parallelogram tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 6, orientation: "flat_top" },
      rules: [],
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: fieldConfigToWasm({ type: "hex_parallelogram", cols: 5, rows: 6, orientation: "flat_top" }),
      stages: [{ id: "stage_1", name: "Stage 1", rules: [] }],
      repair_max_iterations: 100,
      repair_time_budget_secs: 10,
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0, split_chance: 0 },
      preset_connections: [],
      locked_nodes: [],
      split_points: [],
      split_generation: { pattern_mode: false, max_split_nodes: 2, patterns: [] },
    });
  });

  it("calls generateMaze with hex_hexagon tessellationConfig", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      seed: 7,
      tessellationConfig: { type: "hex_hexagon", radius: 3, orientation: "pointy_top" },
      rules: [],
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, {
      tessellation: fieldConfigToWasm({ type: "hex_hexagon", radius: 3, orientation: "pointy_top" }),
      stages: [{ id: "stage_1", name: "Stage 1", rules: [] }],
      repair_max_iterations: 100,
      repair_time_budget_secs: 10,
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0, split_chance: 0 },
      preset_connections: [],
      locked_nodes: [],
      split_points: [],
      split_generation: { pattern_mode: false, max_split_nodes: 2, patterns: [] },
    });
  });

  it("uses buildFreeConfig when isEditingField", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
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
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ selectedNode: 5 });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().selectedNode).toBeNull();
  });

  it("passes strategyParams overrides to generateMaze", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 10, height: 10 },
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "missing_endpoints", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "scored_endpoints" })],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false, collapsed: false }],
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
          params: {},
        }],
      }],
      repair_max_iterations: 100,
      repair_time_budget_secs: 10,
      initial: expect.objectContaining({ method: "custom_vertex_based" }),
      elements: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0, split_chance: 0 },
      preset_connections: [],
      locked_nodes: [],
      split_points: [],
      split_generation: { pattern_mode: false, max_split_nodes: 2, patterns: [] },
    });
  });

  it("omits strategyParams not in descriptor from generateMaze call", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "missing_endpoints", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "scored_endpoints" })],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false, collapsed: false }],
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

  it("forwards a nested strategy's weight param_override even though it's not a declared param", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      rules: [{
        id: "g1", name: "Rule 1", kind: "region_needs_expansion",
        checks: [{ localId: 0, typeId: "min_region_size", params: {}, disabled: false }], nextLocalCheckId: 1,
        strategyId: "weighted_region_merge", disabled: false, ruleDisabled: false,
        params: {}, nestedStrategies: [
          { slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "largest", weight: "3.0" }, nested: [] },
          { slotId: "merge_target", strategyId: "teleport_region_merge", params: { weight: "1.0" }, nested: [] },
        ],
        collapsed: false,
      }],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false, collapsed: false }],
      availableStrategies: [
        {
          id: "weighted_region_merge",
          handles: "region_needs_expansion",
          params: [],
          experimental: false,
          nested_slots: [{ slot_id: "merge_target", kind: "region_needs_expansion", min: 1, max: null, dispatch_kind: "weighted" }],
        },
        {
          id: "expand_region_passage",
          handles: "region_needs_expansion",
          params: [{ id: "target_mode", label: "Target mode", kind: { type: "enum", options: ["largest", "smallest"], default: "largest" } }],
          experimental: false,
          nested_slots: [],
        },
        {
          id: "teleport_region_merge",
          handles: "region_needs_expansion",
          params: [],
          experimental: false,
          nested_slots: [],
        },
      ],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    const rule = call[1].stages.flatMap((s) => s.rules).find((g) => g.id === "g1")!;
    expect(rule.strategy!.nested).toEqual([
      { id: "expand_region_passage", params: { target_mode: "largest", weight: "3.0" }, slot_id: "merge_target", nested: [] },
      { id: "teleport_region_merge", params: { weight: "1.0" }, slot_id: "merge_target", nested: [] },
    ]);
  });

  it("sends rules with no strategy or disabled as strategy: null, not omitted", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      rules: [
        makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null }),
        { id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "some_strategy", disabled: true, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false },
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false, collapsed: false }],
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].stages.flatMap((s) => s.rules)).toEqual([
      { id: "g1", checks: [{ local_id: "0", type_id: "check_a", params: {} }], strategy: null, params: {} },
      { id: "g2", checks: [{ local_id: "0", type_id: "check_b", params: {} }], strategy: null, params: {} },
    ]);
  });
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

  it("names the default rule after its issue kind's label, not a counter", async () => {
    const checks = [{ id: "missing_endpoints", label: "Missing endpoints", description: "", issue_kinds: ["missing_endpoints"], params: [], allow_multiple_instances: false }];
    vi.mocked(getAvailableChecks).mockReturnValue(checks);
    vi.mocked(getAvailableStrategies).mockReturnValue([]);
    await useMazeStore.getState().loadRegistry();
    expect(useMazeStore.getState().rules[0].name).toBe("Add waypoints");
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
