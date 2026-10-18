import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { decodePoint, encodePoint } from "../pixi/tessellationProjection";
import { baseFloorFieldConfig, emptyFreePoints, TEST_FLOOR_ID } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";

const OTHER_FLOOR_ID = "floor_other";

beforeEach(() => {
  useMazeStore.setState({
    floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: OTHER_FLOOR_ID, title: "Floor 2" }],
    activeFloorId: TEST_FLOOR_ID,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 4 }), fieldDirty: false }),
      [OTHER_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 7, rows: 9 }), fieldDirty: false }),
    },
    mazeDirty: false,
    postEditDirty: false,
    backgroundAutoFillPreview: null,
    fieldEditConfirmation: null,
  });
});

describe("copyFloorField", () => {
  it("clears downstream results when the field shape changes", () => {
    useMazeStore.setState({
      nodes: [{ id: 1, x: 0, y: 0, i: 0 }],
      edges: [{ from: 1, to: 1, kind: "basic" }],
      statistics: {} as never,
      mazeDirty: true,
      postEditDirty: true,
      postEditAnalytics: {} as never,
    });
    useMazeStore.getState().setSelectedShape("circle");
    expect(useMazeStore.getState().fieldEditConfirmation).toEqual({ kind: "setSelectedShape", shape: "circle" });
    expect(useMazeStore.getState().nodes).toHaveLength(1);
    useMazeStore.getState().confirmFieldEdit();
    const state = useMazeStore.getState();
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.postEditAnalytics).toBeNull();
    expect(state.mazeDirty).toBe(false);
    expect(state.postEditDirty).toBe(false);
  });

  it("replaces the active floor's FloorFieldConfig with a copy of the source floor's", () => {
    useMazeStore.getState().copyFloorField(OTHER_FLOOR_ID);
    const { floorFields } = useMazeStore.getState();
    expect(floorFields[TEST_FLOOR_ID].fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 7, rows: 9 }));
  });

  it("copies into an independent object, not a shared reference with the source", () => {
    useMazeStore.getState().copyFloorField(OTHER_FLOOR_ID);
    const { floorFields } = useMazeStore.getState();
    expect(floorFields[TEST_FLOOR_ID]).not.toBe(floorFields[OTHER_FLOOR_ID]);
  });

  it("leaves the source floor's own config untouched", () => {
    useMazeStore.getState().copyFloorField(OTHER_FLOOR_ID);
    const { floorFields } = useMazeStore.getState();
    expect(floorFields[OTHER_FLOOR_ID].fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 7, rows: 9 }));
  });

  it("marks the active floor's field dirty", () => {
    useMazeStore.getState().copyFloorField(OTHER_FLOOR_ID);
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldDirty).toBe(true);
  });

  it("is a no-op for an unknown source floor id", () => {
    const before = useMazeStore.getState().floorFields;
    useMazeStore.getState().copyFloorField("not_a_real_id");
    expect(useMazeStore.getState().floorFields).toBe(before);
  });
});

describe("copyCurrentFloorFieldToAll", () => {
  it("replaces every other floor with independent copies of the active floor field", () => {
    useMazeStore.setState({
      floors: [
        { id: TEST_FLOOR_ID, title: "Floor 1" },
        { id: OTHER_FLOOR_ID, title: "Floor 2" },
        { id: "floor_third", title: "Floor 3" },
      ],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldConfig: fieldOf("square", { shape: "custom", points: [[1, 2]] }),
          fieldPoints: new Set([65538]),
          freeFieldPoints: {
            ...emptyFreePoints(), square: new Set([65538]),
          },
          fieldDirty: false,
        }),
        [OTHER_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 7, rows: 9 }) }),
        floor_third: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 11, rows: 13 }) }),
      },
    });

    useMazeStore.getState().copyCurrentFloorFieldToAll();

    const { floorFields } = useMazeStore.getState();
    expect(floorFields[OTHER_FLOOR_ID].fieldConfig).toEqual(fieldOf("square", { shape: "custom", points: [[1, 2]] }));
    expect(floorFields.floor_third.fieldConfig).toEqual(fieldOf("square", { shape: "custom", points: [[1, 2]] }));
    expect(floorFields[OTHER_FLOOR_ID]).not.toBe(floorFields.floor_third);
    expect(floorFields[OTHER_FLOOR_ID].fieldConfig).not.toBe(floorFields.floor_third.fieldConfig);
    expect((floorFields[OTHER_FLOOR_ID].fieldConfig.shape as { points: [number, number][] }).points)
      .not.toBe((floorFields.floor_third.fieldConfig.shape as { points: [number, number][] }).points);
    expect(floorFields[OTHER_FLOOR_ID].fieldPoints).not.toBe(floorFields.floor_third.fieldPoints);
    expect(floorFields[OTHER_FLOOR_ID].freeFieldPoints.square).not.toBe(floorFields.floor_third.freeFieldPoints.square);
    expect(floorFields[OTHER_FLOOR_ID].fieldDirty).toBe(true);
    expect(floorFields[TEST_FLOOR_ID].fieldDirty).toBe(false);
  });

  it("clears generated results", () => {
    useMazeStore.setState({
      nodes: [{ id: 1, x: 0, y: 0, i: 0 }],
      edges: [{ from: 1, to: 1, kind: "basic" }],
      mazeDirty: true,
      postEditDirty: true,
    });

    useMazeStore.getState().copyCurrentFloorFieldToAll();

    expect(useMazeStore.getState().nodes).toEqual([]);
    expect(useMazeStore.getState().edges).toEqual([]);
    expect(useMazeStore.getState().mazeDirty).toBe(false);
    expect(useMazeStore.getState().postEditDirty).toBe(false);
  });

  it("does nothing while the background auto-fill preview is active", () => {
    const floorFields = useMazeStore.getState().floorFields;
    useMazeStore.setState({ backgroundAutoFillPreview: new Set([0]) });

    useMazeStore.getState().copyCurrentFloorFieldToAll();

    expect(useMazeStore.getState().floorFields).toBe(floorFields);
  });
});

