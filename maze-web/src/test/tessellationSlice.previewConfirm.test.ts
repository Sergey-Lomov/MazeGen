import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";
import { baseStoreState, emptyFreePoints, TEST_FLOOR_ID, baseFloorFieldConfig } from "./storeTestHelpers";

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

describe("mazeStore preview/confirm flow", () => {
  it("setPreviewKind does not reset orientation", () => {
    useMazeStore.setState({ previewHexOrientation: "pointy_top", previewTriOrientation: "r90" });
    useMazeStore.getState().setPreviewKind("hex");
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("hex");
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTriOrientation).toBe("r90");
  });

  it("setPreviewKind updates previewTessellationConfig", () => {
    useMazeStore.getState().setPreviewKind("triangle");
    expect(useMazeStore.getState().previewTessellationConfig.type).toBe("triangle_rect");
  });

  it("syncPreviewToConfirmed copies all confirmed values atomically", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexOrientation: "pointy_top",
      triOrientation: "r180",
      previewKind: "triangle",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
    });
    useMazeStore.getState().syncPreviewToConfirmed();
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("hex");
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTriOrientation).toBe("r180");
    expect(s.previewTessellationConfig).toMatchObject({ type: "hex_parallelogram", orientation: "pointy_top" });
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
      previewKind: "triangle",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r90",
      tessellationKind: "square",
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("triangle");
    expect(s.previewTriOrientation).toBe("r90");
    expect(s.previewTessellationConfig.type).toBe("triangle_rect");
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
    expect(s.floorFields[TEST_FLOOR_ID].tessellationConfig.type).toBe("hex_hexagon");
    expect(s.floorFields[otherFloorId].isEditingField).toBe(false);
    expect(s.floorFields[otherFloorId].tessellationConfig.type).toBe("hex_hexagon");
  });
});

describe("mazeStore tessellation misc actions", () => {
  it("setPreviewHexOrientation updates preview config", () => {
    useMazeStore.setState({ previewKind: "hex" });
    useMazeStore.getState().setPreviewHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTessellationConfig).toMatchObject({ type: "hex_parallelogram", orientation: "pointy_top" });
  });

  it("setPreviewTriOrientation updates preview config", () => {
    useMazeStore.setState({ previewKind: "triangle" });
    useMazeStore.getState().setPreviewTriOrientation("r270");
    const s = useMazeStore.getState();
    expect(s.previewTriOrientation).toBe("r270");
    expect(s.previewTessellationConfig).toMatchObject({ type: "triangle_rect", orientation: "r270" });
  });

  it("addFieldPoints adds multiple cells and marks fieldDirty", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({ fieldPoints: new Set<number>(), freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().addFieldPoints([[0, 0], [1, 0], [0, 1]]);
    const field = activeField();
    expect(field.fieldPoints.size).toBe(3);
    expect(field.fieldDirty).toBe(true);
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
    setActiveField({ tessellationConfig: { type: "square", width: 3, height: 3 }, freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setFieldEditMode("custom");
    const field = activeField();
    expect(field.fieldEditMode).toBe("custom");
    expect(field.isEditingField).toBe(true);
    expect(field.fieldPoints.size).toBe(9);
    expect(field.tessellationConfig.type).toBe("square_custom");
  });

  it("setFieldEditMode('default') rebuilds predefined config", () => {
    useMazeStore.setState({ tessellationKind: "square" });
    setActiveField({
      squareShape: "rect",
      hexShape: "parallelogram",
      triangleShape: "rect",
      fieldEditMode: "custom",
      savedConfigs: {},
    });
    useMazeStore.getState().setFieldEditMode("default");
    const field = activeField();
    expect(field.fieldEditMode).toBe("default");
    expect(field.isEditingField).toBe(false);
    expect(field.tessellationConfig.type).toBe("square");
  });
});
