import { describe, expect, it } from "vitest";
import { getFieldAreaStats, warmCartesianCache } from "../pixi/cartesianCache";
import { areaScaleFactor, buildMarkerScaler, hasCellAreaSpread, NO_MARKER_SCALING } from "../pixi/markerScale";
import { footprintsOfMarkers, footprintsOfVertical } from "../pixi/markerFootprints";
import type { VerticalConnectionMarker, VerticalConnectionStyle } from "../pixi/renderers/types";
import { WaypointsRenderer } from "../pixi/renderers/WaypointsRenderer";
import { Container } from "pixi.js";
import type { MarkerData } from "../pixi/renderers/types";
import { fieldOf } from "./fieldConfigFixtures";

const mixed = fieldOf("square_octagon", { shape: "circle", radius: 3 });
const uniform = fieldOf("square", { shape: "circle", radius: 3 });

describe("cell area stats", () => {
  it("report mean/min/max over the field cells", () => {
    warmCartesianCache(mixed);
    const stats = getFieldAreaStats(mixed)!;
    expect(stats.min).toBeLessThan(stats.mean);
    expect(stats.max).toBeGreaterThan(stats.mean);
  });

  it("show spread only for non-uniform tessellations", () => {
    expect(hasCellAreaSpread(mixed)).toBe(true);
    expect(hasCellAreaSpread(uniform)).toBe(false);
  });
});

describe("areaScaleFactor", () => {
  it("is 1 at 0%, sqrt-proportional at 100%, and 1 for the mean cell", () => {
    expect(areaScaleFactor(4, 1, 0)).toBe(1);
    expect(areaScaleFactor(4, 1, 1)).toBeCloseTo(2);
    expect(areaScaleFactor(4, 1, 0.5)).toBeCloseTo(4 ** 0.25);
    expect(areaScaleFactor(3, 3, 1)).toBe(1);
  });
});

