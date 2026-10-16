import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";
import { baseStoreState, emptyFreePoints, freeFieldEditState, hexPredefinedState, trianglePredefinedState, TEST_FLOOR_ID, baseFloorFieldConfig } from "./storeTestHelpers";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  // Cartesian coordinates aren't asserted on in this suite -- any deterministic per-point
  // stand-in is fine, as long as its shape matches `getCartesianCoords`'s real return type.
  getCartesianCoords: vi.fn((cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y])),
}));
vi.mock("../wasm/wasmLoader", () => ({
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

  it("setTessellationConfig updates config and clears error", () => {
    useMazeStore.setState({ error: { kind: "run_failed", message: "old error" } });
    useMazeStore.getState().setTessellationConfig({ type: "hex_parallelogram", cols: 5, rows: 7, orientation: "pointy_top" });
    const cfg = activeField().tessellationConfig;
    expect(cfg).toMatchObject({ type: "hex_parallelogram", cols: 5, rows: 7, orientation: "pointy_top" });
    expect(useMazeStore.getState().error).toBeNull();
  });

  it("setTessellationConfig syncs tessellationKind and hexShape", () => {
    useMazeStore.getState().setTessellationConfig({ type: "hex_hexagon", radius: 3, orientation: "flat_top" });
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect(activeField().hexShape).toBe("hexagon");
  });

  it("setTessellationConfig syncs tessellationKind and triangleShape", () => {
    useMazeStore.getState().setTessellationConfig({ type: "triangle_triangle", side: 5, orientation: "r90" });
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("triangle");
    expect(activeField().triangleShape).toBe("triangle");
  });

  it("setTessellationConfig with square_custom sets isEditingField and syncs freeFieldPoints", () => {
    useMazeStore.getState().setTessellationConfig({ type: "square_custom", points: [[1, 2], [3, 4]] });
    const s = useMazeStore.getState();
    const field = activeField();
    expect(s.tessellationKind).toBe("square");
    expect(field.squareShape).toBe("free");
    expect(field.isEditingField).toBe(true);
    expect(field.fieldPoints.size).toBe(2);
    expect(field.freeFieldPoints.square.size).toBe(2);
  });

  it("setTessellationConfig with hex_custom syncs freeFieldPoints.hex", () => {
    useMazeStore.getState().setTessellationConfig({ type: "hex_custom", points: [[0, 0], [1, 0], [0, 1]], orientation: "pointy_top" });
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
    expect(activeField().tessellationConfig.type).toBe("hex_hexagon");
  });

  it("setTessellationKind to triangle sets tessellationKind and triangle config type", () => {
    useMazeStore.getState().setTessellationKind("triangle");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("triangle");
    expect(activeField().tessellationConfig.type).toBe("triangle_triangle");
  });

  it("setTessellationKind to Cairo uses the standard rectangular field", () => {
    useMazeStore.getState().setTessellationKind("cairo");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("cairo");
    expect(activeField().tessellationConfig).toEqual({ type: "cairo", cols: 10, rows: 10 });
    expect(activeField().cairoShape).toBe("rect");
  });

  it("uses the standard Cairo sizes when selecting each predefined form", () => {
    useMazeStore.getState().setTessellationKind("cairo");

    useMazeStore.getState().setCairoShape("circle");
    expect(activeField().tessellationConfig).toEqual({ type: "cairo_circle", radius: 12 });

    useMazeStore.getState().setCairoShape("triangle");
    expect(activeField().tessellationConfig).toEqual({ type: "cairo_triangle", side: 20 });

    useMazeStore.getState().setCairoShape("hexagon");
    expect(activeField().tessellationConfig).toEqual({ type: "cairo_hexagon", radius: 12 });
  });

  it("switches Cairo between standard and free fields without losing custom points", () => {
    useMazeStore.getState().setTessellationKind("cairo");
    const points = new Set([encodePoint(-3, 2), encodePoint(2, 1)]);
    setActiveField({ freeFieldPoints: { ...emptyFreePoints(), cairo: points } });
    useMazeStore.getState().setCairoShape("free");
    expect(activeField().tessellationConfig).toEqual({ type: "cairo_custom", points: [[-3, 2], [2, 1]] });
    useMazeStore.getState().setCairoShape("rect");
    useMazeStore.getState().setCairoShape("free");
    expect(activeField().tessellationConfig).toEqual({ type: "cairo_custom", points: [[-3, 2], [2, 1]] });
  });

  it("returns from a loaded Cairo custom field to the standard field in default mode", () => {
    useMazeStore.getState().setTessellationConfig({ type: "cairo_custom", points: [[1, 2], [2, 1]] });
    useMazeStore.getState().setFieldEditMode("default");
    expect(activeField().tessellationConfig).toEqual({ type: "cairo", cols: 10, rows: 10 });
    expect(activeField().isEditingField).toBe(false);
  });

  it("setTessellationKind to square sets tessellationKind and square config type", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    useMazeStore.getState().setTessellationKind("square");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("square");
    expect(activeField().tessellationConfig.type).toBe("square");
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
    setActiveField({ freeFieldPoints: { square: new Set([1, 2]), hex: new Set([3]), triangle: new Set(), cairo: new Set() } });
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
    setActiveField({ squareShape: "free", isEditingField: true });
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
        [otherFloorId]: baseFloorFieldConfig({ squareShape: "free", isEditingField: true, fieldPoints: new Set([1, 2, 3]) }),
      },
    });
    useMazeStore.getState().setTessellationKind("square");
    const s = useMazeStore.getState();
    expect(s.floorFields[TEST_FLOOR_ID].isEditingField).toBe(false);
    expect(s.floorFields[otherFloorId].isEditingField).toBe(false);
    expect(s.floorFields[otherFloorId].tessellationConfig.type).toBe("square");
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
    useMazeStore.setState({ tessellationKind: "hex" });
    setActiveField({ hexShape: "parallelogram", tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "pointy_top" } });
    useMazeStore.getState().setHexShape("hexagon");
    const field = activeField();
    expect(field.hexShape).toBe("hexagon");
    expect(field.tessellationConfig.type).toBe("hex_hexagon");
  });

  it("supports the new hex rectangle and circle shapes", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    useMazeStore.getState().setHexShape("rectangle");
    expect(activeField().tessellationConfig.type).toBe("hex_rectangle");
    useMazeStore.getState().setHexShape("circle");
    expect(activeField().tessellationConfig.type).toBe("hex_circle");
  });

  it("setHexShape preserves hex orientation", () => {
    useMazeStore.setState({ tessellationKind: "hex", hexOrientation: "pointy_top" });
    setActiveField({ hexShape: "parallelogram", tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "pointy_top" } });
    useMazeStore.getState().setHexShape("hexagon");
    expect(activeField().tessellationConfig).toMatchObject({ type: "hex_hexagon", orientation: "pointy_top" });
  });

  it("setHexShape to free sets isEditingField and empty fieldPoints (first time)", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    setActiveField({ hexShape: "parallelogram", freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setHexShape("free");
    const field = activeField();
    expect(field.hexShape).toBe("free");
    expect(field.isEditingField).toBe(true);
    expect(field.fieldPoints.size).toBe(0);
    expect(field.tessellationConfig.type).toBe("hex_custom");
  });

  it("setHexShape to free restores previously saved points", () => {
    const pts = new Set([encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState({ tessellationKind: "hex" });
    setActiveField({ hexShape: "parallelogram", freeFieldPoints: { ...emptyFreePoints(), hex: pts } });
    useMazeStore.getState().setHexShape("free");
    const field = activeField();
    expect(field.fieldPoints.size).toBe(2);
    expect(field.fieldPoints).toBe(pts);
  });

  it("setHexShape from free to parallelogram clears isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    setActiveField({ hexShape: "free", isEditingField: true, fieldPoints: new Set([1]) });
    useMazeStore.getState().setHexShape("parallelogram");
    const field = activeField();
    expect(field.isEditingField).toBe(false);
    expect(field.tessellationConfig.type).toBe("hex_parallelogram");
  });

  it("setSquareShape to free sets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({ squareShape: "rect", freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setSquareShape("free");
    const field = activeField();
    expect(field.squareShape).toBe("free");
    expect(field.isEditingField).toBe(true);
    expect(field.tessellationConfig.type).toBe("square_custom");
  });

  it("supports the new square circle shape", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    useMazeStore.getState().setSquareShape("circle");
    expect(activeField().tessellationConfig).toEqual({ type: "square_circle", radius: 10 });
  });

  it("supports the new square triangle shape", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    useMazeStore.getState().setSquareShape("triangle");
    expect(activeField().tessellationConfig).toEqual({ type: "square_triangle", side: 20 });
  });

  it("supports the new hex triangle shape", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    useMazeStore.getState().setHexShape("triangle");
    expect(activeField().tessellationConfig).toEqual({ type: "hex_triangle", side: 20, orientation: "flat_top" });
  });

  it("supports the new triangle circle shape", () => {
    useMazeStore.setState({ tessellationKind: "triangle" });
    useMazeStore.getState().setTriangleShape("circle");
    expect(activeField().tessellationConfig).toEqual({ type: "triangle_circle", radius: 10, orientation: "r0" });
  });

  it("setTriangleShape to free sets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "triangle" });
    setActiveField({ triangleShape: "rect", freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setTriangleShape("free");
    const field = activeField();
    expect(field.triangleShape).toBe("free");
    expect(field.isEditingField).toBe(true);
    expect(field.tessellationConfig.type).toBe("tri_custom");
  });

  it("setTriangleShape to triangle sets triangleShape and triangle_triangle config type", () => {
    useMazeStore.setState({ tessellationKind: "triangle" });
    setActiveField({ triangleShape: "rect", tessellationConfig: { type: "triangle_rect", cols: 10, rows: 10, orientation: "r90" } });
    useMazeStore.getState().setTriangleShape("triangle");
    const field = activeField();
    expect(field.triangleShape).toBe("triangle");
    expect(field.tessellationConfig.type).toBe("triangle_triangle");
  });

  it("setTriangleShape preserves triangle orientation", () => {
    useMazeStore.setState({ tessellationKind: "triangle", triOrientation: "r180" });
    setActiveField({ triangleShape: "rect", tessellationConfig: { type: "triangle_rect", cols: 10, rows: 10, orientation: "r180" } });
    useMazeStore.getState().setTriangleShape("hexagon");
    expect(activeField().tessellationConfig).toMatchObject({ type: "triangle_hexagon", orientation: "r180" });
  });

  it("setTessellationKind hex→triangle preserves triangle orientation default when coming from non-triangle", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    setActiveField({ tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" } });
    useMazeStore.getState().setTessellationKind("triangle");
    expect(activeField().tessellationConfig).toMatchObject({ type: "triangle_triangle", orientation: "r0" });
  });
});

