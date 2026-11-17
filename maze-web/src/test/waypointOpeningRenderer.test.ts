import { describe, it, expect, vi } from "vitest";

vi.mock("pixi.js", () => {
  /** Records every call; unknown methods are accepted so the drawing primitives work against it. */
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    mask: unknown = null;
    destroyed = false;
    constructor() {
      return new Proxy(this, {
        get: (target, prop, receiver) => {
          if (prop in target || typeof prop !== "string") return Reflect.get(target, prop, receiver);
          return (...args: unknown[]) => {
            target.calls.push({ fn: prop, args });
            return receiver;
          };
        },
      });
    }
    clear() { this.calls = []; return this; }
    destroy() { this.destroyed = true; }
  }
  class FakeContainer {
    children: unknown[] = [];
    destroyed = false;
    addChild(...children: unknown[]) { this.children.push(...children); return children[0]; }
    removeChildren() { const removed = this.children; this.children = []; return removed; }
    destroy() { this.destroyed = true; }
  }
  return { Graphics: FakeGraphics, Container: FakeContainer };
});

const { Container } = await import("pixi.js");
const { WaypointOpeningRenderer, gapClipPolygon } = await import("../pixi/renderers/WaypointOpeningRenderer");

type Fake = { calls: { fn: string; args: unknown[] }[]; mask: unknown; destroyed: boolean };
type FakeBox = { children: Fake[] };
const polys = (g: Fake) => g.calls.filter((c) => c.fn === "poly").map((c) => c.args[0] as number[]);
const xs = (p: number[]) => p.filter((_, i) => i % 2 === 0);
const ys = (p: number[]) => p.filter((_, i) => i % 2 === 1);
const extent = (v: number[]) => Math.max(...v) - Math.min(...v);

// A pointer on the top side of a field: it points down (into the cell), the outer side's normal points up.
const flatSide = [[-20, 0], [20, 0]] as [number, number][];
const arrow = (style: Record<string, unknown> = {}, clip: { nx: number; ny: number; side: [number, number][]; reach: number } = { nx: 0, ny: -1, side: flatSide, reach: 1.5 }) =>
  ({ x: 0, y: 0, dx: 0, dy: 1, clip, style: { pattern: "triangle", color: 0xff0000, size: 12, thickness: 4, join: "round", cap: "round", gapColor: 0, gapWidth: 3, ...style } });
const sharpArrow = (style: Record<string, unknown> = {}, reach = 0) => arrow({ pattern: "arrow", join: "miter", cap: "square", size: 30, ...style }, { nx: 0, ny: -1, side: flatSide, reach });

function setup() {
  const container = new Container() as unknown as FakeBox;
  const renderer = new WaypointOpeningRenderer(container as never);
  const [gaps, main] = container.children as unknown as [FakeBox, Fake];
  return { renderer, gaps, main };
}

describe("gapClipPolygon (GitHub issue #330)", () => {
  it("covers the floor side of the outer side, up to `reach` past it", () => {
    const poly = gapClipPolygon(arrow() as never);
    // The normal points up (y < 0): the outward limit is `reach` above the wall point, the floor lies below.
    expect(Math.min(...ys(poly))).toBeCloseTo(-1.5);
    expect(Math.max(...ys(poly))).toBeGreaterThan(12);
  });

  it("stops at the wall point when the wall is cut", () => {
    expect(Math.min(...ys(gapClipPolygon(arrow({}, { nx: 0, ny: -1, side: flatSide, reach: 0 }) as never)))).toBeCloseTo(0);
  });

  it("grows with the pointer's size and gap width, so the ring always fits", () => {
    expect(extent(xs(gapClipPolygon(arrow({ gapWidth: 10 }) as never)))).toBeGreaterThan(extent(xs(gapClipPolygon(arrow({ gapWidth: 1 }) as never))));
    expect(extent(xs(gapClipPolygon(arrow({ size: 40 }) as never)))).toBeGreaterThan(extent(xs(gapClipPolygon(arrow({ size: 10 }) as never))));
  });

  it("follows a curved side instead of its tangent line, so a wall that bends outward is still cleared", () => {
    // The outward normal points up (y < 0); the side bends up on both flanks of the pointer.
    const bent: [number, number][] = [[-20, -8], [-10, -2], [0, 0], [10, -2], [20, -8]];
    const poly = gapClipPolygon(arrow({}, { nx: 0, ny: -1, side: bent, reach: 1.5 }) as never);
    expect(Math.min(...ys(poly))).toBeLessThan(-9);
    // Over the pointer itself the area still ends `reach` past the side.
    expect(Math.min(...ys(gapClipPolygon(arrow({}, { nx: 0, ny: -1, side: [[-1, 0], [0, 0], [1, 0]], reach: 1.5 }) as never)))).toBeCloseTo(-1.5);
  });

  it("reaches `span` below the deepest point of a strongly curved side, even for a small pointer", () => {
    // Normal up; the side's ends are 40 higher than its middle, which is the deepest point.
    const deep: [number, number][] = [[-60, -40], [0, 0], [60, -40]];
    const poly = gapClipPolygon(arrow({ size: 4, gapWidth: 1, thickness: 1 }, { nx: 0, ny: -1, side: deep, reach: 0 }) as never);
    expect(Math.max(...ys(poly))).toBeGreaterThan(8 * 0.99);
  });

  it("does not depend on the direction the side's path runs in", () => {
    const bent: [number, number][] = [[-20, -8], [-10, -2], [0, 0], [10, -2], [20, -8]];
    const ext = (side: [number, number][]) => {
      const poly = gapClipPolygon(arrow({}, { nx: 0, ny: -1, side, reach: 1.5 }) as never);
      return [Math.min(...ys(poly)), Math.max(...ys(poly)), Math.min(...xs(poly)), Math.max(...xs(poly))];
    };
    expect(ext([...bent].reverse())).toEqual(ext(bent));
  });

  it("follows the side's direction, not only horizontal ones", () => {
    expect(Math.max(...xs(gapClipPolygon(arrow({}, { nx: 1, ny: 0, side: [[0, -20], [0, 20]], reach: 2 }) as never)))).toBeCloseTo(2);
  });
});

