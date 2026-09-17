import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { useQualityViewModel } from "../components/features/useQualityViewModel";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  useMazeStore.setState({
    availableChecks: [
      { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] },
      { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [] },
    ],
    availableStrategies: [],
    rules: [
      {
        id: "g1", name: "Rule 1", kind: "k1",
        checks: [
          { localId: 0, typeId: "c1", params: {}, disabled: false },
          { localId: 1, typeId: "c2", params: {}, disabled: true },
        ],
        nextLocalCheckId: 2, strategyId: null, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [],
        collapsed: false,
      },
    ],
    stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false, collapsed: false }],
  });
});

describe("useQualityViewModel", () => {
  it("threads each CheckInstance.disabled through to its resolved CheckVM.disabled, per instance", () => {
    const { result } = renderHook(() => useQualityViewModel());
    const checks = result.current.checks;
    expect(checks.find((c) => c.localId === 0)?.disabled).toBe(false);
    expect(checks.find((c) => c.localId === 1)?.disabled).toBe(true);
  });

  it("reflects a live toggleCheckDisabled call in the next render's CheckVM.disabled", () => {
    const { result, rerender } = renderHook(() => useQualityViewModel());
    expect(result.current.checks.find((c) => c.localId === 0)?.disabled).toBe(false);
    useMazeStore.getState().toggleCheckDisabled("g1", 0);
    rerender();
    expect(result.current.checks.find((c) => c.localId === 0)?.disabled).toBe(true);
  });

  // GitHub issue #486: a nested strategy hides its dispatcher-owned params
  // (`nested_suppressed_params`) in its own rendered `params`, but keeps them on
  // `strategy.params` (which the select dialog reads for defaults).
  it("drops nested_suppressed_params from a nested strategy's rendered params only", () => {
    useMazeStore.setState({
      availableStrategies: [
        {
          id: "priority_missing_loops", handles: "missing_loops",
          params: [{ id: "reserve_percent", label: "Reserve percent", kind: { type: "float", default: 0, min: 0, max: 500 } }],
          experimental: false,
          nested_slots: [{ slot_id: "seed", kind: "missing_loops", min: 1, max: 5, dispatch_kind: "priority" }],
          nested_suppressed_params: [],
        },
        {
          id: "missing_one_ways_from_wall", handles: "missing_loops",
          params: [
            { id: "reserve_percent", label: "Reserve percent", kind: { type: "float", default: 0, min: 0, max: 500 } },
            { id: "src_mode", label: "Source mode", kind: { type: "enum", options: ["random", "dead_end_priority"], default: "random" } },
            { id: "attempts_limit", label: "Attempts limit", kind: { type: "float", default: 25, min: 1, max: 10000 } },
          ],
          experimental: false, nested_slots: [],
          nested_suppressed_params: ["reserve_percent", "attempts_limit"],
        },
      ],
      rules: [{
        id: "g1", name: "Rule 1", kind: "missing_loops",
        checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }],
        nextLocalCheckId: 1, strategyId: "priority_missing_loops", disabled: false, ruleDisabled: false, params: {},
        nestedStrategies: [{ slotId: "seed", strategyId: "missing_one_ways_from_wall", params: {}, nested: [] }],
        collapsed: false,
      }],
      availableChecks: [{ id: "c1", label: "C1", description: "", issue_kinds: ["missing_loops"], params: [] }],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false, collapsed: false }],
    });
    const { result } = renderHook(() => useQualityViewModel());
    const nested = result.current.strategySlots[0].nestedStrategies[0];
    expect(nested.params.map((p) => p.id)).toEqual(["src_mode"]);
    expect(nested.strategy.params.map((p) => p.id)).toEqual(["reserve_percent", "src_mode", "attempts_limit"]);
  });
});
