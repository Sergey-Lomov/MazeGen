import { describe, it, expect } from "vitest";
import { touchedNodeIds } from "../pixi/renderers/edgeUtils";

describe("touchedNodeIds", () => {
  it("returns an empty array for no edges", () => {
    expect(touchedNodeIds<number>([])).toEqual([]);
  });

  it("collects both endpoints of a single edge", () => {
    expect(touchedNodeIds([[1, 2]])).toEqual([1, 2]);
  });

  it("deduplicates a node shared by multiple edges", () => {
    const ids = touchedNodeIds([[1, 2], [2, 3]]);
    expect(new Set(ids)).toEqual(new Set([1, 2, 3]));
    expect(ids.length).toBe(3);
  });

  it("works with bigint ids", () => {
    const ids = touchedNodeIds([[1n, 2n], [2n, 3n]]);
    expect(new Set(ids)).toEqual(new Set([1n, 2n, 3n]));
  });
});
