import { describe, expect, it, vi } from "vitest";

vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number, cfg: { type: string }): [number, number] => {
    if (cfg.type.startsWith("hex")) {
      const inradius = Math.sqrt(3) / 2;
      return [x * 1.5, -(y * inradius * 2 + x * inradius)];
    }
    return [x, y];
  },
}));

import { selectionBoundarySegments } from "../pixi/fieldSelectionGeometry";

describe("selectionBoundarySegments", () => {
  it("removes internal edges from a selected square-cell union", () => {
    const segments = selectionBoundarySegments(
      [[0, 0], [1, 0], [0, 1], [1, 1]],
      "square",
      { type: "square", width: 2, height: 2 },
    );

    expect(segments).toHaveLength(8);
  });

  it("removes shared edges from adjacent hex cells", () => {
    const segments = selectionBoundarySegments(
      [[0, 0], [1, 0]],
      "hex",
      { type: "hex_hexagon", radius: 1, orientation: "flat_top" },
    );

    expect(segments).toHaveLength(10);
  });

  it("removes shared edges from adjacent triangle cells", () => {
    const segments = selectionBoundarySegments(
      [[0, 0], [1, 0]],
      "triangle",
      { type: "triangle_rect", cols: 2, rows: 2, orientation: "r0" },
    );

    expect(segments).toHaveLength(4);
  });
});
