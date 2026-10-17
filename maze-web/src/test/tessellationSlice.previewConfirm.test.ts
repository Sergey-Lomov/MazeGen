import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";
import { baseStoreState, emptyFreePoints, TEST_FLOOR_ID, baseFloorFieldConfig } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeTessellationShapes } from "./tessellationShapesFake";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
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
  useMazeStore.setState({
    ...baseStoreState(),
    mazeDirty: false,
    postEditDirty: false,
    fieldEditConfirmation: null,
    backgroundAutoFillPreview: null,
  });
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

describe("mazeStore preview/confirm flow", () => {
  it("confirmTessellation keeps only split patterns whose shape template the new kind provides", () => {
    const square = { shape: "regular:4", node_count: 1, faces: [[]], weight: 1 };
    const hex = { shape: "regular:6", node_count: 1, faces: [[]], weight: 1 };
    useMazeStore.setState({ tessellationKind: "square", splitPatterns: [square, hex] });
    useMazeStore.getState().setPreviewKind("hex");
    useMazeStore.getState().confirmTessellation();
    expect(useMazeStore.getState().splitPatterns).toEqual([hex]);
  });

  it("setTessellationKind keeps only split patterns whose shape template the new kind provides", () => {
    const square = { shape: "regular:4", node_count: 1, faces: [[]], weight: 1 };
    const tri = { shape: "regular:3", node_count: 1, faces: [[]], weight: 1 };
    useMazeStore.setState({ tessellationKind: "square", splitPatterns: [square, tri] });
    useMazeStore.getState().setTessellationKind("tri");
    expect(useMazeStore.getState().splitPatterns).toEqual([tri]);
  });

  it("confirmTessellation lets quality control drop split patterns the new kind cannot hold", () => {
    const square = { shape: "regular:4", node_count: 1, faces: [[]], weight: 1 };
    const hex = { shape: "regular:6", node_count: 1, faces: [[]], weight: 1 };
    useMazeStore.setState({
      tessellationKind: "square",
      availableChecks: [{ id: "split_pattern_shape", label: "", description: "", issue_kinds: ["invalid_split_tile"], params: [{ id: "patterns", label: "", kind: { type: "pattern_list", with_weights: false } }] }],
      rules: [{
        id: "r", name: null, kind: "invalid_split_tile", nextLocalCheckId: 1, strategyId: null, disabled: false,
        ruleDisabled: false, nestedStrategies: [], params: {}, collapsed: false,
        checks: [{ localId: 0, typeId: "split_pattern_shape", params: { patterns: JSON.stringify([square, hex]) }, disabled: false }],
      }],
    });
    useMazeStore.getState().setPreviewKind("hex");
    useMazeStore.getState().confirmTessellation();
    expect(JSON.parse(useMazeStore.getState().rules[0].checks[0].params.patterns)).toEqual([hex]);
  });

  it("setPreviewKind does not reset orientation", () => {
    useMazeStore.setState({ previewHexOrientation: "pointy_top", previewTriOrientation: "r90" });
    useMazeStore.getState().setPreviewKind("hex");
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("hex");
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTriOrientation).toBe("r90");
  });

  it("setPreviewKind updates previewFieldConfig", () => {
    useMazeStore.getState().setPreviewKind("tri");
    expect([useMazeStore.getState().previewFieldConfig.tessellation.kind, useMazeStore.getState().previewFieldConfig.shape.shape]).toEqual(["tri", "rect"]);
  });

  it("syncPreviewToConfirmed copies all confirmed values atomically", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexOrientation: "pointy_top",
      triOrientation: "r180",
      previewKind: "tri",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
    });
    useMazeStore.getState().syncPreviewToConfirmed();
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("hex");
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTriOrientation).toBe("r180");
    expect(s.previewFieldConfig).toMatchObject({ tessellation: { kind: "hex" }, orientation: "pointy_top", shape: { shape: "parallelogram" } });
  });

  it("confirmTessellation copies preview into confirmed", () => {
    useMazeStore.setState({
      previewKind: "hex",
      previewHexOrientation: "pointy_top",
      previewTriOrientation: "r0",
      tessellationKind: "square",
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect(s.hexOrientation).toBe("pointy_top");
    expect(s.tessellationConfirmed).toBe(true);
  });

  it("confirmTessellation syncs preview fields to confirmed", () => {
    useMazeStore.setState({
      previewKind: "tri",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r90",
      tessellationKind: "square",
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("tri");
    expect(s.previewTriOrientation).toBe("r90");
    expect([s.previewFieldConfig.tessellation.kind, s.previewFieldConfig.shape.shape]).toEqual(["tri", "rect"]);
  });

  it("confirmTessellation with same kind does not clear maze", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      previewKind: "square",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [],
    });
    useMazeStore.getState().confirmTessellation();
    expect(useMazeStore.getState().nodes.length).toBe(1);
  });

  it("confirmTessellation with different kind clears maze", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      previewKind: "hex",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [{ from: 0, to: 0, kind: "basic" }],
      start: 0,
      finish: 0,
      pngExportSettings: {
        ...useMazeStore.getState().pngExportSettings,
        print: { ...useMazeStore.getState().pngExportSettings.print, scaleAutoFit: false },
      },
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.nodes).toHaveLength(0);
    expect(s.edges).toHaveLength(0);
    expect(s.start).toBeNull();
    expect(s.finish).toBeNull();
    expect(s.pngExportSettings.print.scaleAutoFit).toBe(true);
  });

  it("confirmTessellation with different kind clears all incompatible presets", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      previewKind: "hex",
      presetTeleports: [{ id: 7, from: { point: [0, 0] }, to: { point: [1, 0] }, direction: "two_way" }],
      presetVerticalPassages: [{ id: 8, from: { point: [0, 0] }, to: { point: [0, 0], level: 1 }, direction: "two_way" }],
      presetElevators: [{ id: 9, floors: [{ point: [0, 0] }, { point: [0, 0], level: 1 }] }],
      _nextPresetTeleportId: 10,
      _nextPresetVerticalPassageId: 11,
      _nextPresetElevatorId: 12,
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.presetTeleports).toEqual([]);
    expect(s.presetVerticalPassages).toEqual([]);
    expect(s.presetElevators).toEqual([]);
    expect(s._nextPresetTeleportId).toBe(1);
    expect(s._nextPresetVerticalPassageId).toBe(1);
    expect(s._nextPresetElevatorId).toBe(1);
  });

  it("confirmTessellation resets every floor's FloorFieldConfig, not just the active one", () => {
    const otherFloorId = "floor_2";
    const s0 = useMazeStore.getState();
    useMazeStore.setState({
      tessellationKind: "square",
      previewKind: "hex",
      previewHexOrientation: "pointy_top",
      previewTriOrientation: "r0",
      floorFields: {
        ...s0.floorFields,
        [otherFloorId]: baseFloorFieldConfig({ squareShape: "free", isEditingField: true, fieldPoints: new Set([1, 2, 3]) }),
      },
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    // kind/orientation are maze-wide -- every floor's field config gets rebuilt against the newly
    // confirmed kind, so both the active and the other floor should land on a fresh, non-editing
    // hex config (GitHub issue #338).
    expect(s.floorFields[TEST_FLOOR_ID].isEditingField).toBe(false);
    expect([s.floorFields[TEST_FLOOR_ID].fieldConfig.tessellation.kind, s.floorFields[TEST_FLOOR_ID].fieldConfig.shape.shape]).toEqual(["hex", "hexagon"]);
    expect(s.floorFields[otherFloorId].isEditingField).toBe(false);
    expect([s.floorFields[otherFloorId].fieldConfig.tessellation.kind, s.floorFields[otherFloorId].fieldConfig.shape.shape]).toEqual(["hex", "hexagon"]);
  });
});

