import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { QualityDetailPanel } from "../components/features/quality/QualityDetailPanel";
import { useMazeStore } from "../store/mazeStore";
import type { CheckVM, StrategyVM, QualityViewModel } from "../components/features/useQualityViewModel";

const strategy: StrategyVM = { id: "s1", label: "Strategy One", handles: "i1", params: [], experimental: false };

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
  const slots = [{ ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy: null, disabled: false, ruleDisabled: false, producedBy: [check] }];
  return {
    checks: [check],
    stages: [{ stageId: "stage_1", name: "Stage 1", slots, disabled: false }],
    strategySlots: slots,
    ...overrides,
  };
}

function Harness({ selection, vm }: { selection: Parameters<typeof QualityDetailPanel>[0]["selection"]; vm: QualityViewModel }) {
  const flushRef = useRef<() => void>(() => {});
  return <QualityDetailPanel selection={selection} vm={vm} flushRef={flushRef} />;
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
      strategySlots: [{ ruleId: "g1", name: "Rule 1", kind: "i1", label: "Issue One", strategy, disabled: false, ruleDisabled: false, producedBy: [check] }],
    });
    render(
      <Harness selection={{ type: "strategy", ruleId: "g1", strategyId: "s1" }} vm={vm} />
    );
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("renders empty panel when selected check no longer exists", () => {
    render(<Harness selection={{ type: "check", id: "missing" }} vm={makeVm()} />);
    expect(screen.queryByText("Check One")).not.toBeInTheDocument();
  });
});
