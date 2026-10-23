import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SymmetryPanel } from "../components/features/SymmetryPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";

beforeEach(() => {
  useMazeStore.setState({
    ...baseStoreState(),
    fieldOpError: null,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", fieldPrimitive: "symmetry" }),
    },
  });
});

describe("SymmetryPanel", () => {
  it("updates snap mode, scope, and source direction through toggle controls", () => {
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 0, y: 0 }, { x: 0, y: 100 }],
      symmetryScope: "one_side",
    });
    render(<SymmetryPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Free" }));
    fireEvent.click(screen.getByRole("button", { name: "Polygon" }));

    expect(useMazeStore.getState().symmetrySnapMode).toBe("free");
    expect(useMazeStore.getState().symmetryScope).toBe("polygon");

    fireEvent.click(screen.getByRole("button", { name: "Everything" }));
    expect(useMazeStore.getState().symmetryScope).toBe("everything");

    fireEvent.click(screen.getByRole("button", { name: "One side" }));
    fireEvent.click(screen.getByRole("button", { name: "Change direction" }));
    expect(useMazeStore.getState().symmetrySourceSide).toBe(-1);
  });

  it("requires an explicit polygon finish before enabling apply", () => {
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 0, y: 0 }, { x: 0, y: 100 }],
      symmetryScope: "polygon",
      symmetryPolygon: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 40, y: 80 }],
      symmetryPolygonFinished: false,
    });
    render(<SymmetryPanel />);

    expect(screen.getByText("Finish the processing polygon to enable Apply.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply symmetry" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Finish polygon" }));

    expect(useMazeStore.getState().symmetryPolygonFinished).toBe(true);
    expect(screen.getByRole("button", { name: "Apply symmetry" })).not.toBeDisabled();
  });

  it("shows a refused core operation as a warning and disables apply", () => {
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 0, y: 0 }, { x: 0, y: 100 }],
      fieldOpError: { kind: "not_a_symmetry" },
    });
    render(<SymmetryPanel />);

    expect(screen.getByText(/This axis does not fit/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply symmetry" })).toBeDisabled();
  });

  it("shows no status when the configuration is ready", () => {
    useMazeStore.setState({ symmetryAxisPoints: [{ x: 0, y: 0 }, { x: 0, y: 100 }], symmetryScope: "everything" });
    render(<SymmetryPanel />);

    expect(screen.queryByText("The configuration is ready to apply.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply symmetry" })).not.toBeDisabled();
  });
});
