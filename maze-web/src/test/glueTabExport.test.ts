import { describe, expect, it } from "vitest";
import { validateVectorByCorridorsSettings, validateVectorByWallsSettings } from "../store/projectExport/validateImageExport";
import { glueTabOn, shiftTab, selectExportGlueTabLayout, selectExportGlueTabs, type GlueTab } from "../pixi/imageExport/glueTabExport";
import { buildCutPlan, cutTabShift, sheetSpan } from "../pixi/imageExport/cutLines";
import { computeGlueTabWarnings } from "../pixi/selectors/glueTabWarnings";
import { DEFAULT_GLUE_TAB_STYLE } from "../store/slices/imageExportDefaults";
import type { GlueTabStyle } from "../store/imageExportTypes";
import type { MazeState } from "../store/storeTypes";
import type { WireTopology } from "../wasm/types";
import { warmCartesianCache } from "../domain/cartesianCache";
import { getCellVertices } from "../domain/tessellationGeometry";
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

describe("cutTabShift (GitHub issue #1014)", () => {
  // A horizontal cut line at y = 0, the sheet reaches one period (0.5, 10) from it.
  const line = { point: [0, 0] as [number, number], cut: { period: [0.5, 10] as [number, number], direction: [1, 0] as [number, number] } };
  const tile = (y: number): [number, number][] => [[0, y], [1, y], [1, y + 1], [0, y + 1]];

  it("does not move the tabs when the field starts at the line", () => {
    expect(cutTabShift([tile(0), tile(5)], [line])).toEqual([0, 0]);
  });

  it("slides the tabs along the period by the part of the field before the line", () => {
    const [x, y] = cutTabShift([tile(-4), tile(5)], [line]);
    // 4 of the 10 across the period.
    expect(x).toBeCloseTo(0.2);
    expect(y).toBeCloseTo(4);
  });

  it("moves a tab whole", () => {
    const tab: GlueTab = [[0, 0], [0, 4], [-5, 2], [-5, 2]];
    const moved = shiftTab(tab, [0.5, 3]);
    expect(moved[0]).toEqual([0.5, 3]);
    expect(moved[1]).toEqual([0.5, 7]);
    expect(shiftTab(tab, [0, 0])).toBe(tab);
  });
});

describe("selectExportGlueTabs on a torus with one cut (GitHub issue #1014)", () => {
  const cells: [number, number][] = [];
  for (let x = 0; x < 6; x++) for (let y = 0; y < 5; y++) cells.push([x, y]);
  const cfg = fieldOf("square", { shape: "custom", points: cells });
  const topology: WireTopology = {
    fingerprint: "square{}",
    folds: [
      ...[0, 1, 2, 3, 4].map((y): WireTopology["folds"][number] => ({ a: { cell: [5, y], face_idx: 0 }, b: { cell: [0, y], face_idx: 2 }, twist: false, group: 0 })),
      ...[0, 1, 2, 3, 4, 5].map((x): WireTopology["folds"][number] => ({ a: { cell: [x, 4], face_idx: 1 }, b: { cell: [x, 0], face_idx: 3 }, twist: false, group: 1 })),
    ],
    groups: [{ id: 0, folds: [0, 1, 2, 3, 4] }, { id: 1, folds: [5, 6, 7, 8, 9, 10] }],
  };
  const nodes = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
  const stateWith = (cut: { mode: string; offset: number } | null) => ({
    activeFloorId: "f", activeFieldConfig: cfg, floorTopology: { f: topology }, nodes, floors: [{ id: "f" }],
    pngExportSettings: { cuts: { lines: cut ? { f: { 1: cut } } : {} } },
  }) as unknown as MazeState;

  it("does not report cuts on a square tessellation, where tabs and cuts work together", () => {
    warmCartesianCache(cfg, topology);
    expect(selectExportGlueTabLayout(stateWith({ mode: "manual", offset: 0.4 }), style({ inset: 0 })).hasCuts).toBe(false);
  });

  it("puts both tabs on the edges of the sheet, each from the other line to its twin, when both glues are cut", () => {
    warmCartesianCache(cfg, topology);
    const state = { ...stateWith(null), pngExportSettings: { cuts: { lines: { f: { 0: { mode: "manual", offset: 0.3 }, 1: { mode: "manual", offset: 0.4 } } } } } } as unknown as MazeState;
    const tabs = selectExportGlueTabs(state, style({ inset: 0 }));
    expect(tabs).toHaveLength(2);
    const vertical = tabs.find((tab) => tab[0][0] === tab[1][0])!;
    const horizontal = tabs.find((tab) => tab[0][1] === tab[1][1])!;
    // The sheet is one period (the field's own size here) from each line: a tab runs along the other's strip, from line to twin.
    expect(Math.abs(vertical[1][1] - vertical[0][1])).toBeCloseTo(200);
    expect(Math.abs(horizontal[1][0] - horizontal[0][0])).toBeCloseTo(240);
    expect(Math.min(vertical[0][1], vertical[1][1])).toBeCloseTo(horizontal[0][1]);
    expect(Math.min(horizontal[0][0], horizontal[1][0])).toBeCloseTo(vertical[0][0]);
  });

  it("slides the tab of the uncut glue along its edge with the picture", () => {
    warmCartesianCache(cfg, topology);
    const plain = selectExportGlueTabs(stateWith(null), style({ inset: 0 }));
    const cut = selectExportGlueTabs(stateWith({ mode: "manual", offset: 0.4 }), style({ inset: 0 }));
    const verticalTab = (tabs: GlueTab[]) => tabs.find((tab) => tab[0][0] === tab[1][0])!;
    const [before, after] = [verticalTab(plain), verticalTab(cut)];
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after[0][0]).toBeCloseTo(before[0][0]);
    expect(Math.abs(after[0][1] - before[0][1])).toBeGreaterThan(0.1);
    // Whole: the same length, not clipped.
    expect(Math.abs(after[1][1] - after[0][1])).toBeCloseTo(Math.abs(before[1][1] - before[0][1]));
  });
});

