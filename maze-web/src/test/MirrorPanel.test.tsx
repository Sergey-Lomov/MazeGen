import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MirrorPanel } from "../components/features/MirrorPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";

beforeEach(() => {
  useMazeStore.setState({
    ...baseStoreState(),
    fieldOpError: null,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", fieldPrimitive: "mirror" }),
    },
  });
});

describe("MirrorPanel", () => {
  it("updates snap mode, scope, and source direction through toggle controls", () => {
    useMazeStore.setState({
      mirrorAxisPoints: [{ x: 0, y: 0 }, { x: 0, y: 100 }],
      mirrorScope: "one_side",
    });
    render(<MirrorPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Free" }));
    fireEvent.click(screen.getByRole("button", { name: "Polygon" }));

    expect(useMazeStore.getState().mirrorSnapMode).toBe("free");
    expect(useMazeStore.getState().mirrorScope).toBe("polygon");

    fireEvent.click(screen.getByRole("button", { name: "Everything" }));
    expect(useMazeStore.getState().mirrorScope).toBe("everything");

    fireEvent.click(screen.getByRole("button", { name: "One side" }));
    fireEvent.click(screen.getByRole("button", { name: "Change direction" }));
    expect(useMazeStore.getState().mirrorSourceSide).toBe(-1);
  });

  it("requires an explicit polygon finish before enabling apply", () => {
    useMazeStore.setState({
      mirrorAxisPoints: [{ x: 0, y: 0 }, { x: 0, y: 100 }],
      mirrorScope: "polygon",
      mirrorPolygon: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 40, y: 80 }],
      mirrorPolygonFinished: false,
    });
    render(<MirrorPanel />);

    expect(screen.getByText("Finish the processing polygon to enable Apply.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply mirror" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Finish polygon" }));

    expect(useMazeStore.getState().mirrorPolygonFinished).toBe(true);
    expect(screen.getByRole("button", { name: "Apply mirror" })).not.toBeDisabled();
  });

  it("shows a refused core operation as a warning and disables apply", () => {
    useMazeStore.setState({
      mirrorAxisPoints: [{ x: 0, y: 0 }, { x: 0, y: 100 }],
      fieldOpError: { kind: "not_a_symmetry" },
    });
    render(<MirrorPanel />);

    expect(screen.getByText(/This axis does not fit/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply mirror" })).toBeDisabled();
  });

  it("shows no status when the configuration is ready", () => {
    useMazeStore.setState({ mirrorAxisPoints: [{ x: 0, y: 0 }, { x: 0, y: 100 }], mirrorScope: "everything" });
    render(<MirrorPanel />);

    expect(screen.queryByText("The configuration is ready to apply.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply mirror" })).not.toBeDisabled();
  });
});
