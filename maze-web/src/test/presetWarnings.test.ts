import { describe, expect, it } from "vitest";
import {
  computePresetInvalidElementCount, computePresetSplitProblemsOf, computePresetWarningCount, countPresetSplitProblems, presetWarningCount,
  type PresetWarningInput,
} from "../pixi/selectors/presetWarnings";

const emptyInput = (): PresetWarningInput => ({
  presetConnections: new Map(),
  presetSplitPoints: {},
  presetTeleports: [],
  presetVerticalPassages: [],
  presetElevators: [],
  presetStart: null,
  presetFinish: null,
  presetGenSource: null,
  lockedNodes: new Map(),
  autoLockedNodes: new Set(),
  presetActiveSplitNode: {},
  floors: [],
  floorFields: {},
});

describe("presetWarningCount (GitHub issue #1107)", () => {
  it("counts every isolated node and split problem, but all elements outside the field as one", () => {
    expect(presetWarningCount(2, 3, 5)).toBe(6);
    expect(presetWarningCount(0, 0, 1)).toBe(1);
    expect(presetWarningCount(0, 0, 0)).toBe(0);
  });

  it("is zero for an empty preset", () => {
    const input = emptyInput();
    const resolveFieldAt = () => undefined;
    expect(computePresetInvalidElementCount(input, resolveFieldAt)).toBe(0);
    expect(computePresetSplitProblemsOf(input)).toEqual([]);
    expect(computePresetWarningCount(input, resolveFieldAt)).toBe(0);
  });

  it("finds no split problems without floor data and sums messages per point", () => {
    const input = { ...emptyInput(), presetSplitPoints: { "1,1": [0] } };
    expect(computePresetSplitProblemsOf(input)).toEqual([]);
    expect(countPresetSplitProblems([
      { key: "a", endpoint: { point: [0, 0] }, messages: ["x", "y"] },
      { key: "b", endpoint: { point: [1, 1] }, messages: ["z"] },
    ])).toBe(3);
  });
});
