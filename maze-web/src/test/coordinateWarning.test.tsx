import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint } from "../domain/presetEndpoint";
import { coordinateWarningLevels, nodeCoordinateTargets, uniqueCoordinateTargets, type CoordinateWarning } from "../domain/coordinateWarning";
import { CoordinateWarningBubble, coordinateBubbleVariant } from "../components/CoordinateWarningBubble";

describe("coordinate warning helpers", () => {
  it("dedups targets by cell, slot and floor", () => {
    const a = presetEndpoint([1, 2]);
    expect(uniqueCoordinateTargets([a, presetEndpoint([1, 2]), presetEndpoint([1, 2], 1), presetEndpoint([1, 2], undefined, 1)])).toHaveLength(3);
  });

  it("lists distinct ascending floors, floor 0 for an undefined level", () => {
    expect(coordinateWarningLevels([presetEndpoint([0, 0], undefined, 2), presetEndpoint([1, 0]), presetEndpoint([2, 0], undefined, 2)])).toEqual([0, 2]);
  });

  it("resolves node ids to cell targets and skips unknown ids", () => {
    const nodes = [{ id: 1, x: 3, y: 4, i: 0, level: 1 }, { id: 2, x: 3, y: 4, i: 1, level: 1 }];
    expect(nodeCoordinateTargets([1, 2, 99], nodes)).toEqual([presetEndpoint([3, 4], undefined, 1)]);
  });

  it("maps severity to the bubble variant", () => {
    expect(coordinateBubbleVariant("info")).toBe("neutral");
    expect(coordinateBubbleVariant("warning")).toBe("warning");
    expect(coordinateBubbleVariant("critical")).toBe("danger");
  });
});

describe("CoordinateWarningBubble", () => {
  const warning: CoordinateWarning = { severity: "critical", targets: [presetEndpoint([0, 0]), presetEndpoint([1, 0], undefined, 1)] };

  beforeEach(() => {
    useMazeStore.setState({
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }],
      activeFloorId: "f0",
      hoveredCoordinateWarning: null,
    });
  });

  it("hover sets the whole warning, a coordinate hover narrows it to one target, leave clears", () => {
    const { container } = render(<CoordinateWarningBubble warning={warning} message="Bad cells" coordinates={[{ text: "(1, 0)", target: warning.targets[1] }]} />);
    const bubble = container.firstElementChild!;
    fireEvent.mouseEnter(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning).toEqual({ severity: "critical", targets: warning.targets });

    fireEvent.mouseEnter(screen.getByText("(1, 0)"));
    expect(useMazeStore.getState().hoveredCoordinateWarning).toEqual({ severity: "critical", targets: [warning.targets[1]] });

    fireEvent.mouseLeave(screen.getByText("(1, 0)"));
    fireEvent.mouseLeave(bubble);
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("keeps the contour groups of the whole warning on hover but draws a hovered coordinate as a single cell", () => {
    const grouped: CoordinateWarning = { ...warning, groups: [{ targets: warning.targets, outset: true }] };
    const { container } = render(<CoordinateWarningBubble warning={grouped} message="Bad tiles" coordinates={[{ text: "(1, 0)", target: warning.targets[1] }]} />);
    fireEvent.mouseEnter(container.firstElementChild!);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.groups).toEqual(grouped.groups);
    fireEvent.mouseEnter(screen.getByText("(1, 0)"));
    expect(useMazeStore.getState().hoveredCoordinateWarning?.groups).toBeUndefined();
  });

  it("shows a floor badge per targeted floor", () => {
    render(<CoordinateWarningBubble warning={warning} message="Bad cells" />);
    expect(screen.getByText("L1")).toBeInTheDocument();
    expect(screen.getByText("L2")).toBeInTheDocument();
  });

  it("clears the hover when the bubble unmounts while hovered", () => {
    const { unmount, container } = render(<CoordinateWarningBubble warning={warning} message="Bad cells" />);
    fireEvent.mouseEnter(container.firstElementChild!);
    unmount();
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });
  it("lists the floors of floorTargets in the badges without making them targets", () => {
    const withFloorTargets: CoordinateWarning = { severity: "warning", targets: [presetEndpoint([0, 0])], floorTargets: [presetEndpoint([5, 5], undefined, 1)] };
    const { container } = render(<CoordinateWarningBubble warning={withFloorTargets} message="Outside" />);
    expect(screen.getByText("L2")).toBeInTheDocument();
    fireEvent.mouseEnter(container.firstElementChild!);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual(withFloorTargets.targets);
  });

  it("reports its hover through onHoverChange, including an unmount while hovered", () => {
    const onHoverChange = vi.fn();
    const { container, unmount } = render(<CoordinateWarningBubble warning={warning} message="Bad cells" onHoverChange={onHoverChange} />);
    fireEvent.mouseEnter(container.firstElementChild!);
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
    fireEvent.mouseLeave(container.firstElementChild!);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
    fireEvent.mouseEnter(container.firstElementChild!);
    onHoverChange.mockClear();
    unmount();
    expect(onHoverChange).toHaveBeenCalledWith(false);
  });
});