describe("WaypointOpeningRenderer (GitHub issue #330)", () => {
  it("masks each gap ring with its own clip polygon, and the pointer itself is not masked", () => {
    const { renderer, gaps, main } = setup();
    renderer.render([arrow() as never]);
    const [mask, ring] = gaps.children;
    expect(ring.mask).toBe(mask);
    expect(polys(mask)).toEqual([gapClipPolygon(arrow() as never)]);
    expect(main.mask).toBeNull();
  });

  it("draws the gap ring and the pointer on separate layers", () => {
    const { renderer, gaps, main } = setup();
    renderer.render([sharpArrow() as never]);
    const ring = gaps.children[1];
    expect(polys(ring)).toHaveLength(1);
    expect(polys(main)).toHaveLength(1);
    // The gap ring is the pointer grown by the gap width, so it reaches further ahead.
    expect(Math.max(...ys(polys(ring)[0]))).toBeGreaterThan(Math.max(...ys(polys(main)[0])));
  });

  it("makes the ring wider by `reach` where the wall stays, so it clears the wall's outer half", () => {
    const ringTop = (reach: number) => {
      const { renderer, gaps } = setup();
      renderer.render([sharpArrow({}, reach) as never]);
      const copies = polys(gaps.children[1] as Fake);
      expect(copies).toHaveLength(1);
      return Math.min(...ys(copies[0]));
    };
    // The normal points up, so the outward end of the ring moves up by `reach`.
    expect(ringTop(0) - ringTop(3)).toBeCloseTo(3);
  });

  it("a wider gap draws a wider ring", () => {
    const ringWidth = (gapWidth: number) => {
      const { renderer, gaps } = setup();
      renderer.render([sharpArrow({ gapWidth }) as never]);
      return extent(xs(polys(gaps.children[1] as Fake)[0]));
    };
    expect(ringWidth(8)).toBeGreaterThan(ringWidth(2));
  });

  it("draws no gap layer without a gap width", () => {
    const { renderer, gaps, main } = setup();
    renderer.render([sharpArrow({ gapWidth: 0 }) as never]);
    expect(gaps.children).toHaveLength(0);
    expect(polys(main)).toHaveLength(1);
  });

  it.each(["triangle", "chevron", "arrow"] as const)("draws a %s pointer on the main layer and, with a gap, a ring on its own layer", (pattern) => {
    const { renderer, gaps, main } = setup();
    renderer.render([arrow({ pattern, join: "miter", cap: "square" }) as never]);
    expect(main.calls.length).toBeGreaterThan(0);
    expect((gaps.children[1] as Fake).calls.length).toBeGreaterThan(0);
  });

  it("destroys the rings, their masks and its own layers", () => {
    const { renderer, gaps, main } = setup();
    renderer.render([arrow() as never]);
    const [mask, ring] = gaps.children as Fake[];
    renderer.destroy();
    expect([mask.destroyed, ring.destroyed, main.destroyed, (gaps as unknown as Fake).destroyed]).toEqual([true, true, true, true]);
  });

  it("draws nothing without pointers and drops the masks and rings an earlier render made", () => {
    const { renderer, gaps, main } = setup();
    renderer.render([arrow() as never]);
    const [mask, ring] = gaps.children as Fake[];
    renderer.render([]);
    expect(gaps.children).toHaveLength(0);
    expect(mask.destroyed && ring.destroyed).toBe(true);
    expect(main.calls).toHaveLength(0);
  });
});
