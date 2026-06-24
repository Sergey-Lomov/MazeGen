import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RulesColumn } from "../components/features/quality/RulesColumn";
import { useMazeStore } from "../store/mazeStore";
import type { StrategySlotVM, StrategyVM, CheckVM } from "../components/features/useQualityViewModel";

vi.mock("../components/features/CheckSelectDialog", () => ({
  CheckSelectDialog: () => <div data-testid="check-select-dialog" />,
}));
vi.mock("../components/features/StrategySelectDialog", () => ({
  StrategySelectDialog: ({ ruleId, onClose }: { ruleId: string; onClose: () => void }) => (
    <div data-testid="strategy-select-dialog">
      {ruleId}
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

const strategy: StrategyVM = { id: "s1", label: "Strategy One", handles: "k1", params: [] };
const strategyWithParams: StrategyVM = {
  id: "s2",
  label: "Strategy Two",
  handles: "k1",
  params: [{ id: "weight", label: "Weight", kind: { type: "float", default: 1, min: 0, max: 10 } }],
};
const checkA: CheckVM = { id: "c1", label: "Check One", description: "", params: [] };
const checkB: CheckVM = { id: "c2", label: "Check Two", description: "", params: [] };
const checkWithParams: CheckVM = {
  id: "c1",
  label: "Check One",
  description: "",
  params: [{ id: "threshold", label: "Threshold", kind: { type: "float", default: 1, min: 0, max: 10 } }],
};

beforeEach(() => {
  useMazeStore.setState({ rules: [], availableChecks: [], selectedChecks: [] });
});

describe("RulesColumn", () => {
  it("renders one card per rule, with no-fix label when no strategy assigned", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: null, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Logging")).toBeInTheDocument();
  });

  it("shows strategy label when rule has a strategy", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("renders both member checks nested under one rule card", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA, checkB] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.getAllByText("Strategy One")).toHaveLength(1);
    expect(screen.getByText("Check One")).toBeInTheDocument();
    expect(screen.getByText("Check Two")).toBeInTheDocument();
  });

  it("calls onSelect with strategy selection on header click when strategy exists", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Strategy One"));
    expect(onSelect).toHaveBeenCalledWith({ type: "strategy", ruleId: "g1", strategyId: "s1" });
  });

  it("calls onSelect with logging selection on header click when no strategy", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: null, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Logging"));
    expect(onSelect).toHaveBeenCalledWith({ type: "logging", ruleId: "g1" });
  });

  it("calls onSelect with check selection on a member-check row click", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Check One"));
    expect(onSelect).toHaveBeenCalledWith({ type: "check", id: "c1" });
  });

  it("removing a check clears its selection, calls store removeCheck, and leaves the empty rule in place", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={{ type: "check", id: "c1" }} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Remove"));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(useMazeStore.getState().rules).toEqual([{ id: "g1", name: "Rule 1", kind: "k1", checks: [], strategyId: "s1", disabled: false, ruleDisabled: false }]);
  });

  it("renders check params inline and commits changes to the store", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }],
      checkParams: {},
    });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkWithParams] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    vi.runAllTimers();
    expect(useMazeStore.getState().checkParams.c1?.threshold).toBe("7");
    vi.useRealTimers();
  });

  it("flushes a pending check-param edit before removing the check, instead of dropping it", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }],
      checkParams: {},
    });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkWithParams] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    // Remove immediately, well inside the 300ms debounce window — no vi.runAllTimers() here.
    fireEvent.click(screen.getByTitle("Remove"));
    expect(useMazeStore.getState().checkParams.c1?.threshold).toBe("7");
    vi.useRealTimers();
  });

  it("flushes a pending check-param edit before changing selection, instead of dropping it", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }],
      checkParams: {},
    });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkWithParams] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={onSelect} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.click(screen.getByText("Check One"));
    expect(useMazeStore.getState().checkParams.c1?.threshold).toBe("7");
    vi.useRealTimers();
  });

  it("flushes a pending strategy-param edit before opening the strategy edit dialog", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s2", disabled: false, ruleDisabled: false }],
      strategyParams: {},
    });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: strategyWithParams, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByTitle("Edit strategy", { exact: false }));
    expect(useMazeStore.getState().strategyParams.s2?.weight).toBe("5");
    vi.useRealTimers();
  });

  it("opens strategy dialog via edit button", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("strategy-select-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit strategy", { exact: false }));
    expect(screen.getByTestId("strategy-select-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("strategy-select-dialog")).not.toBeInTheDocument();
  });

  it("toggles strategy disabled state via the strategy-panel toggle, keeping selection intact", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    // Two switches now: card-level ruleDisabled (first) and strategy-only disabled (second).
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.disabled).toBe(true);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(false);
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("toggles ruleDisabled via the card-level toggle, independent from the strategy toggle", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(true);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.disabled).toBe(false);
  });

  it("renders strategy params inline and commits changes to the store", () => {
    vi.useFakeTimers();
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s2", disabled: false, ruleDisabled: false }], strategyParams: {} });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: strategyWithParams, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    vi.runAllTimers();
    expect(useMazeStore.getState().strategyParams.s2?.weight).toBe("5");
    vi.useRealTimers();
  });

  it("renders only the card-level toggle (not a strategy toggle) when rule has no strategy", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: null, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("shows empty hint when no rules", () => {
    render(<RulesColumn slots={[]} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByText("Logging")).not.toBeInTheDocument();
  });

  it("opens the top-level add-check dialog via the bottom add-new-rule button", () => {
    render(<RulesColumn slots={[]} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Add new rule"));
    expect(screen.getByTestId("check-select-dialog")).toBeInTheDocument();
  });

  it("opens the add-to-rule dialog with not-yet-active checks of the same kind as candidates", () => {
    useMazeStore.setState({
      availableChecks: [
        { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] },
        { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [] },
      ],
      selectedChecks: ["c1"],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }],
    });
    const slots: StrategySlotVM[] = [
      { ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] },
    ];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    expect(screen.getByText("Check Two")).toBeInTheDocument();
  });

  it("activates the chosen candidate directly into the target rule, not a new one", () => {
    useMazeStore.setState({
      availableChecks: [
        { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] },
        { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [] },
      ],
      selectedChecks: ["c1"],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }],
    });
    const slots: StrategySlotVM[] = [
      { ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] },
    ];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    fireEvent.click(screen.getByText("Check Two"));
    fireEvent.click(screen.getByText("Add"));
    expect(useMazeStore.getState().selectedChecks).toEqual(["c1", "c2"]);
    expect(useMazeStore.getState().rules).toEqual([
      { id: "g1", name: "Rule 1", kind: "k1", checks: ["c1", "c2"], strategyId: "s1", disabled: false, ruleDisabled: false },
    ]);
  });

  it("shows an alert instead of an empty picker when no candidate checks are available", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    expect(screen.getByText("All checks producing this issue kind are already in this rule.")).toBeInTheDocument();
  });

  it("toggles ruleDisabled and visually dims the card title row", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(true);
  });

  it("renames a rule via the edit button's inline input, committed on Enter", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Rename rule"));
    const input = screen.getByDisplayValue("Rule 1");
    fireEvent.change(input, { target: { value: "My rule" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.name).toBe("My rule");
  });

  it("removes a rule via the X button after confirming, clearing strategy selection for it", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={{ type: "strategy", ruleId: "g1", strategyId: "s1" }} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Remove rule"));
    fireEvent.click(screen.getByText("Ok"));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("cancelling the remove-rule confirmation leaves the rule intact", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: ["c1"], strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Remove rule"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(useMazeStore.getState().rules).toHaveLength(1);
  });
});
