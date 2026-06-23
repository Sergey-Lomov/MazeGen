import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QualityCanvas } from "../components/features/QualityCanvas";
import { useMazeStore } from "../store/mazeStore";
import type { CheckDescriptor } from "../wasm/types";

vi.mock("../components/features/CheckSelectDialog", () => ({
  CheckSelectDialog: () => <div data-testid="check-select-dialog" />,
}));
vi.mock("../components/features/StrategySelectDialog", () => ({
  StrategySelectDialog: () => <div data-testid="strategy-select-dialog" />,
}));

const checkDescriptor: CheckDescriptor = {
  id: "c1",
  label: "Check One",
  description: "Check One description",
  issue_kinds: ["i1"],
  params: [],
};

beforeEach(() => {
  useMazeStore.setState({
    availableChecks: [checkDescriptor],
    selectedChecks: ["c1"],
    availableStrategies: [],
    selectedStrategies: {},
    disabledStrategies: {},
    checkParams: {},
    strategyParams: {},
  } as Partial<ReturnType<typeof useMazeStore.getState>>);
});

describe("QualityCanvas", () => {
  it("shows placeholder detail by default", () => {
    render(<QualityCanvas />);
    expect(screen.getByText("Select an item to view details")).toBeInTheDocument();
  });

  it("selecting a check shows its detail", () => {
    render(<QualityCanvas />);
    fireEvent.click(screen.getByText("Check One"));
    expect(screen.getByText("Check One description")).toBeInTheDocument();
  });

  it("renders one strategy slot, not duplicated, when two active checks share a kind", () => {
    const checkB: CheckDescriptor = { id: "c2", label: "Check Two", description: "", issue_kinds: ["i1"], params: [] };
    useMazeStore.setState({
      availableChecks: [checkDescriptor, checkB],
      selectedChecks: ["c1", "c2"],
    } as Partial<ReturnType<typeof useMazeStore.getState>>);
    render(<QualityCanvas />);
    expect(screen.getAllByText("Do not fix")).toHaveLength(1);
  });
});
