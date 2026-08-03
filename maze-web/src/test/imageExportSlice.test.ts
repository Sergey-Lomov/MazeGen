import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { canvas } from "../pixi/colorTokens";

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
    vectorByWallsSettings: { background: canvas.stage.background, showGrid: true, gridColor: canvas.grid.line },
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
