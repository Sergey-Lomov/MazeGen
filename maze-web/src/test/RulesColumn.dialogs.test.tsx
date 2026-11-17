import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RulesColumn } from "../components/features/quality/RulesColumn";
import { useMazeStore } from "../store/mazeStore";
import type { StrategySlotVM, StrategyVM, CheckVM, QualityStageVM } from "../components/features/useQualityViewModel";
import { getTooltipControl } from "./tooltipTestUtils";

// Wraps a flat `StrategySlotVM[]` fixture into a single-stage `QualityStageVM[]` — most tests
// here don't care about stage grouping itself, just about rendering/interacting with rule cards,
// so one stage containing every slot mirrors the pre-#65 flat-list shape these fixtures were
// originally written against.
function wrapStage(slots: StrategySlotVM[]): QualityStageVM[] {
  return [{ stageId: "stage_1", name: "Stage 1", slots, disabled: false, collapsed: false }];
}

vi.mock("../components/features/CheckSelectDialog", () => ({
  CheckSelectDialog: ({ kind, onBack, onNext }: { kind: string; onBack: () => void; onNext: (id: string, paramOverrides: Record<string, Record<string, string>>) => void }) => (
    <div data-testid="check-select-dialog">
      {kind}
      <button onClick={onBack}>go-back</button>
      <button onClick={() => onNext("c1", {})}>pick-checks</button>
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

const strategy: StrategyVM = { id: "s1", label: "Strategy One", handles: "k1", params: [], experimental: false, nestedSlots: [] };
const checkA: CheckVM = { id: "g1:0", ruleId: "g1", localId: 0, typeId: "c1", label: "Check One", cardLabel: "Check One", description: "", params: [], disabled: false };

// Default backing rule for checkA (ruleId "g1", localId 0) — RuleCheckRow looks up its own
// check's params from `store.rules` by (ruleId, localId), so any `slots` fixture referencing
// checkA needs a matching store rule present, even when the test only cares about props.
function defaultRules() {
  return [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }, { localId: 1, typeId: "c2", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }];
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
      return { ...slot, producedBy, collapsed: rule.collapsed };
    })
    .filter((s): s is StrategySlotVM => s !== null);
  return <RulesColumn stages={wrapStage(liveSlots)} selection={selection} onSelect={onSelect} />;
}

describe("RulesColumn dialogs and rule management", () => {
  it("shows empty hint when no rules", () => {
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByText("Logging")).not.toBeInTheDocument();
  });

  it("opens the issue-select dialog via the bottom add-new-rule button, then the check dialog filtered to the picked issue", () => {
    useMazeStore.setState({ availableStrategies: [] });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("issue-select-dialog")).not.toBeInTheDocument();
    fireEvent.click(getTooltipControl("Add new rule"));
    expect(screen.getByTestId("issue-select-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("pick-k1"));
    expect(screen.queryByTestId("issue-select-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("check-select-dialog")).toHaveTextContent("k1");
  });

  it("Back from the check dialog returns to the issue-select dialog", () => {
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(getTooltipControl("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("go-back"));
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("issue-select-dialog")).toBeInTheDocument();
  });

  it("advances to the strategy dialog after picking checks, when a strategy handles the kind", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] }],
      availableStrategies: [{ id: "s1", handles: "k1", params: [], experimental: false, nested_slots: [] }],
    });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(getTooltipControl("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("pick-checks"));
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-rule-strategy-dialog")).toBeInTheDocument();
  });

  it("Back from the strategy dialog returns to the check dialog", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] }],
      availableStrategies: [{ id: "s1", handles: "k1", params: [], experimental: false, nested_slots: [] }],
    });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(getTooltipControl("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("pick-checks"));
    fireEvent.click(screen.getByText("go-back-2"));
    expect(screen.queryByTestId("new-rule-strategy-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("check-select-dialog")).toBeInTheDocument();
  });

  it("creates the rule with the picked checks and strategy on strategy-dialog confirm", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] }],
      availableStrategies: [{ id: "s1", handles: "k1", params: [], experimental: false, nested_slots: [] }],
      rules: [],
    });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(getTooltipControl("Add new rule"));
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
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] }],
      availableStrategies: [],
      rules: [],
    });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(getTooltipControl("Add new rule"));
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
        { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] },
        { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [] },
      ],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    const slots: StrategySlotVM[] = [
      { ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false },
    ];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    expect(screen.getByText("Check Two")).toBeInTheDocument();
  });

  it("activates the chosen candidate directly into the target rule, not a new one", () => {
    useMazeStore.setState({
      availableChecks: [
        { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] },
        { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [] },
      ],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    const slots: StrategySlotVM[] = [
      { ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false },
    ];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    fireEvent.click(screen.getByText("Check Two"));
    fireEvent.click(screen.getByText("Add"));
    expect(useMazeStore.getState().rules).toEqual([
      { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }, { localId: 1, typeId: "c2", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false },
    ]);
  });

  it("keeps the same check type available while excluding multi-floor-only checks on a single floor", () => {
    useMazeStore.setState({
      availableChecks: [
        { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] },
        { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [], visibility: { type: "multi_floor_only" } },
      ],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
      floors: [{ id: "f1", title: "Floor 1" }],
    });
    const slots: StrategySlotVM[] = [
      { ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false },
    ];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    expect(screen.getAllByText("Check One").length).toBeGreaterThan(1);
  });

  it("disables the add-check row with a tooltip instead of an alert when no candidate checks are available", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    const row = screen.getByText("+ Add check");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("All checks compatible with this rule are already added.", { selector: "[hidden]" })).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByText("Check One")).toHaveLength(1);
  });

  it("ignores keyboard activation of the disabled add-check row", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    const row = screen.getByText("+ Add check");
    expect(row).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(screen.getAllByText("Check One")).toHaveLength(1);
  });

  it("opens the picker from the keyboard on the enabled add-check row", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] }, { id: "c3", label: "Check Three", description: "", issue_kinds: ["k1"], params: [] }],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.keyDown(screen.getByText("+ Add check"), { key: "Enter" });
    expect(screen.getByText("Check Three")).toBeInTheDocument();
  });

  it("keeps the add-check row enabled and tooltip-free when candidates exist", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [] }, { id: "c3", label: "Check Three", description: "", issue_kinds: ["k1"], params: [] }],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    const row = screen.getByText("+ Add check");
    expect(row).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByText("All checks compatible with this rule are already added.", { selector: "[hidden]" })).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText("Check Three")).toBeInTheDocument();
  });

  it("toggles ruleDisabled and visually dims the card title row", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(true);
  });

  it("renames a rule via the edit button's inline input, committed on Enter", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(getTooltipControl("Rename rule"));
    const input = screen.getByDisplayValue("Rule 1");
    fireEvent.change(input, { target: { value: "My rule" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.name).toBe("My rule");
  });

  it("removes a rule via the X button after confirming, clearing strategy selection for it", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    // LiveSlots, see comment in "removing a check..." above — removing the whole rule needs the
    // same store-tracking treatment.
    render(<LiveSlots slots={slots} selection={{ type: "strategy", ruleId: "g1", strategyId: "s1" }} onSelect={onSelect} />);
    fireEvent.click(getTooltipControl("Remove rule"));
    fireEvent.click(screen.getByText("Ok"));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("cancelling the remove-rule confirmation leaves the rule intact", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(getTooltipControl("Remove rule"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(useMazeStore.getState().rules).toHaveLength(1);
  });
});
