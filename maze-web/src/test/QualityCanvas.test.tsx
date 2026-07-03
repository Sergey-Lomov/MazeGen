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
  allow_multiple_instances: false,
};

beforeEach(() => {
  useMazeStore.setState({
    availableChecks: [checkDescriptor],
    availableStrategies: [],
    rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false }],
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

  it("renders one strategy slot, not duplicated, when two active checks are merged into one rule", () => {
    const checkB: CheckDescriptor = { id: "c2", label: "Check Two", description: "", issue_kinds: ["i1"], params: [], allow_multiple_instances: false };
    useMazeStore.setState({
      availableChecks: [checkDescriptor, checkB],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }, { localId: 1, typeId: "c2", params: {} }], nextLocalCheckId: 2, strategyId: null, disabled: false, ruleDisabled: false }],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1"], disabled: false }],
    } as Partial<ReturnType<typeof useMazeStore.getState>>);
    render(<QualityCanvas />);
    expect(screen.getAllByText("Logging")).toHaveLength(1);
  });

  it("renders two strategy slots when two active checks of the same kind are in separate rules", () => {
    const checkB: CheckDescriptor = { id: "c2", label: "Check Two", description: "", issue_kinds: ["i1"], params: [], allow_multiple_instances: false };
    useMazeStore.setState({
      availableChecks: [checkDescriptor, checkB],
      rules: [
        { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false },
        { id: "g2", name: "Rule 2", kind: "k1", checks: [{ localId: 0, typeId: "c2", params: {} }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false },
      ],
      stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["g1", "g2"], disabled: false }],
    } as Partial<ReturnType<typeof useMazeStore.getState>>);
    render(<QualityCanvas />);
    expect(screen.getAllByText("Logging")).toHaveLength(2);
  });
});