describe("buildMarkerScaler", () => {
  const stats = () => getFieldAreaStats(mixed)!;
  const at = (pos: [number, number], radius: number, sizeAdaptation: number): MarkerData => ({ pos, radius, color: 0, sizeAdaptation });

  it("is identity at 0% and on uniform fields", () => {
    warmCartesianCache(mixed);
    expect(buildMarkerScaler(mixed, footprintsOfMarkers([at([0.5, 0.5], 0.01, 0)]))).toBe(NO_MARKER_SCALING);
    warmCartesianCache(uniform);
    expect(buildMarkerScaler(uniform, footprintsOfMarkers([at([0.5, 0.5], 0.01, 1)]))).toBe(NO_MARKER_SCALING);
  });

  it("scales a tiny marker by its cell's area within the field's area range", () => {
    warmCartesianCache(mixed);
    const s = stats();
    const scaler = buildMarkerScaler(mixed, footprintsOfMarkers([at([0, 0], 0.001, 1)]));
    const f = scaler.factorAt([0, 0], 1);
    expect(f).toBeGreaterThanOrEqual(Math.sqrt(s.min / s.mean) - 1e-9);
    expect(f).toBeLessThanOrEqual(Math.sqrt(s.max / s.mean) + 1e-9);
  });

  it("gives markers of different adaptation in one cell different factors", () => {
    warmCartesianCache(mixed);
    const scaler = buildMarkerScaler(mixed, footprintsOfMarkers([at([0, 0], 0.001, 1), at([0, 0], 0.001, 0.5)]));
    const full = scaler.factorAt([0, 0], 1);
    const half = scaler.factorAt([0, 0], 0.5);
    expect(full).not.toBeCloseTo(1, 6);
    expect(half).toBeCloseTo(Math.sqrt(full), 6);
    expect(scaler.factorAt([0, 0], 0)).toBe(1);
  });

  it("never grows a marker past its cell", () => {
    warmCartesianCache(mixed);
    // A marker already as big as a cell can't grow, whatever its cell asks for.
    const big = buildMarkerScaler(mixed, footprintsOfMarkers([at([0, 0], 100, 1)]));
    expect(big.factorAt([0, 0], 1)).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("footprintsOfVertical", () => {
  const marker = (overrides: Partial<VerticalConnectionMarker>): VerticalConnectionMarker => ({ pos: [1, 2], fromNode: 0, kind: "vertical_passage", filled: true, arrowFilled: true, ...overrides });
  const abstractMarker = (size: number, adaptation: number) => ({ shape: "square" as const, size, sizeAdaptation: adaptation, borderWidth: 2, gapWidth: 3 });
  const decorative = (size: number, adaptation: number) => ({ size, sizeAdaptation: adaptation, lineWidth: 6, lineColor: 0 });
  const style = {
    style: "abstract",
    twoWayPassageMarker: abstractMarker(10, 0.1),
    oneWayPassageMarker: abstractMarker(12, 0.2),
    elevatorMarker: abstractMarker(14, 0.3),
    decorativeStairsTwoWay: decorative(20, 0.4),
    decorativeStairsOneWay: decorative(22, 0.5),
    decorativeElevator: decorative(24, 0.6),
  } as unknown as VerticalConnectionStyle;

  it("picks each kind's own abstract settings; border and gap ring scale with the marker", () => {
    const fps = footprintsOfVertical([marker({}), marker({ filled: false }), marker({ kind: "elevator" })], style);
    expect(fps.map((f) => [f.radius, f.adaptation, f.outset, f.outsetScales, f.shape])).toEqual([
      [5, 0.1, 5, true, "square"], [6, 0.2, 5, true, "square"], [7, 0.3, 5, true, "square"],
    ]);
  });

  it("picks each kind's own decorative line; the half line width is the scaling outset", () => {
    const fps = footprintsOfVertical([marker({}), marker({ filled: false }), marker({ kind: "elevator" })], { ...style, style: "decorative" });
    expect(fps.map((f) => [f.radius, f.adaptation, f.outset, f.outsetScales])).toEqual([
      [10, 0.4, 3, true], [11, 0.5, 3, true], [12, 0.6, 3, true],
    ]);
  });

  it("caps a scaling-outset marker earlier than the same marker with a fixed outset", () => {
    warmCartesianCache(mixed);
    const base = { pos: [0, 0] as [number, number], shape: "circle" as const, radius: 0.001, outset: 0.2, adaptation: 1 };
    const fixed = buildMarkerScaler(mixed, [base]).factorAt([0, 0], 1);
    const scaling = buildMarkerScaler(mixed, [{ ...base, outsetScales: true }]).factorAt([0, 0], 1);
    expect(scaling).toBeLessThanOrEqual(fixed + 1e-9);
  });
});

describe("buildMarkerScaler fallback", () => {
  it("never returns more than maxFactor for a position without a footprint", () => {
    warmCartesianCache(mixed);
    const scaler = buildMarkerScaler(mixed, footprintsOfMarkers([{ pos: [0, 0], radius: 100, color: 0, sizeAdaptation: 1 }]));
    expect(scaler.factorAt([5, 5], 1)).toBeLessThanOrEqual(scaler.maxFactor + 1e-9);
  });
});

describe("WaypointsRenderer", () => {
  it("draws markers at their scaled radius", () => {
    const draw = (factor: number) => {
      const renderer = new WaypointsRenderer(new Container());
      renderer.render({ markers: [{ pos: [0, 0], radius: 10, color: 0xff0000, sizeAdaptation: 1 }], scaler: { factorAt: () => factor, maxFactor: factor } });
      const bounds = (renderer as unknown as { g: { getLocalBounds(): { width: number } } }).g.getLocalBounds();
      return bounds.width;
    };
    expect(draw(2)).toBeCloseTo(draw(1) * 2, 0);
  });

  it("scales the caption text with the marker", () => {
    const fontSize = (factor: number) => {
      const renderer = new WaypointsRenderer(new Container());
      renderer.render({ markers: [{ pos: [0, 0], radius: 10, color: 0xff0000, sizeAdaptation: 1, text: "S", textSize: 12 }], scaler: { factorAt: () => factor, maxFactor: factor } });
      const labels = (renderer as unknown as { labels: { children: Array<{ style: { fontSize: number } }> } }).labels;
      return labels.children[0].style.fontSize;
    };
    expect(fontSize(2)).toBeCloseTo(fontSize(1) * 2, 5);
  });
});
