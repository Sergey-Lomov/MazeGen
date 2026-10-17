import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { defaultFloorFieldConfig, hasPresetMode } from "../store/storeHelpers";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";

describe("finite tessellation kind (dev test kind)", () => {
  beforeEach(() => {
    const field = defaultFloorFieldConfig("test", "flat_top", "r0");
    useMazeStore.setState({
      ...baseStoreState(),
      tessellationKind: "test",
      floorFields: { [TEST_FLOOR_ID]: field },
    });
  });

  it("starts as a custom field of all its cells", () => {
    const field = useMazeStore.getState().floorFields[TEST_FLOOR_ID];
    expect(field.isEditingField).toBe(true);
    expect(field.fieldEditMode).toBe("custom");
    expect(field.fieldConfig.shape).toEqual({ shape: "custom", points: TESSELLATION_UI.test.finiteCells });
    expect(field.fieldPoints.size).toBe(TESSELLATION_UI.test.finiteCells!.length);
    expect(field.freeFieldPoints.test).toBe(field.fieldPoints);
  });

  it("offers no default (preset) mode, only for finite kinds", () => {
    expect(hasPresetMode("test")).toBe(false);
    expect(hasPresetMode("square")).toBe(true);
  });

  it("ignores a switch to default mode", () => {
    const before = useMazeStore.getState().floorFields[TEST_FLOOR_ID];
    useMazeStore.getState().setFieldEditMode("default");
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID]).toBe(before);
  });
});
