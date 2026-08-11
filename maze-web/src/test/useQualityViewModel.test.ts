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
      { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
      { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
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
});
