import { describe, expect, it } from "vitest";
import type { CutPlan } from "../pixi/imageExport/cutLines";
import { drawnCopies } from "../pixi/imageExport/TopologyWarningHighlight";

const square: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
const plan = (offsets: [number, number][]) =>
  ({ region: [[-1, -1], [5, -1], [5, 5], [-1, 5]], offsets }) as unknown as CutPlan;

describe("drawnCopies", () => {
  it("draws the shape as is without a plan", () => {
    expect(drawnCopies(square, null)).toEqual([square]);
  });

  it("keeps only the offset copies whose centre is in the region, shifted whole", () => {
    const copies = drawnCopies(square, plan([[0, 0], [3, 0], [10, 0]]));
    expect(copies).toEqual([square, square.map(([x, y]) => [x + 3, y])]);
  });

  it("drops the base copy when the transfer moved it out of the region", () => {
    const moved = [[10, 10], [12, 10], [12, 12]] as [number, number][];
    expect(drawnCopies(moved, plan([[0, 0], [-10, -10]]))).toEqual([moved.map(([x, y]) => [x - 10, y - 10])]);
  });
});
