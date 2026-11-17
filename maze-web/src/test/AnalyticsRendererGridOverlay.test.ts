import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { AnalyticsRenderer } from "../pixi/AnalyticsRenderer";
import { baseFloorFieldConfig, baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellOutlines: (await importActual<typeof import("../wasm/mazeService")>()).getCellOutlines,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
  getRegionEdges: (await importActual<typeof import("../wasm/mazeService")>()).getRegionEdges,
  generateMaze: vi.fn(),
  computeAnalyticsAsync: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

describe("AnalyticsRenderer grid overlay (GitHub issue #997)", () => {
  let renderer: AnalyticsRenderer | undefined;

  beforeEach(() => {
    const fieldConfig = fieldOf("square", { shape: "rect", cols: 2, rows: 1 });
    useMazeStore.setState({
      ...baseStoreState(),
      openCard: "analytics",
      activeFieldConfig: fieldConfig,
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig }) },
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [{ from: 0, to: 1, kind: "basic" }],
    } as Partial<ReturnType<typeof useMazeStore.getState>>);
    renderer = new AnalyticsRenderer(new Container());
  });

  afterEach(() => {
    renderer?.destroy();
    renderer = undefined;
    vi.restoreAllMocks();
  });

  it("hides only the grid when its toggle is disabled", () => {
    const layers = renderer as unknown as { gridContainer: Container; floorContainer: Container };
    expect(layers.gridContainer.visible).toBe(true);
    expect(layers.floorContainer.visible).toBe(true);

    useMazeStore.getState().setShowGridOverlay(false);

    expect(layers.gridContainer.visible).toBe(false);
    expect(layers.floorContainer.visible).toBe(true);
  });
});
