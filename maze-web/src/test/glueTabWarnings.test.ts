import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlueTab, GlueTabLayout } from "../pixi/imageExport/glueTabExport";

let tabsNow: GlueTab[] = [];
let missingLinesNow: [number, number][][] = [];
let layoutNow: GlueTabLayout = { tabs: [], missingEnds: [], missingLines: [] };
vi.mock("../pixi/imageExport/glueTabExport", () => ({ selectExportGlueTabLayout: () => layoutNow }));
/** The layout changes identity only when the inputs do, like the real memoised selector. */
const setLayout = () => { layoutNow = { tabs: tabsNow, missingEnds: [], missingLines: missingLinesNow }; };

import { convexPolygonsOverlap, computeGlueTabWarnings, MIN_TAB_BASE } from "../pixi/selectors/glueTabWarnings";

const square = (x: number, y: number, size = 10): [number, number][] => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
/** A tab whose base (first side) is `base` long, at `x`. */
const tab = (x: number, base = 40): GlueTab => [[x, 0], [x + base, 0], [x + base, -20], [x, -20]];
const compute = () => computeGlueTabWarnings({ activeFieldConfig: {} } as never, { showTabs: true, inset: 0, width: 30, alternate: true });

describe("convexPolygonsOverlap", () => {
  it("detects interior overlap, including a contained polygon", () => {
    expect(convexPolygonsOverlap(square(0, 0), square(5, 5))).toBe(true);
    expect(convexPolygonsOverlap(square(0, 0, 10), square(2, 2, 3))).toBe(true);
  });

  it("ignores touching and separated polygons", () => {
    expect(convexPolygonsOverlap(square(0, 0), square(10, 0))).toBe(false);
    expect(convexPolygonsOverlap(square(0, 0), square(10, 10))).toBe(false);
    expect(convexPolygonsOverlap(square(0, 0), square(20, 0))).toBe(false);
  });
});

describe("computeGlueTabWarnings", () => {
  beforeEach(() => { tabsNow = []; missingLinesNow = []; setLayout(); });

  it("returns nothing without tabs", () => {
    expect(compute()).toEqual([]);
  });

  it("returns nothing for roomy, separate tabs", () => {
    tabsNow = [tab(0), tab(50)];
    setLayout();
    expect(compute()).toEqual([]);
  });

  it("flags only the overlapping tabs, as polygons", () => {
    tabsNow = [tab(0), tab(30), tab(200)];
    setLayout();
    const warnings = compute();
    expect(warnings.map((w) => w.id)).toEqual(["glue_tabs_overlap"]);
    expect(warnings[0].polygons).toEqual([tabsNow[0], tabsNow[1]]);
    expect(warnings[0]).toMatchObject({ nodes: [], edges: [] });
  });

  it("flags tabs whose base is below the minimum, and not one exactly at it", () => {
    tabsNow = [tab(0, MIN_TAB_BASE - 1), tab(100, MIN_TAB_BASE), tab(200)];
    setLayout();
    const warnings = compute();
    expect(warnings.map((w) => w.id)).toEqual(["glue_tab_too_thin"]);
    expect(warnings[0].polygons).toEqual([tabsNow[0]]);
  });

  it("reports both warnings together, and reuses the result for the same tabs", () => {
    tabsNow = [tab(0, 5), tab(3, 5)];
    setLayout();
    const first = compute();
    expect(first.map((w) => w.id)).toEqual(["glue_tabs_overlap", "glue_tab_too_thin"]);
    expect(compute()).toBe(first);
  });

  it("flags stretches left without any tab, as bands", () => {
    missingLinesNow = [[[0, 0], [40, 0]]];
    setLayout();
    const warnings = compute();
    expect(warnings.map((w) => w.id)).toEqual(["glue_tab_missing"]);
    expect(warnings[0].bands).toEqual([[[0, 0], [40, 0]]]);
  });
});
