import { describe, it, expect } from "vitest";
import { parseMaxSize, resolveIntervals, editMaxSize, cascadedIndices, withExplicitBounds, withExplicitBoundsInSlots } from "../store/sizeThresholdIntervals";

describe("parseMaxSize", () => {
  it("accepts non-negative integers only", () => {
    expect(parseMaxSize("12")).toBe(12);
    expect(parseMaxSize(" 7 ")).toBe(7);
    expect(parseMaxSize("")).toBeNull();
    expect(parseMaxSize("-3")).toBeNull();
    expect(parseMaxSize("2.5")).toBeNull();
    expect(parseMaxSize("abc")).toBeNull();
    expect(parseMaxSize(undefined)).toBeNull();
  });
});

describe("resolveIntervals", () => {
  it("single entry covers everything from 1", () => {
    expect(resolveIntervals([undefined])).toEqual([{ lo: 1, hi: null }]);
  });

  it("chains lower bounds from the previous upper bound", () => {
    expect(resolveIntervals(["5", "20", undefined])).toEqual([
      { lo: 1, hi: 5 },
      { lo: 6, hi: 20 },
      { lo: 21, hi: null },
    ]);
  });

  it("ignores the last entry's own value", () => {
    expect(resolveIntervals(["5", "999"])[1]).toEqual({ lo: 6, hi: null });
  });

  it("missing or invalid bound falls back to the default span", () => {
    expect(resolveIntervals([undefined, "x", undefined])).toEqual([
      { lo: 1, hi: 5 },
      { lo: 6, hi: 10 },
      { lo: 11, hi: null },
    ]);
  });

  it("raises a bound below its own lower bound", () => {
    expect(resolveIntervals(["5", "3", undefined])).toEqual([
      { lo: 1, hi: 5 },
      { lo: 6, hi: 6 },
      { lo: 7, hi: null },
    ]);
  });
});

describe("editMaxSize", () => {
  it("sets the edited bound and keeps the rest", () => {
    expect(editMaxSize(["5", "20", undefined], 0, "8")).toEqual(["8", "20", null]);
  });

  it("cascades: later bounds pushed below their lower bound are raised", () => {
    expect(editMaxSize(["5", "10", "30", undefined], 0, "15")).toEqual(["15", "16", "30", null]);
  });

  it("clamps a bound below its lower bound to the lower bound", () => {
    expect(editMaxSize(["5", "20", undefined], 1, "2")).toEqual(["5", "6", null]);
  });

  it("invalid text keeps the current bound", () => {
    expect(editMaxSize(["5", "20", undefined], 0, "abc")).toEqual(["5", "20", null]);
  });
});

describe("cascadedIndices", () => {
  it("lists only later bounds the edit raised", () => {
    const raw = ["3", "6", "9", undefined];
    const next = editMaxSize(raw, 0, "7");
    expect(cascadedIndices(raw, 0, next)).toEqual([1]);
  });
  it("is empty when the edit pushes nothing, or only shrinks", () => {
    const raw = ["3", "6", undefined];
    expect(cascadedIndices(raw, 0, editMaxSize(raw, 0, "5"))).toEqual([]);
    expect(cascadedIndices(raw, 1, editMaxSize(raw, 1, "8"))).toEqual([]);
  });
});

describe("withExplicitBounds", () => {
  it("stores the resolved bound of every non-last entry and keeps unchanged entries as-is", () => {
    const entries: { params: Record<string, string> }[] = [{ params: {} }, { params: { max_size: "9" } }, { params: { max_size: "x" } }];
    const out = withExplicitBounds(entries);
    expect(out.map((e) => e.params.max_size)).toEqual(["5", "9", "x"]); // the last entry's own value is left alone
    expect(out[1]).toBe(entries[1]);
  });
});

describe("withExplicitBoundsInSlots", () => {
  it("normalizes only the listed slots, preserving order", () => {
    const list: { slotId: string; params: Record<string, string> }[] = [
      { slotId: "t", params: {} },
      { slotId: "u", params: {} },
      { slotId: "t", params: {} },
    ];
    const out = withExplicitBoundsInSlots(list, new Set(["t"]));
    expect(out.map((e) => [e.slotId, e.params.max_size])).toEqual([["t", "5"], ["u", undefined], ["t", undefined]]);
    expect(out[1]).toBe(list[1]);
  });
});
