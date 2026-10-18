import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";
import { baseStoreState, emptyFreePoints, freeFieldEditState, hexPredefinedState, trianglePredefinedState, TEST_FLOOR_ID, baseFloorFieldConfig } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeTessellationShapes } from "./tessellationShapesFake";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getTessellationShapes: vi.fn((config: Parameters<typeof fakeTessellationShapes>[0]) => fakeTessellationShapes(config)),
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
});

/** The active floor's own FloorFieldConfig — the per-floor scoping point every field-editing
 *  test below reads through (GitHub issue #338). */
function activeField() {
  const s = useMazeStore.getState();
  return s.floorFields[s.activeFloorId];
}

/** Merges `patch` into `floorFields[TEST_FLOOR_ID]`, on top of whatever the current base state
 *  already has for that floor — used by tests that need to arrange floor-scoped fixture state
 *  alongside top-level `setState` fields. */
function setActiveField(patch: Partial<ReturnType<typeof baseFloorFieldConfig>>) {
  const s = useMazeStore.getState();
  useMazeStore.setState({
    floorFields: { ...s.floorFields, [TEST_FLOOR_ID]: { ...s.floorFields[TEST_FLOOR_ID], ...patch } },
  });
}

describe("mazeStore setters", () => {
  it("clears unfinished symmetry geometry when switching to another field primitive", () => {
    setActiveField({ fieldPrimitive: "symmetry" });
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 10, y: 0 }, { x: 10, y: 80 }],
      symmetryPolygon: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 40 }],
      symmetryPolygonFinished: true,
    });

    useMazeStore.getState().setFieldPrimitive("polygon");

    const state = useMazeStore.getState();
    expect(state.floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("polygon");
    expect(state.symmetryAxisPoints).toEqual([]);
    expect(state.symmetryPolygon).toEqual([]);
    expect(state.symmetryPolygonFinished).toBe(false);
  });

  it("clears symmetry geometry after applying while preserving its settings", () => {
    setActiveField({
      fieldEditMode: "custom",
      isEditingField: true,
      fieldPrimitive: "symmetry",
      fieldOperation: "remove",
    });
    useMazeStore.setState({
      symmetrySnapMode: "free",
      symmetryScope: "one_side",
      symmetrySourceSide: -1,
      symmetryAxisPoints: [{ x: 20, y: 0 }, { x: 20, y: 100 }],
      symmetryPolygon: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 40, y: 80 }],
      symmetryPolygonFinished: true,
    });

    useMazeStore.getState().applySymmetry();

    const state = useMazeStore.getState();
    expect(state.floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("point");
    expect(state.symmetryAxisPoints).toEqual([]);
    expect(state.symmetryPolygon).toEqual([]);
    expect(state.symmetryPolygonFinished).toBe(false);
    expect(state.floorFields[TEST_FLOOR_ID].fieldOperation).toBe("remove");
    expect(state.symmetrySnapMode).toBe("free");
    expect(state.symmetryScope).toBe("one_side");
    expect(state.symmetrySourceSide).toBe(-1);
  });

  it("does not apply a polygon symmetry preview before the polygon is finished", () => {
    setActiveField({
      fieldEditMode: "custom",
      isEditingField: true,
      fieldPrimitive: "symmetry",
      fieldPoints: new Set([encodePoint(1, 0)]),
    });
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 20, y: -100 }, { x: 20, y: 100 }],
      symmetryScope: "polygon",
      symmetryPolygon: [{ x: 0, y: -40 }, { x: 100, y: -40 }, { x: 50, y: 40 }],
      symmetryPolygonFinished: false,
    });

    useMazeStore.getState().applySymmetry();

    const state = useMazeStore.getState();
    expect(state.floorFields[TEST_FLOOR_ID].fieldPoints).toEqual(new Set([encodePoint(1, 0)]));
    expect(state.symmetryAxisPoints).toHaveLength(2);
    expect(state.symmetryPolygonFinished).toBe(false);
  });

  it("does not apply symmetry with a zero-length axis", () => {
    setActiveField({ fieldEditMode: "custom", isEditingField: true, fieldPrimitive: "symmetry" });
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 20, y: 20 }, { x: 20, y: 20 }],
      symmetryPolygon: [],
    });

    useMazeStore.getState().applySymmetry();

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("symmetry");
    expect(useMazeStore.getState().symmetryAxisPoints).toHaveLength(2);
  });

  it("setSeed updates seed and clears error", () => {
    useMazeStore.setState({ error: { kind: "run_failed", message: "old error" } });
    useMazeStore.getState().setSeed(99);
    expect(useMazeStore.getState().seed).toBe(99);
    expect(useMazeStore.getState().error).toBeNull();
  });

  it("setFieldConfig updates config and clears error", () => {
    useMazeStore.setState({ error: { kind: "run_failed", message: "old error" } });
    useMazeStore.getState().setFieldConfig(fieldOf("hex", { shape: "parallelogram", cols: 5, rows: 7 }, "pointy_top"));
    const cfg = activeField().fieldConfig;
    expect(cfg).toMatchObject({ tessellation: { kind: "hex" }, orientation: "pointy_top", shape: { shape: "parallelogram", cols: 5, rows: 7 } });
    expect(useMazeStore.getState().error).toBeNull();
  });

  it("setFieldConfig syncs tessellationKind and hexShape", () => {
    useMazeStore.getState().setFieldConfig(fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"));
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect(activeField().selectedShape).toBe("hexagon");
  });

  it("setFieldConfig syncs tessellationKind and triangleShape", () => {
    useMazeStore.getState().setFieldConfig(fieldOf("tri", { shape: "triangle", side: 5 }, "r90"));
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("tri");
    expect(activeField().selectedShape).toBe("triangle");
  });

  it("setFieldConfig with square_custom sets isEditingField and syncs freeFieldPoints", () => {
    useMazeStore.getState().setFieldConfig(fieldOf("square", { shape: "custom", points: [[1, 2], [3, 4]] }));
    const s = useMazeStore.getState();
    const field = activeField();
    expect(s.tessellationKind).toBe("square");
    expect(field.isEditingField).toBe(true);
    expect(field.fieldPoints.size).toBe(2);
    expect(field.freeFieldPoints.square.size).toBe(2);
  });

  it("setFieldConfig with hex_custom syncs freeFieldPoints.hex", () => {
    useMazeStore.getState().setFieldConfig(fieldOf("hex", { shape: "custom", points: [[0, 0], [1, 0], [0, 1]] }, "pointy_top"));
    const s = useMazeStore.getState();
    const field = activeField();
    expect(field.freeFieldPoints.hex.size).toBe(3);
    expect(field.freeFieldPoints.square.size).toBe(0);
    expect(s.hexOrientation).toBe("pointy_top");
  });
});

