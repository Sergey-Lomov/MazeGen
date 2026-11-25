import { describe, it, expect } from "vitest";
import { touchedNodeIds, fullyHighlightedNavEdges } from "../pixi/renderers/edgeUtils";

describe("fullyHighlightedNavEdges", () => {
  const navEdges = [{ path: [1, 2, 3] }, { path: [3, 4] }, { path: [4, 1] }];

  it("keeps only nav edges whose every hop is highlighted", () => {
    expect(fullyHighlightedNavEdges(navEdges, [[1, 2], [2, 3], [3, 4]])).toEqual([navEdges[0], navEdges[1]]);
  });

  it("drops a nav edge with one hop missing", () => {
    expect(fullyHighlightedNavEdges(navEdges, [[1, 2], [3, 4]])).toEqual([navEdges[1]]);
  });

  it("matches hops by direction", () => {
    expect(fullyHighlightedNavEdges(navEdges, [[4, 3]])).toEqual([]);
  });

  it("returns nothing for no highlighted hops", () => {
    expect(fullyHighlightedNavEdges(navEdges, [])).toEqual([]);
  });
});

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
