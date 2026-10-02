import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { canvas } from "../pixi/colorTokens";
import { WALL_THICKNESS } from "../pixi/renderConstants";
import { splitSlotColor } from "../pixi/colorUtils";
import { DEFAULT_PNG_EXPORT_SETTINGS, DEFAULT_SHARED_STYLE_SOURCE, DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_DECORATIVE_SETTINGS, DEFAULT_MARKER_INDEX_SETTINGS } from "../store/slices/imageExportSlice";
import { DEFAULT_VECTOR_BY_WALLS_LINKS } from "../store/slices/parameterLinksDefaults";
import { mmToPx, printCellMeasureMm, DPI_BY_DENSITY } from "../pixi/imageExport/printFit";
import { TRI_TILE_SIZE } from "../pixi/triGeometry";

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
    activeRenderMode: null,
    openRenderModeSettings: null,
    vectorByWallsSectionsExpanded: {},
    vectorByWallsSettings: {
      background: canvas.stage.background,
      showGrid: true,
      gridColor: canvas.grid.line,
      showInnerGrid: false,
      innerGridColor: 0x3a3a3a,
      floorColor: canvas.floor.default,
      wallColor: canvas.wall.default,
      randomWallColorMode: "off",
      wallJoin: "round",
      wallThickness: WALL_THICKNESS,
      oneWayPattern: "triangle",
      oneWayColor: 0xffaa00,
      oneWayGapWidth: 3,
      oneWaySize: 0.3,
      oneWayThickness: 4,
      oneWayJoin: "round",
      startMarker: { shape: "circle", cornerStyle: "miter", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, gapWidth: 0, size: 0.225 },
      finishMarker: { shape: "circle", cornerStyle: "miter", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, gapWidth: 0, size: 0.225 },
      teleportLineCornerStyle: "miter",
      teleportLineShape: "square",
      teleportLineSize: 0.3,
      teleportEdgeColor: canvas.teleport.default,
      teleportEdgeBorderColor: canvas.teleport.default,
      teleportEdgeBorderWidth: 3,
      teleportEdgeGapWidth: 0,
      teleportConnectorColor: canvas.teleport.default,
      teleportConnectorWidth: 3,
      teleportConnectorStyle: "straight",
      teleportAvoidFieldExit: false,
      teleportArrowMode: "center",
      teleportArrowPeriod: 5,
      teleportArrowSize: 6,
      teleportConnectorGapWidth: 0,
      teleportFloorBadge: { shape: "circle", labelType: "arabic", size: 0.16, fillColor: 0x123456, borderColor: 0x123456, textColor: 0x123456, textPadding: 0 },
      teleportGroupCustomization: false,
      teleportGroupOverrides: {},
      ...DEFAULT_VERTICAL_SETTINGS,
      ...DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
      splitNodeColors: [],
      splitSpecialShapes: false,
      markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
      ...DEFAULT_SHARED_STYLE_SOURCE,
      links: DEFAULT_VECTOR_BY_WALLS_LINKS,
    },
  });
});

