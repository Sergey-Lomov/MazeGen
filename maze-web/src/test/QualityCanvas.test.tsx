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

  it("selecting the issue derived from the active check shows issue detail", () => {
    render(<QualityCanvas />);
    fireEvent.click(screen.getByText("i1"));
    expect(screen.getByText("Detected by")).toBeInTheDocument();
    expect(screen.getAllByText("Check One").length).toBeGreaterThan(0);
  });
});
