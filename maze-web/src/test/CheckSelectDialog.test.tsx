import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CheckSelectDialog } from "../components/features/CheckSelectDialog";
import { useMazeStore } from "../store/mazeStore";

const availableChecks = [
  { id: "min_loops_count", label: "Minimum loop count", description: "Fires if too few loops.", issue_kinds: ["missing_loops"], params: [], allow_multiple_instances: false },
  { id: "min_loop_length", label: "Minimum loop length", description: "Fires if a loop is too short.", issue_kinds: ["invalid_loop"], params: [], allow_multiple_instances: false },
  { id: "max_loop_length", label: "Maximum loop length", description: "Fires if a loop is too long.", issue_kinds: ["invalid_loop"], params: [], allow_multiple_instances: false },
];

beforeEach(() => {
  useMazeStore.setState({ availableChecks, rules: [] });
});

describe("CheckSelectDialog", () => {
  it("only lists checks of the given issue kind", () => {
    render(<CheckSelectDialog kind="invalid_loop" onBack={vi.fn()} onNext={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Minimum loop length")).toBeInTheDocument();
    expect(screen.getByText("Maximum loop length")).toBeInTheDocument();
    expect(screen.queryByText("Minimum loop count")).not.toBeInTheDocument();
  });

  it("Next is disabled until at least one check is toggled on", () => {
    render(<CheckSelectDialog kind="invalid_loop" onBack={vi.fn()} onNext={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Next")).toBeDisabled();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByText("Next")).not.toBeDisabled();
  });

  it("Next hands the toggled-on check ids to onNext, without touching the store", () => {
    const onNext = vi.fn();
    render(<CheckSelectDialog kind="invalid_loop" onBack={vi.fn()} onNext={onNext} onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByText("Next"));
    expect(onNext).toHaveBeenCalledWith(["min_loop_length", "max_loop_length"], {});
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("Cancel closes without modifying the store", () => {
    const onClose = vi.fn();
    render(<CheckSelectDialog kind="invalid_loop" onBack={vi.fn()} onNext={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("Back calls onBack instead of onClose", () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(<CheckSelectDialog kind="invalid_loop" onBack={onBack} onNext={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