describe("mazeStore tessellation kind/shape actions", () => {
  it("setTessellationKind to hex sets tessellationKind and hex config type", () => {
    useMazeStore.getState().setTessellationKind("hex");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect([activeField().fieldConfig.tessellation.kind, activeField().fieldConfig.shape.shape]).toEqual(["hex", "hexagon"]);
  });

  it("setTessellationKind to triangle sets tessellationKind and triangle config type", () => {
    useMazeStore.getState().setTessellationKind("tri");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("tri");
    expect([activeField().fieldConfig.tessellation.kind, activeField().fieldConfig.shape.shape]).toEqual(["tri", "triangle"]);
  });

  it("setTessellationKind to Cairo uses the standard rectangular field", () => {
    useMazeStore.getState().setTessellationKind("cairo");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("cairo");
    expect(activeField().fieldConfig).toEqual(fieldOf("cairo", { shape: "rect", cols: 10, rows: 10 }));
    expect(activeField().selectedShape).toBe("rect");
  });

  it("uses the standard Cairo sizes when selecting each predefined form", () => {
    useMazeStore.getState().setTessellationKind("cairo");

    useMazeStore.getState().setSelectedShape("circle");
    expect(activeField().fieldConfig).toEqual(fieldOf("cairo", { shape: "circle", radius: 12 }));

    useMazeStore.getState().setSelectedShape("triangle");
    expect(activeField().fieldConfig).toEqual(fieldOf("cairo", { shape: "triangle", side: 20 }));

    useMazeStore.getState().setSelectedShape("hexagon");
    expect(activeField().fieldConfig).toEqual(fieldOf("cairo", { shape: "hexagon", radius: 12 }));
  });

  it("keeps Cairo custom points when returning to the standard field", () => {
    useMazeStore.getState().setFieldConfig(fieldOf("cairo", { shape: "custom", points: [[-3, 2], [2, 1]] }));
    const points = activeField().freeFieldPoints.cairo;
    useMazeStore.getState().setFieldEditMode("default");
    expect(activeField().fieldConfig).toEqual(fieldOf("cairo", { shape: "rect", cols: 10, rows: 10 }));
    expect(activeField().freeFieldPoints.cairo).toBe(points);
    expect(points.size).toBe(2);
  });

  it("returns from a loaded Cairo custom field to the standard field in default mode", () => {
    useMazeStore.getState().setFieldConfig(fieldOf("cairo", { shape: "custom", points: [[1, 2], [2, 1]] }));
    useMazeStore.getState().setFieldEditMode("default");
    expect(activeField().fieldConfig).toEqual(fieldOf("cairo", { shape: "rect", cols: 10, rows: 10 }));
    expect(activeField().isEditingField).toBe(false);
  });

  it("setTessellationKind to square sets tessellationKind and square config type", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    useMazeStore.getState().setTessellationKind("square");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("square");
    expect([activeField().fieldConfig.tessellation.kind, activeField().fieldConfig.shape.shape]).toEqual(["square", "rect"]);
  });

  it("setTessellationKind clears all incompatible presets", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      presetTeleports: [{ id: 7, from: { point: [0, 0] }, to: { point: [1, 0] }, direction: "two_way" }],
      presetVerticalPassages: [{ id: 8, from: { point: [0, 0] }, to: { point: [0, 0], level: 1 }, direction: "two_way" }],
      presetElevators: [{ id: 9, floors: [{ point: [0, 0] }, { point: [0, 0], level: 1 }] }],
    });
    useMazeStore.getState().setTessellationKind("square");
    const s = useMazeStore.getState();
    expect(s.presetTeleports).toEqual([]);
    expect(s.presetVerticalPassages).toEqual([]);
    expect(s.presetElevators).toEqual([]);
  });

  it("setTessellationKind resets freeFieldPoints for target kind", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    setActiveField({ freeFieldPoints: { square: new Set([1, 2]), hex: new Set([3]), tri: new Set(), cairo: new Set(), square_octagon: new Set() } });
    useMazeStore.getState().setTessellationKind("square");
    const field = activeField();
    // setTessellationKind resets every floor's FloorFieldConfig to a fresh default (GitHub issue
    // #338) since kind is maze-wide -- the previous per-kind freeFieldPoints for other floors would
    // be meaningless, so this is expected to come back empty for every kind, not just the target.
    expect(field.freeFieldPoints.square.size).toBe(0);
    expect(field.freeFieldPoints.hex.size).toBe(0);
  });

  it("setTessellationKind resets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    setActiveField({ isEditingField: true });
    useMazeStore.getState().setTessellationKind("square");
    expect(activeField().isEditingField).toBe(false);
  });

  it("setTessellationKind resets every floor's FloorFieldConfig, not just the active one", () => {
    const otherFloorId = "floor_2";
    const s0 = useMazeStore.getState();
    useMazeStore.setState({
      tessellationKind: "hex",
      floorFields: {
        ...s0.floorFields,
        [otherFloorId]: baseFloorFieldConfig({ isEditingField: true, fieldPoints: new Set([1, 2, 3]) }),
      },
    });
    useMazeStore.getState().setTessellationKind("square");
    const s = useMazeStore.getState();
    expect(s.floorFields[TEST_FLOOR_ID].isEditingField).toBe(false);
    expect(s.floorFields[otherFloorId].isEditingField).toBe(false);
    expect([s.floorFields[otherFloorId].fieldConfig.tessellation.kind, s.floorFields[otherFloorId].fieldConfig.shape.shape]).toEqual(["square", "rect"]);
  });

  it("resets the print cell size after changing tessellation kind", () => {
    useMazeStore.setState({
      pngExportSettings: {
        ...useMazeStore.getState().pngExportSettings,
        print: { ...useMazeStore.getState().pngExportSettings.print, scaleAutoFit: false },
      },
    });

    useMazeStore.getState().setTessellationKind("hex");

    expect(useMazeStore.getState().pngExportSettings.print.scaleAutoFit).toBe(true);
  });

  it("setHexShape to hexagon sets hexShape and hex_hexagon config type", () => {
    useMazeStore.setState(hexPredefinedState({ hexOrientation: "pointy_top", floorFieldOverrides: { fieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 8, rows: 6 }, "pointy_top") } }));
    useMazeStore.getState().setSelectedShape("hexagon");
    const field = activeField();
    expect(field.selectedShape).toBe("hexagon");
    expect([field.fieldConfig.tessellation.kind, field.fieldConfig.shape.shape]).toEqual(["hex", "hexagon"]);
  });

  it("supports the new hex rectangle and circle shapes", () => {
    useMazeStore.setState(hexPredefinedState());
    useMazeStore.getState().setSelectedShape("rect");
    expect([activeField().fieldConfig.tessellation.kind, activeField().fieldConfig.shape.shape]).toEqual(["hex", "rect"]);
    useMazeStore.getState().setSelectedShape("circle");
    expect([activeField().fieldConfig.tessellation.kind, activeField().fieldConfig.shape.shape]).toEqual(["hex", "circle"]);
  });

  it("setHexShape preserves hex orientation", () => {
    useMazeStore.setState(hexPredefinedState({ hexOrientation: "pointy_top", floorFieldOverrides: { fieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 8, rows: 6 }, "pointy_top") } }));
    useMazeStore.getState().setSelectedShape("hexagon");
    expect(activeField().fieldConfig).toMatchObject({ tessellation: { kind: "hex" }, orientation: "pointy_top", shape: { shape: "hexagon" } });
  });

  it("custom edit mode starts from the cells of the selected shape", () => {
    useMazeStore.setState(hexPredefinedState({ floorFieldOverrides: { fieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 3, rows: 2 }, "flat_top") } }));
    useMazeStore.getState().setFieldEditMode("custom");
    const field = activeField();
    expect(field.isEditingField).toBe(true);
    expect(field.fieldPoints.size).toBe(6);
    expect([field.fieldConfig.tessellation.kind, field.fieldConfig.shape.shape]).toEqual(["hex", "custom"]);
  });

  it("custom edit mode keeps the points of a field already custom", () => {
    const pts = new Set([encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState(freeFieldEditState("hex", pts));
    setActiveField({ fieldConfig: fieldOf("hex", { shape: "custom", points: [[1, 0], [0, 1]] }, "flat_top") });
    useMazeStore.getState().setFieldEditMode("custom");
    expect(activeField().fieldPoints).toBe(pts);
  });

  it("selecting a shape while editing a custom field only remembers the selection", () => {
    useMazeStore.setState(freeFieldEditState("hex", new Set([1])));
    useMazeStore.getState().setSelectedShape("parallelogram");
    const field = activeField();
    expect(field.isEditingField).toBe(true);
    expect(field.selectedShape).toBe("parallelogram");
  });

  it("default edit mode returns to the selected shape", () => {
    useMazeStore.setState(freeFieldEditState("hex", new Set([1])));
    useMazeStore.getState().setSelectedShape("parallelogram");
    useMazeStore.getState().setFieldEditMode("default");
    const field = activeField();
    expect(field.isEditingField).toBe(false);
    expect([field.fieldConfig.tessellation.kind, field.fieldConfig.shape.shape]).toEqual(["hex", "parallelogram"]);
  });

  it("setSquareShape to free sets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({ selectedShape: "rect", freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setFieldEditMode("custom");
    const field = activeField();
    expect(field.isEditingField).toBe(true);
    expect([field.fieldConfig.tessellation.kind, field.fieldConfig.shape.shape]).toEqual(["square", "custom"]);
  });

  it("supports the new square circle shape", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    useMazeStore.getState().setSelectedShape("circle");
    expect(activeField().fieldConfig).toEqual(fieldOf("square", { shape: "circle", radius: 10 }));
  });

  it("supports the new square triangle shape", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    useMazeStore.getState().setSelectedShape("triangle");
    expect(activeField().fieldConfig).toEqual(fieldOf("square", { shape: "triangle", side: 20 }));
  });

  it("supports the new hex triangle shape", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    useMazeStore.getState().setSelectedShape("triangle");
    expect(activeField().fieldConfig).toEqual(fieldOf("hex", { shape: "triangle", side: 20 }, "flat_top"));
  });

  it("supports the new triangle circle shape", () => {
    useMazeStore.setState({ tessellationKind: "tri" });
    useMazeStore.getState().setSelectedShape("circle");
    expect(activeField().fieldConfig).toEqual(fieldOf("tri", { shape: "circle", radius: 10 }, "r0"));
  });

  it("setTriangleShape to free sets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "tri" });
    setActiveField({ selectedShape: "rect", freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setFieldEditMode("custom");
    const field = activeField();
    expect(field.isEditingField).toBe(true);
    expect([field.fieldConfig.tessellation.kind, field.fieldConfig.shape.shape]).toEqual(["tri", "custom"]);
  });

  it("setTriangleShape to triangle sets triangleShape and triangle_triangle config type", () => {
    useMazeStore.setState({ tessellationKind: "tri" });
    setActiveField({ selectedShape: "rect", fieldConfig: fieldOf("tri", { shape: "rect", cols: 10, rows: 10 }, "r90") });
    useMazeStore.getState().setSelectedShape("triangle");
    const field = activeField();
    expect(field.selectedShape).toBe("triangle");
    expect([field.fieldConfig.tessellation.kind, field.fieldConfig.shape.shape]).toEqual(["tri", "triangle"]);
  });

  it("setTriangleShape preserves triangle orientation", () => {
    useMazeStore.setState({ tessellationKind: "tri", triOrientation: "r180" });
    setActiveField({ selectedShape: "rect", fieldConfig: fieldOf("tri", { shape: "rect", cols: 10, rows: 10 }, "r180") });
    useMazeStore.getState().setSelectedShape("hexagon");
    expect(activeField().fieldConfig).toMatchObject({ tessellation: { kind: "tri" }, orientation: "r180", shape: { shape: "hexagon" } });
  });

  it("setTessellationKind hex→triangle preserves triangle orientation default when coming from non-triangle", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    setActiveField({ fieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 8, rows: 6 }, "flat_top") });
    useMazeStore.getState().setTessellationKind("tri");
    expect(activeField().fieldConfig).toMatchObject({ tessellation: { kind: "tri" }, orientation: "r0", shape: { shape: "triangle" } });
  });
});

