import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";
import { GenerationRenderer } from "../pixi/GenerationRenderer";
import { GridRenderer } from "../pixi/renderers/GridRenderer";
import { fieldOf } from "./fieldConfigFixtures";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellOutlines: (await importActual<typeof import("../wasm/mazeService")>()).getCellOutlines,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
  generateMaze: vi.fn(),
  computeAnalyticsAsync: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

const FIELD = fieldOf("square", { shape: "rect", cols: 4, rows: 1 });
const NODES = [0, 1, 2, 3].map((x) => ({ id: x, x, y: 0, i: 0 }));
const EDGES = [{ from: 0, to: 1, kind: "basic" as const }];

// `GridRenderer.render` runs exactly once per `renderAll`, so its call count is the redraw count.
describe("GenerationRenderer redraw count (GitHub issue #174)", () => {
  let renderer: GenerationRenderer | null = null;
  let renders: ReturnType<typeof vi.spyOn>;

  const baseState = (patch: Partial<ReturnType<typeof useMazeStore.getState>> = {}) => ({
    ...baseStoreState(),
    floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: FIELD }) },
    activeFieldConfig: FIELD,
    showMaze: true,
    ...patch,
  } as Partial<ReturnType<typeof useMazeStore.getState>>);

  beforeEach(() => {
    renders = vi.spyOn(GridRenderer.prototype, "render");
  });

  afterEach(() => {
    renderer?.destroy();
    renderer = null;
    vi.restoreAllMocks();
  });

  it("draws once on construction when the layer starts visible", () => {
    useMazeStore.setState(baseState({ openCard: "generation" }));
    renderer = new GenerationRenderer(new Container());
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("draws once on construction when the layer starts hidden", () => {
    useMazeStore.setState(baseState({ openCard: "field" } as never));
    renderer = new GenerationRenderer(new Container());
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("draws once when the first maze arrives together with the visibility change", () => {
    useMazeStore.setState(baseState({ openCard: "generation", _generatedNodes: [], _generatedEdges: [] }));
    renderer = new GenerationRenderer(new Container());
    renders.mockClear();

    // The empty-to-generated transition flips the seam arrows' visibility and changes the data in one update.
    useMazeStore.setState({ _generatedNodes: NODES, _generatedEdges: EDGES, start: 0, finish: 3 });
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("draws once when the card opens and the data changes in the same update", () => {
    useMazeStore.setState(baseState({ openCard: "field" } as never));
    renderer = new GenerationRenderer(new Container());
    renders.mockClear();

    useMazeStore.setState({ openCard: "generation", _generatedNodes: NODES, _generatedEdges: EDGES });
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("draws once per data-only change while the layer stays visible", () => {
    useMazeStore.setState(baseState({ openCard: "generation", _generatedNodes: NODES, _generatedEdges: EDGES }));
    renderer = new GenerationRenderer(new Container());
    renders.mockClear();

    useMazeStore.setState({ _generatedEdges: [...EDGES] });
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("draws once when only the visibility changes", () => {
    useMazeStore.setState(baseState({ openCard: "field", _generatedNodes: NODES, _generatedEdges: EDGES } as never));
    renderer = new GenerationRenderer(new Container());
    renders.mockClear();

    useMazeStore.setState({ openCard: "generation" });
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("does not draw while the layer is hidden and nothing relevant changed", () => {
    useMazeStore.setState(baseState({ openCard: "field" } as never));
    renderer = new GenerationRenderer(new Container());
    renders.mockClear();

    useMazeStore.setState({ openCard: "analytics" } as never);
    expect(renders).not.toHaveBeenCalled();
  });
});
