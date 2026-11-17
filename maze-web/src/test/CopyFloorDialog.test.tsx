import * as m from "~/paraglide/messages";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CopyFloorDialog } from "../components/dialogs/CopyFloorDialog";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";

const FLOOR_2_ID = "floor_2";
const FLOOR_3_ID = "floor_3";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    floors: [
      { id: TEST_FLOOR_ID, title: "Floor 1" },
      { id: FLOOR_2_ID, title: "Floor 2" },
      { id: FLOOR_3_ID, title: "Floor 3" },
    ],
    activeFloorId: FLOOR_2_ID,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 4 }) }),
      [FLOOR_2_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 5, rows: 5 }) }),
      [FLOOR_3_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 9, rows: 9 }) }),
    },
  });
});

describe("CopyFloorDialog", () => {
  it("lists every floor but the receiving one, topmost first, and names the receiver in the text", () => {
    render(<CopyFloorDialog targetFloorId={FLOOR_2_ID} onClose={vi.fn()} />);
    const items = screen.getAllByRole("option");
    expect(items.map((el) => el.textContent)).toEqual(["Floor 3", "Floor 1"]);
    expect(screen.getByText(m["field.copy_floor_text"]({ floor: "Floor 2" }))).toBeInTheDocument();
  });

  it("Confirm is disabled until a floor is selected", () => {
    render(<CopyFloorDialog targetFloorId={FLOOR_2_ID} onClose={vi.fn()} />);
    expect(screen.getByText("Confirm")).toBeDisabled();
  });

  it("selecting a floor then confirming copies that floor's field into the active floor", () => {
    const onClose = vi.fn();
    render(<CopyFloorDialog targetFloorId={FLOOR_2_ID} onClose={onClose} />);
    fireEvent.click(screen.getByText("Floor 3"));
    expect(screen.getByText("Confirm")).not.toBeDisabled();
    fireEvent.click(screen.getByText("Confirm"));
    expect(useMazeStore.getState().floorFields[FLOOR_2_ID].fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 9, rows: 9 }));
    expect(onClose).toHaveBeenCalled();
  });

  it("includes topology by default and skips it when the switch is turned off", () => {
    const topology = { fingerprint: "square{}", folds: [], groups: [] };
    useMazeStore.setState({ floorTopology: { [FLOOR_3_ID]: topology } });
    const { unmount } = render(<CopyFloorDialog targetFloorId={FLOOR_2_ID} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Floor 3"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(useMazeStore.getState().floorTopology[FLOOR_2_ID]).toEqual(topology);
    unmount();

    useMazeStore.setState({ floorTopology: { [FLOOR_3_ID]: topology } });
    render(<CopyFloorDialog targetFloorId={FLOOR_2_ID} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Floor 3"));
    fireEvent.click(screen.getByLabelText("Include topology"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(useMazeStore.getState().floorTopology[FLOOR_2_ID]).toBeUndefined();
  });

  it("focuses the list on open, so the arrow keys walk the floors and skip the active one", () => {
    render(<CopyFloorDialog targetFloorId={FLOOR_2_ID} onClose={vi.fn()} />);
    const list = screen.getByRole("listbox");
    expect(document.activeElement).toBe(list);

    // Displayed Floor 3, Floor 2 (active, disabled), Floor 1.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Floor 3" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Floor 1" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Confirm")).not.toBeDisabled();
  });

  it("copies onto the given target floor, not the active one", () => {
    render(<CopyFloorDialog targetFloorId={FLOOR_3_ID} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Floor 1"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(useMazeStore.getState().floorFields[FLOOR_3_ID].fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 3, rows: 4 }));
    expect(useMazeStore.getState().floorFields[FLOOR_2_ID].fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 5, rows: 5 }));
  });

  it("has no Cancel button; Escape closes without copying", () => {
    const onClose = vi.fn();
    render(<CopyFloorDialog targetFloorId={FLOOR_2_ID} onClose={onClose} />);
    fireEvent.click(screen.getByText("Floor 3"));
    expect(screen.queryByText("Cancel")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(useMazeStore.getState().floorFields[FLOOR_2_ID].fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 5, rows: 5 }));
  });
});