describe("mazeStore free field actions", () => {
  it("addFieldPoint adds encoded point and updates fieldConfig", () => {
    useMazeStore.setState(freeFieldEditState("square", new Set<number>()));
    useMazeStore.getState().addFieldPoint(3, 5);
    const field = activeField();
    expect(field.fieldPoints.size).toBe(1);
    expect(field.freeFieldPoints.square.size).toBe(1);
    expect([field.fieldConfig.tessellation.kind, field.fieldConfig.shape.shape]).toEqual(["square", "custom"]);
  });

  it("addFieldPoint is idempotent for same coord", () => {
    useMazeStore.setState(freeFieldEditState("square", new Set<number>()));
    useMazeStore.getState().addFieldPoint(1, 1);
    useMazeStore.getState().addFieldPoint(1, 1);
    expect(activeField().fieldPoints.size).toBe(1);
  });

  it("removeFieldPoint removes point and updates fieldConfig", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState(freeFieldEditState("square", pts));
    useMazeStore.getState().removeFieldPoint(0, 0);
    const field = activeField();
    expect(field.fieldPoints.size).toBe(1);
    expect(field.freeFieldPoints.square.size).toBe(1);
  });

  it("removeFieldPoint is no-op for absent coord", () => {
    const pts = new Set([encodePoint(0, 0)]);
    useMazeStore.setState(freeFieldEditState("square", pts));
    useMazeStore.getState().removeFieldPoint(99, 99);
    expect(activeField().fieldPoints.size).toBe(1);
  });

  it("freeFieldPoints persists per-kind when leaving custom mode", () => {
    const hexPts = new Set([encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState(freeFieldEditState("hex", hexPts));
    setActiveField({ fieldConfig: fieldOf("hex", { shape: "custom", points: [[1, 0], [0, 1]] }, "flat_top") });
    useMazeStore.getState().setFieldEditMode("default");
    const field1 = activeField();
    expect(field1.isEditingField).toBe(false);
    expect(field1.freeFieldPoints.hex).toBe(hexPts);
  });
});

describe("mazeStore.setHexOrientation", () => {
  it("updates hexOrientation only when tessellationKind is not hex", () => {
    useMazeStore.setState({ tessellationKind: "square", hexOrientation: "flat_top" });
    setActiveField({ fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }) });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect([activeField().fieldConfig.tessellation.kind, activeField().fieldConfig.shape.shape]).toEqual(["square", "rect"]);
  });

  it("is no-op when orientation unchanged", () => {
    useMazeStore.setState({ tessellationKind: "hex", hexOrientation: "flat_top" });
    const before = activeField().fieldConfig;
    useMazeStore.getState().setHexOrientation("flat_top");
    expect(activeField().fieldConfig).toBe(before);
  });

  it("updates fieldConfig orientation in predefined mode", () => {
    useMazeStore.setState(hexPredefinedState({
      floorFieldOverrides: { fieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 8, rows: 6 }, "flat_top") },
    }));
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect(activeField().fieldConfig).toMatchObject({ tessellation: { kind: "hex" }, orientation: "pointy_top", shape: { shape: "parallelogram", cols: 8, rows: 6 } });
  });

  it("rebuilds fieldConfig via buildFreeConfig in free mode", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({ tessellationKind: "hex", hexOrientation: "flat_top" });
    setActiveField({
      selectedShape: "rect",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), hex: pts },
      fieldConfig: fieldOf("hex", { shape: "custom", points: [[0, 0], [1, 0]] }, "flat_top"),
    });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect(activeField().fieldConfig).toMatchObject({ tessellation: { kind: "hex" }, orientation: "pointy_top", shape: { shape: "custom" } });
  });

  it("updates activeFieldConfig orientation when nodes exist", () => {
    useMazeStore.setState(hexPredefinedState({
      floorFieldOverrides: { fieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 8, rows: 6 }, "flat_top") },
      activeFieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 8, rows: 6 }, "flat_top"),
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
    }));
    useMazeStore.getState().setHexOrientation("pointy_top");
    expect(useMazeStore.getState().activeFieldConfig).toMatchObject({ tessellation: { kind: "hex" }, orientation: "pointy_top", shape: { shape: "parallelogram", cols: 8 } });
  });

  it("does not update activeFieldConfig when no nodes", () => {
    useMazeStore.setState(hexPredefinedState({
      floorFieldOverrides: { fieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 5, rows: 5 }, "flat_top") },
      activeFieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 5, rows: 5 }, "flat_top"),
      nodes: [],
    }));
    const activeBefore = useMazeStore.getState().activeFieldConfig;
    useMazeStore.getState().setHexOrientation("pointy_top");
    expect(useMazeStore.getState().activeFieldConfig).toBe(activeBefore);
  });

  it("closes an open split-node panel (GitHub issue #235 follow-up) — its face indices meant something else under the old orientation", () => {
    useMazeStore.setState(hexPredefinedState({
      floorFieldOverrides: { fieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 8, rows: 6 }, "flat_top") },
      presetFocusedPoint: [1, 1],
      postEditFocusedPoint: [2, 2],
    }));
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.presetFocusedPoint).toBeNull();
    expect(s.postEditFocusedPoint).toBeNull();
  });
});

