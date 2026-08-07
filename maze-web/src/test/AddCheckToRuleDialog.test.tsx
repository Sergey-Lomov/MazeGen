import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddCheckToRuleDialog } from "../components/features/AddCheckToRuleDialog";
import { useMazeStore } from "../store/mazeStore";
import type { CheckCandidateVM } from "../components/features/AddCheckToRuleDialog";

const candidates: CheckCandidateVM[] = [
  { typeId: "c1", label: "Check One", description: "First check.", params: [] },
  { typeId: "c2", label: "Check Two", description: "Second check.", params: [] },
];

beforeEach(() => {
  useMazeStore.setState({ rules: [] });
});

describe("AddCheckToRuleDialog", () => {
  it("titles the dialog with the rule's issue kind", () => {
    render(<AddCheckToRuleDialog ruleId="g1" kind="invalid_loop" candidates={candidates} onClose={vi.fn()} />);
    expect(screen.getByText(/Add check:/)).toBeInTheDocument();
  });

  it("lists every candidate and selects the first by default", () => {
    render(<AddCheckToRuleDialog ruleId="g1" kind="invalid_loop" candidates={candidates} onClose={vi.fn()} />);
    expect(screen.getByText("Check One")).toBeInTheDocument();
    expect(screen.getByText("Check Two")).toBeInTheDocument();
    expect(screen.getByText("First check.")).toBeInTheDocument();
  });

  it("shows the no-candidates empty state when given an empty list", () => {
    render(<AddCheckToRuleDialog ruleId="g1" kind="invalid_loop" candidates={[]} onClose={vi.fn()} />);
    expect(screen.getByText("No check selected.")).toBeInTheDocument();
  });

  it("switches description on candidate click", () => {
    render(<AddCheckToRuleDialog ruleId="g1" kind="invalid_loop" candidates={candidates} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Check Two"));
    expect(screen.getByText("Second check.")).toBeInTheDocument();
  });

  it("activates the selected check directly into the target rule on Add", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "invalid_loop", checks: [{ localId: 0, typeId: "existing", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [] }],
      availableChecks: [
        { id: "existing", label: "Existing", description: "", issue_kinds: ["invalid_loop"], params: [], allow_multiple_instances: false },
        { id: "c2", label: "Check Two", description: "Second check.", issue_kinds: ["invalid_loop"], params: [], allow_multiple_instances: false },
      ],
    });
    const onClose = vi.fn();
    render(<AddCheckToRuleDialog ruleId="g1" kind="invalid_loop" candidates={candidates} onClose={onClose} />);
    fireEvent.click(screen.getByText("Check Two"));
    fireEvent.click(screen.getByText("Add"));
    expect(useMazeStore.getState().rules[0].checks).toEqual([
      { localId: 0, typeId: "existing", params: {}, disabled: false },
      { localId: 1, typeId: "c2", params: {}, disabled: false },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("Cancel closes without modifying the store", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "invalid_loop", checks: [{ localId: 0, typeId: "existing", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [] }],
    });
    const onClose = vi.fn();
    render(<AddCheckToRuleDialog ruleId="g1" kind="invalid_loop" candidates={candidates} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(useMazeStore.getState().rules[0].checks).toEqual([{ localId: 0, typeId: "existing", params: {}, disabled: false }]);
  });
});
