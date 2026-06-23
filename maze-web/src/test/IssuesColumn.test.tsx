import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssuesColumn } from "../components/features/quality/IssuesColumn";
import { useMazeStore } from "../store/mazeStore";
import type { IssueVM, StrategyVM } from "../components/features/useQualityViewModel";

vi.mock("../components/features/StrategySelectDialog", () => ({
  StrategySelectDialog: ({ issueId, onClose }: { issueId: string; onClose: () => void }) => (
    <div data-testid="strategy-select-dialog">
      {issueId}
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

const issues: IssueVM[] = [
  { id: "i1", label: "Issue One", description: "" },
  { id: "i2", label: "Issue Two", description: "" },
];

const strategy: StrategyVM = { id: "s1", label: "Strategy One", handles: "i1", params: [] };

describe("IssuesColumn", () => {
  beforeEach(() => {
    useMazeStore.setState({ disabledStrategies: {} });
  });

  it("renders all issues", () => {
    render(
      <IssuesColumn issues={issues} issueStrategy={{}} issueStrategyDisabled={{}} selection={null} onSelect={vi.fn()} />
    );
    expect(screen.getByText("Issue One")).toBeInTheDocument();
    expect(screen.getByText("Issue Two")).toBeInTheDocument();
  });

  it("shows no-fix label when issue has no strategy", () => {
    render(
      <IssuesColumn
        issues={[issues[0]]}
        issueStrategy={{ i1: null }}
        issueStrategyDisabled={{}}
        selection={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText("Do not fix")).toBeInTheDocument();
  });

  it("shows strategy label when issue has a strategy", () => {
    render(
      <IssuesColumn
        issues={[issues[0]]}
        issueStrategy={{ i1: strategy }}
        issueStrategyDisabled={{}}
        selection={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("calls onSelect with issue selection on issue card click", () => {
    const onSelect = vi.fn();
    render(
      <IssuesColumn issues={issues} issueStrategy={{}} issueStrategyDisabled={{}} selection={null} onSelect={onSelect} />
    );
    fireEvent.click(screen.getByText("Issue One"));
    expect(onSelect).toHaveBeenCalledWith({ type: "issue", id: "i1" });
  });

  it("calls onSelect with strategy selection on strategy card click when strategy exists", () => {
    const onSelect = vi.fn();
    render(
      <IssuesColumn
        issues={[issues[0]]}
        issueStrategy={{ i1: strategy }}
        issueStrategyDisabled={{}}
        selection={null}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByText("Strategy One"));
    expect(onSelect).toHaveBeenCalledWith({ type: "strategy", issueId: "i1", strategyId: "s1" });
  });

  it("does not call onSelect on strategy card click when no strategy", () => {
    const onSelect = vi.fn();
    render(
      <IssuesColumn
        issues={[issues[0]]}
        issueStrategy={{ i1: null }}
        issueStrategyDisabled={{}}
        selection={null}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByText("Do not fix"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens strategy dialog via edit button", () => {
    render(
      <IssuesColumn
        issues={[issues[0]]}
        issueStrategy={{ i1: strategy }}
        issueStrategyDisabled={{}}
        selection={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.queryByTestId("strategy-select-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit strategy", { exact: false }));
    expect(screen.getByTestId("strategy-select-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("strategy-select-dialog")).not.toBeInTheDocument();
  });

  it("toggles strategy disabled state via toggle button, keeping selection intact", () => {
    render(
      <IssuesColumn
        issues={[issues[0]]}
        issueStrategy={{ i1: strategy }}
        issueStrategyDisabled={{}}
        selection={null}
        onSelect={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(useMazeStore.getState().disabledStrategies.i1).toBe(true);
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("toggling strategy does not trigger onSelect (no card selection side effect)", () => {
    const onSelect = vi.fn();
    render(
      <IssuesColumn
        issues={[issues[0]]}
        issueStrategy={{ i1: strategy }}
        issueStrategyDisabled={{}}
        selection={null}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not render toggle switch when issue has no strategy", () => {
    render(
      <IssuesColumn
        issues={[issues[0]]}
        issueStrategy={{ i1: null }}
        issueStrategyDisabled={{}}
        selection={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
