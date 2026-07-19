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
  description: "Check One description",
  params: [],
};

function makeVm(overrides: Partial<QualityViewModel> = {}): QualityViewModel {
  const slots = [{ ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: null, disabled: false, ruleDisabled: false, producedBy: [check], nestedStrategies: [] }];
  return {
    checks: [check],
    stages: [{ stageId: "stage_1", name: "Stage 1", slots, disabled: false }],
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
      strategySlots: [{ ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy, disabled: false, ruleDisabled: false, producedBy: [check], nestedStrategies: [] }],
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
      nestedSlots: [{ slotId: "slot_a", kind: "k2", min: 1, max: null }],
    };
    const vm = makeVm({
      strategySlots: [{
        ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: topLevel,
        disabled: false, ruleDisabled: false, producedBy: [check],
        nestedStrategies: [{ slotId: "slot_a", strategy: nestedStrategy, params: [], nested: [] }],
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

  it("renders empty panel when selected check no longer exists", () => {
    render(<Harness selection={{ type: "check", id: "missing" }} vm={makeVm()} />);
    expect(screen.queryByText("Check One")).not.toBeInTheDocument();
  });

  it("renders nested strategy detail when a nested_strategy slot is selected", () => {
    const nestedStrategy: StrategyVM = { id: "n1", label: "Nested One", handles: "k2", params: [], experimental: false, nestedSlots: [] };
    const topLevel: StrategyVM = {
      id: "s1", label: "Strategy One", handles: "i1", params: [], experimental: false,
      nestedSlots: [{ slotId: "slot_a", kind: "k2", min: 1, max: 1 }],
    };
    const vm = makeVm({
      strategySlots: [{
        ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: topLevel,
        disabled: false, ruleDisabled: false, producedBy: [check],
        nestedStrategies: [{ slotId: "slot_a", strategy: nestedStrategy, params: [], nested: [] }],
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
      nestedSlots: [{ slotId: "slot_a", kind: "k2", min: 1, max: 1 }],
    };
    const vm = makeVm({
      strategySlots: [{
        ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: topLevel,
        disabled: false, ruleDisabled: false, producedBy: [check],
        nestedStrategies: [{ slotId: "slot_a", strategy: nestedStrategy, params: nestedStrategy.params, nested: [] }],
      }],
    });
    render(<Harness selection={{ type: "nested_strategy", ruleId: "g1", path: [{ slotId: "slot_a", index: 0 }] }} vm={vm} />);
    expect(screen.getByText("Param One")).toBeInTheDocument();
  });

  it("renders empty panel when the selected nested_strategy path no longer resolves", () => {
    const vm = makeVm({
      strategySlots: [{ ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy, disabled: false, ruleDisabled: false, producedBy: [check], nestedStrategies: [] }],
    });
    render(<Harness selection={{ type: "nested_strategy", ruleId: "g1", path: [{ slotId: "slot_a", index: 0 }] }} vm={vm} />);
    expect(screen.queryByText("Strategy One")).not.toBeInTheDocument();
  });
});
