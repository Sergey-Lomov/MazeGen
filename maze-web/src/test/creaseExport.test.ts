import { describe, expect, it } from "vitest";
import { Graphics } from "pixi.js";
import { drawExportCreases, selectExportCreases } from "../pixi/imageExport/creaseExport";
import { DEFAULT_CREASE_STYLE } from "../store/slices/imageExportDefaults";
import { validateVectorByWallsSettings } from "../store/projectExport/validateImageExport";
import type { CreaseExportStyle } from "../store/imageExportTypes";

const style = (patch: Partial<CreaseExportStyle> = {}): CreaseExportStyle => ({ ...DEFAULT_CREASE_STYLE, showCreases: true, ...patch });

describe("selectExportCreases", () => {
  it("returns nothing while creases are hidden", () => {
    const state = { activeFloorId: "f", floorFields: {}, floorCreases: { f: [{ id: 0, a: [0, 0] as const, b: [1, 0] as const }] } };
    expect(selectExportCreases(state as never, style({ showCreases: false }))).toEqual([]);
  });
});

describe("drawExportCreases", () => {
  const line = [{ from: [0, 0] as const, to: [100, 0] as const }];

  it("dashed line draws more path commands than a solid one", () => {
    const solid = new Graphics();
    const dashed = new Graphics();
    drawExportCreases(solid, line, style({ lineStyle: "solid" }));
    drawExportCreases(dashed, line, style({ lineStyle: "dashed" }));
    const pieces = (g: Graphics) => (g.context.instructions[0] as unknown as { data: { path: { shapePath: { shapePrimitives: unknown[] } } } }).data.path.shapePath.shapePrimitives.length;
    expect(pieces(solid)).toBe(1);
    expect(pieces(dashed)).toBeGreaterThan(1);
  });

  it("a mark is a circle with a nose along the crease, at both ends", () => {
    const g = new Graphics();
    drawExportCreases(g, line, style({ mode: "marks", markSize: 10, markTipLength: 8 }));
    const bounds = g.getLocalBounds();
    expect(bounds.minX).toBeCloseTo(-5);
    expect(bounds.maxX).toBeCloseTo(105);
    expect(bounds.minY).toBeCloseTo(-5);
    expect(bounds.maxY).toBeCloseTo(5);
  });

  it("clamps the nose so the two marks do not cross", () => {
    const g = new Graphics();
    drawExportCreases(g, [{ from: [0, 0], to: [20, 0] }], style({ mode: "marks", markSize: 4, markTipLength: 50 }));
    const bounds = g.getLocalBounds();
    expect(bounds.minX).toBeCloseTo(-2);
    expect(bounds.maxX).toBeCloseTo(22);
  });

  it("skips a zero-length crease", () => {
    const g = new Graphics();
    drawExportCreases(g, [{ from: [5, 5], to: [5, 5] }], style({ mode: "marks" }));
    expect(g.getLocalBounds().width).toBe(0);
  });
});

describe("crease style validation", () => {
  it("falls back to the default for a file without the section", () => {
    expect(validateVectorByWallsSettings({}, "x", []).creases).toEqual(DEFAULT_CREASE_STYLE);
  });

  it("keeps stored values and repairs malformed ones", () => {
    const creases = validateVectorByWallsSettings({ creases: { showCreases: true, mode: "marks", lineStyle: "bogus", markSize: 7 } }, "x", []).creases;
    expect(creases).toMatchObject({ showCreases: true, mode: "marks", lineStyle: DEFAULT_CREASE_STYLE.lineStyle, markSize: 7 });
  });
});
