import { describe, it, expect } from "vitest";
import { routeStraightConnectors, routeOrthogonalConnectors, arrowPlacements } from "../pixi/renderers/teleportConnectorRouting";
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

describe("routeOrthogonalConnectors", () => {
  it("a single connector with no collisions bends on-grid with zero offset", () => {
    const [routed] = routeOrthogonalConnectors([edge([0, 0], [10, 20])], 4);
    // Either bend orientation is valid with nothing to collide against — bend is either (10,0) or (0,20).
    expect(routed.points[0]).toBe(0);
    expect(routed.points[1]).toBe(0);
    expect(routed.points[4]).toBe(10);
    expect(routed.points[5]).toBe(20);
    const [, , bendX, bendY] = routed.points;
    expect([bendX, bendY]).toSatisfy(([bx, by]: [number, number]) => (bx === 10 && by === 0) || (bx === 0 && by === 20));
  });

  it("two connectors sharing an overlapping horizontal corridor get offset apart, symmetric around the original line", () => {
    // Both from y=0 straight across to y=0 at different x spans that overlap on x — forces a
    // horizontal segment overlap regardless of bend choice, since both are already flat lines.
    const edges = [edge([0, 0], [10, 0]), edge([2, 0], [12, 0])];
    const routed = routeOrthogonalConnectors(edges, 4);
    // Two connectors in one cluster: offsets are -2 and +2 (gap=4, symmetric around 0).
    const ys = routed.map((r) => r.points[1]);
    expect(new Set(ys.map((y) => Math.abs(y)))).toEqual(new Set([2]));
    expect(ys[0]).not.toBe(ys[1]);
  });

  it("non-overlapping connectors on the same axis/coordinate but disjoint spans get zero offset each", () => {
    const edges = [edge([0, 0], [5, 0]), edge([10, 0], [15, 0])];
    const routed = routeOrthogonalConnectors(edges, 4);
    expect(routed[0].points[1]).toBe(0);
    expect(routed[1].points[1]).toBe(0);
  });

  it("start and end points always land on the original from/to coordinates on the non-offset axis", () => {
    const edges = [edge([0, 0], [10, 0]), edge([2, 0], [12, 0]), edge([4, 0], [14, 0])];
    const routed = routeOrthogonalConnectors(edges, 4);
    routed.forEach((r, i) => {
      expect(r.points[0]).toBe(edges[i].from[0]);
      expect(r.points[4]).toBe(edges[i].to[0]);
    });
  });

  it("a cluster of 3 overlapping connectors gets 3 distinct symmetric offsets", () => {
    const edges = [edge([0, 0], [10, 0]), edge([1, 0], [11, 0]), edge([2, 0], [12, 0])];
    const routed = routeOrthogonalConnectors(edges, 4);
    const ys = routed.map((r) => r.points[1]).sort((a, b) => a - b);
    expect(ys).toEqual([-4, 0, 4]);
  });

  it("orthogonal path always has exactly 3 points (start, bend, end)", () => {
    const routed = routeOrthogonalConnectors([edge([0, 0], [5, 5])], 4);
    expect(routed[0].points).toHaveLength(6);
  });
});

describe("arrowPlacements", () => {
  const straight = [0, 0, 100, 0];

  it("\"none\" returns no arrows", () => {
    expect(arrowPlacements(straight, "none", 5)).toEqual([]);
  });

  it("\"center\" returns one arrow at the midpoint, pointing along the path", () => {
    const [p] = arrowPlacements(straight, "center", 5);
    expect(p).toEqual({ x: 50, y: 0, dx: 1, dy: 0 });
  });

  it("\"double\" returns two arrows at 1/3 and 2/3", () => {
    const placements = arrowPlacements(straight, "double", 5);
    expect(placements).toEqual([
      { x: 100 / 3, y: 0, dx: 1, dy: 0 },
      { x: 200 / 3, y: 0, dx: 1, dy: 0 },
    ]);
  });

  it("\"periodic\" repeats every period, starting half a period in", () => {
    const placements = arrowPlacements(straight, "periodic", 20);
    expect(placements.map((p) => p.x)).toEqual([10, 30, 50, 70, 90]);
  });

  it("\"periodic\" on a connector shorter than one period still gets exactly one arrow", () => {
    const shortPath = [0, 0, 5, 0];
    const placements = arrowPlacements(shortPath, "periodic", 20);
    expect(placements).toHaveLength(1);
    expect(placements[0].x).toBe(2.5);
  });

  it("a zero-length path returns no arrows for any mode", () => {
    const zeroPath = [5, 5, 5, 5];
    expect(arrowPlacements(zeroPath, "center", 5)).toEqual([]);
    expect(arrowPlacements(zeroPath, "double", 5)).toEqual([]);
    expect(arrowPlacements(zeroPath, "periodic", 5)).toEqual([]);
  });

  it("an arrow that would land exactly on an orthogonal path's bend is nudged onto the second segment (more room after than before) with a clean single-segment direction", () => {
    const bent = [0, 0, 10, 0, 10, 10]; // right then down, total length 20
    const [p] = arrowPlacements(bent, "center", 5); // midpoint at distance 10 = exactly the bend
    // Pushed 6 units past the bend, onto the vertical leg (x stays 10, y advances).
    expect(p.x).toBe(10);
    expect(p.y).toBe(6);
    expect(p.dx).toBe(0);
    expect(p.dy).toBe(1);
  });

  it("an arrow close enough to a bend to be within the avoidance distance still gets nudged", () => {
    const bent = [0, 0, 10, 0, 10, 10];
    const [p] = arrowPlacements(bent, "double", 5); // 1/3 of 20 = 6.67, within 6 units of the bend at 10
    expect(p.x).toBe(4);
    expect(p.y).toBe(0);
    expect(p.dx).toBe(1);
    expect(p.dy).toBe(0);
  });

  it("an arrow well clear of any bend is left exactly where it landed", () => {
    const longBent = [0, 0, 30, 0, 30, 30]; // total length 60, bend at 30
    const [p] = arrowPlacements(longBent, "double", 5); // 1/3 of 60 = 20, 10 units clear of the bend
    expect(p.x).toBeCloseTo(20);
    expect(p.y).toBe(0);
  });
});
