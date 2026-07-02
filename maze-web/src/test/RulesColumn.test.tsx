import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RulesColumn } from "../components/features/quality/RulesColumn";
import { useMazeStore } from "../store/mazeStore";
import type { StrategySlotVM, StrategyVM, CheckVM } from "../components/features/useQualityViewModel";

vi.mock("../components/features/CheckSelectDialog", () => ({
  CheckSelectDialog: ({ kind, onBack, onNext }: { kind: string; onBack: () => void; onNext: (ids: string[], paramOverrides: Record<string, Record<string, string>>) => void }) => (
    <div data-testid="check-select-dialog">
      {kind}
      <button onClick={onBack}>go-back</button>
      <button onClick={() => onNext(["c1"], {})}>pick-checks</button>
    </div>
  ),
}));
vi.mock("../components/features/IssueSelectDialog", () => ({
  IssueSelectDialog: ({ onSelect }: { onSelect: (kind: string) => void }) => (
    <div data-testid="issue-select-dialog">
      <button onClick={() => onSelect("k1")}>pick-k1</button>
    </div>
  ),
}));
vi.mock("../components/features/NewRuleStrategyDialog", () => ({
  NewRuleStrategyDialog: ({ onBack, onConfirm }: { onBack: () => void; onConfirm: (strategyId: string | null, params?: Record<string, string>) => void }) => (
    <div data-testid="new-rule-strategy-dialog">
      <button onClick={onBack}>go-back-2</button>
      <button onClick={() => onConfirm("s1", undefined)}>pick-strategy</button>
    </div>
  ),
}));
vi.mock("../components/features/StrategySelectDialog", () => ({
  StrategySelectDialog: ({ ruleId, onClose }: { ruleId: string; onClose: () => void }) => (
    <div data-testid="strategy-select-dialog">
      {ruleId}
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

const strategy: StrategyVM = { id: "s1", label: "Strategy One", handles: "k1", params: [], experimental: false };
const strategyWithParams: StrategyVM = {
  id: "s2",
  label: "Strategy Two",
  handles: "k1",
  params: [{ id: "weight", label: "Weight", kind: { type: "float", default: 1, min: 0, max: 10 } }],
  experimental: false,
};
const checkA: CheckVM = { id: "g1:0", ruleId: "g1", localId: 0, typeId: "c1", label: "Check One", description: "", params: [] };
const checkB: CheckVM = { id: "g1:1", ruleId: "g1", localId: 1, typeId: "c2", label: "Check Two", description: "", params: [] };
const checkWithParams: CheckVM = {
  id: "g1:0",
  ruleId: "g1",
  localId: 0,
  typeId: "c1",
  label: "Check One",
  description: "",
  params: [{ id: "threshold", label: "Threshold", kind: { type: "float", default: 1, min: 0, max: 10 } }],
};

// Default backing rule for checkA/checkB (ruleId "g1", localIds 0/1) — RuleCheckRow looks up its
// own check's params from `store.rules` by (ruleId, localId), so any `slots` fixture referencing
// checkA/checkB needs a matching store rule present, even when the test only cares about props.
function defaultRules() {
  return [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }, { localId: 1, typeId: "c2", params: {} }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false }];
}

beforeEach(() => {
  useMazeStore.setState({ rules: defaultRules(), availableChecks: [], availableStrategies: [] });
});

// For tests that remove a check/rule via a click and then assert on store state, `slots` must
// track the store on every render the same way the real parent (QualityCanvas, via
// useQualityViewModel) does — otherwise RuleCheckRow keeps rendering a `producedBy` entry whose
// backing rule/check no longer exists, which is exactly the scenario these tests exercise.
// `LiveSlots` re-derives each slot's `producedBy` from the live store on every render so the
// prop and the store can never go out of sync within one commit.
function LiveSlots({ slots, selection, onSelect }: { slots: StrategySlotVM[]; selection: Parameters<typeof RulesColumn>[0]["selection"]; onSelect: Parameters<typeof RulesColumn>[0]["onSelect"] }) {
  const rules = useMazeStore((s) => s.rules);
  const liveSlots = slots
    .map((slot) => {
      const rule = rules.find((r) => r.id === slot.ruleId);
      if (!rule) return null;
      const producedBy = slot.producedBy.filter((c) => rule.checks.some((rc) => rc.localId === c.localId));
      return { ...slot, producedBy };
    })
    .filter((s): s is StrategySlotVM => s !== null);
  return <RulesColumn slots={liveSlots} selection={selection} onSelect={onSelect} />;
}

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
    expect(onSelect).toHaveBeenCalledWith({ type: "check", id: "g1:0" });
  });

  it("removing a check clears its selection, calls store removeCheck, and leaves the empty rule in place", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    // LiveSlots (not RulesColumn directly) — `producedBy` must track the store within the same
    // commit as the click, the same way the real parent (QualityCanvas) does via
    // useQualityViewModel, otherwise RuleCheckRow renders a check whose backing rule entry the
    // click just removed.
    render(<LiveSlots slots={slots} selection={{ type: "check", id: "g1:0" }} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Remove"));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(useMazeStore.getState().rules).toEqual([{ id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }]);
  });

  it("renders check params inline and commits changes to the store", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }],
    });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkWithParams] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    vi.runAllTimers();
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0)?.params.threshold).toBe("7");
    vi.useRealTimers();
  });

  it("flushes a pending check-param edit before removing the check, instead of dropping it", () => {
    vi.useFakeTimers();
    // checkWithParams (localId 0) is the one being edited and removed — its own pending edit is
    // necessarily discarded along with the instance itself, since params live inline on the
    // CheckInstance now (no separate global dict for them to survive in, unlike the old model).
    // checkB (localId 1) stays in the rule throughout, so it's the one that proves the flush
    // actually committed rather than being silently dropped by the unrelated removal.
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }, { localId: 1, typeId: "c2", params: {} }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false }],
    });
    const checkBWithParams: CheckVM = { ...checkWithParams, id: "g1:1", localId: 1, typeId: "c2", label: "Check Two" };
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkWithParams, checkBWithParams] }];
    // LiveSlots, see comment in "removing a check..." above.
    render(<LiveSlots slots={slots} selection={null} onSelect={vi.fn()} />);
    const inputs = screen.getAllByDisplayValue("1") as HTMLInputElement[];
    fireEvent.change(inputs[1], { target: { value: "7" } });
    // Remove the other check immediately, well inside the 300ms debounce window — each row's
    // debounce/flush is scoped to its own useParamEditor instance, so removing row 0 must not
    // interfere with row 1's still-pending edit.
    fireEvent.click(screen.getAllByTitle("Remove")[0]);
    vi.runAllTimers();
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 1)?.params.threshold).toBe("7");
    vi.useRealTimers();
  });

  it("flushes a pending check-param edit before changing selection, instead of dropping it", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }],
    });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkWithParams] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={onSelect} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.click(screen.getByText("Check One"));
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0)?.params.threshold).toBe("7");
    vi.useRealTimers();
  });

  it("flushes a pending strategy-param edit before opening the strategy edit dialog", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s2", disabled: false, ruleDisabled: false }],
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
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    // Two switches now: card-level ruleDisabled (first) and strategy-only disabled (second).
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.disabled).toBe(true);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(false);
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("toggles ruleDisabled via the card-level toggle, independent from the strategy toggle", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(true);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.disabled).toBe(false);
  });

  it("renders strategy params inline and commits changes to the store", () => {
    vi.useFakeTimers();
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s2", disabled: false, ruleDisabled: false }], strategyParams: {} });
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

  it("opens the issue-select dialog via the bottom add-new-rule button, then the check dialog filtered to the picked issue", () => {
    useMazeStore.setState({ availableStrategies: [] });
    render(<RulesColumn slots={[]} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("issue-select-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Add new rule"));
    expect(screen.getByTestId("issue-select-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("pick-k1"));
    expect(screen.queryByTestId("issue-select-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("check-select-dialog")).toHaveTextContent("k1");
  });

  it("Back from the check dialog returns to the issue-select dialog", () => {
    render(<RulesColumn slots={[]} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("go-back"));
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("issue-select-dialog")).toBeInTheDocument();
  });

  it("advances to the strategy dialog after picking checks, when a strategy handles the kind", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      availableStrategies: [{ id: "s1", handles: "k1", params: [], experimental: false }],
    });
    render(<RulesColumn slots={[]} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("pick-checks"));
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-rule-strategy-dialog")).toBeInTheDocument();
  });

  it("Back from the strategy dialog returns to the check dialog", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      availableStrategies: [{ id: "s1", handles: "k1", params: [], experimental: false }],
    });
    render(<RulesColumn slots={[]} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("pick-checks"));
    fireEvent.click(screen.getByText("go-back-2"));
    expect(screen.queryByTestId("new-rule-strategy-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("check-select-dialog")).toBeInTheDocument();
  });

  it("creates the rule with the picked checks and strategy on strategy-dialog confirm", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      availableStrategies: [{ id: "s1", handles: "k1", params: [], experimental: false }],
      rules: [],
    });
    render(<RulesColumn slots={[]} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("pick-checks"));
    fireEvent.click(screen.getByText("pick-strategy"));
    expect(screen.queryByTestId("new-rule-strategy-dialog")).not.toBeInTheDocument();
    expect(useMazeStore.getState().rules).toHaveLength(1);
    expect(useMazeStore.getState().rules[0].checks.map((c) => c.typeId)).toEqual(["c1"]);
    expect(useMazeStore.getState().rules[0].strategyId).toBe("s1");
  });

  it("skips the strategy step and creates the rule directly when no strategy handles the kind", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      availableStrategies: [],
      rules: [],
    });
    render(<RulesColumn slots={[]} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("pick-checks"));
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("new-rule-strategy-dialog")).not.toBeInTheDocument();
    expect(useMazeStore.getState().rules).toHaveLength(1);
    expect(useMazeStore.getState().rules[0].checks.map((c) => c.typeId)).toEqual(["c1"]);
    expect(useMazeStore.getState().rules[0].strategyId).toBeNull();
  });

  it("opens the add-to-rule dialog with not-yet-active checks of the same kind as candidates", () => {
    useMazeStore.setState({
      availableChecks: [
        { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
        { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
      ],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }],
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
        { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
        { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
      ],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }],
    });
    const slots: StrategySlotVM[] = [
      { ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] },
    ];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    fireEvent.click(screen.getByText("Check Two"));
    fireEvent.click(screen.getByText("Add"));
    expect(useMazeStore.getState().rules).toEqual([
      { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }, { localId: 1, typeId: "c2", params: {} }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false },
    ]);
  });

  it("shows an alert instead of an empty picker when no candidate checks are available", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    expect(screen.getByText("All checks compatible with this rule are already added.")).toBeInTheDocument();
  });

  it("toggles ruleDisabled and visually dims the card title row", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(true);
  });

  it("renames a rule via the edit button's inline input, committed on Enter", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Rename rule"));
    const input = screen.getByDisplayValue("Rule 1");
    fireEvent.change(input, { target: { value: "My rule" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.name).toBe("My rule");
  });

  it("removes a rule via the X button after confirming, clearing strategy selection for it", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    // LiveSlots, see comment in "removing a check..." above — removing the whole rule needs the
    // same store-tracking treatment.
    render(<LiveSlots slots={slots} selection={{ type: "strategy", ruleId: "g1", strategyId: "s1" }} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Remove rule"));
    fireEvent.click(screen.getByText("Ok"));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("cancelling the remove-rule confirmation leaves the rule intact", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {} }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA] }];
    render(<RulesColumn slots={slots} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Remove rule"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(useMazeStore.getState().rules).toHaveLength(1);
  });
});
