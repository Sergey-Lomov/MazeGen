import { describe, it, expect, vi } from "vitest";

vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
    roundPoly(...args: unknown[]) { this.calls.push({ fn: "roundPoly", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
  }
  return { Graphics: FakeGraphics };
});

const { drawDirectionArrow, drawOneWayTriangle, drawOneWayChevron, drawOneWayChevronRow, chevronRowStep, drawOneWayArrow } = await import("../pixi/renderers/wallUtils");
const { Graphics } = await import("pixi.js");

type FakeG = InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] };
function newG(): FakeG {
  return new Graphics() as FakeG;
}

describe("drawOneWayTriangle", () => {
  it("positions the tip 65% ahead and the base 35% behind the wall's midpoint along (dx, dy)", () => {
    const g = newG();
    // dx=1,dy=0, size=20 (resolvedSize default*... use explicit style.size for a round number).
    drawOneWayTriangle(g, 0, 0, 1, 0, { size: 20 });
    const [roundPolyCall] = g.calls.filter((c) => c.fn === "roundPoly");
    const [cx, , radius] = roundPolyCall.args as [number, number, number, number, number, number];
    // tip = cx + radius (roundPoly's own vertex-0 distance from center along rotation).
    // Solved so tip lands at +0.65*length and base at -0.35*length from (0,0), length = size.
    const length = 20;
    const tip = cx + radius;
    const base = cx - radius * 0.5;
    expect(tip).toBeCloseTo(0.65 * length, 5);
    expect(base).toBeCloseTo(-0.35 * length, 5);
  });

  it("scales the tip/base split proportionally with size, keeping the 65/35 ratio", () => {
    const g = newG();
    drawOneWayTriangle(g, 0, 0, 1, 0, { size: 40 });
    const [roundPolyCall] = g.calls.filter((c) => c.fn === "roundPoly");
    const [cx, , radius] = roundPolyCall.args as [number, number, number, number, number, number];
    const length = 40;
    expect(cx + radius).toBeCloseTo(0.65 * length, 5);
    expect(cx - radius * 0.5).toBeCloseTo(-0.35 * length, 5);
  });

  it("rotates the polygon so vertex 0 points toward (dx, dy)", () => {
    const g = newG();
    drawOneWayTriangle(g, 5, 7, 0, 1, { size: 20 }); // pointing straight down
    const [roundPolyCall] = g.calls.filter((c) => c.fn === "roundPoly");
    const [, , , , , rotation] = roundPolyCall.args as [number, number, number, number, number, number];
    // roundPoly's vertex 0 sits at angle (-PI/2 + rotation); pointing "down" (angle PI/2) requires
    // rotation = PI/2 - (-PI/2) = PI.
    expect(rotation).toBeCloseTo(Math.PI, 5);
  });

  it("offsets the centroid along (dx, dy), not a fixed axis, for a diagonal direction", () => {
    const g = newG();
    const dx = Math.SQRT1_2, dy = Math.SQRT1_2; // 45 degrees
    drawOneWayTriangle(g, 0, 0, dx, dy, { size: 20 });
    const [roundPolyCall] = g.calls.filter((c) => c.fn === "roundPoly");
    const [cx, cy] = roundPolyCall.args as [number, number, number, number, number, number];
    // Centroid offset is a scalar along (dx, dy) — x and y components must match dx/dy's ratio.
    expect(cx).toBeCloseTo(cy, 10);
  });

  it("applies zero corner rounding when join is miter", () => {
    const g = newG();
    drawOneWayTriangle(g, 0, 0, 1, 0, { size: 20, join: "miter" });
    const [roundPolyCall] = g.calls.filter((c) => c.fn === "roundPoly");
    const [, , , , corner] = roundPolyCall.args as [number, number, number, number, number, number];
    expect(corner).toBe(0);
  });

  it("applies nonzero corner rounding when join is round (including the default)", () => {
    const g = newG();
    drawOneWayTriangle(g, 0, 0, 1, 0, { size: 20 });
    const [roundPolyCall] = g.calls.filter((c) => c.fn === "roundPoly");
    const [, , , , corner] = roundPolyCall.args as [number, number, number, number, number, number];
    expect(corner).toBeGreaterThan(0);
  });

  it("fills without a gap stroke when gapWidth is unset or zero", () => {
    const g = newG();
    drawOneWayTriangle(g, 0, 0, 1, 0, { size: 20 });
    expect(g.calls.filter((c) => c.fn === "fill")).toHaveLength(1);
    expect(g.calls.filter((c) => c.fn === "stroke")).toHaveLength(0);
  });

  it("draws a gap stroke with outside alignment when gapWidth is set", () => {
    const g = newG();
    drawOneWayTriangle(g, 0, 0, 1, 0, { size: 20, gapWidth: 3, gapColor: 0xabcdef });
    const [strokeCall] = g.calls.filter((c) => c.fn === "stroke");
    expect(strokeCall.args[0]).toMatchObject({ width: 3, color: 0xabcdef, alignment: 0 });
  });
});

