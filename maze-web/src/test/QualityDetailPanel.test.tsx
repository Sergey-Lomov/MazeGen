import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import { QualityDetailPanel } from "../components/features/quality/QualityDetailPanel";
import { useMazeStore } from "../store/mazeStore";
import type { CheckVM, StrategyVM, QualityViewModel } from "../components/features/useQualityViewModel";

const strategy: StrategyVM = { id: "s1", label: "Strategy One", handles: "i1", params: [], experimental: false, nestedSlots: [] };

const check: CheckVM = {
  id: "g1:0",
  ruleId: "g1",
  localId: 0,
  typeId: "c1",
  label: "Check One",
  cardLabel: "Check One",
  description: "Check One description",
  params: [],
  disabled: false,
};

const checkWithParams: CheckVM = {
  ...check,
  params: [{ id: "threshold", label: "Threshold", kind: { type: "float", default: 1, min: 0, max: 10 } }],
};

function makeVm(overrides: Partial<QualityViewModel> = {}): QualityViewModel {
  const slots = [{ ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: null, disabled: false, ruleDisabled: false, producedBy: [check], params: {}, nestedStrategies: [], collapsed: false }];
  return {
    checks: [check],
    stages: [{ stageId: "stage_1", name: "Stage 1", slots, disabled: false, collapsed: false }],
    strategySlots: slots,
    ...overrides,
  };
}

function Harness({ selection, vm }: { selection: Parameters<typeof QualityDetailPanel>[0]["selection"]; vm: QualityViewModel }) {
  const flushRef = useRef<() => void>(() => {});
  return <QualityDetailPanel selection={selection} vm={vm} flushRef={flushRef} onSelect={() => {}} />;
}

beforeEach(() => {
  useMazeStore.setState({
    rules: [],
    strategyParams: {},
    availableRuleParams: [],
  } as Partial<ReturnType<typeof useMazeStore.getState>>);
});

