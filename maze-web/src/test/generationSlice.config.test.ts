import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { buildExactGenerateCallPayload } from "../store/slices/generationSlice";
import { serializeProject } from "../store/projectExport";
import { DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportSlice";
import { baseStoreState, mockSnapshot, mockGenerateMazeResult, resetGenerationMocks, encodeEdgeAddedTape, makeRule } from "./storeTestHelpers";
import { parseTape } from "../debug/eventTape";
import type { DebugArenaHandle } from "../store/storeTypes";

function emptyDebugArena(): DebugArenaHandle {
  return {
    tape: parseTape(new Uint8Array(0), new Uint8Array(0)), algorithmKind: "recursive_backtracker",
    sources: [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 0, startStep: 0, endStep: 0, checkpointFroms: [] }],
    nodes: [], allNodes: [], totalSteps: 0, debugValueNames: [],
  };
}

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

import { generateMaze, computeAnalytics } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  resetGenerationMocks(vi.mocked(generateMaze), vi.mocked(computeAnalytics), vi.mocked(initWasm));
});

describe("buildGenerateConfig — preset_start/preset_finish", () => {
  it("includes preset_start and preset_finish when set inside the field", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 3, height: 3 },
      presetStart: presetEndpoint([0, 0]),
      presetFinish: presetEndpoint([1, 1]),
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].preset_start).toEqual({ point: [0, 0] });
    expect(call[1].preset_finish).toEqual({ point: [1, 1] });
  });

  it("omits preset_start and preset_finish when unset", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
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
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      tessellationConfig: { type: "square", width: 1, height: 1 },
      presetStart: presetEndpoint([5, 5]),
      presetFinish: presetEndpoint([9, 9]),
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].preset_start).toBeUndefined();
    expect(call[1].preset_finish).toBeUndefined();
  });
});