describe("mazeStore image export", () => {
  it("converts a requested triangle side length using the triangle geometry", () => {
    useMazeStore.setState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, density: "print_300" },
      },
    });

    useMazeStore.getState().setPrintFieldSizing({
      paperSize: "a4",
      customWidthMm: 210,
      customHeightMm: 297,
      orientation: "portrait",
      cellSizeMm: 10,
      marginHMm: 5,
      marginVMm: 5,
    }, { type: "triangle_rect" });

    expect(useMazeStore.getState().pngExportSettings.print.scale).toBeCloseTo(mmToPx(10, 300) / ((TRI_TILE_SIZE * 2) / Math.sqrt(3)));
  });

  it("keeps the physical cell size stable when manually scaled print density changes", () => {
    const scale = 12.5;
    useMazeStore.setState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, density: "print_300", scale, scaleAutoFit: false },
      },
    });
    const beforeMm = printCellMeasureMm({ type: "square" }, scale, DPI_BY_DENSITY.print_300);

    useMazeStore.getState().setPrintDensity("high_600");

    const print = useMazeStore.getState().pngExportSettings.print;
    expect(print.scale).toBeCloseTo(scale * DPI_BY_DENSITY.high_600 / DPI_BY_DENSITY.print_300);
    expect(printCellMeasureMm({ type: "square" }, print.scale, DPI_BY_DENSITY.high_600)).toBeCloseTo(beforeMm);
  });

  it("does not rescale the auto-fit print scale when density changes", () => {
    const scale = 12.5;
    useMazeStore.setState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, density: "print_300", scale, scaleAutoFit: true },
      },
    });

    useMazeStore.getState().setPrintDensity("high_600");

    expect(useMazeStore.getState().pngExportSettings.print.scale).toBe(scale);
  });

  it("starts with no active render mode and no open settings panel", () => {
    const s = useMazeStore.getState();
    expect(s.activeRenderMode).toBeNull();
    expect(s.openRenderModeSettings).toBeNull();
  });

  it("setActiveRenderMode sets the active mode", () => {
    useMazeStore.getState().setActiveRenderMode("vector_by_walls");
    expect(useMazeStore.getState().activeRenderMode).toBe("vector_by_walls");
  });

  it("setOpenRenderModeSettings sets and clears the open settings panel independently of the active mode", () => {
    useMazeStore.getState().setActiveRenderMode("vector_by_walls");
    useMazeStore.getState().setOpenRenderModeSettings("vector_by_walls");
    expect(useMazeStore.getState().openRenderModeSettings).toBe("vector_by_walls");
    expect(useMazeStore.getState().activeRenderMode).toBe("vector_by_walls");

    useMazeStore.getState().setOpenRenderModeSettings(null);
    expect(useMazeStore.getState().openRenderModeSettings).toBeNull();
    expect(useMazeStore.getState().activeRenderMode).toBe("vector_by_walls");
  });

  it("reset() clears activeRenderMode and openRenderModeSettings", () => {
    useMazeStore.getState().setActiveRenderMode("vector_by_walls");
    useMazeStore.getState().setOpenRenderModeSettings("vector_by_walls");
    useMazeStore.getState().reset();
    expect(useMazeStore.getState().activeRenderMode).toBeNull();
    expect(useMazeStore.getState().openRenderModeSettings).toBeNull();
  });
});

