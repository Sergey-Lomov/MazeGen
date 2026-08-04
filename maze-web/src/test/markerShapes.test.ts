import { describe, it, expect } from "vitest";
import { markerPolygonPoints, polygonCornerRadius, cornerTangentPoint } from "../pixi/renderers/markerShapes";

/** Shoelace formula for a closed polygon's area from its flat point list. */
function polygonArea(points: number[]): number {
  let sum = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = [points[i * 2], points[i * 2 + 1]];
    const [x2, y2] = [points[((i + 1) % n) * 2], points[((i + 1) % n) * 2 + 1]];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

describe("markerPolygonPoints", () => {
  it("every regular-polygon shape is area-matched to a circle of radius r (GitHub issue #293 follow-up: shapes must read as the same visual size)", () => {
    const r = 10;
    const expectedArea = Math.PI * r * r;
    for (const shape of ["triangle", "square", "diamond", "pentagon", "hexagon"] as const) {
      expect(polygonArea(markerPolygonPoints(shape, 0, 0, r))).toBeCloseTo(expectedArea, 0);
    }
  });

  it("square — 4 corners equidistant from center, rotated 45deg from 'point up' (corners land near the axes, not the diagonals)", () => {
    const pts = markerPolygonPoints("square", 0, 0, 10);
    expect(pts).toHaveLength(8);
    const R = Math.hypot(pts[0], pts[1]);
    for (let i = 1; i < 4; i++) {
      expect(Math.hypot(pts[i * 2], pts[i * 2 + 1])).toBeCloseTo(R);
    }
    expect(Math.abs(pts[0])).toBeCloseTo(Math.abs(pts[1]));
  });

  it("diamond — 4 corners, first vertex points straight up", () => {
    const pts = markerPolygonPoints("diamond", 5, 5, 10);
    expect(pts).toHaveLength(8);
    expect(pts[0]).toBeCloseTo(5);
    expect(pts[1]).toBeLessThan(5);
  });

  it("triangle — 3 corners, all equidistant from center", () => {
    const pts = markerPolygonPoints("triangle", 0, 0, 10);
    expect(pts).toHaveLength(6);
    const R = Math.hypot(pts[0], pts[1]);
    for (let i = 1; i < 3; i++) {
      expect(Math.hypot(pts[i * 2], pts[i * 2 + 1])).toBeCloseTo(R);
    }
  });

  it("pentagon has 5 points", () => {
    expect(markerPolygonPoints("pentagon", 0, 0, 10)).toHaveLength(10);
  });

  it("hexagon has 6 points", () => {
    expect(markerPolygonPoints("hexagon", 0, 0, 10)).toHaveLength(12);
  });

  it("star — 10 points alternating outer radius R and inner radius 0.5R, area-matched to a circle of radius r", () => {
    const r = 10;
    const pts = markerPolygonPoints("star", 0, 0, r);
    expect(pts).toHaveLength(20);
    const outer = Math.hypot(pts[0], pts[1]);
    for (let i = 0; i < 10; i++) {
      const dist = Math.hypot(pts[i * 2], pts[i * 2 + 1]);
      expect(dist).toBeCloseTo(i % 2 === 1 ? outer * 0.5 : outer);
    }
    expect(polygonArea(pts)).toBeCloseTo(Math.PI * r * r, 0);
  });

  it("first vertex of triangle/star points straight up (same rotation as diamond)", () => {
    const tri = markerPolygonPoints("triangle", 0, 0, 10);
    expect(tri[0]).toBeCloseTo(0);
    expect(tri[1]).toBeLessThan(0);
  });
});

// `drawRoundedPolygon`'s seam-closing math (GitHub issue #293 follow-up) — the path's `moveTo`
// start must land exactly where the wrapped-around last `arcTo` call (corner 0, processed as
// index n in the draw loop) ends, or `closePath` bridges the mismatch with a stray straight
// segment (visible as an overshoot spike on `star`, whose corners alternate rounded/sharp so the
// two ends of edge 0-1 aren't symmetric the way a regular polygon's are).
describe("cornerTangentPoint / polygonCornerRadius (drawRoundedPolygon's seam math)", () => {
  it("square — a 90 degree corner's tangent length equals its radius exactly (tan(45deg) == 1)", () => {
    const pts = markerPolygonPoints("square", 0, 0, 10);
    const radius = 2;
    const [vx, vy] = [pts[0], pts[1]];
    const [tx, ty] = cornerTangentPoint(pts, 0, radius);
    expect(Math.hypot(tx - vx, ty - vy)).toBeCloseTo(radius);
  });

  it("radius is capped by the shorter adjacent edge, same cap cornerTangentPoint respects", () => {
    // A right triangle with a very short edge forces polygonCornerRadius's cap.
    const pts = [0, 0, 1, 0, 0, 10];
    const radius = 5;
    const capped = polygonCornerRadius(pts, 0, radius);
    expect(capped).toBeLessThan(radius);
    expect(capped).toBeCloseTo(0.5); // half of the length-1 edge
  });

  it("ungated corner with radius 0 (degenerate) returns the vertex itself, not NaN", () => {
    const pts = markerPolygonPoints("square", 0, 0, 10);
    const [tx, ty] = cornerTangentPoint(pts, 0, 0);
    expect(tx).toBeCloseTo(pts[0]);
    expect(ty).toBeCloseTo(pts[1]);
  });

  it("star's alternating rounded/sharp corners: cornerTangentPoint(corner 0) matches the true tangent point computed independently via the tangent-length formula (radius / tan(halfAngle))", () => {
    const pts = markerPolygonPoints("star", 0, 0, 50);
    const radius = 50 * 0.25;
    const roundCorner = (i: number) => i % 2 === 0;

    // Independent reference implementation of the same tangent-length formula, kept deliberately
    // separate from the source so this test can't pass by construction.
    const n = pts.length / 2;
    const at = (i: number): [number, number] => {
      const idx = ((i % n) + n) % n;
      return [pts[idx * 2], pts[idx * 2 + 1]];
    };
    const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const expectedRadius0 = Math.min(radius, dist(at(-1), at(0)) / 2, dist(at(0), at(1)) / 2);
    const [vx, vy] = at(0);
    const [nx, ny] = at(1);
    const [px, py] = at(-1);
    const toPrev = dist(at(-1), at(0));
    const toNext = dist(at(0), at(1));
    const dot = ((px - vx) * (nx - vx) + (py - vy) * (ny - vy)) / (toPrev * toNext);
    const halfAngle = Math.acos(Math.min(1, Math.max(-1, dot))) / 2;
    const expectedLen = Math.min(expectedRadius0 / Math.tan(halfAngle), toNext);
    const expected: [number, number] = [vx + ((nx - vx) / toNext) * expectedLen, vy + ((ny - vy) / toNext) * expectedLen];

    const actual = cornerTangentPoint(pts, 0, radius, roundCorner);
    expect(actual[0]).toBeCloseTo(expected[0]);
    expect(actual[1]).toBeCloseTo(expected[1]);
  });

  it("regression: seam start (corner 0's tangent-out point) does NOT equal the naive edge midpoint for star's asymmetric corner pair — this is the exact bug fixed this session (path used to overshoot past the seam)", () => {
    const pts = markerPolygonPoints("star", 0, 0, 50);
    const radius = 50 * 0.25;
    const roundCorner = (i: number) => i % 2 === 0;
    const [tx, ty] = cornerTangentPoint(pts, 0, radius, roundCorner);
    const midX = (pts[0] + pts[2]) / 2;
    const midY = (pts[1] + pts[3]) / 2;
    expect(Math.hypot(tx - midX, ty - midY)).toBeGreaterThan(1);
  });
});