describe("setFieldConfigsForFloors", () => {
  it("preserves per-floor configs when the dirty-edit confirmation is accepted", () => {
    useMazeStore.setState({
      mazeDirty: true,
      postEditDirty: true,
    });

    const configs = {
      [TEST_FLOOR_ID]: fieldOf("square", { shape: "rect", cols: 12, rows: 14 }),
      [OTHER_FLOOR_ID]: fieldOf("square", { shape: "rect", cols: 5, rows: 6 }),
    };
    useMazeStore.getState().setFieldConfigsForFloors(configs, true);

    expect(useMazeStore.getState().fieldEditConfirmation).toEqual({
      kind: "setFieldConfigsForFloors",
      configs,
      applyToAllStandardFloors: true,
    });

    useMazeStore.getState().confirmFieldEdit();

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldConfig).toEqual(configs[TEST_FLOOR_ID]);
    expect(useMazeStore.getState().floorFields[OTHER_FLOOR_ID].fieldConfig).toEqual(configs[OTHER_FLOOR_ID]);
    expect(useMazeStore.getState().fieldEditConfirmation).toBeNull();
  });
});

describe("core-backed field operations", () => {
  const customSquare = (points: [number, number][]) => baseFloorFieldConfig({
    fieldConfig: fieldOf("square", { shape: "custom", points }),
    fieldEditMode: "custom",
    isEditingField: true,
    fieldPoints: new Set(points.map(([x, y]) => encodePoint(x, y))),
    freeFieldPoints: { ...emptyFreePoints(), square: new Set(points.map(([x, y]) => encodePoint(x, y))) },
  });

  it("moveFieldPoints translates the selection by a world vector", () => {
    useMazeStore.setState({ floorFields: { ...useMazeStore.getState().floorFields, [TEST_FLOOR_ID]: customSquare([[0, 0], [1, 0]]) } });
    useMazeStore.getState().moveFieldPoints([[1, 0]], [0, 1]);
    const field = useMazeStore.getState().floorFields[TEST_FLOOR_ID];
    expect([...field.fieldPoints].map(decodePoint).sort()).toEqual([[0, 0], [1, 1]].sort());
    expect(useMazeStore.getState().fieldOpError).toBeNull();
  });

  it("moveFieldPoints keeps the field when core refuses the move", () => {
    useMazeStore.setState({ floorFields: { ...useMazeStore.getState().floorFields, [TEST_FLOOR_ID]: customSquare([[0, 0], [1, 0]]) } });
    useMazeStore.getState().moveFieldPoints([[0, 0]], [0.5, 0]);
    const field = useMazeStore.getState().floorFields[TEST_FLOOR_ID];
    expect(field.fieldPoints.size).toBe(2);
    expect(useMazeStore.getState().fieldOpError).toBeNull();
  });

  it("applySymmetry reports a free axis instead of changing the field", () => {
    useMazeStore.setState({
      floorFields: { ...useMazeStore.getState().floorFields, [TEST_FLOOR_ID]: customSquare([[1, 0]]) },
      symmetryScope: "everything",
      symmetryAxisPoints: [{ x: -100, y: -100 }, { x: 100, y: -60 }],
    });
    useMazeStore.getState().applySymmetry();
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints.size).toBe(1);
    expect(useMazeStore.getState().fieldOpError).toMatchObject({ kind: "not_a_symmetry" });
  });
});