describe("mazeStore vectorByWallsSettings", () => {
  it("starts with editor-matching background-grid defaults and the inner grid disabled", () => {
    const s = useMazeStore.getState();
    expect(s.vectorByWallsSettings).toEqual({
      background: canvas.stage.background,
      showGrid: true,
      gridColor: canvas.grid.line,
      showInnerGrid: false,
      innerGridColor: 0x3a3a3a,
      floorColor: canvas.floor.default,
      wallColor: canvas.wall.default,
      randomWallColorMode: "off",
      wallJoin: "round",
      wallThickness: WALL_THICKNESS,
      oneWayPattern: "triangle",
      oneWayColor: 0xffaa00,
      oneWayGapWidth: 3,
      oneWaySize: 0.3,
      oneWayThickness: 4,
      oneWayJoin: "round",
      startMarker: { shape: "circle", cornerStyle: "miter", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, gapWidth: 0, size: 0.225 },
      finishMarker: { shape: "circle", cornerStyle: "miter", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, gapWidth: 0, size: 0.225 },
      teleportLineCornerStyle: "miter",
      teleportLineShape: "square",
      teleportLineSize: 0.3,
      teleportEdgeColor: canvas.teleport.default,
      teleportEdgeBorderColor: canvas.teleport.default,
      teleportEdgeBorderWidth: 3,
      teleportEdgeGapWidth: 0,
      teleportConnectorColor: canvas.teleport.default,
      teleportConnectorWidth: 3,
      teleportConnectorStyle: "straight",
      teleportAvoidFieldExit: false,
      teleportArrowMode: "center",
      teleportArrowPeriod: 5,
      teleportArrowSize: 6,
      teleportConnectorGapWidth: 0,
      teleportFloorBadge: { shape: "circle", labelType: "arabic", size: 0.16, fillColor: 0x123456, borderColor: 0x123456, textColor: 0x123456, textPadding: 0 },
      teleportGroupCustomization: false,
      teleportGroupOverrides: {},
      ...DEFAULT_VERTICAL_SETTINGS,
      ...DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
      splitNodeColors: [],
      splitSpecialShapes: false,
      markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
      ...DEFAULT_SHARED_STYLE_SOURCE,
      links: DEFAULT_VECTOR_BY_WALLS_LINKS,
    });
  });

  it("setVectorByWallsBackground updates only the background field", () => {
    useMazeStore.getState().setVectorByWallsBackground(0x123456);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.background).toBe(0x123456);
    expect(settings.showGrid).toBe(true);
    expect(settings.gridColor).toBe(canvas.grid.line);
  });

  it("setVectorByWallsShowGrid toggles grid visibility", () => {
    useMazeStore.getState().setVectorByWallsShowGrid(false);
    expect(useMazeStore.getState().vectorByWallsSettings.showGrid).toBe(false);
  });

  it("setVectorByWallsGridColor updates only the grid color field", () => {
    useMazeStore.getState().setVectorByWallsGridColor(0xabcdef);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.gridColor).toBe(0xabcdef);
    expect(settings.background).toBe(canvas.stage.background);
  });

  it("keeps the inner-grid toggle and color independent from the original background grid", () => {
    useMazeStore.getState().setVectorByWallsShowInnerGrid(true);
    useMazeStore.getState().setVectorByWallsInnerGridColor(0xabcdef);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.showInnerGrid).toBe(true);
    expect(settings.innerGridColor).toBe(0xabcdef);
    expect(settings.showGrid).toBe(true);
    expect(settings.gridColor).toBe(canvas.grid.line);
  });

  it("setVectorByWallsFloorColor updates only the floor color field", () => {
    useMazeStore.getState().setVectorByWallsFloorColor(0x111111);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.floorColor).toBe(0x111111);
    expect(settings.background).toBe(canvas.stage.background);
  });

  it("setVectorByWallsWallColor updates only the wall color field", () => {
    useMazeStore.getState().setVectorByWallsWallColor(0x222222);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.wallColor).toBe(0x222222);
    expect(settings.background).toBe(canvas.stage.background);
  });

  it("setVectorByWallsWallJoin updates only the wall join field", () => {
    useMazeStore.getState().setVectorByWallsWallJoin("miter");
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.wallJoin).toBe("miter");
    expect(settings.background).toBe(canvas.stage.background);
  });

  it("setVectorByWallsWallThickness updates only the wall thickness field", () => {
    useMazeStore.getState().setVectorByWallsWallThickness(7);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.wallThickness).toBe(7);
    expect(settings.background).toBe(canvas.stage.background);
  });

  it("setVectorByWallsOneWayPattern updates only the one-way pattern field", () => {
    useMazeStore.getState().setVectorByWallsOneWayPattern("chevron");
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.oneWayPattern).toBe("chevron");
    expect(settings.background).toBe(canvas.stage.background);
  });

  it("setVectorByWallsOneWayColor/BorderWidth/Size/Thickness/Join update only the one-way fields", () => {
    useMazeStore.getState().setVectorByWallsOneWayColor(0x555555);
    useMazeStore.getState().setVectorByWallsOneWayGapWidth(3);
    useMazeStore.getState().setVectorByWallsOneWaySize(0.3);
    useMazeStore.getState().setVectorByWallsOneWayThickness(6);
    useMazeStore.getState().setVectorByWallsOneWayJoin("miter");
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.oneWayColor).toBe(0x555555);
    expect(settings.oneWayGapWidth).toBe(3);
    expect(settings.oneWaySize).toBe(0.3);
    expect(settings.oneWayThickness).toBe(6);
    expect(settings.oneWayJoin).toBe("miter");
    expect(settings.background).toBe(canvas.stage.background);
  });

  it("setVectorByWallsStartMarkerShape updates only the start marker's shape", () => {
    useMazeStore.getState().setVectorByWallsStartMarkerShape("diamond");
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.startMarker.shape).toBe("diamond");
    expect(settings.finishMarker.shape).toBe("circle");
  });

  it("setVectorByWallsStartMarkerFillColor/BorderColor/BorderWidth/GapWidth/Size/CornerStyle update only the start marker", () => {
    useMazeStore.getState().setVectorByWallsStartMarkerFillColor(0x111111);
    useMazeStore.getState().setVectorByWallsStartMarkerBorderColor(0x222222);
    useMazeStore.getState().setVectorByWallsStartMarkerBorderWidth(3);
    useMazeStore.getState().setVectorByWallsStartMarkerGapWidth(2);
    useMazeStore.getState().setVectorByWallsStartMarkerSize(0.5);
    useMazeStore.getState().setVectorByWallsStartMarkerCornerStyle("round");
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.startMarker).toEqual({ shape: "circle", cornerStyle: "round", fillColor: 0x111111, borderColor: 0x222222, borderWidth: 3, gapWidth: 2, size: 0.5 });
    expect(settings.finishMarker.fillColor).toBe(canvas.node.finish);
  });

  it("setVectorByWallsFinishMarkerShape/FillColor/BorderColor/BorderWidth/GapWidth/Size/CornerStyle update only the finish marker", () => {
    useMazeStore.getState().setVectorByWallsFinishMarkerShape("star");
    useMazeStore.getState().setVectorByWallsFinishMarkerFillColor(0x333333);
    useMazeStore.getState().setVectorByWallsFinishMarkerBorderColor(0x444444);
    useMazeStore.getState().setVectorByWallsFinishMarkerBorderWidth(5);
    useMazeStore.getState().setVectorByWallsFinishMarkerGapWidth(4);
    useMazeStore.getState().setVectorByWallsFinishMarkerSize(0.6);
    useMazeStore.getState().setVectorByWallsFinishMarkerCornerStyle("round");
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.finishMarker).toEqual({ shape: "star", cornerStyle: "round", fillColor: 0x333333, borderColor: 0x444444, borderWidth: 5, gapWidth: 4, size: 0.6 });
    expect(settings.startMarker.fillColor).toBe(canvas.node.start);
  });

  it("setVectorByWallsTwoWayPassageMarker* setters update only the two-way marker and mark cornerStyle/markerBorderWidth/gapWidth/markerSize overridden for 'twoWayPassage'", () => {
    useMazeStore.getState().setVectorByWallsTwoWayPassageMarkerShape("diamond");
    useMazeStore.getState().setVectorByWallsTwoWayPassageMarkerFillColor(0x111111);
    useMazeStore.getState().setVectorByWallsTwoWayPassageMarkerBorderColor(0x222222);
    useMazeStore.getState().setVectorByWallsTwoWayPassageMarkerCornerStyle("miter");
    useMazeStore.getState().setVectorByWallsTwoWayPassageMarkerBorderWidth(7);
    useMazeStore.getState().setVectorByWallsTwoWayPassageMarkerGapWidth(6);
    useMazeStore.getState().setVectorByWallsTwoWayPassageMarkerSize(0.5);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.twoWayPassageMarker).toEqual({ shape: "diamond", cornerStyle: "miter", fillColor: 0x111111, borderColor: 0x222222, borderWidth: 7, gapWidth: 6, size: 0.5 });
    // Untouched sibling marker groups stay at their own defaults (elevator defaults to "diamond"
    // itself, so only oneWayPassage — default "circle" — is a safe non-collision check here).
    expect(settings.oneWayPassageMarker.shape).not.toBe("diamond");
    // The four Shared-style-backed fields (GitHub issue #347 follow-up) must record themselves as
    // disabled links for the two-way marker's own targets specifically.
    const twoWayTargets = ["twoWayPassageMarker.cornerStyle", "twoWayPassageMarker.borderWidth", "twoWayPassageMarker.gapWidth", "twoWayPassageMarker.size"];
    for (const target of twoWayTargets) {
      expect(settings.links.find((l) => l.target === target)?.enabled).toBe(false);
    }
  });

  it("setVectorByWallsOneWayPassageMarker* setters update only the one-way marker and mark cornerStyle/markerBorderWidth/gapWidth/markerSize overridden for 'oneWayPassage'", () => {
    useMazeStore.getState().setVectorByWallsOneWayPassageMarkerShape("square");
    useMazeStore.getState().setVectorByWallsOneWayPassageMarkerFillColor(0x333333);
    useMazeStore.getState().setVectorByWallsOneWayPassageMarkerBorderColor(0x444444);
    useMazeStore.getState().setVectorByWallsOneWayPassageMarkerCornerStyle("miter");
    useMazeStore.getState().setVectorByWallsOneWayPassageMarkerBorderWidth(8);
    useMazeStore.getState().setVectorByWallsOneWayPassageMarkerGapWidth(1);
    useMazeStore.getState().setVectorByWallsOneWayPassageMarkerSize(0.4);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.oneWayPassageMarker).toEqual({ shape: "square", cornerStyle: "miter", fillColor: 0x333333, borderColor: 0x444444, borderWidth: 8, gapWidth: 1, size: 0.4 });
    expect(settings.twoWayPassageMarker.shape).not.toBe("square");
    expect(settings.elevatorMarker.shape).not.toBe("square");
    const oneWayTargets = ["oneWayPassageMarker.cornerStyle", "oneWayPassageMarker.borderWidth", "oneWayPassageMarker.gapWidth", "oneWayPassageMarker.size"];
    for (const target of oneWayTargets) {
      expect(settings.links.find((l) => l.target === target)?.enabled).toBe(false);
    }
  });

  it("setVectorByWallsElevatorMarker* setters update only the elevator marker and mark cornerStyle/markerBorderWidth/gapWidth/markerSize overridden for 'elevator'", () => {
    useMazeStore.getState().setVectorByWallsElevatorMarkerShape("star");
    useMazeStore.getState().setVectorByWallsElevatorMarkerFillColor(0x555555);
    useMazeStore.getState().setVectorByWallsElevatorMarkerBorderColor(0x666666);
    useMazeStore.getState().setVectorByWallsElevatorMarkerCornerStyle("miter");
    useMazeStore.getState().setVectorByWallsElevatorMarkerBorderWidth(9);
    useMazeStore.getState().setVectorByWallsElevatorMarkerGapWidth(2);
    useMazeStore.getState().setVectorByWallsElevatorMarkerSize(0.6);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.elevatorMarker).toEqual({ shape: "star", cornerStyle: "miter", fillColor: 0x555555, borderColor: 0x666666, borderWidth: 9, gapWidth: 2, size: 0.6 });
    expect(settings.twoWayPassageMarker.shape).not.toBe("star");
    expect(settings.oneWayPassageMarker.shape).not.toBe("star");
    const elevatorTargets = ["elevatorMarker.cornerStyle", "elevatorMarker.borderWidth", "elevatorMarker.gapWidth", "elevatorMarker.size"];
    for (const target of elevatorTargets) {
      expect(settings.links.find((l) => l.target === target)?.enabled).toBe(false);
    }
  });

  it("setVectorByWallsSplitNodeColor sets a slot directly adjacent to the current array end", () => {
    useMazeStore.getState().setVectorByWallsSplitNodeColor(0, 0xaaaaaa);
    expect(useMazeStore.getState().vectorByWallsSettings.splitNodeColors).toEqual([0xaaaaaa]);
    useMazeStore.getState().setVectorByWallsSplitNodeColor(1, 0xbbbbbb);
    expect(useMazeStore.getState().vectorByWallsSettings.splitNodeColors).toEqual([0xaaaaaa, 0xbbbbbb]);
  });

  it("setVectorByWallsSplitNodeColor backfills any skipped intermediate slots with splitSlotColor's own default", () => {
    // Setting index 2 directly (array starts empty) must fill slots 0/1 with their default
    // palette color, not leave them undefined/sparse.
    useMazeStore.getState().setVectorByWallsSplitNodeColor(2, 0xcccccc);
    const colors = useMazeStore.getState().vectorByWallsSettings.splitNodeColors;
    expect(colors).toEqual([
      splitSlotColor(0, canvas.node.splitSlots),
      splitSlotColor(1, canvas.node.splitSlots),
      0xcccccc,
    ]);
  });

  it("setVectorByWallsSplitNodeColor overwrites an already-set slot without touching others", () => {
    useMazeStore.getState().setVectorByWallsSplitNodeColor(0, 0x111111);
    useMazeStore.getState().setVectorByWallsSplitNodeColor(1, 0x222222);
    useMazeStore.getState().setVectorByWallsSplitNodeColor(0, 0x999999);
    expect(useMazeStore.getState().vectorByWallsSettings.splitNodeColors).toEqual([0x999999, 0x222222]);
  });

  it("setVectorByWallsSplitSpecialShapes toggles the flag", () => {
    useMazeStore.getState().setVectorByWallsSplitSpecialShapes(true);
    expect(useMazeStore.getState().vectorByWallsSettings.splitSpecialShapes).toBe(true);
    useMazeStore.getState().setVectorByWallsSplitSpecialShapes(false);
    expect(useMazeStore.getState().vectorByWallsSettings.splitSpecialShapes).toBe(false);
  });

  it("reset() does NOT clear vectorByWallsSettings — export settings are an independent layer from maze data", () => {
    useMazeStore.getState().setVectorByWallsBackground(0x123456);
    useMazeStore.getState().setVectorByWallsShowGrid(false);
    useMazeStore.getState().reset();
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.background).toBe(0x123456);
    expect(settings.showGrid).toBe(false);
  });
});

