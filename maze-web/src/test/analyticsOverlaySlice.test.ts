import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
});

describe("mazeStore analytics overlays", () => {
  it("each overlay setter toggles its own flag independently", () => {
    const s0 = useMazeStore.getState();
    s0.setShowMazeOverlay(false);
    s0.setShowComponentsOverlay(true);
    s0.setShowGraphOverlay(true);
    s0.setShowNavGraphOverlay(true);
    s0.setShowPureCyclesOverlay(true);
    s0.setShowRouteOverlay(true);
    s0.setShowRegionClassesOverlay(true);
    const s = useMazeStore.getState();
    expect(s.showMazeOverlay).toBe(false);
    expect(s.showComponentsOverlay).toBe(true);
    expect(s.showGraphOverlay).toBe(true);
    expect(s.showNavGraphOverlay).toBe(true);
    expect(s.showPureCyclesOverlay).toBe(true);
    expect(s.showRouteOverlay).toBe(true);
    expect(s.showRegionClassesOverlay).toBe(true);
  });

  it("setRegionClassLegendOpen toggles the legend modal flag", () => {
    expect(useMazeStore.getState().regionClassLegendOpen).toBe(false);
    useMazeStore.getState().setRegionClassLegendOpen(true);
    expect(useMazeStore.getState().regionClassLegendOpen).toBe(true);
    useMazeStore.getState().setRegionClassLegendOpen(false);
    expect(useMazeStore.getState().regionClassLegendOpen).toBe(false);
  });
});
