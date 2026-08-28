import { describe, it, expect, vi } from "vitest";

vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    eventMode = "auto";
    cursor = "";
    handlers: Record<string, (...args: unknown[]) => void> = {};
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
    circle(...args: unknown[]) { this.calls.push({ fn: "circle", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    on(event: string, handler: (...args: unknown[]) => void) { this.handlers[event] = handler; return this; }
  }
  class FakeContainer {
    children: FakeGraphics[] = [];
    addChild(child: FakeGraphics) { this.children.push(child); return child; }
  }
  return { Graphics: FakeGraphics, Container: FakeContainer, Text: class {
    options: unknown;
    anchor = { set: vi.fn() };
    x = 0;
    y = 0;
    constructor(options: unknown) { this.options = options; }
  } };
});

vi.mock("../pixi/tessellationGeometry", () => ({
  getCellCenter: (x: number, y: number) => ({ x: x * 10, y: y * 10 }),
}));

vi.mock("../pixi/renderers/floorNavigation", () => ({
  navigateToFloor: vi.fn(),
}));

const { drawCrossFloorStub, drawCrossFloorBadge, computeRegionBadgeRingPos, attachFloorBadgeNavigation, FLOOR_BADGE_STROKE_WIDTH } = await import(
  "../pixi/renderers/floorBadge"
);
const { navigateToFloor } = await import("../pixi/renderers/floorNavigation");
const { Graphics, Container } = await import("pixi.js");

type FakeG = InstanceType<typeof Graphics> & {
  calls: { fn: string; args: unknown[] }[];
  eventMode: string;
  cursor: string;
  handlers: Record<string, (...args: unknown[]) => void>;
};
interface FakeCont {
  children: unknown[];
}
function newG(): FakeG {
  return new Graphics() as unknown as FakeG;
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

  it("accepts the debug highlight's width and alpha", () => {
    const g = newG();
    drawCrossFloorStub(g, { x: 0, y: 0 }, { x: 100, y: 0 }, "none", 0xffffff, 5, 10, 3, 0.9);
    const [strokeCall] = g.calls.filter((c) => c.fn === "stroke");
    expect(strokeCall.args).toEqual([{ width: 3, color: 0xffffff, alpha: 0.9, cap: "round" }]);
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

describe("drawCrossFloorBadge", () => {
  it("places the floor-number label above the opaque badge body", () => {
    const container = new Container() as unknown as FakeCont;
    drawCrossFloorBadge(container as never, { x: 20, y: 30 }, 1, 8, 0x111111, 0x222222, 0xffffff);
    expect(container.children).toHaveLength(3);
    expect(container.children[0]).toBeInstanceOf(Graphics); // badge body
    expect(container.children[1]).not.toBeInstanceOf(Graphics); // floor-number Text
    expect((container.children[1] as { options: { text: string } }).options.text).toBe("2");
    expect(container.children[2]).toBeInstanceOf(Graphics); // navigation hit area
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

describe("attachFloorBadgeNavigation", () => {
  function newContainer(): FakeCont {
    return new Container() as unknown as FakeCont;
  }

  it("sizes the hit-circle to radius + FLOOR_BADGE_STROKE_WIDTH, covering the badge's stroked border", () => {
    const container = newContainer();
    attachFloorBadgeNavigation(container as never, 20, 30, 5, 2);
    const hit = container.children[0] as FakeG;
    const [circleCall] = hit.calls.filter((c) => c.fn === "circle");
    expect(circleCall.args).toEqual([20, 30, 5 + FLOOR_BADGE_STROKE_WIDTH]);
  });

  it("wires pointertap to navigateToFloor with the given target floor index", () => {
    const container = newContainer();
    attachFloorBadgeNavigation(container as never, 0, 0, 5, 3);
    const hit = container.children[0] as FakeG;
    hit.handlers["pointertap"]();
    expect(navigateToFloor).toHaveBeenCalledWith(3);
  });

  it("makes the hit-circle interactive with a pointer cursor", () => {
    const container = newContainer();
    attachFloorBadgeNavigation(container as never, 0, 0, 5, 0);
    const hit = container.children[0] as FakeG;
    expect(hit.eventMode).toBe("static");
    expect(hit.cursor).toBe("pointer");
  });
});