describe("drawOneWayChevron", () => {
  it("uses the thickness style knob for its stroke width, independent of size", () => {
    const g = newG();
    drawOneWayChevron(g, 0, 0, 1, 0, { size: 20, thickness: 7 });
    const [strokeCall] = g.calls.filter((c) => c.fn === "stroke");
    expect(strokeCall.args[0]).toMatchObject({ width: 7 });
  });

  it("draws a wider gap pass before the main stroke when gapWidth is set", () => {
    const g = newG();
    drawOneWayChevron(g, 0, 0, 1, 0, { size: 20, thickness: 4, gapWidth: 2, gapColor: 0x111111 });
    const strokeCalls = g.calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(2);
    expect(strokeCalls[0].args[0]).toMatchObject({ width: 4 + 2 * 2, color: 0x111111 });
    expect(strokeCalls[1].args[0]).toMatchObject({ width: 4 });
  });

  it("draws only the main stroke when gapWidth is unset", () => {
    const g = newG();
    drawOneWayChevron(g, 0, 0, 1, 0, { size: 20, thickness: 4 });
    expect(g.calls.filter((c) => c.fn === "stroke")).toHaveLength(1);
  });

  it("uses the width style knob for its opening, independent of size", () => {
    const g1 = newG();
    drawOneWayChevron(g1, 0, 0, 1, 0, { size: 20 });
    const [moveTo1] = g1.calls.filter((c) => c.fn === "moveTo");
    const [, y1] = moveTo1.args as [number, number];

    const g2 = newG();
    drawOneWayChevron(g2, 0, 0, 1, 0, { size: 20, width: 100 });
    const [moveTo2] = g2.calls.filter((c) => c.fn === "moveTo");
    const [, y2] = moveTo2.args as [number, number];

    expect(y2).not.toBeCloseTo(y1, 5);
    expect(Math.abs(y2)).toBeCloseTo(100, 5);
  });
});

describe("drawOneWayChevronRow", () => {
  it("draws `count` chevrons (one stroke pass each, no gap)", () => {
    const g = newG();
    drawOneWayChevronRow(g, 0, 0, 1, 0, 3, 10, 5, { thickness: 4 });
    expect(g.calls.filter((c) => c.fn === "moveTo")).toHaveLength(3);
    expect(g.calls.filter((c) => c.fn === "stroke")).toHaveLength(3);
  });

  it("centers the row on (cx, cy) — the two chevrons' own centers are equidistant from it", () => {
    const g = newG();
    drawOneWayChevronRow(g, 0, 0, 1, 0, 2, 10, 6, { thickness: 4 });
    const lineTos = g.calls.filter((c) => c.fn === "lineTo");
    // Each chevron's tip sits at its own center + size (drawOneWayChevron's own convention) — so
    // each chevron's own center = tipX - length (length = 10 here).
    const firstCenterX = (lineTos[0].args as [number, number])[0] - 10;
    const secondCenterX = (lineTos[2].args as [number, number])[0] - 10;
    expect(firstCenterX + secondCenterX).toBeCloseTo(0, 5);
  });

  it("draws a single chevron centered on (cx, cy) when count is 1", () => {
    const g = newG();
    drawOneWayChevronRow(g, 5, 7, 0, 1, 1, 20, 5, { thickness: 4 });
    const single = newG();
    drawOneWayChevron(single, 5, 7, 0, 1, { thickness: 4, size: 20 });
    expect(g.calls).toEqual(single.calls);
  });

  it("spaces adjacent chevrons by length + gap + thickness (GitHub issue #312 follow-up)", () => {
    const length = 10;
    const gap = 1;
    const thickness = 10; // a thick stroke must not eat into a small gap
    const g = newG();
    drawOneWayChevronRow(g, 0, 0, 1, 0, 2, length, gap, { thickness });
    const lineTos = g.calls.filter((c) => c.fn === "lineTo");
    const firstTipX = (lineTos[0].args as [number, number])[0]; // first chevron's own tip
    const secondTipX = (lineTos[2].args as [number, number])[0]; // second chevron's own tip
    expect(secondTipX - firstTipX).toBeCloseTo(length + gap + thickness, 5);
  });
});

