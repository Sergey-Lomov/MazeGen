import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FloorSwitcher } from "../components/FloorSwitcher";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";
import { getTooltipControl } from "./tooltipTestUtils";

const floors = [
  { id: "a", title: "Floor 1" },
  { id: "b", title: "Floor 2" },
  { id: "c", title: "Floor 3" },
];

beforeEach(() => {
  useMazeStore.setState({ floors, activeFloorId: "b" });
});

describe("FloorSwitcher", () => {
  it("shows the active floor's 1-based index and title", () => {
    render(<FloorSwitcher />);
    expect(screen.getByText("2: Floor 2")).toBeInTheDocument();
  });

  it("moving up (toward the array's end) advances to the next floor", () => {
    render(<FloorSwitcher />);
    fireEvent.click(getTooltipControl(m["floors.switcher_next_floor"]()));
    expect(useMazeStore.getState().activeFloorId).toBe("c");
  });

  it("moving down (toward the array's start) goes to the previous floor", () => {
    render(<FloorSwitcher />);
    fireEvent.click(getTooltipControl(m["floors.switcher_prev_floor"]()));
    expect(useMazeStore.getState().activeFloorId).toBe("a");
  });

  it("disables the up arrow at the top floor", () => {
    useMazeStore.setState({ activeFloorId: "c" });
    render(<FloorSwitcher />);
    expect(getTooltipControl(m["floors.switcher_next_floor"]())).toBeDisabled();
  });

  it("disables the down arrow at the bottom floor", () => {
    useMazeStore.setState({ activeFloorId: "a" });
    render(<FloorSwitcher />);
    expect(getTooltipControl(m["floors.switcher_prev_floor"]())).toBeDisabled();
  });

  it("falls back to the bottom floor when activeFloorId is stale", () => {
    useMazeStore.setState({ activeFloorId: "not_a_real_id" });
    render(<FloorSwitcher />);
    expect(screen.getByText("1: Floor 1")).toBeInTheDocument();
  });
});
