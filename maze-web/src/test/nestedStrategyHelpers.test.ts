import { describe, it, expect } from "vitest";
import { pathsEqual, findRawNested } from "../components/features/quality/NestedStrategyPanel";
import { resolveNestedStrategyVM } from "../components/features/quality/QualityDetailPanel";
import type { NestedStrategyVM, StrategyVM } from "../components/features/useQualityViewModel";
import type { NestedStrategyState, QcRuleState } from "../store/storeTypes";

describe("pathsEqual", () => {
  it("is true for two empty paths", () => {
    expect(pathsEqual([], [])).toBe(true);
  });

  it("is true for identical paths", () => {
    expect(pathsEqual(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("is false for different lengths", () => {
    expect(pathsEqual(["a"], ["a", "b"])).toBe(false);
  });

  it("is false for same length but different content", () => {
    expect(pathsEqual(["a", "b"], ["a", "c"])).toBe(false);
  });

  it("is false when order differs", () => {
    expect(pathsEqual(["a", "b"], ["b", "a"])).toBe(false);
  });
});

const strategy: StrategyVM = { id: "s1", label: "S1", handles: "k1", params: [], experimental: false, nestedSlots: [] };

function nestedVM(slotId: string, nested: NestedStrategyVM[] = []): NestedStrategyVM {
  return { slotId, strategy, params: [], nested };
}

describe("resolveNestedStrategyVM", () => {
  it("returns undefined for an empty path", () => {
    expect(resolveNestedStrategyVM([nestedVM("a")], [])).toBeUndefined();
  });

  it("resolves a top-level slot", () => {
    const node = nestedVM("a");
    expect(resolveNestedStrategyVM([node], ["a"])).toBe(node);
  });

  it("resolves a depth-2 slot", () => {
    const child = nestedVM("b");
    const parent = nestedVM("a", [child]);
    expect(resolveNestedStrategyVM([parent], ["a", "b"])).toBe(child);
  });

  it("returns undefined for an unknown slot id at the top level", () => {
    expect(resolveNestedStrategyVM([nestedVM("a")], ["no_such_slot"])).toBeUndefined();
  });

  it("returns undefined when an intermediate slot in the path doesn't exist", () => {
    const parent = nestedVM("a", [nestedVM("b")]);
    expect(resolveNestedStrategyVM([parent], ["a", "no_such_slot"])).toBeUndefined();
  });
});

function nestedState(slotId: string, nested: NestedStrategyState[] = []): NestedStrategyState {
  return { slotId, strategyId: "s1", params: {}, nested };
}

function ruleWith(nestedStrategies: NestedStrategyState[]): QcRuleState {
  return {
    id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 0,
    strategyId: "s1", disabled: false, ruleDisabled: false, nestedStrategies,
  };
}

describe("findRawNested", () => {
  it("returns undefined when the rule is undefined", () => {
    expect(findRawNested(undefined, ["a"])).toBeUndefined();
  });

  it("returns undefined for an empty path", () => {
    expect(findRawNested(ruleWith([nestedState("a")]), [])).toBeUndefined();
  });

  it("resolves a top-level slot", () => {
    const node = nestedState("a");
    expect(findRawNested(ruleWith([node]), ["a"])).toBe(node);
  });

  it("resolves a depth-2 slot", () => {
    const child = nestedState("b");
    const rule = ruleWith([nestedState("a", [child])]);
    expect(findRawNested(rule, ["a", "b"])).toBe(child);
  });

  it("returns undefined for an unknown slot id", () => {
    expect(findRawNested(ruleWith([nestedState("a")]), ["no_such_slot"])).toBeUndefined();
  });
});