describe("mazeStore shared-style link patch/reset actions (GitHub issue #643)", () => {
  it("patchVectorByWallsMarkerIndexSettings disables the markerIndex.gap link only when patch.gap is present", () => {
    useMazeStore.getState().patchVectorByWallsMarkerIndexSettings({ offset: 5 });
    expect(useMazeStore.getState().vectorByWallsSettings.links.find((l) => l.target === "markerIndex.gap")?.enabled).toBe(true);
    useMazeStore.getState().patchVectorByWallsMarkerIndexSettings({ gap: 2 });
    expect(useMazeStore.getState().vectorByWallsSettings.markerIndex.gap).toBe(2);
    expect(useMazeStore.getState().vectorByWallsSettings.links.find((l) => l.target === "markerIndex.gap")?.enabled).toBe(false);
  });

  it("resetVectorByWallsSharedStyleField no-ops on a path with no incoming link", () => {
    const before = useMazeStore.getState().vectorByWallsSettings;
    useMazeStore.getState().resetVectorByWallsSharedStyleField("markerSize");
    expect(useMazeStore.getState().vectorByWallsSettings).toBe(before);
  });

  it("patchVectorByCorridorsOneWaySettings disables the oneWayJoin link only when patch.oneWayJoin is present", () => {
    useMazeStore.getState().patchVectorByCorridorsOneWaySettings({ oneWayColor: 0x123456 });
    expect(useMazeStore.getState().vectorByCorridorsSettings.links.find((l) => l.target === "oneWayJoin")?.enabled).toBe(true);
    useMazeStore.getState().patchVectorByCorridorsOneWaySettings({ oneWayJoin: "miter" });
    expect(useMazeStore.getState().vectorByCorridorsSettings.oneWayJoin).toBe("miter");
    expect(useMazeStore.getState().vectorByCorridorsSettings.links.find((l) => l.target === "oneWayJoin")?.enabled).toBe(false);
  });

  it("patchVectorByCorridorsMarkerIndexSettings disables the markerIndex.gap link only when patch.gap is present", () => {
    useMazeStore.getState().patchVectorByCorridorsMarkerIndexSettings({ offset: 5 });
    expect(useMazeStore.getState().vectorByCorridorsSettings.links.find((l) => l.target === "markerIndex.gap")?.enabled).toBe(true);
    useMazeStore.getState().patchVectorByCorridorsMarkerIndexSettings({ gap: 2 });
    expect(useMazeStore.getState().vectorByCorridorsSettings.markerIndex.gap).toBe(2);
    expect(useMazeStore.getState().vectorByCorridorsSettings.links.find((l) => l.target === "markerIndex.gap")?.enabled).toBe(false);
  });

  it("resetVectorByCorridorsSharedStyleField no-ops on a path with no incoming link", () => {
    const before = useMazeStore.getState().vectorByCorridorsSettings;
    useMazeStore.getState().resetVectorByCorridorsSharedStyleField("markerSize");
    expect(useMazeStore.getState().vectorByCorridorsSettings).toBe(before);
  });
});

