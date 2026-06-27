import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CheckSelectDialog } from "../components/features/CheckSelectDialog";
import { useMazeStore } from "../store/mazeStore";

const availableChecks = [
  { id: "missing_endpoints", label: "Missing endpoints", description: "Fires if no start/finish.", issue_kinds: ["missing_endpoints"], params: [] },
  { id: "min_loops_count", label: "Minimum loop count", description: "Fires if too few loops.", issue_kinds: ["missing_loops"], params: [] },
];

beforeEach(() => {
  useMazeStore.setState({ availableChecks, selectedChecks: [], checkParams: {} });
});

describe("CheckSelectDialog", () => {
  it("has a static title that does not depend on the current selection", () => {
    render(<CheckSelectDialog onClose={vi.fn()} />);
    expect(screen.getByText("Select initial check for new rule")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Minimum loop count"));
    expect(screen.getByText("Select initial check for new rule")).toBeInTheDocument();
  });

  it("lists every available check, not just unselected ones", () => {
    useMazeStore.setState({ selectedChecks: ["missing_endpoints"] });
    render(<CheckSelectDialog onClose={vi.fn()} />);
    expect(screen.getByText("Start and finish present")).toBeInTheDocument();
    expect(screen.getByText("Minimum loop count")).toBeInTheDocument();
  });

  it("disables Add and shows the already-active warning for an already-selected check", () => {
    useMazeStore.setState({ selectedChecks: ["missing_endpoints"] });
    render(<CheckSelectDialog onClose={vi.fn()} />);
    expect(screen.getByText("Cannot add two checks of this type")).toBeInTheDocument();
    expect(screen.getByText("Add")).toBeDisabled();
  });

  it("adding a check always creates a new rule (no ruleId passed)", () => {
    const onClose = vi.fn();
    render(<CheckSelectDialog onClose={onClose} />);
    fireEvent.click(screen.getByText("Minimum loop count"));
    fireEvent.click(screen.getByText("Add"));
    expect(useMazeStore.getState().selectedChecks).toEqual(["min_loops_count"]);
    expect(useMazeStore.getState().rules).toHaveLength(1);
    expect(useMazeStore.getState().rules[0].checks).toEqual(["min_loops_count"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("Cancel closes without modifying the store", () => {
    const onClose = vi.fn();
    render(<CheckSelectDialog onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(useMazeStore.getState().selectedChecks).toEqual([]);
  });
});
