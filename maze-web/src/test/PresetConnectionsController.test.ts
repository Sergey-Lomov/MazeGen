import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";
import { encodePoint } from "../pixi/tessellationProjection";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { PresetConnectionsController } from "../pixi/PresetConnectionsController";
import type { PresetConnectionsRenderer } from "../pixi/PresetConnectionsRenderer";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

const fieldCells = new Set([
  encodePoint(0, 0),
  encodePoint(1, 0),
  encodePoint(2, 0),
]);

function makeRenderer(): PresetConnectionsRenderer {
  return {
    getCachedCellSet: () => fieldCells,
    getCachedCells: () => [],
    updateCellHover: vi.fn(),
    updateHover: vi.fn(),
    updateTeleportPreview: vi.fn(),
  } as unknown as PresetConnectionsRenderer;
}

function makeController(): PresetConnectionsController {
  return new PresetConnectionsController(
    () => ({ x: 0, y: 0, scale: { x: 1, y: 1 } }) as unknown as Container,
    makeRenderer(),
    () => {},
  );
}

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    openCard: "preset_connections",
    presetConnectionsTool: "set_start",
    presetStart: presetEndpoint([0, 0]),
    presetFinish: null,
    presetDragOverride: null,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({
        tessellationConfig: { type: "square", width: 3, height: 3 },
        fieldPoints: fieldCells,
      }),
    },
  });
});

describe("PresetConnectionsController marker drag", () => {
  it("returns to the origin preview and can continue to a later cell", () => {
    const controller = makeController();

    // Square cell centers are (20, -20), (60, -20), and (100, -20).
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20);
    expect(useMazeStore.getState().presetDragOverride).toEqual({
      kind: "marker", marker: "start", point: [1, 0],
    });

    controller.onPointerMove(20, -20);
    expect(useMazeStore.getState().presetDragOverride).toBeNull();
    controller.onPointerMove(20, -20);
    expect(useMazeStore.getState().presetDragOverride).toBeNull();

    controller.onPointerMove(100, -20);
    expect(useMazeStore.getState().presetDragOverride).toEqual({
      kind: "marker", marker: "start", point: [2, 0],
    });

    controller.onPointerUp(0);
    expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([2, 0]));
    expect(useMazeStore.getState().presetDragOverride).toBeNull();
  });

  it("applies the same origin reset when dragging the finish marker", () => {
    useMazeStore.setState({ presetStart: null, presetFinish: presetEndpoint([0, 0]) });
    const controller = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20);
    controller.onPointerMove(20, -20);
    controller.onPointerMove(100, -20);
    controller.onPointerUp(0);

    expect(useMazeStore.getState().presetStart).toBeNull();
    expect(useMazeStore.getState().presetFinish).toEqual(presetEndpoint([2, 0]));
    expect(useMazeStore.getState().presetDragOverride).toBeNull();
  });
});
