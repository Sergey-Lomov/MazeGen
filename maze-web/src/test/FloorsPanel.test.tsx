import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FloorsPanel } from "../components/features/FloorsPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig } from "./storeTestHelpers";
import * as m from "~/paraglide/messages";
import { getTooltipAnchors, getTooltipControl, getTooltipControlWithin } from "./tooltipTestUtils";

function setFloors(titles: string[]) {
  useMazeStore.setState({
    floors: titles.map((title, i) => ({ id: `f${i}`, title })),
    activeFloorId: "f0",
    mazeDirty: false,
    postEditDirty: false,
  });
}

function startRename(floorTitle: string) {
  const row = screen.getByText(floorTitle).closest("div") as HTMLElement;
  fireEvent.click(getTooltipControlWithin(row, m["floors.rename_floor"]()));
  return screen.getByRole("textbox") as HTMLInputElement;
}

beforeEach(() => setFloors(["Floor 1", "Floor 2"]));

describe("FloorsPanel blocked-action explanations", () => {
  it("explains the disabled remove button of the last floor with a tooltip", () => {
    setFloors(["Floor 1"]);
    render(<FloorsPanel onClose={() => {}} />);
    expect(getTooltipAnchors(m["floors.remove_last_floor_hint"]())).toHaveLength(1);
    expect(getTooltipControl(m["floors.remove_floor"]())).toBeDisabled();
  });

  it("shows no remove tooltip while several floors exist", () => {
    render(<FloorsPanel onClose={() => {}} />);
    expect(screen.queryAllByTestId("tooltip-anchor").some((a) => document.getElementById(a.getAttribute("aria-describedby") ?? "")?.textContent?.includes(m["floors.remove_last_floor_hint"]()))).toBe(false);
    expect(getTooltipControl(m["floors.remove_floor"]())).not.toBeDisabled();
  });

  it("reverts an empty rename and shows a field hint", () => {
    render(<FloorsPanel onClose={() => {}} />);
    const input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "   " } });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(useMazeStore.getState().floors.find((f) => f.id === "f0")?.title).toBe("Floor 1");
    expect(screen.getByText(m["floors.empty_title_hint"]())).toBeInTheDocument();
  });

  it("commits a valid rename without a hint", () => {
    render(<FloorsPanel onClose={() => {}} />);
    const input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "Cellar" } });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(useMazeStore.getState().floors.find((f) => f.id === "f0")?.title).toBe("Cellar");
    expect(screen.queryByText(m["floors.empty_title_hint"]())).toBeNull();
  });

  it("shows the hint when an empty rename is committed by blur", () => {
    render(<FloorsPanel onClose={() => {}} />);
    const input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "" } });
    act(() => { fireEvent.blur(input); });

    expect(useMazeStore.getState().floors.find((f) => f.id === "f0")?.title).toBe("Floor 1");
    expect(screen.getByText(m["floors.empty_title_hint"]())).toBeInTheDocument();
  });

  it("drops a stale empty-title hint when another floor starts renaming", () => {
    render(<FloorsPanel onClose={() => {}} />);
    const input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "" } });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(screen.getByText(m["floors.empty_title_hint"]())).toBeInTheDocument();

    startRename("Floor 2");
    expect(screen.queryByText(m["floors.empty_title_hint"]())).toBeNull();
  });

  it("dismisses the hint when a later rename is accepted", () => {
    render(<FloorsPanel onClose={() => {}} />);
    let input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "" } });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(screen.getByText(m["floors.empty_title_hint"]())).toBeInTheDocument();

    input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "Attic" } });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(screen.queryByText(m["floors.empty_title_hint"]())).toBeNull();
  });
});