describe("chevronRowStep", () => {
  it("computes length + gap + thickness", () => {
    expect(chevronRowStep(10, 1, 10)).toBeCloseTo(10 + 1 + 10, 5);
  });
});

describe("drawOneWayArrow", () => {
  it("ends the shaft at the arrowhead's base, not the tip", () => {
    const g = newG();
    drawOneWayArrow(g, 0, 0, 1, 0, { size: 20, thickness: 4 });
    const [firstLineTo] = g.calls.filter((c) => c.fn === "lineTo");
    const [x] = firstLineTo.args as [number, number];
    // tip would be at x=20; the shaft's first lineTo must stop short of it, at the arrowhead base
    // (headSize = size*0.5 back from the tip => x = 20 - 10 = 10).
    expect(x).toBeCloseTo(10, 5);
    expect(x).toBeLessThan(20);
  });

  it("uses the thickness style knob for its stroke width, independent of size", () => {
    const g = newG();
    drawOneWayArrow(g, 0, 0, 1, 0, { size: 20, thickness: 9 });
    const [strokeCall] = g.calls.filter((c) => c.fn === "stroke");
    expect(strokeCall.args[0]).toMatchObject({ width: 9 });
  });

  it("draws a wider gap pass before the main stroke when gapWidth is set", () => {
    const g = newG();
    drawOneWayArrow(g, 0, 0, 1, 0, { size: 20, thickness: 4, gapWidth: 2, gapColor: 0x111111 });
    const strokeCalls = g.calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(2);
    expect(strokeCalls[0].args[0]).toMatchObject({ width: 4 + 2 * 2, color: 0x111111 });
  });
});

describe("drawDirectionArrow", () => {
  it("points the tip toward (dx, dy) at the given size", () => {
    const g = newG();
    drawDirectionArrow(g, 0, 0, 1, 0, 10);
    const [polyCall] = g.calls.filter((c) => c.fn === "poly");
    const [points] = polyCall.args as [number[]];
    const [tipX, tipY] = points;
    expect(tipX).toBeCloseTo(10, 5);
    expect(tipY).toBeCloseTo(0, 5);
  });

  it("fills with the given color, falling back to canvas.edge.oneWay when unset", async () => {
    const { canvas } = await import("../pixi/colorTokens");
    const g = newG();
    drawDirectionArrow(g, 0, 0, 1, 0, 10);
    const [fillCall] = g.calls.filter((c) => c.fn === "fill");
    expect(fillCall.args[0]).toEqual({ color: canvas.edge.oneWay, alpha: 1 });

    const g2 = newG();
    drawDirectionArrow(g2, 0, 0, 1, 0, 10, 0x123456);
    const [fillCall2] = g2.calls.filter((c) => c.fn === "fill");
    expect(fillCall2.args[0]).toEqual({ color: 0x123456, alpha: 1 });
  });

  it("fills at the given alpha", () => {
    const g = newG();
    drawDirectionArrow(g, 0, 0, 1, 0, 10, 0x123456, 0.4);
    const [fillCall] = g.calls.filter((c) => c.fn === "fill");
    expect(fillCall.args[0]).toEqual({ color: 0x123456, alpha: 0.4 });
  });
});
