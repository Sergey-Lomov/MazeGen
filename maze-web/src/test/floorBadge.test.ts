import { describe, it, expect, vi } from "vitest";

vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
  }
  return { Graphics: FakeGraphics, Container: class {}, Text: class {} };
});

vi.mock("../pixi/tessellationGeometry", () => ({
  getCellCenter: (x: number, y: number) => ({ x: x * 10, y: y * 10 }),
}));

const { drawCrossFloorStub, computeRegionBadgeRingPos } = await import("../pixi/renderers/floorBadge");
const { Graphics } = await import("pixi.js");

type FakeG = InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] };
function newG(): FakeG {
  return new Graphics() as FakeG;
}

describe("drawCrossFloorStub", () => {
  it("trims the line by nodeRadius+1 at the node end and badgeRadius+1 at the badge end", () => {
    const g = newG();
    // Horizontal stub, node at x=0, badge at x=100 — trim is purely along x.
    drawCrossFloorStub(g, { x: 0, y: 0 }, { x: 100, y: 0 }, "none", 0xffffff, 5, 10);
    const [moveToCall] = g.calls.filter((c) => c.fn === "moveTo");
    const [lineToCall] = g.calls.filter((c) => c.fn === "lineTo");
    expect(moveToCall.args).toEqual([6, 0]); // nodeRadius(5) + 1
    expect(lineToCall.args).toEqual([89, 0]); // 100 - (badgeRadius(10) + 1)
  });

  it("does nothing when node and badge positions coincide (zero-length stub)", () => {
    const g = newG();
    drawCrossFloorStub(g, { x: 5, y: 5 }, { x: 5, y: 5 }, "none", 0xffffff, 5, 10);
    expect(g.calls).toHaveLength(0);
  });

  it("draws no arrow when direction is \"none\"", () => {
    const g = newG();
    drawCrossFloorStub(g, { x: 0, y: 0 }, { x: 100, y: 0 }, "none", 0xffffff, 5, 10);
    expect(g.calls.some((c) => c.fn === "poly")).toBe(false);
  });

  it("draws an arrow pointing toward the badge for direction \"toBadge\"", () => {
    const g = newG();
    drawCrossFloorStub(g, { x: 0, y: 0 }, { x: 100, y: 0 }, "toBadge", 0xffffff, 5, 10);
    const [polyCall] = g.calls.filter((c) => c.fn === "poly");
    const [points] = polyCall.args as [number[]];
    const [tipX] = points;
    // Arrow tip sits ahead of the midpoint along +x (toward the badge).
    const midX = (6 + 89) / 2;
    expect(tipX).toBeGreaterThan(midX);
  });

  it("draws an arrow pointing toward the node for direction \"fromBadge\"", () => {
    const g = newG();
    drawCrossFloorStub(g, { x: 0, y: 0 }, { x: 100, y: 0 }, "fromBadge", 0xffffff, 5, 10);
    const [polyCall] = g.calls.filter((c) => c.fn === "poly");
    const [points] = polyCall.args as [number[]];
    const [tipX] = points;
    const midX = (6 + 89) / 2;
    expect(tipX).toBeLessThan(midX);
  });
});

describe("computeRegionBadgeRingPos", () => {
  const cfg = {} as never;

  it("places a single badge at the cell center", () => {
    const pos = computeRegionBadgeRingPos([2, 3], cfg, 6, 0, 1);
    expect(pos).toEqual({ x: 20, y: 30 });
  });

  it("spreads two badges evenly around a ring of radius (badgeRadius+strokeWidth)*1.25", () => {
    const a = computeRegionBadgeRingPos([0, 0], cfg, 8, 0, 2);
    const b = computeRegionBadgeRingPos([0, 0], cfg, 8, 1, 2);
    const ringRadius = 13.75; // (8 + 3) * 1.25
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(ringRadius);
    expect(Math.hypot(b.x, b.y)).toBeCloseTo(ringRadius);
    // Opposite sides of the ring (slot 0 vs slot 1 of 2).
    expect(a.x).toBeCloseTo(-b.x);
    expect(a.y).toBeCloseTo(-b.y);
  });

  it("starts the first slot straight up from the cell center", () => {
    const pos = computeRegionBadgeRingPos([1, 1], cfg, 4, 0, 3);
    const ringRadius = 8.75; // (4 + 3) * 1.25
    expect(pos.x).toBeCloseTo(10);
    expect(pos.y).toBeCloseTo(10 - ringRadius); // center.y - ringRadius (straight up)
  });
});
