import { describe, it, expect } from "vitest";
import { pathsEqual, findRawNested } from "../components/features/quality/NestedStrategyPanel";
import { resolveNestedStrategyVM } from "../components/features/quality/QualityDetailPanel";
import type { NestedStrategyVM, StrategyVM } from "../components/features/useQualityViewModel";
import type { NestedStrategyState, PathSegment, QcRuleState } from "../store/storeTypes";

function seg(slotId: string, index = 0): PathSegment {
  return { slotId, index };
}

describe("pathsEqual", () => {
  it("is true for two empty paths", () => {
    expect(pathsEqual([], [])).toBe(true);
  });

  it("is true for identical paths", () => {
    expect(pathsEqual([seg("a"), seg("b")], [seg("a"), seg("b")])).toBe(true);
  });

  it("is false for different lengths", () => {
    expect(pathsEqual([seg("a")], [seg("a"), seg("b")])).toBe(false);
  });

  it("is false for same length but different slotId", () => {
    expect(pathsEqual([seg("a"), seg("b")], [seg("a"), seg("c")])).toBe(false);
  });

  it("is false for same slotId but different index", () => {
    expect(pathsEqual([seg("a", 0)], [seg("a", 1)])).toBe(false);
  });

  it("is false when order differs", () => {
    expect(pathsEqual([seg("a"), seg("b")], [seg("b"), seg("a")])).toBe(false);
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

  it("resolves a top-level slot at index 0", () => {
    const node = nestedVM("a");
    expect(resolveNestedStrategyVM([node], [seg("a")])).toBe(node);
  });

  it("resolves a depth-2 slot", () => {
    const child = nestedVM("b");
    const parent = nestedVM("a", [child]);
    expect(resolveNestedStrategyVM([parent], [seg("a"), seg("b")])).toBe(child);
  });

  it("returns undefined for an unknown slot id at the top level", () => {
    expect(resolveNestedStrategyVM([nestedVM("a")], [seg("no_such_slot")])).toBeUndefined();
  });

  it("returns undefined when an intermediate slot in the path doesn't exist", () => {
    const parent = nestedVM("a", [nestedVM("b")]);
    expect(resolveNestedStrategyVM([parent], [seg("a"), seg("no_such_slot")])).toBeUndefined();
  });

  it("resolves the second entry of a multi-entry slot by index", () => {
    const first = nestedVM("merge_target");
    const second = nestedVM("merge_target");
    expect(resolveNestedStrategyVM([first, second], [seg("merge_target", 1)])).toBe(second);
  });

  it("returns undefined for an out-of-range index in a multi-entry slot", () => {
    const only = nestedVM("merge_target");
    expect(resolveNestedStrategyVM([only], [seg("merge_target", 1)])).toBeUndefined();
  });
});

function nestedState(slotId: string, nested: NestedStrategyState[] = []): NestedStrategyState {
  return { slotId, strategyId: "s1", params: {}, nested };
}

function ruleWith(nestedStrategies: NestedStrategyState[]): QcRuleState {
  return {
    id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 0,
    strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies,
    collapsed: false,
  };
}

describe("findRawNested", () => {
  it("returns undefined when the rule is undefined", () => {
    expect(findRawNested(undefined, [seg("a")])).toBeUndefined();
  });

  it("returns undefined for an empty path", () => {
    expect(findRawNested(ruleWith([nestedState("a")]), [])).toBeUndefined();
  });

  it("resolves a top-level slot at index 0", () => {
    const node = nestedState("a");
    expect(findRawNested(ruleWith([node]), [seg("a")])).toBe(node);
  });

  it("resolves a depth-2 slot", () => {
    const child = nestedState("b");
    const rule = ruleWith([nestedState("a", [child])]);
    expect(findRawNested(rule, [seg("a"), seg("b")])).toBe(child);
  });

  it("returns undefined for an unknown slot id", () => {
    expect(findRawNested(ruleWith([nestedState("a")]), [seg("no_such_slot")])).toBeUndefined();
  });

  it("resolves the second entry of a multi-entry slot by index", () => {
    const first = nestedState("merge_target");
    const second = nestedState("merge_target");
    expect(findRawNested(ruleWith([first, second]), [seg("merge_target", 1)])).toBe(second);
  });

  it("returns undefined for an out-of-range index in a multi-entry slot", () => {
    const only = nestedState("merge_target");
    expect(findRawNested(ruleWith([only]), [seg("merge_target", 1)])).toBeUndefined();
  });
});
