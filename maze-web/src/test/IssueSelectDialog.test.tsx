import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueSelectDialog } from "../components/features/IssueSelectDialog";
import { useMazeStore } from "../store/mazeStore";

const availableChecks = [
  { id: "min_loops_count", label: "Minimum loop count", description: "Fires if too few loops.", issue_kinds: ["missing_loops"], params: [], allow_multiple_instances: false },
  { id: "min_loop_length", label: "Minimum loop length", description: "Fires if a loop is too short.", issue_kinds: ["invalid_loop"], params: [], allow_multiple_instances: false },
  { id: "max_loop_length", label: "Maximum loop length", description: "Fires if a loop is too long.", issue_kinds: ["invalid_loop"], params: [], allow_multiple_instances: false },
];

beforeEach(() => {
  useMazeStore.setState({ availableChecks });
});

describe("IssueSelectDialog", () => {
  it("lists distinct issue kinds, not one per check, under section headers", () => {
    render(<IssueSelectDialog onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Loops")).toBeInTheDocument();
    expect(screen.getAllByText("Add")).toHaveLength(1);
    expect(screen.getAllByText("Validate")).toHaveLength(1);
  });

  it("calls onSelect with the chosen kind, not the store", () => {
    const onSelect = vi.fn();
    render(<IssueSelectDialog onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Validate"));
    fireEvent.click(screen.getByText("Select"));
    expect(onSelect).toHaveBeenCalledWith("invalid_loop");
  });

  it("Cancel closes without calling onSelect", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<IssueSelectDialog onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
