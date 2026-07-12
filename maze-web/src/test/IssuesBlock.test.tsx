import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssuesBlock } from "../components/IssuesBlock";
import { useMazeStore } from "../store/mazeStore";
import type { IssueDto } from "../wasm/types";

/// Builds one `invalid_loop` IssueDto, mirroring what `MinLoopLengthCheck::report_check` (via
/// `cycle_check_core::build_report_issues`) produces since GitHub issue #98 — one issue per
/// invalid cycle, `source_checks: [checkId]`, `edges[checkId]` holding exactly that one cycle.
function invalidLoopIssue(checkId: string, threshold: string, cycleEdges: [number, number][]): IssueDto {
  return {
    kind: "invalid_loop",
    payload: { kind: "invalid_loop", edges: { [checkId]: [cycleEdges] } },
    source_checks: [checkId],
    source_check_types: { [checkId]: "min_loop_length" },
    details: { [checkId]: { threshold } },
  };
}

/// Builds one `region_needs_expansion` IssueDto — mirrors `invalidLoopIssue` above but for the
/// other payload variant `groupIssues`/`IssueBubble` branch on (see `IssuePayloadDto` in
/// `wasm/types.ts`). `minRegionSize` matches `DETAIL_LABELS.min_region_size`'s expected detail
/// key in `issueRegistry.ts`.
function regionNeedsExpansionIssue(checkId: string, minRegionSize: string, regionNodes: number[]): IssueDto {
  return {
    kind: "region_needs_expansion",
    payload: { kind: "region_needs_expansion", nodes: { [checkId]: [regionNodes] } },
    source_checks: [checkId],
    source_check_types: { [checkId]: "min_region_size" },
    details: { [checkId]: { min_region_size: minRegionSize } },
  };
}

/// Builds one `qc_no_progress` IssueDto — no source check (`source_checks: []`, not a
/// toggleable `Check<T>`), exercising `resolveLabel`'s null-`sourceCheck` fallback (details keyed
/// under `issue.kind` itself) and its `rule_ids` core-id -> `QcRuleState.name` substitution.
function qcNoProgressIssue(ruleIds: string): IssueDto {
  return {
    kind: "qc_no_progress",
    payload: { kind: "none" },
    source_checks: [],
    source_check_types: {},
    details: { qc_no_progress: { rule_ids: ruleIds } },
  };
}

