import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CopyFieldToFloorsDialog } from "../components/dialogs/CopyFieldToFloorsDialog";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";
import * as m from "~/paraglide/messages";

const FLOOR_2_ID = "floor_2";
const FLOOR_3_ID = "floor_3";

// The primary button also carries the number of chosen floors: "Copy (2)".
const COPY_BUTTON = new RegExp(`^${m["floors.copy_confirm"]()}( \\(\\d+\\))?$`);

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    floors: [
      { id: TEST_FLOOR_ID, title: "Floor 1" },
      { id: FLOOR_2_ID, title: "Floor 2" },
      { id: FLOOR_3_ID, title: "Floor 3" },
    ],
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig(),
      [FLOOR_2_ID]: baseFloorFieldConfig(),
      [FLOOR_3_ID]: baseFloorFieldConfig(),
    },
  });
});

describe("CopyFieldToFloorsDialog", () => {
  it("names the source floor and lists every other floor topmost first", () => {
    render(<CopyFieldToFloorsDialog sourceFloorId={FLOOR_2_ID} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(m["floors.copy_to_floors_text"]({ floor: "Floor 2" }))).toBeInTheDocument();
    const switches = screen.getAllByRole("checkbox");
    // Floor 3, Floor 1, then the topology switch.
    expect(switches.map((s) => s.getAttribute("aria-label"))).toEqual(["Floor 3", "Floor 1", m["field.copy_floor_include_topology"]()]);
  });

  it("disables the copy button until a floor is chosen, but copy-to-all always works", () => {
    const onSubmit = vi.fn();
    render(<CopyFieldToFloorsDialog sourceFloorId={TEST_FLOOR_ID} onSubmit={onSubmit} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: COPY_BUTTON })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: m["floors.copy_to_all"]() }));
    expect(onSubmit).toHaveBeenCalledWith([FLOOR_3_ID, FLOOR_2_ID], true);
  });

  it("submits only the chosen floors", () => {
    const onSubmit = vi.fn();
    render(<CopyFieldToFloorsDialog sourceFloorId={TEST_FLOOR_ID} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Floor 2" }));
    fireEvent.click(screen.getByRole("button", { name: COPY_BUTTON }));
    expect(onSubmit).toHaveBeenCalledWith([FLOOR_2_ID], true);
  });

  it("shows the number of chosen floors on the primary button and toggles a floor by clicking its row", () => {
    render(<CopyFieldToFloorsDialog sourceFloorId={TEST_FLOOR_ID} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: COPY_BUTTON }).textContent).toBe(m["floors.copy_confirm"]());
    fireEvent.click(screen.getByText("Floor 2"));
    expect(screen.getByRole("checkbox", { name: "Floor 2" })).toBeChecked();
    fireEvent.click(screen.getByText("Floor 3"));
    expect(screen.getByRole("button", { name: COPY_BUTTON }).textContent).toBe(`${m["floors.copy_confirm"]()} (2)`);
    fireEvent.click(screen.getByText("Floor 2"));
    expect(screen.getByRole("checkbox", { name: "Floor 2" })).not.toBeChecked();
  });

  it("toggles once when the switch itself is clicked", () => {
    render(<CopyFieldToFloorsDialog sourceFloorId={TEST_FLOOR_ID} onSubmit={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Floor 2" }));
    expect(screen.getByRole("checkbox", { name: "Floor 2" })).toBeChecked();
  });

  it("passes the include-topology switch through, for both buttons", () => {
    const onSubmit = vi.fn();
    render(<CopyFieldToFloorsDialog sourceFloorId={TEST_FLOOR_ID} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: m["field.copy_floor_include_topology"]() }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Floor 2" }));
    fireEvent.click(screen.getByRole("button", { name: COPY_BUTTON }));
    expect(onSubmit).toHaveBeenLastCalledWith([FLOOR_2_ID], false);

    fireEvent.click(screen.getByRole("button", { name: m["floors.copy_to_all"]() }));
    expect(onSubmit).toHaveBeenLastCalledWith([FLOOR_3_ID, FLOOR_2_ID], false);
  });

  it("has no cancel button", () => {
    render(<CopyFieldToFloorsDialog sourceFloorId={TEST_FLOOR_ID} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: m["common.cancel"]() })).toBeNull();
  });
});
