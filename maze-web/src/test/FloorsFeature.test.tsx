import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FloorsFeature } from "../components/features/FloorsFeature";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";
import { getTooltipControl, getTooltipControlWithin } from "./tooltipTestUtils";

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

describe("FloorsFeature blocked-action explanations", () => {
  it("explains the disabled remove button of the last floor with a tooltip", () => {
    setFloors(["Floor 1"]);
    render(<FloorsFeature />);
    expect(screen.getByText(m["floors.remove_last_floor_hint"](), { selector: "[hidden]" })).toBeInTheDocument();
    expect(getTooltipControl(m["floors.remove_floor"]())).toBeDisabled();
  });

  it("shows no remove tooltip while several floors exist", () => {
    render(<FloorsFeature />);
    expect(screen.queryByText(m["floors.remove_last_floor_hint"](), { selector: "[hidden]" })).toBeNull();
    expect(getTooltipControl(m["floors.remove_floor"]())).not.toBeDisabled();
  });

  it("reverts an empty rename and shows a field hint", () => {
    render(<FloorsFeature />);
    const input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "   " } });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(useMazeStore.getState().floors.find((f) => f.id === "f0")?.title).toBe("Floor 1");
    expect(screen.getByText(m["floors.empty_title_hint"]())).toBeInTheDocument();
  });

  it("commits a valid rename without a hint", () => {
    render(<FloorsFeature />);
    const input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "Cellar" } });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(useMazeStore.getState().floors.find((f) => f.id === "f0")?.title).toBe("Cellar");
    expect(screen.queryByText(m["floors.empty_title_hint"]())).toBeNull();
  });

  it("shows the hint when an empty rename is committed by blur", () => {
    render(<FloorsFeature />);
    const input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "" } });
    act(() => { fireEvent.blur(input); });

    expect(useMazeStore.getState().floors.find((f) => f.id === "f0")?.title).toBe("Floor 1");
    expect(screen.getByText(m["floors.empty_title_hint"]())).toBeInTheDocument();
  });

  it("drops a stale empty-title hint when another floor starts renaming", () => {
    render(<FloorsFeature />);
    const input = startRename("Floor 1");
    fireEvent.change(input, { target: { value: "" } });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(screen.getByText(m["floors.empty_title_hint"]())).toBeInTheDocument();

    startRename("Floor 2");
    expect(screen.queryByText(m["floors.empty_title_hint"]())).toBeNull();
  });

  it("dismisses the hint when a later rename is accepted", () => {
    render(<FloorsFeature />);
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
