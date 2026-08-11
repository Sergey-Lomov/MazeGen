import { describe, it, expect } from "vitest";
import { routeStraightConnectors, arrowPlacements } from "../pixi/renderers/teleportConnectorRouting";
import type { TeleportEdge } from "../pixi/renderers/types";

function edge(from: [number, number], to: [number, number]): TeleportEdge {
  return { from, to, oneWay: false };
}

describe("routeStraightConnectors", () => {
  it("routes each edge as its own direct 2-point line", () => {
    const routed = routeStraightConnectors([edge([0, 0], [10, 10]), edge([5, 5], [1, 9])]);
    expect(routed).toEqual([
      { points: [0, 0, 10, 10] },
      { points: [5, 5, 1, 9] },
    ]);
  });
});

describe("arrowPlacements", () => {
  const straight = [0, 0, 100, 0];

  it("\"none\" returns no arrows", () => {
    expect(arrowPlacements(straight, "none", 5, 5)).toEqual([]);
  });

  it("\"center\" returns one arrow at the midpoint, pointing along the path", () => {
    const [p] = arrowPlacements(straight, "center", 5, 5);
    expect(p).toEqual({ x: 50, y: 0, dx: 1, dy: 0 });
  });

  it("\"double\" returns two arrows at 1/3 and 2/3", () => {
    const placements = arrowPlacements(straight, "double", 5, 5);
    expect(placements).toEqual([
      { x: 100 / 3, y: 0, dx: 1, dy: 0 },
      { x: 200 / 3, y: 0, dx: 1, dy: 0 },
    ]);
  });

  it("\"periodic\" repeats every period, starting half a period in", () => {
    const placements = arrowPlacements(straight, "periodic", 20, 5);
    expect(placements.map((p) => p.x)).toEqual([10, 30, 50, 70, 90]);
  });

  it("\"periodic\" on a connector shorter than one period still gets exactly one arrow", () => {
    const shortPath = [0, 0, 5, 0];
    const placements = arrowPlacements(shortPath, "periodic", 20, 5);
    expect(placements).toHaveLength(1);
    expect(placements[0].x).toBe(2.5);
  });

  it("a zero-length path returns no arrows for any mode", () => {
    const zeroPath = [5, 5, 5, 5];
    expect(arrowPlacements(zeroPath, "center", 5, 5)).toEqual([]);
    expect(arrowPlacements(zeroPath, "double", 5, 5)).toEqual([]);
    expect(arrowPlacements(zeroPath, "periodic", 5, 5)).toEqual([]);
  });

  it("an arrow that would land exactly on an orthogonal path's bend is pushed forward by arrowSize, staying on the second segment's direction", () => {
    const bent = [0, 0, 10, 0, 10, 10]; // right then down, total length 20
    const [p] = arrowPlacements(bent, "center", 5, 6); // midpoint at distance 10 = exactly the bend
    // Pushed 6 units past the bend, onto the vertical leg.
    expect(p.x).toBe(10);
    expect(p.y).toBe(6);
    expect(p.dx).toBe(0);
    expect(p.dy).toBe(1);
  });

  it("an arrow close enough to a bend to be within the avoidance distance still gets pushed back, staying on its own side", () => {
    const bent = [0, 0, 10, 0, 10, 10];
    const [p] = arrowPlacements(bent, "double", 5, 6); // 1/3 of 20 = 6.67, within 6 units of the bend at 10, before it
    expect(p.x).toBe(4);
    expect(p.y).toBe(0);
    expect(p.dx).toBe(1);
    expect(p.dy).toBe(0);
  });

  it("an arrow well clear of any bend is left exactly where it landed", () => {
    const longBent = [0, 0, 30, 0, 30, 30]; // total length 60, bend at 30
    const [p] = arrowPlacements(longBent, "double", 5, 6); // 1/3 of 60 = 20, 10 units clear of the bend
    expect(p.x).toBeCloseTo(20);
    expect(p.y).toBe(0);
  });

  it("a bend avoidance larger than the segment on that side is clamped to the room available", () => {
    const bent = [0, 0, 4, 0, 4, 2]; // short first leg (length 4), bend at distance 4, total length 6
    const [p] = arrowPlacements(bent, "center", 5, 6); // midpoint at distance 3, before the bend, room before is only 4
    // Room before the bend (4) < arrowSize (6), so it's clamped to the segment's own start (distance 0).
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
    expect(p.dx).toBe(1);
    expect(p.dy).toBe(0);
  });
});
