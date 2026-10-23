import { describe, expect, it } from "vitest";

import { selectionBoundary } from "../pixi/fieldSelectionGeometry";
import { fieldOf } from "./fieldConfigFixtures";

describe("selectionBoundary segments", () => {
  it("removes internal edges from a selected square-cell union", () => {
    const { segments } = selectionBoundary(
      [[0, 0], [1, 0], [0, 1], [1, 1]],
      fieldOf("square", { shape: "rect", cols: 2, rows: 2 }),
    );

    expect(segments).toHaveLength(8);
  });

  it("removes shared edges from adjacent hex cells", () => {
    const { segments } = selectionBoundary(
      [[0, 0], [1, 0]],
      fieldOf("hex", { shape: "hexagon", radius: 1 }, "flat_top"),
    );

    expect(segments).toHaveLength(10);
  });

  it("removes shared edges from adjacent triangle cells", () => {
    const { segments } = selectionBoundary(
      [[0, 0], [1, 0]],
      fieldOf("tri", { shape: "rect", cols: 2, rows: 2 }, "r0"),
    );

    expect(segments).toHaveLength(4);
  });
});

describe("selectionBoundary", () => {
  const cfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });

  it("puts edge-adjacent cells in one component", () => {
    const { segments, components } = selectionBoundary([[0, 0], [1, 0]], cfg);

    expect(components).toHaveLength(segments.length);
    expect(new Set(components).size).toBe(1);
  });

  it("splits cells touching only at a corner into separate components", () => {
    const { components } = selectionBoundary([[0, 0], [1, 1]], cfg);

    expect(new Set(components).size).toBe(2);
  });
});
