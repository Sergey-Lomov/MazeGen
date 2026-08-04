import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { canvas } from "../pixi/colorTokens";
import { WALL_THICKNESS } from "../pixi/renderConstants";
import { splitSlotColor } from "../pixi/colorUtils";

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
      floorColor: canvas.floor.default,
      wallColor: canvas.wall.default,
      wallJoin: "round",
      wallThickness: WALL_THICKNESS,
      oneWayPattern: "triangle",
      oneWayColor: 0xffaa00,
      oneWayBorderWidth: 3,
      oneWaySize: 0.3,
      oneWayThickness: 4,
      oneWayJoin: "round",
      startMarker: { shape: "circle", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0 },
      finishMarker: { shape: "circle", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0 },
      teleportLineCornerStyle: "sharp",
      teleportLineShape: "square",
      teleportLineSize: 0.3,
      teleportEdgeColor: canvas.teleport.default,
      teleportEdgeBorderColor: canvas.teleport.default,
      teleportEdgeBorderWidth: 3,
      teleportConnectorColor: canvas.teleport.default,
      teleportConnectorWidth: 3,
      teleportConnectorStyle: "straight",
      teleportArrowMode: "center",
      teleportArrowPeriod: 5,
      teleportArrowSize: 6,
      teleportConnectorBorderWidth: 0,
      teleportGroupCustomization: false,
      teleportGroupOverrides: {},
      splitNodeColors: [],
      splitSpecialShapes: false,
    },
  });
});

describe("mazeStore image export", () => {
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
  it("starts with defaults matching the editor's own canvas/grid colors, grid shown", () => {
    const s = useMazeStore.getState();
    expect(s.vectorByWallsSettings).toEqual({
      background: canvas.stage.background,
      showGrid: true,
      gridColor: canvas.grid.line,
      floorColor: canvas.floor.default,
      wallColor: canvas.wall.default,
      wallJoin: "round",
      wallThickness: WALL_THICKNESS,
      oneWayPattern: "triangle",
      oneWayColor: 0xffaa00,
      oneWayBorderWidth: 3,
      oneWaySize: 0.3,
      oneWayThickness: 4,
      oneWayJoin: "round",
      startMarker: { shape: "circle", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0 },
      finishMarker: { shape: "circle", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0 },
      teleportLineCornerStyle: "sharp",
      teleportLineShape: "square",
      teleportLineSize: 0.3,
      teleportEdgeColor: canvas.teleport.default,
      teleportEdgeBorderColor: canvas.teleport.default,
      teleportEdgeBorderWidth: 3,
      teleportConnectorColor: canvas.teleport.default,
      teleportConnectorWidth: 3,
      teleportConnectorStyle: "straight",
      teleportArrowMode: "center",
      teleportArrowPeriod: 5,
      teleportArrowSize: 6,
      teleportConnectorBorderWidth: 0,
      teleportGroupCustomization: false,
      teleportGroupOverrides: {},
      splitNodeColors: [],
      splitSpecialShapes: false,
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
    useMazeStore.getState().setVectorByWallsOneWayBorderWidth(3);
    useMazeStore.getState().setVectorByWallsOneWaySize(0.3);
    useMazeStore.getState().setVectorByWallsOneWayThickness(6);
    useMazeStore.getState().setVectorByWallsOneWayJoin("miter");
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.oneWayColor).toBe(0x555555);
    expect(settings.oneWayBorderWidth).toBe(3);
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

  it("setVectorByWallsStartMarkerFillColor/BorderColor/BorderWidth update only the start marker", () => {
    useMazeStore.getState().setVectorByWallsStartMarkerFillColor(0x111111);
    useMazeStore.getState().setVectorByWallsStartMarkerBorderColor(0x222222);
    useMazeStore.getState().setVectorByWallsStartMarkerBorderWidth(3);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.startMarker).toEqual({ shape: "circle", fillColor: 0x111111, borderColor: 0x222222, borderWidth: 3 });
    expect(settings.finishMarker.fillColor).toBe(canvas.node.finish);
  });

  it("setVectorByWallsFinishMarkerShape/FillColor/BorderColor/BorderWidth update only the finish marker", () => {
    useMazeStore.getState().setVectorByWallsFinishMarkerShape("star");
    useMazeStore.getState().setVectorByWallsFinishMarkerFillColor(0x333333);
    useMazeStore.getState().setVectorByWallsFinishMarkerBorderColor(0x444444);
    useMazeStore.getState().setVectorByWallsFinishMarkerBorderWidth(5);
    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.finishMarker).toEqual({ shape: "star", fillColor: 0x333333, borderColor: 0x444444, borderWidth: 5 });
    expect(settings.startMarker.fillColor).toBe(canvas.node.start);
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
