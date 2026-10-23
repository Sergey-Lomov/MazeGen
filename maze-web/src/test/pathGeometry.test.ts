import { describe, expect, it } from "vitest";
import { getGeometrySnapshot, type PathCommand } from "../wasm/mazeService";
import { tracePath, pathToSvg, arcSweep, type PathTarget } from "../pixi/geometry/pathRenderer";
import { applyTransform, isSimilarity, transformCommand, type WorldTransform } from "../pixi/geometry/worldTransform";
import { closestPointOnPolyline, offsetPolyline, polylineIntersections } from "../pixi/geometry/polylineOps";
import { fieldOf } from "./fieldConfigFixtures";

const YFLIP: WorldTransform = { a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 0 };

function recorder(): PathTarget & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    moveTo: (...a) => calls.push(["moveTo", ...a]),
    lineTo: (...a) => calls.push(["lineTo", ...a]),
  };
}

describe("path renderer", () => {
  const quarter: PathCommand[] = [
    { op: "move_to", to: [1, 0] },
    { op: "arc_to", center: [0, 0], radius: 1, start_angle: 0, end_angle: Math.PI / 2, ccw: true },
    { op: "line_to", to: [0, 0] },
  ];

  it("traces an arc as chords on the circle that end exactly at the arc's end", () => {
    const target = recorder();
    tracePath(target, quarter);
    const points = target.calls.slice(1, -1).map(([, x, y]) => [x, y] as [number, number]);
    expect(target.calls[0]).toEqual(["moveTo", 1, 0]);
    expect(target.calls[target.calls.length - 1]).toEqual(["lineTo", 0, 0]);
    expect(points.length).toBe(16);
    for (const [x, y] of points) expect(Math.hypot(x, y)).toBeCloseTo(1, 12);
    expect(points[points.length - 1][0]).toBeCloseTo(0, 12);
    expect(points[points.length - 1][1]).toBeCloseTo(1, 12);
  });

  it("traces an arc and its reverse through the same points", () => {
    const forward = recorder();
    const backward = recorder();
    tracePath(forward, quarter.slice(0, 2));
    tracePath(backward, [
      { op: "move_to", to: [0, 1] },
      { op: "arc_to", center: [0, 0], radius: 1, start_angle: Math.PI / 2, end_angle: 0, ccw: false },
    ]);
    const key = (calls: unknown[][]) => calls.map(([, x, y]) => `${(x as number).toFixed(9)},${(y as number).toFixed(9)}`);
    expect(key(backward.calls).reverse()).toEqual(key(forward.calls));
  });

  it("keeps an arc on the same curve under a Y flip", () => {
    const target = recorder();
    tracePath(target, quarter, YFLIP);
    expect(target.calls[0][1] as number).toBeCloseTo(1, 12);
    expect(target.calls[0][2] as number).toBeCloseTo(0, 12);
    const last = target.calls[target.calls.length - 2];
    expect(last[1] as number).toBeCloseTo(0, 12);
    expect(last[2] as number).toBeCloseTo(-1, 12);
    for (const [, x, y] of target.calls.slice(1, -1)) expect(Math.hypot(x as number, y as number)).toBeCloseTo(1, 12);
  });

  it("scales radii by a uniform scale and rejects non-similarity transforms for arcs", () => {
    const scaled = transformCommand({ a: 3, b: 0, c: 0, d: 3, tx: 1, ty: 2 }, quarter[1]);
    expect(scaled).toMatchObject({ center: [1, 2], radius: 3 });
    expect(isSimilarity({ a: 2, b: 0, c: 0, d: 1, tx: 0, ty: 0 })).toBe(false);
    expect(() => transformCommand({ a: 2, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, quarter[1])).toThrow();
    expect(applyTransform(YFLIP, [1, 2])).toEqual([1, -2]);
  });

  it("writes SVG path data with the matching arc flags", () => {
    expect(pathToSvg(quarter)).toBe("M 1 0 A 1 1 0 0 1 0 1 L 0 0");
    const flipped = pathToSvg(quarter, YFLIP);
    expect(flipped).toBe("M 1 0 A 1 1 0 0 0 0 -1 L 0 0");
  });

  it("marks arcs longer than a half turn as large and splits a full circle in two", () => {
    const threeQuarter = pathToSvg([{ op: "arc_to", center: [0, 0], radius: 1, start_angle: 0, end_angle: -Math.PI / 2, ccw: true }]);
    expect(threeQuarter).toBe("A 1 1 0 1 1 0 -1");
    const circle = pathToSvg([{ op: "arc_to", center: [0, 0], radius: 1, start_angle: 0, end_angle: 0, ccw: true }]);
    expect(circle).toBe("A 1 1 0 0 1 -1 0 A 1 1 0 0 1 1 0");
    expect(arcSweep(0, 0, false)).toBeCloseTo(-2 * Math.PI);
  });

  it("draws a real core boundary path", () => {
    const square = fieldOf("square", { shape: "custom", points: [[0, 0]] });
    const [cell] = getGeometrySnapshot({
      tessellation: square.tessellation,
      cells: [[0, 0]],
      boundary: { kind: "path" },
      fieldVersion: 0,
    }).cells;
    expect(pathToSvg(cell.boundary.commands)).toMatch(/^M [\d. -]+( L [\d. -]+)+$/);
  });
});

describe("polyline operations", () => {
  const line: [number, number][] = [[0, 0], [4, 0], [4, 3]];

  it("finds the closest point and its segment", () => {
    expect(closestPointOnPolyline(line, [2, 1])).toMatchObject({ point: [2, 0], distance: 1, segmentIndex: 0, t: 0.5 });
    expect(closestPointOnPolyline(line, [6, 2])).toMatchObject({ point: [4, 2], distance: 2, segmentIndex: 1 });
    expect(closestPointOnPolyline(line, [0, 3], true)).toMatchObject({ segmentIndex: 2 });
    expect(closestPointOnPolyline([[1, 1]], [0, 0])).toBeNull();
  });

  it("intersects polylines, reporting touching ends once and ignoring parallel overlap", () => {
    const cross = polylineIntersections(line, [[2, -1], [2, 1]]);
    expect(cross).toEqual([{ point: [2, 0], segmentA: 0, tA: 0.5, segmentB: 0, tB: 0.5 }]);
    expect(polylineIntersections(line, [[4, -1], [4, 1]]).map((hit) => hit.point)).toEqual([[4, 0]]);
    expect(polylineIntersections(line, [[1, 0], [3, 0]])).toEqual([]);
    expect(polylineIntersections(line, [[5, 5], [6, 6]])).toEqual([]);
  });

  it("offsets to the left with a miter join and bevels sharp corners", () => {
    expect(offsetPolyline(line, 1)).toEqual([[0, 1], [3, 1], [3, 3]]);
    expect(offsetPolyline(line, -1)).toEqual([[0, -1], [5, -1], [5, 3]]);
    const spike = offsetPolyline([[0, 0], [10, 0], [0, 0.5]], 1);
    expect(spike.length).toBe(4);
  });

  it("offsets a closed polygon and drops repeated vertices", () => {
    const square: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
    // Left of a counter-clockwise polygon is inward.
    expect(offsetPolyline(square, -1, { closed: true })).toEqual([[-1, -1], [3, -1], [3, 3], [-1, 3]]);
    expect(offsetPolyline(square, 0.5, { closed: true })).toEqual([[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]]);
    expect(offsetPolyline([[1, 1], [1, 1]], 1)).toEqual([]);
  });
});