describe("QualityDetailPanel", () => {
  it("shows placeholder when nothing selected", () => {
    render(<Harness selection={null} vm={makeVm()} />);
    expect(screen.getByText("Select an item to view details")).toBeInTheDocument();
  });

  it("renders check detail when a check is selected", () => {
    render(<Harness selection={{ type: "check", id: "g1:0" }} vm={makeVm()} />);
    expect(screen.getByText("Check One")).toBeInTheDocument();
    expect(screen.getByText("Check One description")).toBeInTheDocument();
  });

  it("renders strategy detail when a strategy is selected", () => {
    const vm = makeVm({
      strategySlots: [{ ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy, disabled: false, ruleDisabled: false, producedBy: [check], params: {}, nestedStrategies: [], collapsed: false }],
    });
    render(
      <Harness selection={{ type: "strategy", ruleId: "g1", strategyId: "s1" }} vm={vm} />
    );
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("clicking a nested strategy shown under a selected top-level strategy calls onSelect", () => {
    const onSelect = vi.fn();
    const nestedStrategy: StrategyVM = { id: "expand_region_passage", label: "expand_region_passage", handles: "k2", params: [], experimental: false, nestedSlots: [] };
    const topLevel: StrategyVM = {
      id: "s1", label: "Strategy One", handles: "i1", params: [], experimental: false,
      nestedSlots: [{ slotId: "slot_a", kind: "k2", min: 1, max: null, dispatchKind: "priority" }],
    };
    const vm = makeVm({
      strategySlots: [{
        ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: topLevel,
        disabled: false, ruleDisabled: false, producedBy: [check],
        params: {}, nestedStrategies: [{ slotId: "slot_a", strategy: nestedStrategy, params: [], nested: [] }], collapsed: false,
      }],
    });
    function HarnessWithSelect({ vm: v }: { vm: QualityViewModel }) {
      const flushRef = useRef<() => void>(() => {});
      return <QualityDetailPanel selection={{ type: "strategy", ruleId: "g1", strategyId: "s1" }} vm={v} flushRef={flushRef} onSelect={onSelect} />;
    }
    render(<HarnessWithSelect vm={vm} />);
    fireEvent.click(screen.getByText("Region expansion via passage"));
    expect(onSelect).toHaveBeenCalledWith({ type: "nested_strategy", ruleId: "g1", path: [{ slotId: "slot_a", index: 0 }] });
  });

  it("shows the placeholder when selected check no longer exists", () => {
    render(<Harness selection={{ type: "check", id: "missing" }} vm={makeVm()} />);
    expect(screen.queryByText("Check One")).not.toBeInTheDocument();
    expect(screen.getByText("Select an item to view details")).toBeInTheDocument();
  });

  it("renders nested strategy detail when a nested_strategy slot is selected", () => {
    const nestedStrategy: StrategyVM = { id: "n1", label: "Nested One", handles: "k2", params: [], experimental: false, nestedSlots: [] };
    const topLevel: StrategyVM = {
      id: "s1", label: "Strategy One", handles: "i1", params: [], experimental: false,
      nestedSlots: [{ slotId: "slot_a", kind: "k2", min: 1, max: 1, dispatchKind: "unordered" }],
    };
    const vm = makeVm({
      strategySlots: [{
        ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: topLevel,
        disabled: false, ruleDisabled: false, producedBy: [check],
        params: {}, nestedStrategies: [{ slotId: "slot_a", strategy: nestedStrategy, params: [], nested: [] }], collapsed: false,
      }],
    });
    render(<Harness selection={{ type: "nested_strategy", ruleId: "g1", path: [{ slotId: "slot_a", index: 0 }] }} vm={vm} />);
    expect(screen.getByText("Nested One")).toBeInTheDocument();
  });

  it("renders the nested strategy's own params on the detail panel", () => {
    const nestedStrategy: StrategyVM = {
      id: "n1", label: "Nested One", handles: "k2", experimental: false, nestedSlots: [],
      params: [{ id: "p1", label: "Param One", kind: { type: "float", default: 1, min: 0, max: 10 } }],
    };
    const topLevel: StrategyVM = {
      id: "s1", label: "Strategy One", handles: "i1", params: [], experimental: false,
      nestedSlots: [{ slotId: "slot_a", kind: "k2", min: 1, max: 1, dispatchKind: "unordered" }],
    };
    const vm = makeVm({
      strategySlots: [{
        ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: topLevel,
        disabled: false, ruleDisabled: false, producedBy: [check],
        params: {}, nestedStrategies: [{ slotId: "slot_a", strategy: nestedStrategy, params: nestedStrategy.params, nested: [] }], collapsed: false,
      }],
    });
    render(<Harness selection={{ type: "nested_strategy", ruleId: "g1", path: [{ slotId: "slot_a", index: 0 }] }} vm={vm} />);
    expect(screen.getByText("Param One")).toBeInTheDocument();
  });

  it("shows the placeholder when the selected nested_strategy path no longer resolves", () => {
    const vm = makeVm({
      strategySlots: [{ ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy, disabled: false, ruleDisabled: false, producedBy: [check], params: {}, nestedStrategies: [], collapsed: false }],
    });
    render(<Harness selection={{ type: "nested_strategy", ruleId: "g1", path: [{ slotId: "slot_a", index: 0 }] }} vm={vm} />);
    expect(screen.queryByText("Strategy One")).not.toBeInTheDocument();
    expect(screen.getByText("Select an item to view details")).toBeInTheDocument();
  });

  it("renders a check param's label read-only, with no editable control", () => {
    const vm = makeVm({ checks: [checkWithParams] });
    render(<Harness selection={{ type: "param", owner: { kind: "check", checkId: "g1:0" }, paramId: "threshold" }} vm={vm} />);
    expect(screen.getByText("Threshold")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("renders a strategy param's label when a strategy param is selected", () => {
    const strategyWithParams: StrategyVM = {
      ...strategy,
      params: [{ id: "weight", label: "Weight", kind: { type: "float", default: 1, min: 0, max: 10 } }],
    };
    const vm = makeVm({
      strategySlots: [{ ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: strategyWithParams, disabled: false, ruleDisabled: false, producedBy: [check], params: {}, nestedStrategies: [], collapsed: false }],
    });
    render(<Harness selection={{ type: "param", owner: { kind: "strategy", ruleId: "g1" }, paramId: "weight" }} vm={vm} />);
    expect(screen.getByText("Weight")).toBeInTheDocument();
  });

  it("renders a nested strategy param's label when a nested strategy param is selected", () => {
    const nestedStrategy: StrategyVM = {
      id: "n1", label: "Nested One", handles: "k2", experimental: false, nestedSlots: [],
      params: [{ id: "p1", label: "Param One", kind: { type: "float", default: 1, min: 0, max: 10 } }],
    };
    const topLevel: StrategyVM = {
      id: "s1", label: "Strategy One", handles: "i1", params: [], experimental: false,
      nestedSlots: [{ slotId: "slot_a", kind: "k2", min: 1, max: 1, dispatchKind: "unordered" }],
    };
    const vm = makeVm({
      strategySlots: [{
        ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: topLevel,
        disabled: false, ruleDisabled: false, producedBy: [check],
        params: {}, nestedStrategies: [{ slotId: "slot_a", strategy: nestedStrategy, params: nestedStrategy.params, nested: [] }], collapsed: false,
      }],
    });
    render(<Harness selection={{ type: "param", owner: { kind: "nested_strategy", ruleId: "g1", path: [{ slotId: "slot_a", index: 0 }] }, paramId: "p1" }} vm={vm} />);
    expect(screen.getByText("Param One")).toBeInTheDocument();
  });

  it("renders a rule-level param's label from availableRuleParams when selected", () => {
    useMazeStore.setState({ availableRuleParams: [{ id: "not_a_real_param_id", label: "Fallback Label", kind: { type: "bool", default: false }, applies_to: ["c1"] }] });
    const vm = makeVm();
    render(<Harness selection={{ type: "param", owner: { kind: "rule", ruleId: "g1" }, paramId: "not_a_real_param_id" }} vm={vm} />);
    expect(screen.getByText("Fallback Label")).toBeInTheDocument();
  });

  it("shows the placeholder when the selected param no longer resolves", () => {
    const vm = makeVm();
    render(<Harness selection={{ type: "param", owner: { kind: "check", checkId: "missing" }, paramId: "threshold" }} vm={vm} />);
    expect(screen.queryByText("Threshold")).not.toBeInTheDocument();
    expect(screen.getByText("Select an item to view details")).toBeInTheDocument();
  });

  it("renders option explanations for an enum param when selected (GitHub issue #435)", () => {
    const checkWithEnumParam: CheckVM = {
      ...check,
      params: [{ id: "region_class", label: "Region class", kind: { type: "enum", default: "all", options: ["all", "path", "alternative", "unreachable", "trap"] } }],
    };
    const vm = makeVm({ checks: [checkWithEnumParam] });
    render(<Harness selection={{ type: "param", owner: { kind: "check", checkId: "g1:0" }, paramId: "region_class" }} vm={vm} />);
    expect(screen.getByText("Path", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Trap", { selector: "strong" })).toBeInTheDocument();
  });

  it("renders option explanations for a priority param when selected (GitHub issue #435)", () => {
    const checkWithPriorityParam: CheckVM = {
      ...check,
      params: [{ id: "unreachable_priority", label: "Unreachable priority", kind: { type: "priority", default: "indifferent" } }],
    };
    const vm = makeVm({ checks: [checkWithPriorityParam] });
    render(<Harness selection={{ type: "param", owner: { kind: "check", checkId: "g1:0" }, paramId: "unreachable_priority" }} vm={vm} />);
    expect(screen.getByText("required", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("forbidden", { selector: "strong" })).toBeInTheDocument();
  });
});
