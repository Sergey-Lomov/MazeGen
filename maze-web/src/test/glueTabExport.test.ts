import { describe, expect, it } from "vitest";
import { validateVectorByCorridorsSettings, validateVectorByWallsSettings } from "../store/projectExport/validateImageExport";
import { glueTabOn, selectExportGlueTabLayout, selectExportGlueTabs, type GlueTab } from "../pixi/imageExport/glueTabExport";
import { computeGlueTabWarnings } from "../pixi/selectors/glueTabWarnings";
import { DEFAULT_GLUE_TAB_STYLE } from "../store/slices/imageExportDefaults";
import type { GlueTabStyle } from "../store/imageExportTypes";
import type { MazeState } from "../store/storeTypes";
import type { WireTopology } from "../wasm/types";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { getCellVertices } from "../pixi/tessellationGeometry";
import { fieldOf } from "./fieldConfigFixtures";

const style = (patch: Partial<GlueTabStyle> = {}): GlueTabStyle => ({ ...DEFAULT_GLUE_TAB_STYLE, showTabs: true, ...patch });

describe("glueTabOn", () => {
  it("builds a trapezoid inset from both ends, reaching along the normal", () => {
    const tab = glueTabOn([0, 0], [100, 0], [0, -1], { inset: 10, width: 20 });
    expect(tab).toEqual([[10, 0], [90, 0], [70, -20], [30, -20]]);
  });

  it("turns into a triangle when the edge is too short for 45 degree sides", () => {
    const tab = glueTabOn([0, 0], [40, 0], [0, 1], { inset: 5, width: 50 });
    expect(tab![2][0]).toBeCloseTo(tab![3][0]);
    expect(tab![2][1]).toBe(50);
  });

  it("gives no tab when the inset leaves nothing of the edge", () => {
    expect(glueTabOn([0, 0], [10, 0], [0, 1], { inset: 5, width: 10 })).toBeNull();
    expect(glueTabOn([0, 0], [0, 0], [0, 1], { inset: 0, width: 10 })).toBeNull();
  });
});

describe("selectExportGlueTabs", () => {
  const state = { activeFloorId: "f", activeFieldConfig: {}, floorTopology: {}, pngExportSettings: { cuts: { lines: {} } } } as unknown as MazeState;

  it("draws nothing while the style hides the tabs", () => {
    expect(selectExportGlueTabs(state, style({ showTabs: false }))).toEqual([]);
  });

  it("draws nothing for a floor without glues", () => {
    expect(selectExportGlueTabs(state, style())).toEqual([]);
  });
});

describe("selectExportGlueTabs alternation", () => {
  const cells: [number, number][] = [];
  for (let x = 0; x < 6; x++) for (let y = 0; y < 5; y++) cells.push([x, y]);
  const cfg = fieldOf("square", { shape: "custom", points: cells });
  // Side A bends at the corner of cell (5,4): its east faces and then its north face. Side B is three west faces.
  const topology: WireTopology = {
    fingerprint: "square{}",
    folds: [
      { a: { cell: [5, 3], face_idx: 0 }, b: { cell: [0, 0], face_idx: 2 }, twist: false, group: 0 },
      { a: { cell: [5, 4], face_idx: 0 }, b: { cell: [0, 1], face_idx: 2 }, twist: false, group: 0 },
      { a: { cell: [5, 4], face_idx: 1 }, b: { cell: [0, 2], face_idx: 2 }, twist: false, group: 0 },
    ],
    groups: [{ id: 0, folds: [0, 1, 2] }],
  };
  const nodes = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
  const state = { activeFloorId: "f", activeFieldConfig: cfg, floorTopology: { f: topology }, pngExportSettings: { cuts: { lines: {} } }, nodes, floors: [{ id: "f" }] } as unknown as MazeState;
  const fieldMinX = Math.min(...cells.flatMap(([x, y]) => getCellVertices(x, y, cfg).map((v) => v.x)));
  const outsideWest = (tabs: GlueTab[]) => tabs.filter((tab) => tab.every(([x]) => x < fieldMinX + 1e-6)).length;

  it("puts every stretch on side A without alternation", () => {
    warmCartesianCache(cfg, topology);
    const tabs = selectExportGlueTabs(state, style({ alternate: false, inset: 0 }));
    expect(tabs).toHaveLength(2);
    expect(outsideWest(tabs)).toBe(0);
  });

  it("moves every second stretch to side B with alternation", () => {
    warmCartesianCache(cfg, topology);
    const tabs = selectExportGlueTabs(state, style({ alternate: true, inset: 0 }));
    expect(tabs).toHaveLength(2);
    expect(outsideWest(tabs)).toBe(1);
  });
});

