import { describe, it, expect } from "vitest";
import type { Graphics } from "pixi.js";
import { borderCompensatedRadius, drawMarkerUnderlay, drawMarkerWithBorder, circlePolygonPoints, markerPolygonPoints, offsetPolygonPath, offsetPolygonPoints, polygonCornerRadius, cornerTangentPoint } from "../pixi/renderers/markerShapes";

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

describe("circlePolygonPoints", () => {
  it("returns a closed, center-free outline with every vertex on the requested radius", () => {
    const cx = 12.5;
    const cy = -3.25;
    const radius = 20;
    const points = circlePolygonPoints(cx, cy, radius);

    expect(points.length / 2).toBeGreaterThanOrEqual(16);
    for (let i = 0; i < points.length; i += 2) {
      expect(Math.hypot(points[i] - cx, points[i + 1] - cy)).toBeCloseTo(radius, 10);
    }
    expect(points[0]).toBeCloseTo(cx + radius, 10);
    expect(points[1]).toBeCloseTo(cy, 10);
  });

  it("keeps a minimum tessellation for zero-radius markers", () => {
    expect(circlePolygonPoints(0, 0, 0)).toHaveLength(32);
  });
});

describe("offsetPolygonPoints", () => {
  it("keeps every offset edge parallel to the source edge at the requested distance", () => {
    const source = markerPolygonPoints("square", 0, 0, 10);
    const offset = offsetPolygonPoints(source, 3);
    for (let i = 0; i < source.length / 2; i++) {
      const j = (i + 1) % (source.length / 2);
      const ax = source[j * 2] - source[i * 2];
      const ay = source[j * 2 + 1] - source[i * 2 + 1];
      const length = Math.hypot(ax, ay);
      const nx = ay / length;
      const ny = -ax / length;
      const distance = Math.abs((offset[i * 2] - source[i * 2]) * nx + (offset[i * 2 + 1] - source[i * 2 + 1]) * ny);
      expect(distance).toBeCloseTo(3, 8);
    }
  });

  it("uses a bounded join at sharp concave corners instead of a clipped vertex spike", () => {
    const source = markerPolygonPoints("star", 0, 0, 20);
    const offset = offsetPolygonPath(source, 5);
    expect(offset.length).toBeGreaterThanOrEqual(source.length);
    expect(offset.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from({ length: offset.length / 2 }, (_, i) =>
      Math.hypot(offset[i * 2], offset[i * 2 + 1]),
    ))).toBeLessThan(50);
  });

  it("round join remains at the requested distance from the source corner", () => {
    const source = markerPolygonPoints("square", 0, 0, 10);
    const offset = offsetPolygonPath(source, 3, 4, "round");
    expect(offset.length).toBeGreaterThan(source.length);
    for (let i = 0; i < offset.length; i += 2) {
      expect(Math.hypot(offset[i], offset[i + 1])).toBeGreaterThan(10);
    }
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

describe("borderCompensatedRadius", () => {
  const shapes = ["triangle", "square", "diamond", "pentagon", "hexagon", "star", "cross"] as const;
  const outerArea = (shape: (typeof shapes)[number], r: number, bw: number, rounded: boolean) => {
    const outer = offsetPolygonPath(
      markerPolygonPoints(shape, 0, 0, r), bw, 4, rounded ? "round" : "miter",
      shape === "star" ? (i) => i % 2 === 0 : undefined,
    );
    return Math.abs(polygonArea(outer));
  };

  it("is identity for circle and zero border", () => {
    expect(borderCompensatedRadius("circle", 10, 3, false)).toBe(10);
    expect(borderCompensatedRadius("square", 10, 0, false)).toBe(10);
  });

  it("scales linearly with r for a fixed borderWidth / r ratio", () => {
    for (const shape of shapes) {
      expect(borderCompensatedRadius(shape, 40, 12, false)).toBeCloseTo(4 * borderCompensatedRadius(shape, 10, 3, false), 6);
    }
  });

  it("falls back to r when compensation cannot shrink the fill (huge border on a tiny marker still stays in (0, r])", () => {
    for (const shape of shapes) {
      const v = borderCompensatedRadius(shape, 1, 50, false);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it.each(shapes)("%s outer area matches circle of radius r + borderWidth", (shape) => {
    for (const rounded of [false, true]) {
      const fillR = borderCompensatedRadius(shape, 10, 3, rounded);
      expect(fillR).toBeLessThan(10);
      // Round joins are tessellated, so allow ~1% relative error.
      expect(outerArea(shape, fillR, 3, rounded) / (Math.PI * 13 * 13)).toBeCloseTo(1, 2);
    }
  });
});

describe("border-aware marker drawing", () => {
  /** Records `poly` point lists and `fill` styles in call order. */
  function mockGraphics() {
    const polys: number[][] = [];
    const fills: unknown[] = [];
    const g = {
      poly(points: number[]) { polys.push(points); return g; },
      fill(style: unknown) { fills.push(style); return g; },
    };
    return { g: g as unknown as Graphics, polys, fills };
  }
  const bounds = (pts: number[]) => {
    const xs = pts.filter((_, i) => i % 2 === 0);
    return Math.max(...xs) - Math.min(...xs);
  };

  it("draws the border contour first, then a fill shrunk by the compensation", () => {
    const { g, polys, fills } = mockGraphics();
    drawMarkerWithBorder(g, "square", 0, 0, 10, false, 0x111111, 0x222222, 3);
    expect(fills).toEqual([0x222222, 0x111111]);
    const fillR = borderCompensatedRadius("square", 10, 3, false);
    expect(fillR).toBeLessThan(10);
    expect(polys[1]).toEqual(markerPolygonPoints("square", 0, 0, fillR));
    expect(bounds(polys[0])).toBeGreaterThan(bounds(polys[1]));
  });

  it("keeps the plain fill radius when borderWidth is 0", () => {
    const { g, polys, fills } = mockGraphics();
    drawMarkerWithBorder(g, "square", 0, 0, 10, false, 0x111111, 0x222222, 0);
    expect(fills).toEqual([0x111111]);
    expect(polys[0]).toEqual(markerPolygonPoints("square", 0, 0, 10));
  });

  it("underlay with borderWidth equal to outset coincides with the marker's own border contour", () => {
    const border = mockGraphics();
    drawMarkerWithBorder(border.g, "diamond", 5, 5, 10, false, 0x1, 0x2, 3);
    const underlay = mockGraphics();
    drawMarkerUnderlay(underlay.g, "diamond", 5, 5, 10, false, 3, 0x3, 3);
    expect(underlay.polys[0]).toEqual(border.polys[0]);
  });
});
