import { describe, expect, it, vi } from "vitest";

vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number, cfg: { tessellation: { kind: string } }): [number, number] =>
    fakeCellCenter(x, y, cfg.tessellation.kind),
}));

import { selectionBoundarySegments } from "../pixi/fieldSelectionGeometry";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeCellCenter } from "./cellCentersFake";

describe("selectionBoundarySegments", () => {
  it("removes internal edges from a selected square-cell union", () => {
    const segments = selectionBoundarySegments(
      [[0, 0], [1, 0], [0, 1], [1, 1]],
      "square",
      fieldOf("square", { shape: "rect", cols: 2, rows: 2 }),
    );

    expect(segments).toHaveLength(8);
  });

  it("removes shared edges from adjacent hex cells", () => {
    const segments = selectionBoundarySegments(
      [[0, 0], [1, 0]],
      "hex",
      fieldOf("hex", { shape: "hexagon", radius: 1 }, "flat_top"),
    );

    expect(segments).toHaveLength(10);
  });

  it("removes shared edges from adjacent triangle cells", () => {
    const segments = selectionBoundarySegments(
      [[0, 0], [1, 0]],
      "tri",
      fieldOf("tri", { shape: "rect", cols: 2, rows: 2 }, "r0"),
    );

    expect(segments).toHaveLength(4);
  });
});
