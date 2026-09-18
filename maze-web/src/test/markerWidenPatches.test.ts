import { describe, it, expect } from "vitest";
import { drawMarkerWidenPatches } from "../pixi/renderers/markerWidenPatches";
import type { MarkerData } from "../pixi/renderers/types";

class FakeGraphics {
  calls: { fn: string; args: unknown[] }[] = [];
  circle(...args: unknown[]) { this.calls.push({ fn: "circle", args }); return this; }
  poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
  arcTo(...args: unknown[]) { this.calls.push({ fn: "arcTo", args }); return this; }
  moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
  closePath(...args: unknown[]) { this.calls.push({ fn: "closePath", args }); return this; }
  fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
  stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
}

function g() {
  return new FakeGraphics() as unknown as import("pixi.js").Graphics & FakeGraphics;
}

describe("drawMarkerWidenPatches", () => {
  it("draws one filled patch per marker, in the line's own color", () => {
    const graphics = g();
    const markers: MarkerData[] = [
      { pos: [5, 5], color: 0x111, radius: 10 },
      { pos: [20, 5], color: 0x222, radius: 8 },
    ];
    drawMarkerWidenPatches(graphics, markers, 0xabcdef, 4, 3);
    const polyCalls = graphics.calls.filter((c) => c.fn === "poly");
    const fillCalls = graphics.calls.filter((c) => c.fn === "fill");
    // Each patch draws its own path twice (fill + outward stroke, `drawMarkerUnderlay`) — 4 total.
    expect(polyCalls).toHaveLength(4);
    expect(fillCalls).toHaveLength(2);
    expect((fillCalls[0].args[0] as { color: number }).color).toBe(0xabcdef);
    expect((fillCalls[1].args[0] as { color: number }).color).toBe(0xabcdef);
  });

  it("patch radius is the marker's own visible footprint (radius + borderWidth + gapWidth) when that exceeds the line's half-width — drawn as a single true outward offset of the marker's own fill radius by borderWidth + extra, not a rescaled bigger shape (GitHub issue #552 second and sixth follow-up)", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 10, borderWidth: 3, gapWidth: 2 }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 4, 1); // line half-width 2, padding 1
    const [firstPoints] = graphics.calls.find((c) => c.fn === "poly")!.args as [number[]];
    const baseRadius = Math.max(...Array.from({ length: firstPoints.length / 2 }, (_, i) => Math.hypot(firstPoints[i * 2], firstPoints[i * 2 + 1])));
    expect(baseRadius).toBeCloseTo(10); // the marker's own fill radius, not the outer or footprint radius
    const strokeArgs = graphics.calls.find((c) => c.fn === "stroke")!.args[0] as { width: number };
    expect(strokeArgs.width).toBe(6); // borderWidth 3 + extra 3, extra = footprint 16 - outer radius 13
  });

  it("borderWidth alone (no gapWidth, minimal padding) still draws an outward offset matching the border's own width, so the patch tracks the marker's true outer edge instead of stopping at the bare fill radius (GitHub issue #552 sixth follow-up)", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 10, borderWidth: 2 }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 4, 1); // line half-width 2, footprint 13
    const [firstPoints] = graphics.calls.find((c) => c.fn === "poly")!.args as [number[]];
    const baseRadius = Math.max(...Array.from({ length: firstPoints.length / 2 }, (_, i) => Math.hypot(firstPoints[i * 2], firstPoints[i * 2 + 1])));
    expect(baseRadius).toBeCloseTo(10); // the marker's own fill radius
    const strokeArgs = graphics.calls.find((c) => c.fn === "stroke")!.args[0] as { width: number };
    expect(strokeArgs.width).toBe(3); // borderWidth 2 + extra 1, extra = footprint 13 - outer radius 12
  });

  it("padding <= 0 draws no widen patch at all, regardless of borderWidth/gapWidth (GitHub issue #552 seventh follow-up: padding is this feature's own on/off switch)", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 10, borderWidth: 5, gapWidth: 5 }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 4, 0);
    expect(graphics.calls).toHaveLength(0);
  });

  it("patch radius is floored at the line's own half-width for a marker smaller than the stroke", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 1 }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 20, 1); // line half-width 10, marker footprint 2
    const [firstPoints] = graphics.calls.find((c) => c.fn === "poly")!.args as [number[]];
    const baseRadius = Math.max(...Array.from({ length: firstPoints.length / 2 }, (_, i) => Math.hypot(firstPoints[i * 2], firstPoints[i * 2 + 1])));
    expect(baseRadius).toBeCloseTo(1);
    const strokeArgs = graphics.calls.find((c) => c.fn === "stroke")!.args[0] as { width: number };
    expect(strokeArgs.width).toBe(9); // halfWidth-floored patchRadius 10 - base radius 1
  });

  it("padding is added on top of the marker's own footprint", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 10 }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 4, 5); // footprint 10, padding 5
    const [firstPoints] = graphics.calls.find((c) => c.fn === "poly")!.args as [number[]];
    const baseRadius = Math.max(...Array.from({ length: firstPoints.length / 2 }, (_, i) => Math.hypot(firstPoints[i * 2], firstPoints[i * 2 + 1])));
    expect(baseRadius).toBeCloseTo(10);
    const strokeArgs = graphics.calls.find((c) => c.fn === "stroke")!.args[0] as { width: number };
    expect(strokeArgs.width).toBe(5); // padding
  });

  it("draws the marker's own shape, not always a circle", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 10, shape: "square" }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 4, 3);
    // Path drawn twice (fill + outward stroke, `drawMarkerUnderlay`).
    expect(graphics.calls.filter((c) => c.fn === "poly")).toHaveLength(2);
    expect(graphics.calls.filter((c) => c.fn === "circle")).toHaveLength(0);
  });

  it("rounds the patch's corners when the marker's own cornerStyle is 'round'", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 10, shape: "square", cornerStyle: "round" }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 4, 3);
    expect(graphics.calls.filter((c) => c.fn === "arcTo").length).toBeGreaterThan(0);
    expect(graphics.calls.filter((c) => c.fn === "poly")).toHaveLength(0);
  });

  it("shapeOverride 'square' forces every patch square regardless of the marker's own shape", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 10, shape: "circle" }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 4, 3, "square", "sharp");
    expect(graphics.calls.filter((c) => c.fn === "poly")).toHaveLength(2);
    expect(graphics.calls.filter((c) => c.fn === "circle")).toHaveLength(0);
  });

  // GitHub issue #485 follow-up: the cross-floor badge marker is not special-cased any more — its
  // widen patch obeys `markerWidenShape` exactly like an ordinary marker.
  it("shapeOverride 'circle' also flattens a badge-shaped (hexagon) marker to a circle", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 10, shape: "hexagon", cornerStyle: "sharp" }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 4, 3, "circle");
    expect(graphics.calls.filter((c) => c.fn === "poly")).toHaveLength(2);
    expect(graphics.calls.filter((c) => c.fn === "circle")).toHaveLength(0);
  });

  it("shapeOverride 'match_marker' copies a badge-shaped (hexagon) marker's own shape", () => {
    const graphics = g();
    const markers: MarkerData[] = [{ pos: [0, 0], color: 0x111, radius: 10, shape: "hexagon", cornerStyle: "sharp" }];
    drawMarkerWidenPatches(graphics, markers, 0x000000, 4, 3, "match_marker");
    expect(graphics.calls.filter((c) => c.fn === "poly")).toHaveLength(2);
    expect(graphics.calls.filter((c) => c.fn === "circle")).toHaveLength(0);
  });

  it("no markers -> no draw calls", () => {
    const graphics = g();
    drawMarkerWidenPatches(graphics, [], 0x000000, 4, 0);
    expect(graphics.calls).toHaveLength(0);
  });
});
