import { describe, it, expect, vi } from "vitest";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

// `getCartesian` (cartesianCache.ts) delegates to wasm, unavailable in this unit-test environment
// — same mock `tessellationGeometry.test.ts` uses, canonical (unit-tile-scale) square formula.
vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number): [number, number] => [x, y],
}));

vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
    roundPoly(...args: unknown[]) { this.calls.push({ fn: "roundPoly", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    arcTo(...args: unknown[]) { this.calls.push({ fn: "arcTo", args }); return this; }
    closePath(...args: unknown[]) { this.calls.push({ fn: "closePath", args }); return this; }
  }
  return { Graphics: FakeGraphics };
});

const { drawDirectionArrow, drawOneWayTriangle, drawOneWayChevron, drawOneWayChevronRow, chevronRowStep, drawOneWayArrow, drawOneWayWallHighlight, drawCellBoundaryHighlight, clampBoundaryInset, cellBoundaryKey, MAP_ONE_WAY_SIZE } = await import("../pixi/renderers/wallUtils");
const { Graphics } = await import("pixi.js");

type FakeG = InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] };
function newG(): FakeG {
  return new Graphics() as FakeG;
}

describe("drawOneWayTriangle", () => {
  it("positions the tip at 0.65*length, base at -0.35*length, length = 1.5*radius, radius = size/2 (GitHub issue #681 third follow-up: `size` is the triangle's own circumscribed-circle diameter)", () => {
    const g = newG();
    // dx=1,dy=0, size=20 (resolvedSize default*... use explicit style.size for a round number).
    drawOneWayTriangle(g, 0, 0, 1, 0, { size: 20 });
    const [roundPolyCall] = g.calls.filter((c) => c.fn === "roundPoly");
    const [cx, , radius] = roundPolyCall.args as [number, number, number, number, number, number];
    const size = 20;
    const expectedRadius = size * 0.5;
    const expectedLength = 1.5 * expectedRadius;
    const tip = cx + radius;
    const base = cx - radius * 0.5;
    expect(tip).toBeCloseTo(0.65 * expectedLength, 5);
    expect(base).toBeCloseTo(-0.35 * expectedLength, 5);
  });

  it("scales the tip/base split proportionally with size", () => {
    const g = newG();
    drawOneWayTriangle(g, 0, 0, 1, 0, { size: 40 });
    const [roundPolyCall] = g.calls.filter((c) => c.fn === "roundPoly");
    const [cx, , radius] = roundPolyCall.args as [number, number, number, number, number, number];
    const size = 40;
    const expectedRadius = size * 0.5;
    const expectedLength = 1.5 * expectedRadius;
    expect(cx + radius).toBeCloseTo(0.65 * expectedLength, 5);
    expect(cx - radius * 0.5).toBeCloseTo(-0.35 * expectedLength, 5);
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
    // Each chevron's tip sits at its own center + width/1.4 (drawOneWayChevron's own convention,
    // with no `style.width` override here, width = size*0.5*WINGSPAN_FRACTION = 3.75) — so each
    // chevron's own center = tipX - (3.75 / 1.4).
    const tipOffset = (10 * 0.5 * 0.75) / 1.4;
    const firstCenterX = (lineTos[0].args as [number, number])[0] - tipOffset;
    const secondCenterX = (lineTos[2].args as [number, number])[0] - tipOffset;
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
    // half = size*0.5*WINGSPAN_FRACTION = 7.5, tip at x=7.5; the shaft's first lineTo must stop
    // short of it, at the arrowhead base (headSize = half*0.5 = 3.75 back from the tip => x =
    // 7.5 - 3.75 = 3.75).
    expect(x).toBeCloseTo(3.75, 5);
    expect(x).toBeLessThan(7.5);
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

  it("fills a pentagon patch between the shaft's stroked edges and the wings' stroked edges, closing the notch between them for any corner style", () => {
    // GitHub issue #690: the shaft's stroked outline and the wings' stroked outline are two
    // separate open paths (the shaft ends on-axis, the wings start off-axis) — no cap style can
    // close the gap/protrusion between them on its own. The pentagon is the shaft's own two side
    // edges extended forward to where they meet each wing's own outer edge, then straight to the
    // tip, filled solid so the shaft reads as flush with the arrowhead regardless of corner style.
    const g = newG();
    drawOneWayArrow(g, 0, 0, 1, 0, { size: 20, thickness: 4 });
    const polyCall = g.calls.find((c) => c.fn === "poly");
    expect(polyCall).toBeDefined();
    const [points] = polyCall!.args as [number[]];
    expect(points).toHaveLength(10); // 5 points
    // The pentagon's tip vertex (3rd point) must be the arrowhead's own tip.
    // half = size*0.5*WINGSPAN_FRACTION = 7.5 => tip at x=7.5.
    expect(points[4]).toBeCloseTo(7.5, 5);
    expect(points[5]).toBeCloseTo(0, 5);
    const fillCall = g.calls.find((c) => c.fn === "fill");
    expect(fillCall).toBeDefined();
  });

  it("widens the pentagon's own base past the arrowhead's natural wing-base span when the shaft is thicker than it", () => {
    // Small arrowhead with an independently-set, comparatively thick stroke can make the shaft
    // thicker than the wings' own base offset (headSize * 0.6) — the pentagon's two base corners
    // must still sit exactly on the shaft's own side lines (shaftHalf off-axis), not narrower, so
    // the shaft's sides are never left poking out past the patch.
    const g = newG();
    drawOneWayArrow(g, 0, 0, 1, 0, { size: 20, thickness: 8 });
    const polyCall = g.calls.find((c) => c.fn === "poly");
    const [points] = polyCall!.args as [number[]];
    // First point's lateral (y) coordinate must be exactly shaftHalf = 4.
    expect(Math.abs(points[1])).toBeCloseTo(4, 5);
  });

  it("disables the joint patch entirely below the minimum size, where its clamped geometry would itself look wrong", () => {
    // GitHub issue #690 follow-up: at very small sizes the patch's own geometry (clamped against
    // the arrow's short axis) produced visible artifacts — better to skip it than draw it
    // degenerate. The plain shaft+wing strokes (pre-patch behavior) are used instead below size 20.
    const g = newG();
    drawOneWayArrow(g, 0, 0, 1, 0, { size: 19, thickness: 4 });
    const polyCall = g.calls.find((c) => c.fn === "poly");
    expect(polyCall).toBeUndefined();
  });

  it("fills a second, wider joint patch in the gap color when gapWidth is set, matching the gap ring's own width", () => {
    // The gap ring is its own separately-stroked, wider outline with the same on-axis/off-axis
    // notch as the main shape — without its own patch, the main patch (drawn at the narrower main
    // stroke width) would leave the gap ring's own wider notch unfixed.
    const g = newG();
    drawOneWayArrow(g, 0, 0, 1, 0, { size: 20, thickness: 4, gapWidth: 2, gapColor: 0x111111 });
    const polyCalls = g.calls.filter((c) => c.fn === "poly");
    const fillCalls = g.calls.filter((c) => c.fn === "fill");
    expect(polyCalls).toHaveLength(2); // gap patch, then main patch
    expect(fillCalls).toHaveLength(2);
    expect(fillCalls[0].args[0]).toMatchObject({ color: 0x111111 });
    // The gap patch's own base half-width (4+2*2)/2 = 4 must be wider than the main patch's (2).
    const [gapPoints] = polyCalls[0].args as [number[]];
    const [mainPoints] = polyCalls[1].args as [number[]];
    expect(Math.abs(gapPoints[1])).toBeCloseTo(4, 5);
    expect(Math.abs(mainPoints[1])).toBeCloseTo(2, 5);
  });

  it("clamps the patch's own base to the arrowhead's base (never behind it, let alone past the tail) when thickness is extreme relative to size", () => {
    // headSize = (size*0.5*WINGSPAN_FRACTION)*0.5 = 3.75 for size=20; a thickness of 100 would
    // otherwise solve for a meeting point far behind the tail. The clamp keeps the patch's base at
    // or ahead of headBack (axial distance 0 from it) instead of producing a degenerate shape.
    const g = newG();
    drawOneWayArrow(g, 0, 0, 1, 0, { size: 20, thickness: 100 });
    const polyCall = g.calls.find((c) => c.fn === "poly");
    const [points] = polyCall!.args as [number[]];
    // headBackX = tipX - headSize = 3.75 - 3.75 = 0. Base corners' axial (x) coordinate must be
    // at or ahead of headBackX, never negative (which would be behind headBack, toward the tail).
    expect(points[0]).toBeGreaterThanOrEqual(0 - 1e-9);
    expect(points[8]).toBeGreaterThanOrEqual(0 - 1e-9);
  });

  it("does not throw when size is 0 (degenerate, zero-length arrow; patch is skipped below the minimum size)", () => {
    const g = newG();
    expect(() => drawOneWayArrow(g, 0, 0, 1, 0, { size: 0, thickness: 4 })).not.toThrow();
    const polyCall = g.calls.find((c) => c.fn === "poly");
    expect(polyCall).toBeUndefined();
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

describe("drawOneWayWallHighlight", () => {
  const cfg: TessellationConfig = { type: "square", width: 5, height: 5 };

  it("returns true and strokes the shared wall plus a gapless triangle for tessellation-adjacent cells", () => {
    const g = newG();
    const drew = drawOneWayWallHighlight(g, [0, 0], [1, 0], cfg, 0xff0000, 3, 0.9);

    expect(drew).toBe(true);
    const strokeCall = g.calls.find((c) => c.fn === "stroke");
    expect(strokeCall!.args[0]).toMatchObject({ width: 3, color: 0xff0000, alpha: 0.9 });
    const fillCall = g.calls.find((c) => c.fn === "fill");
    expect(fillCall!.args[0]).toBe(0xff0000); // drawOneWayTriangle's own no-gap fill call shape
    // No gap stroke pass — only the one wall-line stroke above, none from drawOneWayTriangle
    // itself (it only adds a stroke when `gapWidth` is set, which this caller never passes).
    expect(g.calls.filter((c) => c.fn === "stroke")).toHaveLength(1);
  });

  it("uses the map's own one-way indicator size (MAP_ONE_WAY_SIZE), not the smaller generic default", () => {
    const g = newG();
    drawOneWayWallHighlight(g, [0, 0], [1, 0], cfg, 0xff0000, 3, 0.9);
    const [roundPolyCall] = g.calls.filter((c) => c.fn === "roundPoly");
    const [, , radius] = roundPolyCall.args as [number, number, number];
    // radius = size*0.5, size = MAP_ONE_WAY_SIZE here (GitHub issue #681 third follow-up: `size`
    // is the triangle's own circumscribed-circle diameter).
    expect(radius).toBeCloseTo(MAP_ONE_WAY_SIZE * 0.5, 5);
  });

  it("returns false and draws nothing for two cells that aren't tessellation-adjacent", () => {
    const g = newG();
    const drew = drawOneWayWallHighlight(g, [0, 0], [4, 4], cfg, 0xff0000, 3, 0.9);

    expect(drew).toBe(false);
    expect(g.calls).toHaveLength(0);
  });
});

describe("drawCellBoundaryHighlight", () => {
  it("uses one key for both directions of the same boundary", () => {
    expect(cellBoundaryKey([1, 2], [3, 4])).toBe(cellBoundaryKey([3, 4], [1, 2]));
  });

  const cfg: TessellationConfig = { type: "square", width: 5, height: 5 };

  it("draws a rounded, stroked quad spanning the shared edge and both cell halves", () => {
    const g = newG();
    expect(drawCellBoundaryHighlight(g, [0, 0], [1, 0], cfg, 0xff0000, 1, 2)).toBe(true);
    expect(g.calls.filter((call) => call.fn === "arcTo").length).toBeGreaterThan(0);
    expect(g.calls.find((call) => call.fn === "stroke")!.args[0]).toMatchObject({ width: 2, color: 0xff0000, alpha: 1 });
    expect(g.calls.find((call) => call.fn === "fill")!.args[0]).toEqual({ color: 0xff0000, alpha: 1 });
  });

  it("keeps the fill when the border is disabled", () => {
    const g = newG();
    expect(drawCellBoundaryHighlight(g, [0, 0], [1, 0], cfg, 0xff0000, 0.4, 0)).toBe(true);
    expect(g.calls.find((call) => call.fn === "fill")!.args[0]).toEqual({ color: 0xff0000, alpha: 0.4 });
    expect(g.calls.find((call) => call.fn === "stroke")).toBeUndefined();
  });

  it("shrinks the quad along the edge's own tangent when inset is set (GitHub issue #627)", () => {
    const plain = newG();
    drawCellBoundaryHighlight(plain, [0, 0], [1, 0], cfg, 0xff0000, 1, 0);
    const inset = newG();
    drawCellBoundaryHighlight(inset, [0, 0], [1, 0], cfg, 0xff0000, 1, 0, undefined, 0.3);

    const startOf = (g: FakeG) => g.calls.find((call) => call.fn === "moveTo")!.args as [number, number];
    const [plainX, plainY] = startOf(plain);
    const [insetX, insetY] = startOf(inset);
    // The shared edge for two horizontally adjacent square cells is vertical, so the tangent
    // shift is along y; the perpendicular (x) span must stay untouched.
    expect(insetX).toBeCloseTo(plainX, 5);
    expect(Math.abs(insetY)).toBeLessThan(Math.abs(plainY));
  });

});

describe("clampBoundaryInset", () => {
  it("passes a small inset through unchanged", () => {
    expect(clampBoundaryInset(3, 40)).toBe(3);
  });

  it("never goes negative for a short edge, even though edgeLength / 2 - 1 is itself negative", () => {
    // A naive `min(max(inset, 0), edgeLength / 2 - 1)` clamp order fails here: the upper bound
    // `edgeLength / 2 - 1` evaluates to -0.5 for edgeLength=1, so `max(inset, 0)` (>= 0) clamped
    // against a negative upper bound goes negative — flipping the tangent-inset direction instead
    // of shrinking to zero (GitHub issue #627 follow-up).
    expect(clampBoundaryInset(5, 1)).toBe(0);
    expect(clampBoundaryInset(0, 1)).toBe(0);
  });

  it("caps at half the edge length minus 1px so the quad never collapses or crosses over", () => {
    expect(clampBoundaryInset(1000, 40)).toBe(19);
  });
});