describe("mazeStore generation misc actions", () => {
  it("setStrategy sets a strategy for a rule", () => {
    useMazeStore.setState({ rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "missing_endpoints", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null })] });
    useMazeStore.getState().setStrategy("g1", "scored_endpoints");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.strategyId).toBe("scored_endpoints");
  });

  it("setStrategy auto-fills a mandatory nested slot with the first compatible candidate", () => {
    useMazeStore.setState({
      rules: [makeRule({ id: "g1", name: "Rule 1", kind: "excessive_scc_count", checks: [{ localId: 0, typeId: "scc_count", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null })],
      availableStrategies: [
        {
          id: "reduce_scc_count",
          handles: "excessive_scc_count",
          params: [{ id: "merge_priority", label: "Merge priority", kind: { type: "enum", options: ["smallest", "largest", "random"], default: "smallest" } }],
          experimental: false,
          nested_slots: [{ slot_id: "merge_target", kind: "region_needs_expansion", min: 1, max: 1, dispatch_kind: "unordered" }],
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
    useMazeStore.setState({ rules: [makeRule({ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "missing_endpoints", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "scored_endpoints" })] });
    useMazeStore.getState().clearStrategy("g1");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.strategyId).toBeNull();
  });

  const nestedTestStrategies = [
    {
      id: "reduce_scc_count",
      handles: "excessive_scc_count",
      params: [{ id: "merge_priority", label: "Merge priority", kind: { type: "enum" as const, options: ["smallest", "largest"], default: "smallest" } }],
      experimental: false,
      nested_slots: [{ slot_id: "merge_target", kind: "region_needs_expansion", min: 1, max: 1, dispatch_kind: "unordered" as const }],
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
      checks: [{ localId: 0, typeId: "scc_count", params: {}, disabled: false }], nextLocalCheckId: 1,
      strategyId: "reduce_scc_count", disabled: false, ruleDisabled: false, params: {},
      nestedStrategies: [{ slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "largest" }, nested: [] }],
      collapsed: false,
    };
  }

  it("setNestedStrategy replaces the strategy filling a top-level slot with fresh defaults", () => {
    useMazeStore.setState({ rules: [ruleWithReduceSccCount()], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategy("g1", [{ slotId: "merge_target", index: 0 }], "other_expand_strategy");
    const rule = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(rule?.nestedStrategies).toEqual([
      { slotId: "merge_target", strategyId: "other_expand_strategy", params: {}, nested: [] },
    ]);
  });

  it("setNestedStrategy with null removes the slot's assignment entirely", () => {
    useMazeStore.setState({ rules: [ruleWithReduceSccCount()], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategy("g1", [{ slotId: "merge_target", index: 0 }], null);
    const rule = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(rule?.nestedStrategies).toEqual([]);
  });

  it("setNestedStrategy at an unknown path is a no-op (no matching parent to update)", () => {
    const rule = ruleWithReduceSccCount();
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategy("g1", [{ slotId: "no_such_slot", index: 0 }, { slotId: "deeper", index: 0 }], "other_expand_strategy");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.nestedStrategies).toEqual(rule.nestedStrategies);
  });

  it("setNestedStrategy at an out-of-range index is a no-op", () => {
    const rule = ruleWithReduceSccCount();
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategy("g1", [{ slotId: "merge_target", index: 1 }], "other_expand_strategy");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.nestedStrategies).toEqual(rule.nestedStrategies);
  });

  it("setNestedStrategyParam updates a param on the nested strategy at the given path", () => {
    useMazeStore.setState({ rules: [ruleWithReduceSccCount()], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategyParam("g1", [{ slotId: "merge_target", index: 0 }], "target_mode", "smallest");
    const rule = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(rule?.nestedStrategies).toEqual([
      { slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "smallest" }, nested: [] },
    ]);
  });

  it("setNestedStrategyParam at a depth-2 path updates the correct nested node", () => {
    const rule = {
      id: "g1", name: "Rule 1", kind: "excessive_scc_count",
      checks: [{ localId: 0, typeId: "scc_count", params: {}, disabled: false }], nextLocalCheckId: 1,
      strategyId: "reduce_scc_count", disabled: false, ruleDisabled: false, params: {},
      nestedStrategies: [{
        slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "largest" },
        nested: [{ slotId: "inner_slot", strategyId: "other_expand_strategy", params: { foo: "bar" }, nested: [] }],
      }],
      collapsed: false,
    };
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().setNestedStrategyParam("g1", [{ slotId: "merge_target", index: 0 }, { slotId: "inner_slot", index: 0 }], "foo", "baz");
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
    useMazeStore.getState().setNestedStrategyParam("g1", [{ slotId: "no_such_slot", index: 0 }], "target_mode", "smallest");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.nestedStrategies).toEqual(rule.nestedStrategies);
  });

  it("addNestedStrategy appends a second entry to a multi-slot without touching the first", () => {
    useMazeStore.setState({ rules: [ruleWithReduceSccCount()], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().addNestedStrategy("g1", [{ slotId: "merge_target", index: 0 }], "region_needs_expansion");
    const rule = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(rule?.nestedStrategies).toEqual([
      { slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "largest" }, nested: [] },
      { slotId: "merge_target", strategyId: "expand_region_passage", params: { target_mode: "largest" }, nested: [] },
    ]);
  });

  it("addNestedStrategy is a no-op when no strategy handles the given kind", () => {
    const rule = ruleWithReduceSccCount();
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().addNestedStrategy("g1", [{ slotId: "merge_target", index: 0 }], "no_such_kind");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.nestedStrategies).toEqual(rule.nestedStrategies);
  });

  it("removeNestedStrategy removes exactly the addressed entry, shifting later siblings down", () => {
    const rule = {
      id: "g1", name: "Rule 1", kind: "excessive_scc_count",
      checks: [{ localId: 0, typeId: "scc_count", params: {}, disabled: false }], nextLocalCheckId: 1,
      strategyId: "reduce_scc_count", disabled: false, ruleDisabled: false, params: {},
      nestedStrategies: [
        { slotId: "merge_target", strategyId: "expand_region_passage", params: { tag: "first" }, nested: [] },
        { slotId: "merge_target", strategyId: "other_expand_strategy", params: { tag: "second" }, nested: [] },
      ],
      collapsed: false,
    };
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().removeNestedStrategy("g1", [{ slotId: "merge_target", index: 0 }]);
    const updated = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(updated?.nestedStrategies).toEqual([
      { slotId: "merge_target", strategyId: "other_expand_strategy", params: { tag: "second" }, nested: [] },
    ]);
  });

  it("removeNestedStrategy at an out-of-range index is a no-op", () => {
    const rule = ruleWithReduceSccCount();
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().removeNestedStrategy("g1", [{ slotId: "merge_target", index: 1 }]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.nestedStrategies).toEqual(rule.nestedStrategies);
  });

  it("moveNestedStrategy 'up' swaps the entry with its immediate previous sibling", () => {
    const rule = {
      id: "g1", name: "Rule 1", kind: "region_needs_expansion",
      checks: [], nextLocalCheckId: 0,
      strategyId: "priority_region_merge", disabled: false, ruleDisabled: false, params: {},
      nestedStrategies: [
        { slotId: "merge_target", strategyId: "expand_region_passage", params: { tag: "first" }, nested: [] },
        { slotId: "merge_target", strategyId: "other_expand_strategy", params: { tag: "second" }, nested: [] },
      ],
      collapsed: false,
    };
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().moveNestedStrategy("g1", [{ slotId: "merge_target", index: 1 }], "up");
    const updated = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(updated?.nestedStrategies).toEqual([
      { slotId: "merge_target", strategyId: "other_expand_strategy", params: { tag: "second" }, nested: [] },
      { slotId: "merge_target", strategyId: "expand_region_passage", params: { tag: "first" }, nested: [] },
    ]);
  });

  it("moveNestedStrategy 'down' swaps the entry with its immediate next sibling", () => {
    const rule = {
      id: "g1", name: "Rule 1", kind: "region_needs_expansion",
      checks: [], nextLocalCheckId: 0,
      strategyId: "priority_region_merge", disabled: false, ruleDisabled: false, params: {},
      nestedStrategies: [
        { slotId: "merge_target", strategyId: "expand_region_passage", params: { tag: "first" }, nested: [] },
        { slotId: "merge_target", strategyId: "other_expand_strategy", params: { tag: "second" }, nested: [] },
      ],
      collapsed: false,
    };
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().moveNestedStrategy("g1", [{ slotId: "merge_target", index: 0 }], "down");
    const updated = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(updated?.nestedStrategies).toEqual([
      { slotId: "merge_target", strategyId: "other_expand_strategy", params: { tag: "second" }, nested: [] },
      { slotId: "merge_target", strategyId: "expand_region_passage", params: { tag: "first" }, nested: [] },
    ]);
  });

  it("moveNestedStrategy is a no-op when there's no sibling in that direction", () => {
    const rule = {
      id: "g1", name: "Rule 1", kind: "region_needs_expansion",
      checks: [], nextLocalCheckId: 0,
      strategyId: "priority_region_merge", disabled: false, ruleDisabled: false, params: {},
      nestedStrategies: [
        { slotId: "merge_target", strategyId: "expand_region_passage", params: { tag: "first" }, nested: [] },
        { slotId: "merge_target", strategyId: "other_expand_strategy", params: { tag: "second" }, nested: [] },
      ],
      collapsed: false,
    };
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().moveNestedStrategy("g1", [{ slotId: "merge_target", index: 0 }], "up");
    useMazeStore.getState().moveNestedStrategy("g1", [{ slotId: "merge_target", index: 1 }], "down");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.nestedStrategies).toEqual(rule.nestedStrategies);
  });

  it("moveNestedStrategy with a stale path is a no-op", () => {
    const rule = ruleWithReduceSccCount();
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().moveNestedStrategy("g1", [{ slotId: "no_such_slot", index: 0 }], "up");
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.nestedStrategies).toEqual(rule.nestedStrategies);
  });

  it("moveNestedStrategy at a nested depth swaps siblings within the addressed parent's own list", () => {
    const rule = {
      id: "g1", name: "Rule 1", kind: "region_needs_expansion",
      checks: [], nextLocalCheckId: 0,
      strategyId: "priority_region_merge", disabled: false, ruleDisabled: false, params: {},
      nestedStrategies: [
        {
          slotId: "merge_target", strategyId: "expand_region_passage", params: {},
          nested: [
            { slotId: "inner_slot", strategyId: "a", params: {}, nested: [] },
            { slotId: "inner_slot", strategyId: "b", params: {}, nested: [] },
          ],
        },
      ],
      collapsed: false,
    };
    useMazeStore.setState({ rules: [rule], availableStrategies: nestedTestStrategies });
    useMazeStore.getState().moveNestedStrategy("g1", [{ slotId: "merge_target", index: 0 }, { slotId: "inner_slot", index: 0 }], "down");
    const updated = useMazeStore.getState().rules.find((g) => g.id === "g1");
    expect(updated?.nestedStrategies[0].nested).toEqual([
      { slotId: "inner_slot", strategyId: "b", params: {}, nested: [] },
      { slotId: "inner_slot", strategyId: "a", params: {}, nested: [] },
    ]);
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

  it("setDebugStep / setDebugAutoPlayDelay update their fields", () => {
    useMazeStore.getState().setDebugStep(3);
    useMazeStore.getState().setDebugAutoPlayDelay(500);
    const s = useMazeStore.getState();
    expect(s.debugStep).toBe(3);
    expect(s.debugAutoPlayDelay).toBe(500);
  });

  it("setDebugStep(step, false) skips the floor auto-switch, but a later plain setDebugStep(step) applies it (GitHub issue #350 flicker fix)", () => {
    const debugTape = encodeEdgeAddedTape([[0n, 1n]]); // matches mockSnapshot.nodes' ids (0, 1)
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({
      seed: 7, randomSeed: false, rules: [], debugMode: true,
      floors: [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }],
      activeFloorId: "floor_0",
    });
    useMazeStore.getState().generate();
    // Both edge endpoints on floor 1 (index 1) — nodes come from `mockSnapshot`, which carries no
    // `level`, so patched in directly (mirrors `debugSelectors.test.ts`'s own fixture pattern).
    useMazeStore.setState((s) => ({
      debugArena: s.debugArena && {
        ...s.debugArena,
        nodes: s.debugArena.nodes.map((n) => ({ ...n, level: 1 })),
      },
    }));

    useMazeStore.getState().setDebugStep(0, false);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_0");

    useMazeStore.getState().setDebugStep(0);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_1");
  });

  it("setDebugStep respects debugAutoSwitchFloor — off disables every trigger, not just the scrubber drag", () => {
    const debugTape = encodeEdgeAddedTape([[0n, 1n]]);
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({
      seed: 7, randomSeed: false, rules: [], debugMode: true,
      floors: [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }],
      activeFloorId: "floor_0",
      debugAutoSwitchFloor: false,
    });
    useMazeStore.getState().generate();
    useMazeStore.setState((s) => ({
      debugArena: s.debugArena && {
        ...s.debugArena,
        nodes: s.debugArena.nodes.map((n) => ({ ...n, level: 1 })),
      },
    }));

    // A plain (non-scrubber) setDebugStep call, `switchFloor` left at its default `true` — still
    // no switch, since the user-facing toggle overrides it.
    useMazeStore.getState().setDebugStep(0);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_0");

    useMazeStore.getState().toggleDebugAutoSwitchFloor();
    useMazeStore.getState().setDebugStep(0);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_1");
  });

  it("generate() with debugMode on and a debug tape builds a debugArena and sets debugStep to the last step", () => {
    const debugTape = encodeEdgeAddedTape([[1n, 2n], [2n, 3n], [3n, 4n]]);
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, expect.objectContaining({ debug_events: true }));
    const s = useMazeStore.getState();
    expect(s.debugArena).not.toBeNull();
    expect(s.debugArena?.totalSteps).toBe(3);
    expect(s.debugStep).toBe(2);
  });

  it("generate() with debugMode on and a long-enough tape resolves a web-computed snapshot into debugArena.checkpointFroms (GitHub issue #128)", () => {
    // Snapshots are now computed entirely on the web side (`resolveDebugArenaMetadata`) every
    // CHECKPOINT_INTERVAL (500) mutating events — a 1000-edge chain crosses that threshold once.
    const edges: [bigint, bigint][] = Array.from({ length: 1000 }, (_, i) => [BigInt(i + 1), BigInt(i + 2)]);
    const debugTape = encodeEdgeAddedTape(edges);
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.debugArena?.sources[0].checkpointFroms.map((f) => f.step)).toEqual([499, 999]);
  });

  it("generate() with debugMode on but a tape with zero mutating events still builds a (zero-step) debugArena (GitHub issue #173)", () => {
    // A source scope always exists even with zero mutating events (the tape's own root scope
    // node) — the debug panel should render a single static frame rather than not appear at all.
    const debugTape = encodeEdgeAddedTape([]);
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.debugArena).not.toBeNull();
    expect(s.debugArena?.totalSteps).toBe(0);
    expect(s.debugStep).toBe(0);
  });

  it("generate() with debugMode on but no debug tape (algorithm not instrumented) leaves debugArena null", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.debugArena).toBeNull();
    expect(s.debugStep).toBe(0);
  });

  it("generate() with debugMode off does not set debug_events on the config, even with a tape available", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: false });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, expect.not.objectContaining({ debug_events: true }));
    expect(useMazeStore.getState().debugArena).toBeNull();
  });

  it("loadProject clamps the restored debugStep to the freshly regenerated arena's last step", () => {
    const debugTape = encodeEdgeAddedTape([[1n, 2n], [2n, 3n]]); // totalSteps = 2, lastStep = 1
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    const file = serializeProject(useMazeStore.getState());
    file.debug = { ...file.debug, debugMode: true, debugStep: 99 }; // saved step beyond this run's range
    useMazeStore.getState().loadProject(file);
    expect(useMazeStore.getState().debugStep).toBe(1);
  });

  it("loadProject restores the saved debugStep as-is when it's within the regenerated arena's range", () => {
    const debugTape = encodeEdgeAddedTape([[1n, 2n], [2n, 3n], [3n, 4n]]); // totalSteps = 3, lastStep = 2
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    const file = serializeProject(useMazeStore.getState());
    file.debug = { ...file.debug, debugMode: true, debugStep: 1 };
    useMazeStore.getState().loadProject(file);
    expect(useMazeStore.getState().debugStep).toBe(1);
  });

  it("loadProject restores vectorByCorridorsSettings/vectorByCorridorsSectionsExpanded from the saved file", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [] });
    const file = serializeProject(useMazeStore.getState());
    file.imageExport = {
      ...file.imageExport,
      vectorByCorridorsSettings: { ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, color: 0x123456, thickness: 12, join: "miter" },
      vectorByCorridorsSectionsExpanded: { cells: true },
    };
    useMazeStore.getState().loadProject(file);
    expect(useMazeStore.getState().vectorByCorridorsSettings).toEqual({
      ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
      color: 0x123456,
      thickness: 12,
      join: "miter",
    });
    expect(useMazeStore.getState().vectorByCorridorsSectionsExpanded).toEqual({ cells: true });
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
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
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
      split_points: [],
      split_generation: { pattern_mode: false, max_split_nodes: 2, patterns: [] },
    }));
  });

  it("setQcExperiment persists the toggle across generate() calls", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [] });
    useMazeStore.getState().setQcExperiment(true);
    expect(useMazeStore.getState().qcExperiment).toBe(true);
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().qcExperiment).toBe(true);
  });

  it("generate() records lastUsedQcExperiment from the toggle at call time", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], qcExperiment: true });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().lastUsedQcExperiment).toBe(true);

    useMazeStore.setState({ qcExperiment: false });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().lastUsedQcExperiment).toBe(false);
  });

  it("setQcExperiment marks debugStale when a debug arena exists", () => {
    useMazeStore.setState({ debugArena: emptyDebugArena() });
    useMazeStore.getState().setQcExperiment(true);
    expect(useMazeStore.getState().debugStale).toBe(true);
  });

  it("setQcExperiment does not mark debugStale when there is no debug arena", () => {
    useMazeStore.setState({ debugArena: null, debugStale: false });
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
