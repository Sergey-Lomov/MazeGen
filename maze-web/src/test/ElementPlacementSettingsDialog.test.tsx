import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ElementPlacementSettingsDialog, elementPlacementDialogWidth } from "../components/dialogs/ElementPlacementSettingsDialog";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

describe("ElementPlacementSettingsDialog", () => {
  beforeEach(() => {
    useMazeStore.setState({
      elementsConfig: { one_way_chance: 0, teleport_chance: 0, teleport_one_way_chance: 0, split_chance: 0 },
    });
  });

  it("uses switches and hides vertical elements on a single floor", () => {
    render(<ElementPlacementSettingsDialog cellTypes={["square"]} multiFloor={false} onClose={() => {}} />);

    expect(screen.getByText(m["generation.cell_type.square"]())).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: `${m["generation.element.start"]()} ${m["generation.cell_type.square"]()}` })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: `${m["generation.element.finish"]()} ${m["generation.cell_type.square"]()}` })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    expect(screen.queryByText(m["generation.element.vertical_passage"]())).not.toBeInTheDocument();
    expect(screen.queryByText(m["generation.element.elevator"]())).not.toBeInTheDocument();
    const enableAll = screen.getByRole("button", { name: m["generation.enable_all"]() });
    const disableAll = screen.getByRole("button", { name: m["generation.disable_all"]() });
    expect(enableAll.closest("tfoot")).not.toBeNull();
    expect(enableAll.parentElement).toBe(disableAll.parentElement);
    expect(enableAll.parentElement).toHaveStyle({ display: "inline-flex", alignItems: "stretch" });
  });

  it("widens for every cell-type column while staying within the viewport", () => {
    render(<ElementPlacementSettingsDialog cellTypes={["triangle", "square", "dodecagon"]} multiFloor={false} onClose={() => {}} />);

    const modal = screen.getByText(m["generation.element_placement_title"]()).parentElement?.parentElement;
    expect(modal).toHaveStyle({
      width: `${elementPlacementDialogWidth(3)}px`,
      maxWidth: "calc(100vw - 32px)",
    });
  });

  it("shows vertical passages and elevators for multiple floors", () => {
    render(<ElementPlacementSettingsDialog cellTypes={["square"]} multiFloor onClose={() => {}} />);

    expect(screen.getByRole("checkbox", { name: `${m["generation.element.vertical_passage"]()} ${m["generation.cell_type.square"]()}` })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: `${m["generation.element.elevator"]()} ${m["generation.cell_type.square"]()}` })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
  });

  it("warns when an element has no allowed cell type", () => {
    useMazeStore.setState({
      elementsConfig: {
        one_way_chance: 0,
        teleport_chance: 0,
        teleport_one_way_chance: 0,
        split_chance: 0,
        cell_type_restrictions: { start: { square: false } },
      },
    });
    render(<ElementPlacementSettingsDialog cellTypes={["square"]} multiFloor={false} onClose={() => {}} />);

    expect(screen.getByText(m["generation.element_placement_no_allowed_cells"]({
      elements: m["generation.element.start"](),
    }))).toBeInTheDocument();
  });

  it("keeps settings as a draft until confirmed", () => {
    const onClose = vi.fn();
    render(<ElementPlacementSettingsDialog cellTypes={["square"]} multiFloor={false} onClose={onClose} />);

    fireEvent.click(screen.getByRole("checkbox", { name: `${m["generation.element.start"]()} ${m["generation.cell_type.square"]()}` }));
    expect(useMazeStore.getState().elementsConfig.cell_type_restrictions).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(useMazeStore.getState().elementsConfig.cell_type_restrictions).toBeUndefined();
  });

  it("applies draft settings when confirmed", () => {
    render(<ElementPlacementSettingsDialog cellTypes={["square"]} multiFloor={false} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("checkbox", { name: `${m["generation.element.start"]()} ${m["generation.cell_type.square"]()}` }));
    fireEvent.click(screen.getByRole("button", { name: m["common.confirm"]() }));

    expect(useMazeStore.getState().elementsConfig.cell_type_restrictions).toEqual({ start: { square: false } });
  });
});
