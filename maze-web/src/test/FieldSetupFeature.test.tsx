import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FieldSetupFeature, fieldSetupSubtitle } from "../components/features/FieldSetupFeature";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
});

describe("FieldSetupFeature — Copy floor button", () => {
  it("is hidden with a single floor", () => {
    render(<FieldSetupFeature />);
    expect(screen.queryByText("Copy floor")).not.toBeInTheDocument();
  });

  it("is shown once more than one floor exists", () => {
    useMazeStore.setState({
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig(),
        floor_2: baseFloorFieldConfig(),
      },
    });
    render(<FieldSetupFeature />);
    expect(screen.getByText("Copy floor")).toBeInTheDocument();
  });
});

describe("fieldSetupSubtitle — multi-floor aggregation (GitHub issue #383)", () => {
  it("sums cell counts across floors, not just the first floor's", () => {
    const floors = [
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 2 } }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("13");
  });

  it("shows the shared shape label when all floors match", () => {
    const floors = [
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("Rect");
  });

  it("shows 'Different floor shapes' when floors' shapes/sizes differ", () => {
    const floors = [
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 5, height: 5 } }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("Different floor shapes");
  });

  it("sums custom-mode point counts across floors", () => {
    const floors = [
      baseFloorFieldConfig({ fieldEditMode: "custom", fieldPoints: new Set([1, 2]) }),
      baseFloorFieldConfig({ fieldEditMode: "custom", fieldPoints: new Set([3, 4, 5]) }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("5");
  });

  it("treats a custom floor and a default floor as different shapes", () => {
    const floors = [
      baseFloorFieldConfig({ fieldEditMode: "custom", fieldPoints: new Set([1]) }),
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("Different floor shapes");
  });
});