describe("FloorsPanel rows", () => {
  it("marks only the active floor with a bar and a click makes a floor active", () => {
    render(<FloorsPanel onClose={() => {}} />);
    expect(screen.getAllByTestId("list-cell-current")).toHaveLength(1);
    const rowOf = (title: string) => screen.getAllByTestId("floor-row").find((r) => r.textContent?.includes(title))!;
    expect(rowOf("Floor 1").querySelector("[data-testid='list-cell-current']")).not.toBeNull();
    fireEvent.click(screen.getByText("Floor 2"));
    expect(useMazeStore.getState().activeFloorId).toBe("f1");
    expect(rowOf("Floor 2").querySelector("[data-testid='list-cell-current']")).not.toBeNull();
    expect(rowOf("Floor 1").querySelector("[data-testid='list-cell-current']")).toBeNull();
  });

  it("offers the field copy actions per row only with several floors", () => {
    const { unmount } = render(<FloorsPanel onClose={() => {}} />);
    expect(screen.getAllByRole("button", { name: m["field.copy_floor"]() })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: m["floors.copy_to_floors"]() })).toHaveLength(2);
    unmount();

    setFloors(["Floor 1"]);
    render(<FloorsPanel onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: m["field.copy_floor"]() })).toBeNull();
    expect(screen.queryByRole("button", { name: m["floors.copy_to_floors"]() })).toBeNull();
  });
});

describe("FloorsPanel list edits with a generation present", () => {
  beforeEach(() => {
    useMazeStore.setState({
      floorFields: { f0: baseFloorFieldConfig(), f1: baseFloorFieldConfig() },
    });
  });

  function rowAction(floorTitle: string, name: string) {
    const row = screen.getByText(floorTitle).closest("[data-testid='floor-row']") as HTMLElement;
    return getTooltipControlWithin(row, name);
  }

  it("changes the list at once when there is nothing to lose", () => {
    render(<FloorsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: m["floors.add_floor"]() }));
    expect(useMazeStore.getState().floors).toHaveLength(3);
    fireEvent.click(rowAction("Floor 1", m["floors.remove_floor"]()));
    expect(useMazeStore.getState().floors.map((f) => f.id)).not.toContain("f0");
  });

  it("asks before adding a floor, and resets the generation on confirm", () => {
    useMazeStore.setState({ mazeDirty: true });
    render(<FloorsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: m["floors.add_floor"]() }));
    expect(screen.getByText(m["floors.confirm_add_generation"]())).toBeInTheDocument();
    expect(useMazeStore.getState().floors).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: m["common.ok"]() }));
    expect(useMazeStore.getState().floors).toHaveLength(3);
    expect(useMazeStore.getState().mazeDirty).toBe(false);
  });

  it("keeps the floors when the add confirmation is cancelled", () => {
    useMazeStore.setState({ mazeDirty: true });
    render(<FloorsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: m["floors.add_floor"]() }));
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(useMazeStore.getState().floors).toHaveLength(2);
    expect(useMazeStore.getState().mazeDirty).toBe(true);
  });

  it("asks before removing a floor while a generation exists", () => {
    useMazeStore.setState({ mazeDirty: true });
    render(<FloorsPanel onClose={() => {}} />);
    fireEvent.click(rowAction("Floor 2", m["floors.remove_floor"]()));
    expect(screen.getByText(m["floors.confirm_remove_generation"]())).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: m["common.ok"]() }));
    expect(useMazeStore.getState().floors).toHaveLength(1);
  });

  it("asks before reordering floors while a generation exists", () => {
    useMazeStore.setState({ mazeDirty: true });
    render(<FloorsPanel onClose={() => {}} />);
    fireEvent.click(rowAction("Floor 1", m["floors.move_floor_up"]()));
    expect(screen.getByText(m["floors.confirm_reorder"]())).toBeInTheDocument();
    expect(useMazeStore.getState().floors.map((f) => f.title)).toEqual(["Floor 1", "Floor 2"]);
    fireEvent.click(screen.getByRole("button", { name: m["common.ok"]() }));
    expect(useMazeStore.getState().floors.map((f) => f.title)).toEqual(["Floor 2", "Floor 1"]);
  });
});
