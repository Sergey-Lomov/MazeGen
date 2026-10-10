import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { DEFAULT_PNG_EXPORT_SETTINGS, DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportDefaults";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  useMazeStore.setState({
    ...baseStoreState(),
    pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
    vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
    vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  });
});

type Mode = "Walls" | "Corridors";
const MODES: Mode[] = ["Walls", "Corridors"];
const settingsKey = (mode: Mode): "vectorByWallsSettings" | "vectorByCorridorsSettings" => (mode === "Walls" ? "vectorByWallsSettings" : "vectorByCorridorsSettings");
type AnyFn = (...a: unknown[]) => void;
const actions = () => useMazeStore.getState() as unknown as Record<string, AnyFn>;

function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);
}

// Per-kind marker setters: [setter suffix, settings path, value to apply].
const MARKER_FIELDS: [string, string, unknown][] = [
  ["Shape", "shape", "square"],
  ["CornerStyle", "cornerStyle", "miter"],
  ["FillColor", "fillColor", 0x123456],
  ["BorderColor", "borderColor", 0x654321],
  ["BorderWidth", "borderWidth", 7],
  ["GapWidth", "gapWidth", 5],
  ["Size", "size", 21],
];
const TEXT_FIELDS: [string, string, unknown][] = [
  ["TextEnabled", "textEnabled", true],
  ["TextFontWeight", "textFontWeight", "regular"],
  ["TextSize", "textSize", 14],
  ["TextColor", "textColor", 0xabcdef],
];

describe("per-kind marker setters write their settings path", () => {
  for (const mode of MODES) {
    const cases: [string, string, unknown][] = [];
    for (const kind of ["Start", "Finish"]) {
      const path = kind.toLowerCase() + "Marker";
      for (const [suffix, field, value] of [...MARKER_FIELDS, ...TEXT_FIELDS]) {
        cases.push([`setVectorBy${mode}${kind}Marker${suffix}`, `${path}.${field}`, value]);
      }
      cases.push([`setVectorBy${mode}${kind}MarkerText`, `${path}.text`, "S"]);
    }
    for (const kind of ["TwoWayPassage", "OneWayPassage", "Elevator"]) {
      const path = kind[0].toLowerCase() + kind.slice(1) + "Marker";
      for (const [suffix, field, value] of MARKER_FIELDS) {
        cases.push([`setVectorBy${mode}${kind}Marker${suffix}`, `${path}.${field}`, value]);
      }
    }
    cases.push([`setVectorBy${mode}ElevatorBadgesCornerStyle`, "elevatorBadges.cornerStyle", "miter"]);
    it.each(cases)(`${mode}: %s -> %s`, (setter, path, value) => {
      const fn = actions()[setter];
      expect(fn, setter).toBeTypeOf("function");
      fn(value);
      expect(readPath(useMazeStore.getState()[settingsKey(mode)], path)).toBe(value);
    });
  }
});

describe("flat vector setters write their settings path", () => {
  const common: [string, string, unknown][] = [
    ["Background", "background", 0x111111],
    ["ShowGrid", "showGrid", false],
    ["GridColor", "gridColor", 0x222222],
  ];
  const walls: [string, string, unknown][] = [
    ...common,
    ["ShowInnerGrid", "showInnerGrid", true],
    ["InnerGridColor", "innerGridColor", 0x333333],
    ["FloorColor", "floorColor", 0x444444],
    ["WallColor", "wallColor", 0x555555],
    ["RandomWallColorMode", "randomWallColorMode", "per_wall"],
    ["WallJoin", "wallJoin", "miter"],
    ["WallThickness", "wallThickness", 5],
    ["OneWayPattern", "oneWayPattern", "chevron"],
    ["OneWayColor", "oneWayColor", 0x666666],
    ["OneWayGapWidth", "oneWayGapWidth", 4],
    ["OneWaySize", "oneWaySize", 0.4],
    ["OneWayThickness", "oneWayThickness", 6],
    ["OneWayJoin", "oneWayJoin", "miter"],
    ["SplitSpecialShapes", "splitSpecialShapes", false],
  ];
  const corridors: [string, string, unknown][] = [
    ...common,
    ["Color", "color", 0x777777],
    ["Thickness", "thickness", 9],
    ["Join", "join", "miter"],
    ["RenderStyle", "renderStyle", "segments"],
    ["MarkerWidenPadding", "markerWidenPadding", 3],
    ["MarkerWidenShape", "markerWidenShape", "round"],
    ["SplitSpecialShapes", "splitSpecialShapes", false],
    ["SplitGapWidth", "splitGapWidth", 4],
    ["SplitDiagonalBowAmount", "splitDiagonalBowAmount", 0.2],
  ];
  it.each(walls)("Walls: set%s", (suffix, path, value) => {
    const fn = actions()[`setVectorByWalls${suffix}`];
    expect(fn, suffix).toBeTypeOf("function");
    fn(value);
    expect(readPath(useMazeStore.getState().vectorByWallsSettings, path)).toBe(value);
  });
  it.each(corridors)("Corridors: set%s", (suffix, path, value) => {
    const fn = actions()[`setVectorByCorridors${suffix}`];
    expect(fn, suffix).toBeTypeOf("function");
    fn(value);
    expect(readPath(useMazeStore.getState().vectorByCorridorsSettings, path)).toBe(value);
  });
});

