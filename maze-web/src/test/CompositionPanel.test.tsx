import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { useMazeStore } from "../store/mazeStore";
import { defaultCompositionState, compositionTransientUi } from "../store/slices/compositionSlice";
import { CompositionPanel } from "../components/features/CompositionPanel";
import * as m from "~/paraglide/messages";

describe("CompositionPanel (GitHub issue #1099)", () => {
  beforeEach(() => {
    useMazeStore.setState({ ...defaultCompositionState(), ...compositionTransientUi });
  });

  it("lists elements top-most first as list cells and marks only the selected one as current", () => {
    for (let i = 0; i < 2; i++) useMazeStore.getState().addCompositionElement("test_text");
    render(<CompositionPanel />);
    const rows = screen.getAllByTestId("composition-row");
    expect(rows.map((r) => r.getAttribute("data-element-id"))).toEqual(["element_2", "element_1"]);
    expect(within(rows[0]).queryByTestId("list-cell-current")).not.toBeNull();
    expect(within(rows[1]).queryByTestId("list-cell-current")).toBeNull();
    fireEvent.click(rows[1]);
    expect(within(screen.getAllByTestId("composition-row")[1]).queryByTestId("list-cell-current")).not.toBeNull();
  });

  it("renames through the edit action", () => {
    useMazeStore.getState().addCompositionElement("test_text");
    render(<CompositionPanel />);
    fireEvent.click(screen.getByRole("button", { name: m["composition.edit"]() }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Caption" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useMazeStore.getState().compositions[0].elements[0].name).toBe("Caption");
  });

  it("cancels a rename on Escape", () => {
    useMazeStore.getState().addCompositionElement("test_text");
    const before = useMazeStore.getState().compositions[0].elements[0].name;
    render(<CompositionPanel />);
    fireEvent.click(screen.getByRole("button", { name: m["composition.edit"]() }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Dropped" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(useMazeStore.getState().compositions[0].elements[0].name).toBe(before);
  });

  it("moves, hides and locks through the row actions, and a locked row cannot be edited, moved or deleted", () => {
    for (let i = 0; i < 2; i++) useMazeStore.getState().addCompositionElement("test_text");
    render(<CompositionPanel />);
    const elements = () => useMazeStore.getState().compositions[0].elements;
    const topRow = () => screen.getAllByTestId("composition-row")[0];
    const action = (name: string) => within(topRow()).getByRole("button", { name }) as HTMLButtonElement;

    fireEvent.click(action(m["composition.move_down"]()));
    expect(elements().map((e) => e.id)).toEqual(["element_2", "element_1"]);

    fireEvent.click(action(m["composition.hide"]()));
    expect(elements().find((e) => e.id === "element_1")!.visible).toBe(false);

    fireEvent.click(action(m["composition.lock"]()));
    expect(elements().find((e) => e.id === "element_1")!.locked).toBe(true);
    for (const name of [m["composition.move_up"](), m["composition.move_down"](), m["composition.edit"](), m["composition.remove"]()]) {
      expect(action(name).disabled).toBe(true);
    }
    fireEvent.click(action(m["composition.unlock"]()));
    expect(action(m["composition.remove"]()).disabled).toBe(false);
  });

  it("deletes only after the confirmation", () => {
    useMazeStore.getState().addCompositionElement("test_text");
    render(<CompositionPanel />);
    const elements = () => useMazeStore.getState().compositions[0].elements;
    fireEvent.click(screen.getByRole("button", { name: m["composition.remove"]() }));
    expect(elements()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(elements()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: m["composition.remove"]() }));
    fireEvent.click(screen.getByRole("button", { name: m["common.ok"]() }));
    expect(elements()).toHaveLength(0);
  });
});