describe("mazeStore.setTriOrientation", () => {
  it("updates triOrientation only when tessellationKind is not triangle", () => {
    useMazeStore.setState({ tessellationKind: "square", triOrientation: "r0" });
    setActiveField({ fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }) });
    useMazeStore.getState().setTriOrientation("r90");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r90");
    expect([activeField().fieldConfig.tessellation.kind, activeField().fieldConfig.shape.shape]).toEqual(["square", "rect"]);
  });

  it("is no-op when orientation unchanged", () => {
    useMazeStore.setState({ tessellationKind: "tri", triOrientation: "r0" });
    const before = activeField().fieldConfig;
    useMazeStore.getState().setTriOrientation("r0");
    expect(activeField().fieldConfig).toBe(before);
  });

  it("updates fieldConfig orientation in predefined mode", () => {
    useMazeStore.setState(trianglePredefinedState({
      floorFieldOverrides: { fieldConfig: fieldOf("tri", { shape: "rect", cols: 10, rows: 10 }, "r0") },
    }));
    useMazeStore.getState().setTriOrientation("r180");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r180");
    expect(activeField().fieldConfig).toMatchObject({ tessellation: { kind: "tri" }, orientation: "r180", shape: { shape: "rect", cols: 10 } });
  });

  it("rebuilds fieldConfig via buildFreeConfig in free mode", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({ tessellationKind: "tri", triOrientation: "r0", hexOrientation: "flat_top" });
    setActiveField({
      selectedShape: "rect",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), tri: pts },
      fieldConfig: fieldOf("tri", { shape: "custom", points: [[0, 0], [1, 0]] }, "r0"),
    });
    useMazeStore.getState().setTriOrientation("r270");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r270");
    expect(activeField().fieldConfig).toMatchObject({ tessellation: { kind: "tri" }, orientation: "r270", shape: { shape: "custom" } });
  });

  it("updates activeFieldConfig orientation when nodes exist", () => {
    useMazeStore.setState(trianglePredefinedState({
      floorFieldOverrides: { fieldConfig: fieldOf("tri", { shape: "rect", cols: 6, rows: 4 }, "r0") },
      activeFieldConfig: fieldOf("tri", { shape: "rect", cols: 6, rows: 4 }, "r0"),
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
    }));
    useMazeStore.getState().setTriOrientation("r90");
    expect(useMazeStore.getState().activeFieldConfig).toMatchObject({ tessellation: { kind: "tri" }, orientation: "r90", shape: { shape: "rect", cols: 6 } });
  });
});
