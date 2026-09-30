import { describe, expect, it } from "vitest";
import { cellsInsidePolygon, polygonWorldGeometry } from "../pixi/polygonGeometry";

describe("polygon field geometry", () => {
  it("selects square cells by their centers", () => {
    const polygon = [
      { x: -1, y: 1 },
      { x: 81, y: 1 },
      { x: 81, y: 81 },
      { x: -1, y: 81 },
    ];

    expect(cellsInsidePolygon(polygon, { type: "square", width: 1, height: 1 })).toEqual([
      [0, 0], [0, 1], [1, 0], [1, 1],
    ]);
  });

  it.each([
    ["hex", { type: "hex_hexagon" as const, radius: 1, orientation: "flat_top" as const }],
    ["triangle", { type: "triangle_rect" as const, cols: 1, rows: 1, orientation: "r0" as const }],
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
    const cells = cellsInsidePolygon(bowTie, { type: "square", width: 1, height: 1 });
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
