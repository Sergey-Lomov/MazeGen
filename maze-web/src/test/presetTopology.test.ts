import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { initialTopologyState } from "../store/slices/topologySlice";
import { clearTopologyInfoMemo, floorTopologyInfo } from "../store/topologyInfo";
import { getFieldPresetTopology } from "../wasm/mazeService";
import { tessellationConfigOf } from "../fieldConfig";
import { presetTopologyOf } from "../store/presetTopology";
import { fieldOf } from "./fieldConfigFixtures";
import { baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";
import { fakeTessellationShapes } from "./tessellationShapesFake";

vi.mock("../wasm/mazeService", async (importActual) => {
  const actual = await importActual<typeof import("../wasm/mazeService")>();
  return {
    getFieldPreset: actual.getFieldPreset,
    getFieldPresetTopology: actual.getFieldPresetTopology,
    getFieldCapabilities: actual.getFieldCapabilities,
    translateFieldCells: actual.translateFieldCells,
    reflectFieldCells: actual.reflectFieldCells,
    getTopologyInfo: actual.getTopologyInfo,
    editTopology: actual.editTopology,
    TopologyError: actual.TopologyError,
    getTessellationShapes: vi.fn((config: Parameters<typeof fakeTessellationShapes>[0]) => fakeTessellationShapes(config)),
    generateMaze: vi.fn(),
    computeAnalytics: vi.fn(),
    getAvailableChecks: vi.fn(() => []),
    getAvailableStrategies: vi.fn(() => []),
    getGeometrySnapshot: actual.getGeometrySnapshot,
    getCellAt: actual.getCellAt,
    getCellsInRegion: actual.getCellsInRegion,
  };
});
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

// Runs against the real `maze-core` module loaded by `setup.ts`.
const square = tessellationConfigOf("square");

beforeEach(() => {
  clearTopologyInfoMemo();
  useMazeStore.setState({ ...baseStoreState(), ...initialTopologyState, floorTopology: {} });
});

const get = () => useMazeStore.getState();
const topologyOf = () => get().floorTopology[TEST_FLOOR_ID];

describe("topology presets over wasm", () => {
  it("the box defines seven groups of folds; a shape-only preset defines none", () => {
    const box = getFieldPresetTopology(square, "box", { width: 3, height: 3, depth: 3, net: 0, mode: 0, aspect: 100 });
    expect(box?.fingerprint).toBe("square{}");
    expect(box?.folds).toHaveLength(21);
    expect(box?.groups).toHaveLength(7);
    expect(getFieldPresetTopology(square, "rect", { cols: 3, rows: 2 })).toBeNull();
  });
});

describe("a floor on a topology preset", () => {
  it("takes the box's gluings with the shape and drops them on another shape", () => {
    get().setSelectedShape("box");
    expect(get().floorFields[TEST_FLOOR_ID].fieldConfig.shape).toMatchObject({ shape: "box" });
    expect(topologyOf()?.groups).toHaveLength(7);

    get().setSelectedShape("rect");
    expect(topologyOf()).toBeUndefined();
  });

  it("every fold of the box is active on its field", () => {
    get().setSelectedShape("box");
    const info = floorTopologyInfo(get(), TEST_FLOOR_ID);
    if (!info.ok) throw new Error(info.error);
    expect(info.info.activity.length).toBeGreaterThan(0);
    expect(info.info.activity.every((a) => a.state === "active")).toBe(true);
  });

  it("follows the size parameters", () => {
    get().setFieldConfig(fieldOf("square", { shape: "box", width: 2, height: 2, depth: 2, net: 0, mode: 0, aspect: 100 }));
    expect(topologyOf()?.folds).toHaveLength(14);
    get().setFieldConfig(fieldOf("square", { shape: "box", width: 5, height: 5, depth: 5, net: 0, mode: 0, aspect: 100 }));
    expect(topologyOf()?.folds).toHaveLength(35);
    expect(get().floorFields[TEST_FLOOR_ID].selectedShape).toBe("box");
  });

  it("by-faces mode has twelve gluings for either net; a zero mode/net is a valid value", () => {
    for (const net of [0, 1] as const) {
      const cfg = fieldOf("square", { shape: "box", width: 2, height: 3, depth: 4, net, mode: 1, aspect: 100 });
      expect(presetTopologyOf(cfg)?.groups).toHaveLength(12);
      expect(presetTopologyOf(fieldOf("square", { shape: "box", width: 2, height: 3, depth: 4, net, mode: 0, aspect: 100 }))?.groups).toHaveLength(7);
    }
  });

  it("the compact net is by faces whatever the mode says", () => {
    for (const mode of [0, 1] as const) {
      const cfg = fieldOf("square", { shape: "box", width: 2, height: 3, depth: 4, net: 2, mode, aspect: 100 });
      expect(presetTopologyOf(cfg)?.groups).toHaveLength(12);
    }
  });

  it("keeps the gluings when the field becomes custom and drops them when it returns to a shape", () => {
    get().setSelectedShape("box");
    const box = topologyOf();
    get().setFieldEditMode("custom");
    expect(topologyOf()).toBe(box);

    get().setSelectedShape("rect");
    get().setFieldEditMode("default");
    expect(topologyOf()).toBeUndefined();
  });

  it("returns to the box's gluings from a custom field", () => {
    get().setSelectedShape("box");
    get().setFieldEditMode("custom");
    get().setFieldEditMode("default");
    expect(topologyOf()?.groups).toHaveLength(7);
  });
});

describe("presetTopologyOf", () => {
  it("is undefined for a custom field and for a size below the minimum", () => {
    expect(presetTopologyOf(fieldOf("square", { shape: "custom", points: [[0, 0]] }))).toBeUndefined();
    expect(presetTopologyOf(fieldOf("square", { shape: "box", width: 0, height: 0, depth: 0, net: 0, mode: 0, aspect: 100 }))).toBeUndefined();
  });

  it("is undefined for a size core refuses as too large", () => {
    expect(presetTopologyOf(fieldOf("square", { shape: "box", width: 409, height: 409, depth: 409, net: 0, mode: 0, aspect: 100 }))).toBeUndefined();
  });

  it("shares one object between calls for the same shape", () => {
    const cfg = fieldOf("square", { shape: "box", width: 4, height: 4, depth: 4, net: 0, mode: 0, aspect: 100 });
    expect(presetTopologyOf(cfg)).toBe(presetTopologyOf(cfg));
  });
});
