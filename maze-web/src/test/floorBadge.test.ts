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
  return { Graphics: FakeGraphics, Container: FakeContainer, Cache: { get: () => undefined }, BitmapText: class {
    options: { text: string; style?: { fontSize?: number } };
    anchor = { set: vi.fn() };
    pivot = { y: 0 };
    x = 0;
    y = 0;
    constructor(options: { text: string; style?: { fontSize?: number } }) { this.options = options; }
    // Crude 0.6em/char width model so `fitTeleportBadgeFontSize`'s probe loop can measure.
    get width() { return this.options.text.length * (this.options.style?.fontSize ?? 0) * 0.6; }
    destroy() {}
  } };
});

vi.mock("../pixi/tessellationGeometry", () => ({
  getCellCenter: (x: number, y: number) => ({ x: x * 10, y: y * 10 }),
  getCellVertices: () => [
    { x: -10, y: -10 },
    { x: 10, y: -10 },
    { x: 10, y: 10 },
    { x: -10, y: 10 },
  ],
}));

vi.mock("../pixi/renderers/floorNavigation", () => ({
  navigateToFloor: vi.fn(),
}));

const { drawCrossFloorStub, drawCrossFloorBadge, computeCrossFloorBadgePos, computeRegionBadgeRingPos, attachFloorBadgeNavigation, fitTeleportBadgeFontSize, FLOOR_BADGE_STROKE_WIDTH } = await import(
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

  it("runs to the node's own center when nodeGapless is set (no nodeRadius trim)", () => {
    const g = newG();
    drawCrossFloorStub(g, { x: 0, y: 0 }, { x: 100, y: 0 }, "none", 0xffffff, 5, 10, 2, 1, true);
    const [moveToCall] = g.calls.filter((c) => c.fn === "moveTo");
    expect(moveToCall.args).toEqual([0, 0]);
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
    expect(strokeCall.args).toEqual([{ width: 3, color: 0xffffff, alpha: 0.9, cap: "butt" }]);
  });

  it("draws an arrow pointing toward the badge for direction \"toBadge\"", () => {
    const g = newG();
    drawCrossFloorStub(g, { x: 0, y: 0 }, { x: 100, y: 0 }, "toBadge", 0xffffff, 5, 10);
    const [polyCall] = g.calls.filter((c) => c.fn === "poly");
    const [points] = polyCall.args as [number[]];
    const [tipX] = points;
    // Arrow tip sits ahead of the node-center → badge-center midpoint along +x (toward the badge).
    const midX = (0 + 100) / 2;
    expect(tipX).toBeGreaterThan(midX);
  });

  it("draws an arrow pointing toward the node for direction \"fromBadge\"", () => {
    const g = newG();
    drawCrossFloorStub(g, { x: 0, y: 0 }, { x: 100, y: 0 }, "fromBadge", 0xffffff, 5, 10);
    const [polyCall] = g.calls.filter((c) => c.fn === "poly");
    const [points] = polyCall.args as [number[]];
    const [tipX] = points;
    const midX = (0 + 100) / 2;
    expect(tipX).toBeLessThan(midX);
  });
});

describe("drawCrossFloorBadge", () => {
  it("places the floor-number label above the opaque badge body", () => {
    const container = new Container() as unknown as FakeCont;
    drawCrossFloorBadge(container as never, { x: 20, y: 30 }, 1, 8, 0x111111, 0x222222, 0xffffff);
    expect(container.children).toHaveLength(3);
    expect(container.children[0]).toBeInstanceOf(Graphics); // badge body
    expect(container.children[1]).not.toBeInstanceOf(Graphics); // floor-number BitmapText
    expect((container.children[1] as { options: { text: string } }).options.text).toBe("2");
    expect(container.children[2]).toBeInstanceOf(Graphics); // navigation hit area
  });

  it("draws the digit in the bold MSDF atlas, sized to the badge radius (no lower bound) in the floor color", () => {
    const container = new Container() as unknown as FakeCont;
    // radius 20 → fontSize 20 * 1.6 = 32; radius 5 → 8 (GitHub issue #485 removed the old min-12 clamp).
    drawCrossFloorBadge(container as never, { x: 0, y: 0 }, 0, 20, 0x111111, 0x222222, 0xabcdef);
    const style = (container.children[1] as { options: { style: { fontFamily: string; fontSize: number; fill: number } } }).options.style;
    expect(style.fontFamily).toBe("Roboto-Bold");
    expect(style.fontSize).toBeCloseTo(32);
    expect(style.fill).toBe(0xabcdef);

    const small = new Container() as unknown as FakeCont;
    drawCrossFloorBadge(small as never, { x: 0, y: 0 }, 0, 5, 0x111111, 0x222222, 0xabcdef);
    expect((small.children[1] as { options: { style: { fontSize: number } } }).options.style.fontSize).toBeCloseTo(8);
  });
});

