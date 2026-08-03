import { describe, it, expect } from "vitest";
import { polygonPoints } from "../pixi/renderers/WaypointsRenderer";

describe("polygonPoints", () => {
  it("square — 4 axis-aligned corners at distance r from center", () => {
    const pts = polygonPoints("square", 0, 0, 10);
    expect(pts).toHaveLength(8);
    for (let i = 0; i < 4; i++) {
      const x = pts[i * 2];
      const y = pts[i * 2 + 1];
      expect(Math.hypot(x, y)).toBeCloseTo(10);
    }
    // Rotated 45deg from "point up" — corners land near the axes, not the diagonals.
    expect(Math.abs(pts[0])).toBeCloseTo(Math.abs(pts[1]));
  });

  it("diamond — 4 corners, first vertex points straight up", () => {
    const pts = polygonPoints("diamond", 5, 5, 10);
    expect(pts).toHaveLength(8);
    expect(pts[0]).toBeCloseTo(5);
    expect(pts[1]).toBeCloseTo(5 - 10);
  });

  it("triangle — 3 corners, all at distance r from center", () => {
    const pts = polygonPoints("triangle", 0, 0, 10);
    expect(pts).toHaveLength(6);
    for (let i = 0; i < 3; i++) {
      expect(Math.hypot(pts[i * 2], pts[i * 2 + 1])).toBeCloseTo(10);
    }
  });

  it("star5 — 10 points alternating outer radius r and inner radius 0.5r", () => {
    const pts = polygonPoints("star5", 0, 0, 10);
    expect(pts).toHaveLength(20);
    for (let i = 0; i < 10; i++) {
      const dist = Math.hypot(pts[i * 2], pts[i * 2 + 1]);
      expect(dist).toBeCloseTo(i % 2 === 1 ? 5 : 10);
    }
  });

  it("first vertex of triangle/star5 points straight up (same rotation as diamond)", () => {
    const tri = polygonPoints("triangle", 0, 0, 10);
    expect(tri[0]).toBeCloseTo(0);
    expect(tri[1]).toBeCloseTo(-10);
  });
});