describe("IssuesBlock grouping", () => {
  it("collapses several separate issues from the same check into one bubble with a count badge", () => {
    const issues: IssueDto[] = [
      invalidLoopIssue("rule_1:min_loop_length", "10", [[0, 1], [1, 2], [2, 0]]),
      invalidLoopIssue("rule_1:min_loop_length", "10", [[3, 4], [4, 5], [5, 3]]),
      invalidLoopIssue("rule_1:min_loop_length", "10", [[6, 7], [7, 8], [8, 6]]),
      invalidLoopIssue("rule_1:min_loop_length", "10", [[9, 10], [10, 11], [11, 9]]),
    ];
    render(<IssuesBlock issues={issues} />);

    expect(screen.getAllByText("Loop shorter than 10 tiles")).toHaveLength(1);
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("keeps two differently-configured instances of the same check type as separate bubbles", () => {
    const issues: IssueDto[] = [
      invalidLoopIssue("rule_1:min_loop_length", "10", [[0, 1], [1, 2], [2, 0]]),
      invalidLoopIssue("rule_2:min_loop_length", "5", [[3, 4], [4, 5], [5, 3]]),
    ];
    render(<IssuesBlock issues={issues} />);

    expect(screen.getByText("Loop shorter than 10 tiles")).toBeInTheDocument();
    expect(screen.getByText("Loop shorter than 5 tiles")).toBeInTheDocument();
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("does not show a count badge for a single (ungrouped) issue", () => {
    const issues: IssueDto[] = [invalidLoopIssue("rule_1:min_loop_length", "10", [[0, 1], [1, 2], [2, 0]])];
    render(<IssuesBlock issues={issues} />);

    expect(screen.getByText("Loop shorter than 10 tiles")).toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("hovering the grouped bubble highlights every cycle it represents, not just the first", () => {
    const setHoveredIssueLoopEdges = vi.fn();
    useMazeStore.setState({ setHoveredIssueLoopEdges });
    const issues: IssueDto[] = [
      invalidLoopIssue("rule_1:min_loop_length", "10", [[0, 1]]),
      invalidLoopIssue("rule_1:min_loop_length", "10", [[3, 4]]),
    ];
    render(<IssuesBlock issues={issues} />);

    fireEvent.mouseEnter(screen.getByText("Loop shorter than 10 tiles").closest("div")!);
    expect(setHoveredIssueLoopEdges).toHaveBeenCalledWith([[0, 1], [3, 4]]);
  });
});

describe("IssuesBlock grouping — region_needs_expansion", () => {
  it("collapses several separate region issues from the same check into one bubble with a count badge", () => {
    const issues: IssueDto[] = [
      regionNeedsExpansionIssue("rule_1:min_region_size", "10", [1, 2, 3]),
      regionNeedsExpansionIssue("rule_1:min_region_size", "10", [4, 5, 6]),
      regionNeedsExpansionIssue("rule_1:min_region_size", "10", [7, 8, 9]),
    ];
    render(<IssuesBlock issues={issues} />);

    expect(screen.getAllByText("Region smaller than 10 tile(s)")).toHaveLength(1);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("keeps two differently-configured instances of the same region check as separate bubbles", () => {
    const issues: IssueDto[] = [
      regionNeedsExpansionIssue("rule_1:min_region_size", "10", [1, 2, 3]),
      regionNeedsExpansionIssue("rule_2:min_region_size", "5", [4, 5, 6]),
    ];
    render(<IssuesBlock issues={issues} />);

    expect(screen.getByText("Region smaller than 10 tile(s)")).toBeInTheDocument();
    expect(screen.getByText("Region smaller than 5 tile(s)")).toBeInTheDocument();
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("does not show a count badge for a single (ungrouped) region issue", () => {
    const issues: IssueDto[] = [regionNeedsExpansionIssue("rule_1:min_region_size", "10", [1, 2, 3])];
    render(<IssuesBlock issues={issues} />);

    expect(screen.getByText("Region smaller than 10 tile(s)")).toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("hovering the grouped region bubble highlights every region it represents, not just the first", () => {
    const setHoveredIssueRegionGroups = vi.fn();
    useMazeStore.setState({ setHoveredIssueRegionGroups });
    const issues: IssueDto[] = [
      regionNeedsExpansionIssue("rule_1:min_region_size", "10", [1, 2]),
      regionNeedsExpansionIssue("rule_1:min_region_size", "10", [7, 8]),
    ];
    render(<IssuesBlock issues={issues} />);

    fireEvent.mouseEnter(screen.getByText("Region smaller than 10 tile(s)").closest("div")!);
    expect(setHoveredIssueRegionGroups).toHaveBeenCalledWith([[1, 2], [7, 8]]);
  });
});

describe("IssuesBlock — no source check (qc_no_progress)", () => {
  it("substitutes core rule ids with store rule names in the rendered label", () => {
    useMazeStore.setState({
      rules: [
        { id: "rule_6", name: "Min loop length", kind: "k", checks: [], nextLocalCheckId: 0, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
        { id: "rule_9", name: "Max loop length", kind: "k", checks: [], nextLocalCheckId: 0, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] },
      ],
    });
    const issues: IssueDto[] = [qcNoProgressIssue("rule_6, rule_9")];
    render(<IssuesBlock issues={issues} />);

    expect(screen.getByText("Repair loop stalled: rule(s) stuck in place - Min loop length, Max loop length")).toBeInTheDocument();
  });

  it("falls back to the raw core id when no matching rule is found in the store", () => {
    useMazeStore.setState({ rules: [] });
    const issues: IssueDto[] = [qcNoProgressIssue("rule_6")];
    render(<IssuesBlock issues={issues} />);

    expect(screen.getByText("Repair loop stalled: rule(s) stuck in place - rule_6")).toBeInTheDocument();
  });

  it("groups two no-source-check issues with identical substituted labels into one bubble", () => {
    useMazeStore.setState({
      rules: [{ id: "rule_6", name: "Min loop length", kind: "k", checks: [], nextLocalCheckId: 0, strategyId: null, disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    });
    const issues: IssueDto[] = [qcNoProgressIssue("rule_6"), qcNoProgressIssue("rule_6")];
    render(<IssuesBlock issues={issues} />);

    expect(screen.getAllByText("Repair loop stalled: rule(s) stuck in place - Min loop length")).toHaveLength(1);
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});

describe("IssuesBlock empty state", () => {
  it("renders nothing for an empty issues array", () => {
    const { container } = render(<IssuesBlock issues={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