describe("group overrides and split colors", () => {
  it.each(MODES)("%s: group override merges, then null deletes", (mode) => {
    const key = settingsKey(mode);
    const set = actions()[`setVectorBy${mode}TeleportGroupOverride`];
    set("g1", { edgeColor: 0x111111 });
    set("g1", { connectorWidth: 5 });
    expect(useMazeStore.getState()[key].teleportGroupOverrides["g1"]).toMatchObject({ edgeColor: 0x111111, connectorWidth: 5 });
    set("g1", null);
    expect(useMazeStore.getState()[key].teleportGroupOverrides["g1"]).toBeUndefined();
  });

  it("Corridors: split node color backfills skipped slots", () => {
    useMazeStore.getState().setVectorByCorridorsSplitNodeColor(0, 0xaaaaaa);
    useMazeStore.getState().setVectorByCorridorsSplitNodeColor(2, 0xcccccc);
    const colors = useMazeStore.getState().vectorByCorridorsSettings.splitNodeColors;
    expect(colors).toHaveLength(3);
    expect(colors[0]).toBe(0xaaaaaa);
    expect(colors[2]).toBe(0xcccccc);
  });
});

describe("patch actions", () => {
  it("Corridors: one-way, vertical, badges, marker index, teleport patches apply", () => {
    const st = actions();
    st.patchVectorByCorridorsOneWaySettings({ oneWayJoin: "miter" });
    st.patchVectorByCorridorsVerticalSettings({ twoWayArrowColor: 0x123456 });
    st.patchVectorByCorridorsElevatorBadges({ size: 15 });
    st.patchVectorByCorridorsMarkerIndexSettings({ enabled: true });
    st.patchVectorByCorridorsTeleportSettings({ teleportConnectorWidth: 6 });
    const c = useMazeStore.getState().vectorByCorridorsSettings;
    expect(c.twoWayArrowColor).toBe(0x123456);
    expect(c.elevatorBadges.size).toBe(15);
    expect(c.markerIndex.enabled).toBe(true);
    expect(c.teleportConnectorWidth).toBe(6);
  });

  it("Walls: vertical, decorative, badges, marker index, teleport patches apply", () => {
    const st = actions();
    st.patchVectorByWallsVerticalSettings({ twoWayArrowColor: 0x123456 });
    st.patchVectorByWallsDecorativeLineStyle("decorativeElevator", { lineWidth: 6 });
    st.patchVectorByWallsElevatorBadges({ size: 15 });
    st.patchVectorByWallsMarkerIndexSettings({ enabled: true });
    st.patchVectorByWallsTeleportSettings({ teleportConnectorWidth: 6 });
    const w = useMazeStore.getState().vectorByWallsSettings;
    expect(w.twoWayArrowColor).toBe(0x123456);
    expect(w.decorativeElevator.lineWidth).toBe(6);
    expect(w.elevatorBadges.size).toBe(15);
    expect(w.markerIndex.enabled).toBe(true);
    expect(w.teleportConnectorWidth).toBe(6);
  });

  it.each(MODES)("%s: vertical shared style patch applies", (mode) => {
    actions()[`patchVectorBy${mode}VerticalSharedStyle`]({ twoWayArrowColor: 0x0a0b0c });
    expect(useMazeStore.getState()[settingsKey(mode)].twoWayArrowColor).toBe(0x0a0b0c);
  });
});

