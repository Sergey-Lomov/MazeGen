import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, resetGenerationMocks, makeRule } from "./storeTestHelpers";

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

describe("mazeStore generation strategy actions", () => {
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

});