describe("sheetSpan (GitHub issue #1014)", () => {
  const horizontal = { point: [0, 3] as [number, number], cut: { period: [0, 10] as [number, number], direction: [1, 0] as [number, number] } };
  const vertical = { point: [2, 0] as [number, number], cut: { period: [6, 0] as [number, number], direction: [0, 1] as [number, number] } };

  it("is unknown without another cut", () => {
    expect(sheetSpan(horizontal, [])).toBeNull();
  });

  it("runs between the other line and its twin", () => {
    const [from, to] = sheetSpan(horizontal, [vertical])!;
    expect(from[0]).toBeCloseTo(2);
    expect(to[0]).toBeCloseTo(8);
    expect(from[1]).toBeCloseTo(3);
  });

  it("ignores a parallel cut", () => {
    expect(sheetSpan(horizontal, [{ ...horizontal, point: [0, 50] as [number, number] }])).toBeNull();
  });
});

describe("cut guides on a sheet with two cuts (GitHub issue #1014)", () => {
  const cut = (group: number, period: [number, number], direction: [number, number]) => ({ group, period, origin: [0, 0] as [number, number], direction, minOffset: 0, maxOffset: 1, distancePerOffset: 1 });
  const horizontal = { point: [0, 3] as [number, number], cut: cut(0, [0, 10], [1, 0]) };
  const vertical = { point: [2, 0] as [number, number], cut: cut(1, [6, 0], [0, 1]) };
  const tile = (x: number, y: number): [number, number][] => [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];

  it("runs each guide from the other line to its twin, not over the tiles", () => {
    const tiles = [tile(2, 3), tile(7, 11), tile(0, 0)];
    const plan = buildCutPlan({ minX: 0, minY: 0, maxX: 8, maxY: 12 }, [horizontal, vertical], undefined, tiles)!;
    const ofHorizontal = plan.guides.filter((g) => g.group === 0);
    expect(ofHorizontal.length).toBeGreaterThan(0);
    for (const g of ofHorizontal) {
      expect(Math.min(g.from[0], g.to[0])).toBeCloseTo(2);
      expect(Math.max(g.from[0], g.to[0])).toBeCloseTo(8);
    }
  });
});

describe("hasCuts on a hex tessellation (GitHub issue #1014)", () => {
  const COLUMNS = 4;
  const ROWS = 3;
  const hexCells: [number, number][] = [];
  for (let q = 0; q < COLUMNS; q++) for (let r = 0; r < ROWS; r++) hexCells.push([q, r]);
  const hexField = fieldOf("hex", { shape: "custom", points: hexCells }, "pointy_top");
  const topology: WireTopology = {
    fingerprint: "hex{}",
    folds: [0, 1, 2].map((r): WireTopology["folds"][number] => ({ a: { cell: [COLUMNS - 1, r], face_idx: 0 }, b: { cell: [0, r], face_idx: 3 }, twist: false, group: 0 })),
    groups: [{ id: 0, folds: [0, 1, 2] }],
  };
  const nodes = hexCells.map(([x, y], id) => ({ id, x, y, i: 0 }));
  const stateWith = (cut: { mode: string; offset: number } | null) => ({
    activeFloorId: "f", activeFieldConfig: hexField, floorTopology: { f: topology }, nodes, floors: [{ id: "f" }],
    pngExportSettings: { cuts: { lines: cut ? { f: { 0: cut } } : {} } },
  }) as unknown as MazeState;

  it("reports an active cut, and not a missing one", () => {
    warmCartesianCache(hexField, topology);
    expect(selectExportGlueTabLayout(stateWith({ mode: "auto", offset: 0 }), style()).hasCuts).toBe(true);
    expect(selectExportGlueTabLayout(stateWith(null), style()).hasCuts).toBe(false);
  });
});
