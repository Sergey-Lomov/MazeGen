import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StrategySelectDialog } from "../components/features/StrategySelectDialog";
import { useMazeStore } from "../store/mazeStore";

const availableStrategies = [
  { id: "random_endpoints", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [] },
  { id: "farthest_endpoints", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [] },
  { id: "invalid_loop_random", handles: "invalid_loop", params: [], experimental: false, nested_slots: [] },
];

beforeEach(() => {
  useMazeStore.setState({
    availableStrategies,
    rules: [{ id: "g1", name: "Rule 1", kind: "missing_endpoints", checks: [{ localId: 0, typeId: "missing_endpoints", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "random_endpoints", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    strategyParams: {},
  });
});

describe("StrategySelectDialog", () => {
  it("only lists strategies handling the given kind, plus no_fix", () => {
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
    expect(screen.getByText("Random endpoints")).toBeInTheDocument();
    expect(screen.getByText("Farthest endpoints")).toBeInTheDocument();
    expect(screen.queryByText("Random invalid loop break")).not.toBeInTheDocument();
  });

  it("preselects the rule's current strategy", () => {
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Select"));
    expect(useMazeStore.getState().rules[0].strategyId).toBe("random_endpoints");
  });

  it("selecting a different strategy and confirming calls setStrategy", () => {
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Farthest endpoints"));
    fireEvent.click(screen.getByText("Select"));
    expect(useMazeStore.getState().rules[0].strategyId).toBe("farthest_endpoints");
  });

  it("selecting no_fix and confirming calls clearStrategy", () => {
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Logging"));
    fireEvent.click(screen.getByText("Select"));
    expect(useMazeStore.getState().rules[0].strategyId).toBeNull();
  });

  it("Cancel closes without modifying the store", () => {
    const onClose = vi.fn();
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={onClose} />);
    fireEvent.click(screen.getByText("Farthest endpoints"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(useMazeStore.getState().rules[0].strategyId).toBe("random_endpoints");
  });
});
