import { describe, it, expect } from "vitest";
import { deriveSplitPointsFromNodes } from "../pixi/splitPointsCore";

describe("deriveSplitPointsFromNodes", () => {
  it("returns an empty map when no point has more than one node", () => {
    const nodes = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    expect(deriveSplitPointsFromNodes(nodes)).toEqual({});
  });

  it("assigns slot ids 0..n-2 to every point with more than one node, skipping the original", () => {
    const nodes = [
      { x: 0, y: 0 },
      { x: 1, y: 0 }, // split point: 2 nodes -> 1 slot
      { x: 1, y: 0 },
      { x: 2, y: 0 }, // split point: 3 nodes -> 2 slots
      { x: 2, y: 0 },
      { x: 2, y: 0 },
    ];
    expect(deriveSplitPointsFromNodes(nodes)).toEqual({
      "1,0": [0],
      "2,0": [0, 1],
    });
  });

  it("handles an empty node list", () => {
    expect(deriveSplitPointsFromNodes([])).toEqual({});
  });
});
