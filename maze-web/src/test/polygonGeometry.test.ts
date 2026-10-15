import { describe, expect, it } from "vitest";
import { cellsInsidePolygon, polygonWorldGeometry } from "../pixi/polygonGeometry";
import { fieldOf } from "./fieldConfigFixtures";

describe("polygon field geometry", () => {
  it("selects square cells by their centers", () => {
    const polygon = [
      { x: -1, y: 1 },
      { x: 81, y: 1 },
      { x: 81, y: 81 },
      { x: -1, y: 81 },
    ];

    expect(cellsInsidePolygon(polygon, fieldOf("square", { shape: "rect", cols: 1, rows: 1 }))).toEqual([
      [0, 0], [0, 1], [1, 0], [1, 1],
    ]);
  });

  it.each([
    ["hex", fieldOf("hex", { shape: "hexagon", radius: 1 }, "flat_top")],
    ["triangle", fieldOf("tri", { shape: "rect", cols: 1, rows: 1 }, "r0")],
  ] as const)("works on the %s tessellation", (_kind, config) => {
    const polygon = [
      { x: -100, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: -100 },
      { x: -100, y: -100 },
    ];
    expect(cellsInsidePolygon(polygon, config).length).toBeGreaterThan(0);
  });

  it("uses the even-odd rule for self-intersecting polygons", () => {
    const bowTie = [
      { x: -60, y: -60 },
      { x: 100, y: 100 },
      { x: 100, y: -60 },
      { x: -60, y: 100 },
    ];
    const cells = cellsInsidePolygon(bowTie, fieldOf("square", { shape: "rect", cols: 1, rows: 1 }));
    expect(cells).toContainEqual([0, 0]);
    expect(cells).not.toContainEqual([3, 3]);
  });

  it("keeps polygon preview points in world coordinates", () => {
    expect(polygonWorldGeometry([{ x: 10, y: 20 }, { x: 30, y: 40 }])).toEqual({
      kind: "polygon",
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    });
  });
});
