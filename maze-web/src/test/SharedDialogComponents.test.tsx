import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as m from "~/paraglide/messages";
import { ElevatorFloorPicker, type ElevatorFloorRow } from "../components/dialogs/ElevatorFloorPicker";
import { EntityChoiceDialog } from "../components/dialogs/EntityChoiceDialog";
import { numberToCssColor } from "../components/dialogs/SplitTargetPicker";

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
});