describe("fitTeleportBadgeFontSize", () => {
  // GitHub issue #485 follow-up: `textPadding` must shrink the font from its very first step,
  // regardless of how narrow the label or how small the badge — the old width-only bound let a
  // one-glyph label ignore the leading part of the slider.
  it("shrinks the font on every textPadding step, even for a narrow single-glyph label", () => {
    const r = 8;
    const at = (pad: number) => fitTeleportBadgeFontSize(["1"], r, pad, 0);
    const p0 = at(0);
    const p1 = at(1);
    const p2 = at(2);
    expect(p1).toBeLessThan(p0);
    expect(p2).toBeLessThan(p1);
    // Height bound is exactly the padded box side: 2*r - 2*pad.
    expect(p1).toBeCloseTo(2 * r - 2 * 1);
    expect(p2).toBeCloseTo(2 * r - 2 * 2);
  });

  it("shrinks the font for a wider label so it still fits, and never exceeds the padded box side", () => {
    const r = 8;
    const bw = 4;
    const side = 2 * (r + bw); // textPadding 0
    const narrow = fitTeleportBadgeFontSize(["1"], r, 0, bw);
    const wide = fitTeleportBadgeFontSize(["VIII"], r, 0, bw);
    expect(wide).toBeLessThan(narrow); // a 4-glyph label must draw smaller than a 1-glyph one
    expect(wide).toBeLessThanOrEqual(side + 1e-9);
    expect(narrow).toBeCloseTo(side); // narrow label is capped by the box side, not its own width
  });

  it("returns 0 for no labels and clamps a padding wider than the badge to 0", () => {
    expect(fitTeleportBadgeFontSize([], 8, 0, 0)).toBe(0);
    expect(fitTeleportBadgeFontSize(["1"], 4, 10, 0)).toBe(0);
  });

  // GitHub issue #485 — the default `textPadding` (3.4) must reproduce the pre-#485 hardcoded badge
  // label size: `Math.max(r * 1.6, 12)` = 12 for a single-digit label at the default badge radius
  // (`floorBadge.size` 0.16 * TILE_SIZE = 6.4) and the default border width (3).
  it("with the shipped defaults, a single-digit label fits at exactly the pre-#485 size (12)", async () => {
    const { DEFAULT_MAZE_RENDER_STYLE } = await import("../pixi/defaultMazeRenderStyle");
    const badge = DEFAULT_MAZE_RENDER_STYLE.teleport.floorBadge;
    const r = badge.size * 40; // TILE_SIZE
    const bw = DEFAULT_MAZE_RENDER_STYLE.teleport.borderWidth;
    // The mock BitmapText models a digit as 0.6 em wide, so for "1" the width bound is slack and
    // the box-side cap (`2*(r+bw) - 2*textPadding`) is what lands the result on 12.
    expect(fitTeleportBadgeFontSize(["1"], r, badge.textPadding, bw)).toBeCloseTo(12);
  });
});

describe("computeRegionBadgeRingPos", () => {
  const cfg = {} as never;

  it("places a single badge at the cell center", () => {
    const pos = computeRegionBadgeRingPos([2, 3], cfg, 6, 0, 1);
    expect(pos).toEqual({ x: 20, y: 30 });
  });

  describe("computeCrossFloorBadgePos", () => {
    const cfg = {} as never;

    it("distributes more badges than cell corners evenly around the cell", () => {
      const positions = Array.from({ length: 5 }, (_, slot) =>
        computeCrossFloorBadgePos([0, 0], [0, 0], cfg, 2, 10, slot, 5),
      );
      const radius = 8;

      for (const position of positions) expect(Math.hypot(position.x, position.y)).toBeCloseTo(radius);
      for (let slot = 0; slot < positions.length; slot++) {
        const angle = -Math.PI / 2 + (slot / positions.length) * 2 * Math.PI;
        expect(positions[slot].x).toBeCloseTo(Math.cos(angle) * radius);
        expect(positions[slot].y).toBeCloseTo(Math.sin(angle) * radius);
      }
    });
  });

  it("spreads two badges evenly around a ring of radius (badgeRadius+strokeWidth)*1.5", () => {
    const a = computeRegionBadgeRingPos([0, 0], cfg, 8, 0, 2);
    const b = computeRegionBadgeRingPos([0, 0], cfg, 8, 1, 2);
    const ringRadius = 16.5; // (8 + 3) * 1.5
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(ringRadius);
    expect(Math.hypot(b.x, b.y)).toBeCloseTo(ringRadius);
    // Opposite sides of the ring (slot 0 vs slot 1 of 2).
    expect(a.x).toBeCloseTo(-b.x);
    expect(a.y).toBeCloseTo(-b.y);
  });

  it("starts the first slot straight up from the cell center", () => {
    const pos = computeRegionBadgeRingPos([1, 1], cfg, 4, 0, 3);
    const ringRadius = 10.5; // (4 + 3) * 1.5
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
