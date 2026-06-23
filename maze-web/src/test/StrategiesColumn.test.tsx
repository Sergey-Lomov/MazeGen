import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StrategiesColumn } from "../components/features/quality/StrategiesColumn";
import { useMazeStore } from "../store/mazeStore";
import type { StrategySlotVM, StrategyVM, CheckVM } from "../components/features/useQualityViewModel";

vi.mock("../components/features/StrategySelectDialog", () => ({
  StrategySelectDialog: ({ issueId, onClose }: { issueId: string; onClose: () => void }) => (
    <div data-testid="strategy-select-dialog">
      {issueId}
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

const strategy: StrategyVM = { id: "s1", label: "Strategy One", handles: "k1", params: [] };
const checkA: CheckVM = { id: "c1", label: "Check One", description: "", params: [] };
const checkB: CheckVM = { id: "c2", label: "Check Two", description: "", params: [] };

beforeEach(() => {
  useMazeStore.setState({ disabledStrategies: {} });
});

describe("StrategiesColumn", () => {
  it("renders one slot per kind, with no-fix label when no strategy assigned", () => {
    const slots: StrategySlotVM[] = [{ kind: "k1", label: "Kind One", strategy: null, disabled: false, producedBy: [checkA] }];
    render(<StrategiesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Do not fix")).toBeInTheDocument();
  });

  it("shows strategy label when slot has a strategy", () => {
    const slots: StrategySlotVM[] = [{ kind: "k1", label: "Kind One", strategy, disabled: false, producedBy: [checkA] }];
    render(<StrategiesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("renders the shared kind as a single slot, not duplicated per producing check", () => {
    const slots: StrategySlotVM[] = [{ kind: "k1", label: "Kind One", strategy, disabled: false, producedBy: [checkA, checkB] }];
    render(<StrategiesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.getAllByText("Strategy One")).toHaveLength(1);
  });

  it("calls onSelect with strategy selection on slot click when strategy exists", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ kind: "k1", label: "Kind One", strategy, disabled: false, producedBy: [checkA] }];
    render(<StrategiesColumn slots={slots} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Strategy One"));
    expect(onSelect).toHaveBeenCalledWith({ type: "strategy", issueId: "k1", strategyId: "s1" });
  });

  it("does not call onSelect on slot click when no strategy", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ kind: "k1", label: "Kind One", strategy: null, disabled: false, producedBy: [checkA] }];
    render(<StrategiesColumn slots={slots} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Do not fix"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens strategy dialog via edit button", () => {
    const slots: StrategySlotVM[] = [{ kind: "k1", label: "Kind One", strategy, disabled: false, producedBy: [checkA] }];
    render(<StrategiesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("strategy-select-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit strategy", { exact: false }));
    expect(screen.getByTestId("strategy-select-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("strategy-select-dialog")).not.toBeInTheDocument();
  });

  it("toggles strategy disabled state via toggle button, keeping selection intact", () => {
    const slots: StrategySlotVM[] = [{ kind: "k1", label: "Kind One", strategy, disabled: false, producedBy: [checkA] }];
    render(<StrategiesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(useMazeStore.getState().disabledStrategies.k1).toBe(true);
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("does not render toggle switch when slot has no strategy", () => {
    const slots: StrategySlotVM[] = [{ kind: "k1", label: "Kind One", strategy: null, disabled: false, producedBy: [checkA] }];
    render(<StrategiesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows empty hint when no slots", () => {
    render(<StrategiesColumn slots={[]} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByText("Do not fix")).not.toBeInTheDocument();
  });
});
