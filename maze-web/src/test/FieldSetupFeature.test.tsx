import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FieldSetupFeature } from "../components/features/FieldSetupFeature";
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
