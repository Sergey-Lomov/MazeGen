import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as m from "~/paraglide/messages";
import { ElevatorFloorPicker, type ElevatorFloorRow } from "../components/dialogs/ElevatorFloorPicker";
import { EntityChoiceDialog } from "../components/dialogs/EntityChoiceDialog";
import { SplitTargetPicker, numberToCssColor, shownSplitTargets } from "../components/dialogs/SplitTargetPicker";
import { VerticalDirectionPicker } from "../components/dialogs/VerticalDirectionPicker";
import { ToolIconRow } from "../components/ToolIconRow";

vi.mock("../components/features/ToolGlyph", () => ({
  ToolGlyph: ({ tool }: { tool: string }) => <span data-testid={`glyph-${tool}`} />,
}));

const rows: ElevatorFloorRow[] = [
  { key: "floor-1", index: 0, label: "1: Ground", status: "current", statusLabel: "Current", checked: true },
  { key: "floor-2", index: 1, label: "2: Upper", status: "available", statusLabel: "Available", checked: false },
  { key: "floor-3", index: 2, label: "3: Missing", status: "no_cell", statusLabel: "No cell", checked: false },
];

describe("shared preset/post-edit dialog components", () => {
  it("keeps elevator confirmation disabled below the minimum and disables missing floors", () => {
    const onConfirm = vi.fn();
    const onToggle = vi.fn();
    render(
      <ElevatorFloorPicker
        title="Elevator"
        hint="Choose floors"
        rows={rows}
        selectedFloorCount={1}
        onToggle={(row) => onToggle(row.index)}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: m["common.confirm"]() })).toBeDisabled();
    expect(screen.getAllByRole("checkbox")[2]).toBeDisabled();
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(onToggle).toHaveBeenCalledWith(1);
  });

  it("renders the shared entity layout and routes row/delete-all actions", () => {
    const onSelect = vi.fn();
    const onDeleteAll = vi.fn();
    const row = { key: "teleport:1", title: "Teleport", bubbles: ["L2 x:3 y:4"], entityId: 1 };
    render(
      <EntityChoiceDialog
        title="Entities"
        hint="Choose one"
        rows={[row]}
        deleteAllLabel="Delete all"
        onSelect={onSelect}
        onDeleteAll={onDeleteAll}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Teleport/ }));
    expect(onSelect).toHaveBeenCalledWith(row);
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(onDeleteAll).toHaveBeenCalledOnce();
  });

  it("formats packed colors for split-target dots", () => {
    expect(numberToCssColor(0x0a1b2c)).toBe("#0a1b2c");
  });

  it("leaves out an excluded split node but keeps every other node's own index (GitHub issue #748)", () => {
    expect(shownSplitTargets([undefined, 0, 1], (slotId) => slotId === 0)).toEqual([
      { node: undefined, index: 0 },
      { node: 1, index: 2 },
    ]);
    expect(shownSplitTargets([7, 9], () => false)).toEqual([{ node: 7, index: 0 }, { node: 9, index: 1 }]);
  });

  it("routes split-target selection and cancellation while keeping the preview slot", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const option = { key: "node-1", color: "#123456", label: "Node 1" };
    render(
      <SplitTargetPicker
        title="Target"
        hint="Choose a node"
        options={[option]}
        preview={<span>Preview</span>}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Node 1/ }));
    expect(onSelect).toHaveBeenCalledWith(option);
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("routes both vertical directions through the shared picker", () => {
    const onSelect = vi.fn();
    render(<VerticalDirectionPicker title="Direction" onSelect={onSelect} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: m["preset.vertical_direction_up"]() }));
    fireEvent.click(screen.getByRole("button", { name: m["preset.vertical_direction_down"]() }));
    expect(onSelect.mock.calls.map(([direction]) => direction)).toEqual(["up", "down"]);
  });

  it("keeps generic tool glyph mapping and destructive selection in the shared row", () => {
    const onPick = vi.fn();
    render(
      <ToolIconRow
        tools={[["wall", "Wall"], ["delete", "Delete"]]}
        activeTool="delete"
        onPick={onPick}
        glyphFor={(tool) => tool === "delete" ? "delete" : "wall"}
        isDanger={(tool) => tool === "delete"}
      />,
    );

    expect(screen.getByTestId("glyph-wall")).toBeInTheDocument();
    expect(screen.getByTestId("glyph-delete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("btn-tool-icon-selected-danger");
    fireEvent.click(screen.getByRole("button", { name: "Wall" }));
    expect(onPick).toHaveBeenCalledWith("wall");
  });

});