describe("mazeStore parameter-links management actions (GitHub issue #644)", () => {
  it("addVectorByWallsLink creates a link and propagates the source's value", () => {
    useMazeStore.getState().removeVectorByWallsLink("elevatorMarker.size");
    useMazeStore.getState().setVectorByWallsSharedMarkerSize(0.33);
    useMazeStore.getState().addVectorByWallsLink("markerSize", "elevatorMarker.size");
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.elevatorMarker.size).toBe(0.33);
    expect(settings.links.find((l) => l.target === "elevatorMarker.size")).toMatchObject({ source: "markerSize", enabled: true });
  });

  it("removeVectorByWallsLink drops the link targeting the given path without touching its value", () => {
    const before = useMazeStore.getState().vectorByWallsSettings.startMarker.cornerStyle;
    useMazeStore.getState().removeVectorByWallsLink("startMarker.cornerStyle");
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.links.find((l) => l.target === "startMarker.cornerStyle")).toBeUndefined();
    expect(settings.startMarker.cornerStyle).toBe(before);
  });

  it("setVectorByWallsLinkEnabled toggles enabled without re-propagating on disable", () => {
    useMazeStore.getState().setVectorByWallsStartMarkerSize(0.77);
    useMazeStore.getState().setVectorByWallsLinkEnabled("startMarker.size", true);
    expect(useMazeStore.getState().vectorByWallsSettings.links.find((l) => l.target === "startMarker.size")?.enabled).toBe(true);
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.size).toBe(useMazeStore.getState().vectorByWallsSettings.markerSize);
  });

  it("addVectorByCorridorsLink creates a link and propagates the source's value", () => {
    useMazeStore.getState().removeVectorByCorridorsLink("elevatorMarker.size");
    useMazeStore.getState().setVectorByCorridorsSharedMarkerSize(0.21);
    useMazeStore.getState().addVectorByCorridorsLink("markerSize", "elevatorMarker.size");
    const settings = useMazeStore.getState().vectorByCorridorsSettings;
    expect(settings.elevatorMarker.size).toBe(0.21);
    expect(settings.links.find((l) => l.target === "elevatorMarker.size")).toMatchObject({ source: "markerSize", enabled: true });
  });

  it("removeVectorByCorridorsLink drops the link targeting the given path without touching its value", () => {
    const before = useMazeStore.getState().vectorByCorridorsSettings.startMarker.cornerStyle;
    useMazeStore.getState().removeVectorByCorridorsLink("startMarker.cornerStyle");
    const settings = useMazeStore.getState().vectorByCorridorsSettings;
    expect(settings.links.find((l) => l.target === "startMarker.cornerStyle")).toBeUndefined();
    expect(settings.startMarker.cornerStyle).toBe(before);
  });

});

describe("mazeStore vectorByWallsSectionsExpanded", () => {
  it("starts empty", () => {
    expect(useMazeStore.getState().vectorByWallsSectionsExpanded).toEqual({});
  });

  it("setVectorByWallsSectionExpanded sets a section's expanded state by id", () => {
    useMazeStore.getState().setVectorByWallsSectionExpanded("background", false);
    expect(useMazeStore.getState().vectorByWallsSectionsExpanded).toEqual({ background: false });
    useMazeStore.getState().setVectorByWallsSectionExpanded("background", true);
    expect(useMazeStore.getState().vectorByWallsSectionsExpanded).toEqual({ background: true });
  });
});
