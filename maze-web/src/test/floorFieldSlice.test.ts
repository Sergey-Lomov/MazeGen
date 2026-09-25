import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";

const OTHER_FLOOR_ID = "floor_other";

beforeEach(() => {
  useMazeStore.setState({
    floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: OTHER_FLOOR_ID, title: "Floor 2" }],
    activeFloorId: TEST_FLOOR_ID,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 4 }, fieldDirty: false }),
      [OTHER_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 7, height: 9 }, fieldDirty: false }),
    },
    mazeDirty: false,
    postEditDirty: false,
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
    useMazeStore.getState().setSquareShape("free");
    expect(useMazeStore.getState().fieldEditConfirmation).toEqual({ kind: "setSquareShape", shape: "free" });
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
    expect(floorFields[TEST_FLOOR_ID].tessellationConfig).toEqual({ type: "square", width: 7, height: 9 });
  });

  it("copies into an independent object, not a shared reference with the source", () => {
    useMazeStore.getState().copyFloorField(OTHER_FLOOR_ID);
    const { floorFields } = useMazeStore.getState();
    expect(floorFields[TEST_FLOOR_ID]).not.toBe(floorFields[OTHER_FLOOR_ID]);
  });

  it("leaves the source floor's own config untouched", () => {
    useMazeStore.getState().copyFloorField(OTHER_FLOOR_ID);
    const { floorFields } = useMazeStore.getState();
    expect(floorFields[OTHER_FLOOR_ID].tessellationConfig).toEqual({ type: "square", width: 7, height: 9 });
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