describe("link actions", () => {
  it.each(MODES)("%s: toggle, force, reset field, reset all, remove", (mode) => {
    const key = settingsKey(mode);
    const links = () => useMazeStore.getState()[key].links;
    const first = links()[0];
    const target = first.target;
    const enabledOf = () => links().find((l) => l.target === target)!.enabled;

    const before = links();
    actions()[`setVectorBy${mode}LinkEnabled`](target, !first.enabled);
    expect(links()).not.toBe(before);
    expect(enabledOf()).toBe(!first.enabled);
    // Same state again: no-op, identity kept.
    const same = links();
    actions()[`setVectorBy${mode}LinkEnabled`](target, enabledOf());
    expect(links()).toEqual(same);

    actions()[`forceVectorBy${mode}SharedStyle`]();
    actions()[`resetVectorBy${mode}SharedStyleField`](target);
    actions()[`removeVectorBy${mode}Link`](target);
    expect(links().find((l) => l.target === target)).toBeUndefined();
    // Removing a missing link is a no-op.
    const afterRemove = links();
    actions()[`removeVectorBy${mode}Link`](target);
    expect(links()).toEqual(afterRemove);

    actions()[`resetVectorBy${mode}Settings`]();
    expect(links().find((l) => l.target === target)).toBeDefined();
  });
});

describe("png export setters", () => {
  it("writes each digital / print field", () => {
    const st = actions();
    st.setPngOutputMode("print");
    st.setDigitalScale(3);
    st.setDigitalCanvasMode("fixed");
    st.setDigitalMarginValue(12);
    st.setDigitalFixedSize(800, 600);
    st.setPrintPaperSize("a3");
    st.setPrintCustomSize(100, 200);
    st.setPrintOrientation("landscape");
    st.setPrintMargins(5, 6);
    st.setPrintScale(2);
    st.setPrintScaleAutoFit(true);
    st.setPrintAnchor("top_left");
    const p = useMazeStore.getState().pngExportSettings;
    expect(p.outputMode).toBe("print");
    expect(p.digital).toMatchObject({ scale: 3, canvasMode: "fixed", marginValue: 12, fixedWidth: 800, fixedHeight: 600 });
    expect(p.print).toMatchObject({ paperSize: "a3", customWidthMm: 100, customHeightMm: 200, orientation: "landscape", marginHMm: 5, marginVMm: 6, scale: 2, scaleAutoFit: true, anchor: "top_left" });
  });

  it("custom placement forces the custom anchor", () => {
    actions().setPrintCustomPlacement(1.5, 10, 20);
    expect(useMazeStore.getState().pngExportSettings.print).toMatchObject({ scale: 1.5, offsetXMm: 10, offsetYMm: 20, anchor: "custom" });
  });

  it("field sizing disables auto-fit and sets paper params", () => {
    actions().setPrintScaleAutoFit(true);
    actions().setPrintFieldSizing(
      { paperSize: "a4", customWidthMm: 210, customHeightMm: 297, orientation: "portrait", marginHMm: 10, marginVMm: 10, cellSizeMm: 5 },
      { type: "square" },
    );
    const print = useMazeStore.getState().pngExportSettings.print;
    expect(print.scaleAutoFit).toBe(false);
    expect(print.paperSize).toBe("a4");
    expect(print.scale).toBeGreaterThan(0);
  });
});

describe("misc UI state setters", () => {
  it("covers panel / section / warning toggles", () => {
    const st = actions();
    st.setActiveRenderMode("vector_by_walls");
    st.setOpenRenderModeSettings("vector_by_walls");
    st.setOpenExportFormatSettings("png");
    st.setExportFormatSettingsCovered(true);
    expect(useMazeStore.getState().exportFormatSettingsCovered).toBe(true);
    st.setOpenExportFormatSettings(null);
    expect(useMazeStore.getState().exportFormatSettingsCovered).toBe(false);
    st.setVectorByWallsSectionExpanded("a", true);
    st.setVectorByCorridorsSectionExpanded("b", true);
    st.setLinkIconVisibility("all");
    st.setHoveredTeleportNodeIds([1, 2]);
    st.setHoveredExportWarningKey("w");
    st.setShowColorWarnings(false);
    const s = useMazeStore.getState();
    expect(s.vectorByWallsSectionsExpanded["a"]).toBe(true);
    expect(s.vectorByCorridorsSectionsExpanded["b"]).toBe(true);
    expect(s.hoveredTeleportNodeIds).toEqual([1, 2]);
    expect(s.hoveredExportWarningKey).toBeNull();
    expect(s.showColorWarnings).toBe(false);
  });
});
