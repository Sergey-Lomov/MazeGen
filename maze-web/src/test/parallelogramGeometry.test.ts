import { describe, expect, it } from "vitest";
import { parallelogramFromPoints, snapBaseEnd, tessellationEdgeDirections } from "../pixi/parallelogramGeometry";
import { cellsInsidePolygon } from "../pixi/polygonGeometry";
import { fieldOf } from "./fieldConfigFixtures";

const deg = (value: number) => (value * Math.PI) / 180;
const angleOf = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ((Math.atan2(b.y - a.y, b.x - a.x) % Math.PI) + Math.PI) % Math.PI;

describe("tessellation edge directions", () => {
  it("finds two perpendicular directions on a square grid", () => {
    const directions = tessellationEdgeDirections(fieldOf("square", { shape: "rect", cols: 3, rows: 3 }));
    expect(directions).toHaveLength(2);
    expect(directions[0]).toBeCloseTo(0, 6);
    expect(directions[1]).toBeCloseTo(deg(90), 6);
  });

  it("finds three directions 60 degrees apart on hex and tri grids", () => {
    for (const config of [
      fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"),
      fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }, "r0"),
    ]) {
      const directions = tessellationEdgeDirections(config);
      expect(directions).toHaveLength(3);
      expect(directions[1] - directions[0]).toBeCloseTo(deg(60), 6);
      expect(directions[2] - directions[1]).toBeCloseTo(deg(60), 6);
    }
  });
});

describe("edge directions of irregular tessellations", () => {
  it("offers no alignment axes for curved or radial tessellations", () => {
    expect(tessellationEdgeDirections(fieldOf("radial", { shape: "circle", radius: 4 }))).toEqual([]);
    expect(tessellationEdgeDirections(fieldOf("curved_quadrilateral", { shape: "rect", cols: 4, rows: 4 }))).toEqual([]);
  });
});

describe("parallelogram from points", () => {
  const square = [0, deg(90)];
  const origin = { x: 0, y: 0 };

  it("builds a parallelogram whose sides follow the base and the pointer", () => {
    const points = parallelogramFromPoints(origin, { x: 100, y: 0 }, { x: 30, y: 60 })!;
    expect(points).toEqual([origin, { x: 100, y: 0 }, { x: 130, y: 60 }, { x: 30, y: 60 }]);
  });

  it("snaps the second side to an edge direction other than the base", () => {
    const points = parallelogramFromPoints(origin, { x: 100, y: 0 }, { x: 5, y: 60 }, { directions: square })!;
    expect(points[3].x).toBeCloseTo(0, 6);
    expect(points[3].y).toBeCloseTo(60, 6);
  });

  it("never snaps the second side onto the base direction", () => {
    const points = parallelogramFromPoints(origin, { x: 100, y: 0 }, { x: 80, y: 3 }, { directions: [0] })!;
    expect(points[3]).toEqual({ x: 80, y: 3 });
  });

  it("keeps the angle free when no direction is near", () => {
    const points = parallelogramFromPoints(origin, { x: 100, y: 0 }, { x: 40, y: 40 }, { directions: square })!;
    expect(points[3]).toEqual({ x: 40, y: 40 });
  });

  it("makes the sides equal for equalSides", () => {
    const points = parallelogramFromPoints(origin, { x: 100, y: 0 }, { x: 10, y: 200 }, { equalSides: true })!;
    expect(Math.hypot(points[3].x, points[3].y)).toBeCloseTo(100, 6);
    expect(angleOf(origin, points[3])).toBeCloseTo(angleOf(origin, { x: 10, y: 200 }), 6);
  });

  it("rejects a degenerate parallelogram", () => {
    expect(parallelogramFromPoints(origin, { x: 100, y: 0 }, { x: 50, y: 0 })).toBeNull();
    expect(parallelogramFromPoints(origin, origin, { x: 0, y: 50 })).toBeNull();
  });

  it("snaps the base end onto the nearest edge direction", () => {
    const end = snapBaseEnd(origin, { x: 100, y: 4 }, square);
    expect(end.x).toBeCloseTo(100, 6);
    expect(end.y).toBeCloseTo(0, 6);
    expect(snapBaseEnd(origin, { x: 100, y: 60 }, square)).toEqual({ x: 100, y: 60 });
  });

  it("selects the cells of a hex parallelogram aligned with the grid", () => {
    const config = fieldOf("hex", { shape: "hexagon", radius: 5 }, "flat_top");
    const directions = tessellationEdgeDirections(config);
    const base = snapBaseEnd(origin, { x: 200, y: 3 }, directions);
    const points = parallelogramFromPoints(origin, base, { x: 90, y: 150 }, { directions })!;
    expect(angleOf(points[0], points[1])).toBeCloseTo(0, 6);
    expect(directions.some((d) => Math.abs(d - angleOf(points[0], points[3])) < 1e-6)).toBe(true);
    expect(cellsInsidePolygon(points, config).length).toBeGreaterThan(0);
  });
});
