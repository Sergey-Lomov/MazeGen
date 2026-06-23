import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { QualityDetailPanel } from "../components/features/quality/QualityDetailPanel";
import { useMazeStore } from "../store/mazeStore";
import type { CheckVM, StrategyVM, QualityViewModel } from "../components/features/useQualityViewModel";

const strategy: StrategyVM = { id: "s1", label: "Strategy One", handles: "i1", params: [] };

const check: CheckVM = {
  id: "c1",
  label: "Check One",
  description: "Check One description",
  params: [],
};

function makeVm(overrides: Partial<QualityViewModel> = {}): QualityViewModel {
  return {
    checks: [check],
    strategySlots: [{ kind: "i1", label: "Issue One", strategy: null, disabled: false, producedBy: [check] }],
    ...overrides,
  };
}

function Harness({ selection, vm }: { selection: Parameters<typeof QualityDetailPanel>[0]["selection"]; vm: QualityViewModel }) {
  const flushRef = useRef<() => void>(() => {});
  return <QualityDetailPanel selection={selection} vm={vm} flushRef={flushRef} />;
}

beforeEach(() => {
  useMazeStore.setState({
    checkParams: {},
    strategyParams: {},
  } as Partial<ReturnType<typeof useMazeStore.getState>>);
});

describe("QualityDetailPanel", () => {
  it("shows placeholder when nothing selected", () => {
    render(<Harness selection={null} vm={makeVm()} />);
    expect(screen.getByText("Select an item to view details")).toBeInTheDocument();
  });

  it("renders check detail when a check is selected", () => {
    render(<Harness selection={{ type: "check", id: "c1" }} vm={makeVm()} />);
    expect(screen.getByText("Check One")).toBeInTheDocument();
    expect(screen.getByText("Check One description")).toBeInTheDocument();
  });

  it("renders strategy detail when a strategy is selected", () => {
    const vm = makeVm({
      strategySlots: [{ kind: "i1", label: "Issue One", strategy, disabled: false, producedBy: [check] }],
    });
    render(
      <Harness selection={{ type: "strategy", issueId: "i1", strategyId: "s1" }} vm={vm} />
    );
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("renders empty panel when selected check no longer exists", () => {
    render(<Harness selection={{ type: "check", id: "missing" }} vm={makeVm()} />);
    expect(screen.queryByText("Check One")).not.toBeInTheDocument();
  });
});
