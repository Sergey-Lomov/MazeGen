import { describe, it, expect } from "vitest";
import { deriveSplitPointsFromNodes } from "../pixi/splitPointsCore";

describe("deriveSplitPointsFromNodes", () => {
  it("returns an empty map when no point has more than one node", () => {
    const nodes = [{ x: 0, y: 0, i: 0 }, { x: 1, y: 0, i: 0 }, { x: 0, y: 1, i: 0 }];
    expect(deriveSplitPointsFromNodes(nodes)).toEqual({});
  });

  it("derives slot ids from each node's own i (i - 1), skipping the original (i = 0)", () => {
    const nodes = [
      { x: 0, y: 0, i: 0 },
      { x: 1, y: 0, i: 0 }, // split point: 2 nodes -> 1 slot
      { x: 1, y: 0, i: 1 },
      { x: 2, y: 0, i: 0 }, // split point: 3 nodes -> 2 slots
      { x: 2, y: 0, i: 1 },
      { x: 2, y: 0, i: 2 },
    ];
    expect(deriveSplitPointsFromNodes(nodes)).toEqual({
      "1,0": [0],
      "2,0": [0, 1],
    });
  });

  // GitHub issue #236 regression: an earlier slot (i = 1) was removed at some point, leaving a
  // hole — the surviving slot's i (3) must not be renumbered down to a compacted position.
  it("preserves a hole left by an earlier removed slot instead of compacting positions", () => {
    const nodes = [
      { x: 0, y: 0, i: 0 },
      { x: 0, y: 0, i: 3 }, // i = 1, 2 were removed; this slot's real slot id is 2, not 0
    ];
    expect(deriveSplitPointsFromNodes(nodes)).toEqual({
      "0,0": [2],
    });
  });

  it("handles an empty node list", () => {
    expect(deriveSplitPointsFromNodes([])).toEqual({});
  });
});