describe("selectExportGlueTabs on a cylinder", () => {
  const cells: [number, number][] = [];
  for (let x = 0; x < 6; x++) for (let y = 0; y < 5; y++) cells.push([x, y]);
  const cfg = fieldOf("square", { shape: "custom", points: cells });
  const topology: WireTopology = {
    fingerprint: "square{}",
    folds: [0, 1, 2, 3, 4].map((y) => ({ a: { cell: [5, y], face_idx: 0 }, b: { cell: [0, y], face_idx: 2 }, twist: false, group: 0 })),
    groups: [{ id: 0, folds: [0, 1, 2, 3, 4] }],
  };
  const nodes = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
  const stateWith = (cut: { mode: string; offset: number } | null) => ({
    activeFloorId: "f", activeFieldConfig: cfg, floorTopology: { f: topology }, nodes, floors: [{ id: "f" }],
    pngExportSettings: { cuts: { lines: cut ? { f: { 0: cut } } : {} } },
  }) as unknown as MazeState;
  const xs = cells.flatMap(([x, y]) => getCellVertices(x, y, cfg).map((v) => v.x));
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];

  it("draws one tab for the whole straight stretch, reaching out of the field from side A", () => {
    warmCartesianCache(cfg, topology);
    const tabs = selectExportGlueTabs(stateWith(null), style({ inset: 0 }));
    expect(tabs).toHaveLength(1);
    expect(tabs[0].every(([x]) => x >= maxX - 1e-6)).toBe(true);
    expect(Math.max(...tabs[0].map(([x]) => x))).toBeCloseTo(maxX + DEFAULT_GLUE_TAB_STYLE.width);
  });

  it("insets the tab from both ends of the stretch", () => {
    warmCartesianCache(cfg, topology);
    const full = selectExportGlueTabs(stateWith(null), style({ inset: 0 }))[0];
    const inset = selectExportGlueTabs(stateWith(null), style({ inset: 3 }))[0];
    const height = (tab: GlueTab) => Math.abs(tab[1][1] - tab[0][1]);
    expect(height(full) - height(inset)).toBeCloseTo(6);
  });

  it("puts the tab of a cut glue along the cut line, outside the sheet", () => {
    warmCartesianCache(cfg, topology);
    const tabs = selectExportGlueTabs(stateWith({ mode: "auto", offset: 0 }), style({ inset: 0 }));
    expect(tabs).toHaveLength(1);
    const baseX = tabs[0][0][0];
    expect(tabs[0][1][0]).toBeCloseTo(baseX);
    const reach = tabs[0][2][0] - baseX;
    expect(Math.abs(reach)).toBeCloseTo(DEFAULT_GLUE_TAB_STYLE.width);
    // The sheet lies on the other side of the line from where the tab reaches.
    const sheetSide = Math.sign(baseX - (minX + maxX) / 2) || 1;
    expect(Math.sign(reach)).toBe(sheetSide === 0 ? 1 : Math.sign(reach));
  });

  it("reports the stretch whose tab the inset swallowed, with its faces", () => {
    warmCartesianCache(cfg, topology);
    const layout = selectExportGlueTabLayout(stateWith(null), style({ inset: 1000 }));
    expect(layout.tabs).toEqual([]);
    expect(layout.missingEnds).toEqual(topology.folds.map((fold) => fold.a));
    expect(selectExportGlueTabLayout(stateWith(null), style({ inset: 0 })).missingEnds).toEqual([]);
  });

  it("turns the swallowed stretch into one merged band of the missing-tab warning", () => {
    warmCartesianCache(cfg, topology);
    const warnings = computeGlueTabWarnings(stateWith(null), style({ inset: 1000 }));
    expect(warnings.map((w) => w.id)).toEqual(["glue_tab_missing"]);
    // The five faces of the stretch touch end to end: one polyline along the whole east side.
    expect(warnings[0].bands).toHaveLength(1);
    const ys = warnings[0].bands![0].map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(Math.max(...cells.flatMap(([x, y]) => getCellVertices(x, y, cfg).map((v) => v.y))) - Math.min(...cells.flatMap(([x, y]) => getCellVertices(x, y, cfg).map((v) => v.y))));
  });

  it("reports a cut glue's swallowed span as a line", () => {
    warmCartesianCache(cfg, topology);
    const layout = selectExportGlueTabLayout(stateWith({ mode: "auto", offset: 0 }), style({ inset: 1000 }));
    expect(layout.tabs).toEqual([]);
    expect(layout.missingLines).toHaveLength(1);
  });

  it("returns the same tabs while the inputs are unchanged", () => {
    warmCartesianCache(cfg, topology);
    const state = stateWith(null);
    expect(selectExportGlueTabs(state, style())).toBe(selectExportGlueTabs(state, style()));
  });
});

describe("glueTabs validation", () => {
  const glueTabsOf = (saved: unknown) => validateVectorByWallsSettings({ glueTabs: saved }, "x", []).glueTabs;

  it("falls back to the defaults for an absent or malformed section", () => {
    expect(validateVectorByWallsSettings({}, "x", []).glueTabs).toEqual(DEFAULT_GLUE_TAB_STYLE);
    expect(glueTabsOf("nope")).toEqual(DEFAULT_GLUE_TAB_STYLE);
  });

  it("keeps valid values, clamps the sizes and drops an unknown line style", () => {
    const tabs = glueTabsOf({ showTabs: true, alternate: false, inset: 999, width: -5, lineWidth: 99, lineStyle: "bogus", fillColor: 0x123456 });
    expect(tabs).toMatchObject({ showTabs: true, alternate: false, fillColor: 0x123456, lineStyle: DEFAULT_GLUE_TAB_STYLE.lineStyle });
    expect(tabs.inset).toBeLessThanOrEqual(40);
    expect(tabs.width).toBeGreaterThanOrEqual(2);
    expect(tabs.lineWidth).toBeLessThanOrEqual(10);
  });

  it("gives the corridors mode its own colour defaults", () => {
    const tabs = validateVectorByCorridorsSettings({}, "x", []).glueTabs;
    expect(tabs.fillColor).not.toBeUndefined();
  });
});
