import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { QualityDetailPanel } from "../components/features/quality/QualityDetailPanel";
import { useMazeStore } from "../store/mazeStore";
import type { CheckVM, IssueVM, StrategyVM, QualityViewModel } from "../components/features/useQualityViewModel";

const check: CheckVM = {
  id: "c1",
  label: "Check One",
  description: "Check One description",
  params: [],
};

const issue: IssueVM = { id: "i1", label: "Issue One", description: "Issue One description" };

const strategy: StrategyVM = { id: "s1", label: "Strategy One", handles: "i1", params: [] };

function makeVm(overrides: Partial<QualityViewModel> = {}): QualityViewModel {
  return {
    checks: [check],
    issues: [issue],
    issueStrategy: { i1: null },
    issueToChecks: { i1: [check] },
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

  it("renders issue detail with detecting checks", () => {
    render(<Harness selection={{ type: "issue", id: "i1" }} vm={makeVm()} />);
    expect(screen.getByText("Issue One")).toBeInTheDocument();
    expect(screen.getByText("Issue One description")).toBeInTheDocument();
    expect(screen.getByText("Check One")).toBeInTheDocument();
  });

  it("renders strategy detail when a strategy is selected", () => {
    const vm = makeVm({ issueStrategy: { i1: strategy } });
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