describe("mazeStore free field actions", () => {
  it("addFieldPoint adds encoded point and updates tessellationConfig", () => {
    useMazeStore.setState(freeFieldEditState("square", new Set<number>()));
    useMazeStore.getState().addFieldPoint(3, 5);
    const field = activeField();
    expect(field.fieldPoints.size).toBe(1);
    expect(field.freeFieldPoints.square.size).toBe(1);
    expect(field.tessellationConfig.type).toBe("square_custom");
  });

  it("addFieldPoint is idempotent for same coord", () => {
    useMazeStore.setState(freeFieldEditState("square", new Set<number>()));
    useMazeStore.getState().addFieldPoint(1, 1);
    useMazeStore.getState().addFieldPoint(1, 1);
    expect(activeField().fieldPoints.size).toBe(1);
  });

  it("removeFieldPoint removes point and updates tessellationConfig", () => {
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

  it("freeFieldPoints persists per-kind when switching shapes", () => {
    const hexPts = new Set([encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState(freeFieldEditState("hex", hexPts));
    useMazeStore.getState().setHexShape("parallelogram");
    const field1 = activeField();
    expect(field1.isEditingField).toBe(false);
    expect(field1.freeFieldPoints.hex.size).toBe(2);

    useMazeStore.getState().setHexShape("free");
    const field2 = activeField();
    expect(field2.isEditingField).toBe(true);
    expect(field2.fieldPoints.size).toBe(2);
    expect(field2.fieldPoints).toBe(hexPts);
  });
});

describe("mazeStore.setHexOrientation", () => {
  it("updates hexOrientation only when tessellationKind is not hex", () => {
    useMazeStore.setState({ tessellationKind: "square", hexOrientation: "flat_top" });
    setActiveField({ tessellationConfig: { type: "square", width: 10, height: 10 } });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect(activeField().tessellationConfig.type).toBe("square");
  });

  it("is no-op when orientation unchanged", () => {
    useMazeStore.setState({ tessellationKind: "hex", hexOrientation: "flat_top" });
    const before = activeField().tessellationConfig;
    useMazeStore.getState().setHexOrientation("flat_top");
    expect(activeField().tessellationConfig).toBe(before);
  });

  it("updates tessellationConfig orientation in predefined mode", () => {
    useMazeStore.setState(hexPredefinedState({
      floorFieldOverrides: { tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" } },
    }));
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect(activeField().tessellationConfig).toMatchObject({ type: "hex_parallelogram", orientation: "pointy_top", cols: 8, rows: 6 });
  });

  it("rebuilds tessellationConfig via buildFreeConfig in free mode", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({ tessellationKind: "hex", hexOrientation: "flat_top" });
    setActiveField({
      hexShape: "free",
      squareShape: "rect",
      triangleShape: "rect",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), hex: pts },
      tessellationConfig: { type: "hex_custom", points: [[0, 0], [1, 0]], orientation: "flat_top" },
    });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect(activeField().tessellationConfig).toMatchObject({ type: "hex_custom", orientation: "pointy_top" });
  });

  it("updates activeTessellationConfig orientation when nodes exist", () => {
    useMazeStore.setState(hexPredefinedState({
      floorFieldOverrides: { tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" } },
      activeTessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" },
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
    }));
    useMazeStore.getState().setHexOrientation("pointy_top");
    expect(useMazeStore.getState().activeTessellationConfig).toMatchObject({ type: "hex_parallelogram", orientation: "pointy_top", cols: 8 });
  });

  it("does not update activeTessellationConfig when no nodes", () => {
    useMazeStore.setState(hexPredefinedState({
      floorFieldOverrides: { tessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 5, orientation: "flat_top" } },
      activeTessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 5, orientation: "flat_top" },
      nodes: [],
    }));
    const activeBefore = useMazeStore.getState().activeTessellationConfig;
    useMazeStore.getState().setHexOrientation("pointy_top");
    expect(useMazeStore.getState().activeTessellationConfig).toBe(activeBefore);
  });

  it("closes an open split-node panel (GitHub issue #235 follow-up) — its face indices meant something else under the old orientation", () => {
    useMazeStore.setState(hexPredefinedState({
      floorFieldOverrides: { tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" } },
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
    setActiveField({ tessellationConfig: { type: "square", width: 10, height: 10 } });
    useMazeStore.getState().setTriOrientation("r90");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r90");
    expect(activeField().tessellationConfig.type).toBe("square");
  });

  it("is no-op when orientation unchanged", () => {
    useMazeStore.setState({ tessellationKind: "triangle", triOrientation: "r0" });
    const before = activeField().tessellationConfig;
    useMazeStore.getState().setTriOrientation("r0");
    expect(activeField().tessellationConfig).toBe(before);
  });

  it("updates tessellationConfig orientation in predefined mode", () => {
    useMazeStore.setState(trianglePredefinedState({
      floorFieldOverrides: { tessellationConfig: { type: "triangle_rect", cols: 10, rows: 10, orientation: "r0" } },
    }));
    useMazeStore.getState().setTriOrientation("r180");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r180");
    expect(activeField().tessellationConfig).toMatchObject({ type: "triangle_rect", orientation: "r180", cols: 10 });
  });

  it("rebuilds tessellationConfig via buildFreeConfig in free mode", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({ tessellationKind: "triangle", triOrientation: "r0", hexOrientation: "flat_top" });
    setActiveField({
      triangleShape: "free",
      hexShape: "parallelogram",
      squareShape: "rect",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), triangle: pts },
      tessellationConfig: { type: "tri_custom", points: [[0, 0], [1, 0]], orientation: "r0" },
    });
    useMazeStore.getState().setTriOrientation("r270");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r270");
    expect(activeField().tessellationConfig).toMatchObject({ type: "tri_custom", orientation: "r270" });
  });

  it("updates activeTessellationConfig orientation when nodes exist", () => {
    useMazeStore.setState(trianglePredefinedState({
      floorFieldOverrides: { tessellationConfig: { type: "triangle_rect", cols: 6, rows: 4, orientation: "r0" } },
      activeTessellationConfig: { type: "triangle_rect", cols: 6, rows: 4, orientation: "r0" },
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
    }));
    useMazeStore.getState().setTriOrientation("r90");
    expect(useMazeStore.getState().activeTessellationConfig).toMatchObject({ type: "triangle_rect", orientation: "r90", cols: 6 });
  });
});
