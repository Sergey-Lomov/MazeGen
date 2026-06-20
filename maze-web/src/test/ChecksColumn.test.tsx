import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChecksColumn } from "../components/features/quality/ChecksColumn";
import { useMazeStore } from "../store/mazeStore";
import type { CheckVM } from "../components/features/useQualityViewModel";

vi.mock("../components/features/CheckSelectDialog", () => ({
  CheckSelectDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="check-select-dialog">
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

const checks: CheckVM[] = [
  { id: "c1", label: "Check One", description: "", params: [] },
  { id: "c2", label: "Check Two", description: "", params: [] },
];

beforeEach(() => {
  useMazeStore.setState({ selectedChecks: ["c1", "c2"] } as Partial<ReturnType<typeof useMazeStore.getState>>);
});

describe("ChecksColumn", () => {
  it("renders all checks", () => {
    render(<ChecksColumn checks={checks} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Check One")).toBeInTheDocument();
    expect(screen.getByText("Check Two")).toBeInTheDocument();
  });

  it("shows empty hint when no checks", () => {
    render(<ChecksColumn checks={[]} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByText("Check One")).not.toBeInTheDocument();
  });

  it("calls onSelect with check selection on card click", () => {
    const onSelect = vi.fn();
    render(<ChecksColumn checks={checks} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Check One"));
    expect(onSelect).toHaveBeenCalledWith({ type: "check", id: "c1" });
  });

  it("removes a check and clears selection if it was selected", () => {
    const onSelect = vi.fn();
    render(
      <ChecksColumn
        checks={checks}
        selection={{ type: "check", id: "c1" }}
        onSelect={onSelect}
      />
    );
    const removeButtons = screen.getAllByTitle("Remove", { exact: false });
    fireEvent.click(removeButtons[0]);
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(useMazeStore.getState().selectedChecks).toEqual(["c2"]);
  });

  it("opens and closes the add-check dialog", () => {
    render(<ChecksColumn checks={checks} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Add check", { exact: false }));
    expect(screen.getByTestId("check-select-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
  });
});