describe("mazeStore tessellation misc actions", () => {
  it("setPreviewHexOrientation updates preview config", () => {
    useMazeStore.setState({ previewKind: "hex" });
    useMazeStore.getState().setPreviewHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewFieldConfig).toMatchObject({ tessellation: { kind: "hex" }, orientation: "pointy_top", shape: { shape: "parallelogram" } });
  });

  it("setPreviewTriOrientation updates preview config", () => {
    useMazeStore.setState({ previewKind: "tri" });
    useMazeStore.getState().setPreviewTriOrientation("r270");
    const s = useMazeStore.getState();
    expect(s.previewTriOrientation).toBe("r270");
    expect(s.previewFieldConfig).toMatchObject({ tessellation: { kind: "tri" }, orientation: "r270", shape: { shape: "rect" } });
  });

  it("addFieldPoints adds multiple cells and marks fieldDirty", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({ fieldPoints: new Set<number>(), freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().addFieldPoints([[0, 0], [1, 0], [0, 1]]);
    const field = activeField();
    expect(field.fieldPoints.size).toBe(3);
    expect(field.fieldDirty).toBe(true);
  });

  it("locks field mutations while the auto-fill preview is active", () => {
    const originalPoints = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    setActiveField({
      fieldEditMode: "custom",
      fieldPoints: originalPoints,
      freeFieldPoints: { ...emptyFreePoints(), square: originalPoints },
      fieldPrimitive: "point",
      fieldOperation: "add",
      fieldConfig: fieldOf("square", { shape: "custom", points: [[0, 0], [1, 0]] }),
    });
    useMazeStore.setState({ backgroundAutoFillPreview: new Set([encodePoint(4, 4)]) });

    const store = useMazeStore.getState();
    store.setFieldOperation("remove");
    store.setFieldPrimitive("polygon");
    store.addFieldPoints([[2, 0]]);
    store.removeFieldPoints([[0, 0]]);
    store.moveFieldPoints([[0, 0]], 3, 3);
    store.clearFieldPoints();
    store.setFieldConfig(fieldOf("square", { shape: "rect", cols: 8, rows: 8 }));
    store.setFieldEditMode("default");

    const field = activeField();
    expect(field.fieldPoints).toEqual(originalPoints);
    expect(field.fieldPrimitive).toBe("point");
    expect(field.fieldOperation).toBe("add");
    expect(field.fieldConfig).toEqual(fieldOf("square", { shape: "custom", points: [[0, 0], [1, 0]] }));
    expect(field.fieldEditMode).toBe("custom");
    expect(useMazeStore.getState().fieldEditConfirmation).toBeNull();
  });

  it("addFieldPoints is no-op when all cells already present", () => {
    const pts = new Set([encodePoint(0, 0)]);
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({ fieldPoints: pts, freeFieldPoints: { ...emptyFreePoints(), square: pts }, fieldDirty: false });
    useMazeStore.getState().addFieldPoints([[0, 0]]);
    expect(activeField().fieldDirty).toBe(false);
  });

  it("removeFieldPoints removes multiple cells", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({ fieldPoints: pts, freeFieldPoints: { ...emptyFreePoints(), square: pts } });
    useMazeStore.getState().removeFieldPoints([[0, 0], [1, 0]]);
    expect(activeField().fieldPoints.size).toBe(1);
  });

  it("queues a field move for confirmation without changing the field immediately", () => {
    const points = new Set([encodePoint(0, 0)]);
    useMazeStore.setState({
      mazeDirty: true,
      tessellationKind: "square",
      floorFields: {
        ...useMazeStore.getState().floorFields,
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", fieldPoints: points }),
      },
    });

    useMazeStore.getState().moveFieldPoints([[0, 0]], 1, 0);

    expect(activeField().fieldPoints).toEqual(points);
    expect(useMazeStore.getState().fieldEditConfirmation).toEqual({
      kind: "moveFieldPoints",
      cells: [[0, 0]],
      dx: 1,
      dy: 0,
    });
  });


  it("clearFieldPoints empties the set", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({ fieldPoints: pts, freeFieldPoints: { ...emptyFreePoints(), square: pts } });
    useMazeStore.getState().clearFieldPoints();
    expect(activeField().fieldPoints.size).toBe(0);
  });

  it("clearFieldPoints is no-op on already-empty set", () => {
    setActiveField({ fieldPoints: new Set<number>(), fieldDirty: false });
    useMazeStore.getState().clearFieldPoints();
    expect(activeField().fieldDirty).toBe(false);
  });

  it("setShowFieldOverlay toggles flag", () => {
    useMazeStore.getState().setShowFieldOverlay(false);
    expect(useMazeStore.getState().showFieldOverlay).toBe(false);
  });

  it("setShowFieldOrigin toggles flag", () => {
    useMazeStore.getState().setShowFieldOrigin(false);
    expect(useMazeStore.getState().showFieldOrigin).toBe(false);
  });

  it("setFieldPrimitive updates primitive", () => {
    useMazeStore.getState().setFieldPrimitive("hexagon");
    expect(activeField().fieldPrimitive).toBe("hexagon");
  });

  it("setFieldEditMode('custom') derives fieldPoints from predefined config cells", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }), freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setFieldEditMode("custom");
    const field = activeField();
    expect(field.fieldEditMode).toBe("custom");
    expect(field.isEditingField).toBe(true);
    expect(field.fieldPoints.size).toBe(9);
    expect([field.fieldConfig.tessellation.kind, field.fieldConfig.shape.shape]).toEqual(["square", "custom"]);
  });

  it("setFieldEditMode('default') rebuilds predefined config", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({
      squareShape: "rect",
      hexShape: "parallelogram",
      triangleShape: "rect",
      fieldEditMode: "custom",
      savedShapes: {},
    });
    useMazeStore.getState().setFieldEditMode("default");
    const field = activeField();
    expect(field.fieldEditMode).toBe("default");
    expect(field.isEditingField).toBe(false);
    expect([field.fieldConfig.tessellation.kind, field.fieldConfig.shape.shape]).toEqual(["square", "rect"]);
  });
});
