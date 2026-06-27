import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewRuleStrategyDialog } from "../components/features/NewRuleStrategyDialog";
import { useMazeStore } from "../store/mazeStore";

const availableStrategies = [
  { id: "s1", handles: "k1", params: [] },
  { id: "s2", handles: "k1", params: [] },
  { id: "s3", handles: "k2", params: [] },
];

const endpointStrategies = [
  { id: "random_endpoints", handles: "missing_endpoints", params: [] },
  { id: "farthest_endpoints", handles: "missing_endpoints", params: [] },
  { id: "scored_endpoints", handles: "missing_endpoints", params: [] },
];

beforeEach(() => {
  useMazeStore.setState({ availableStrategies });
});

describe("NewRuleStrategyDialog", () => {
  it("lists no_fix plus only strategies handling the given kind", () => {
    render(<NewRuleStrategyDialog kind="k1" onBack={vi.fn()} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("s1")).toBeInTheDocument();
    expect(screen.getByText("s2")).toBeInTheDocument();
    expect(screen.queryByText("s3")).not.toBeInTheDocument();
  });

  it("confirms with strategyId null for no_fix", () => {
    const onConfirm = vi.fn();
    render(<NewRuleStrategyDialog kind="k1" onBack={vi.fn()} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Logging"));
    fireEvent.click(screen.getByText("Add"));
    expect(onConfirm).toHaveBeenCalledWith(null, undefined);
  });

  it("confirms with the picked strategy id", () => {
    const onConfirm = vi.fn();
    render(<NewRuleStrategyDialog kind="k1" onBack={vi.fn()} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("s2"));
    fireEvent.click(screen.getByText("Add"));
    expect(onConfirm).toHaveBeenCalledWith("s2", undefined);
  });

  it("Back calls onBack instead of onClose", () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(<NewRuleStrategyDialog kind="k1" onBack={onBack} onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("defaults the selection to scored_endpoints for the missing_endpoints kind", () => {
    useMazeStore.setState({ availableStrategies: endpointStrategies });
    const onConfirm = vi.fn();
    render(<NewRuleStrategyDialog kind="missing_endpoints" onBack={vi.fn()} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Add"));
    expect(onConfirm).toHaveBeenCalledWith("scored_endpoints", undefined);
  });

  it("Cancel closes without calling onConfirm", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<NewRuleStrategyDialog kind="k1" onBack={vi.fn()} onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
