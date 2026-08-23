import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NestedStrategySelectDialog } from "../components/features/quality/NestedStrategySelectDialog";
import { useMazeStore } from "../store/mazeStore";

const availableStrategies = [
  { id: "priority_region_merge", handles: "merge_target", params: [], experimental: false, nested_slots: [] },
  { id: "weighted_region_merge", handles: "merge_target", params: [], experimental: false, nested_slots: [] },
  { id: "random_endpoints", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [] },
];

const path = [{ slotId: "merge_target", index: 0 }];

beforeEach(() => {
  useMazeStore.setState({
    availableStrategies,
    rules: [{ id: "g1", name: "Rule 1", kind: "region_needs_expansion", checks: [], nextLocalCheckId: 0, strategyId: "reduce_scc_count", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [{ slotId: "merge_target", strategyId: "priority_region_merge", params: {}, nested: [] }], collapsed: false }],
  });
});

describe("NestedStrategySelectDialog", () => {
  it("only lists strategies handling the given slot kind", () => {
    render(<NestedStrategySelectDialog ruleId="g1" path={path} slotKind="merge_target" currentStrategyId="priority_region_merge" onClose={vi.fn()} />);
    expect(screen.getByText("Priority-fallback region merge")).toBeInTheDocument();
    expect(screen.getByText("Weighted random region merge")).toBeInTheDocument();
    expect(screen.queryByText("Random endpoints")).not.toBeInTheDocument();
  });

  it("selecting a candidate and confirming calls setNestedStrategy", () => {
    render(<NestedStrategySelectDialog ruleId="g1" path={path} slotKind="merge_target" currentStrategyId="priority_region_merge" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Weighted random region merge"));
    fireEvent.click(screen.getByText("Select"));
    expect(useMazeStore.getState().rules[0].nestedStrategies[0]).toMatchObject({ slotId: "merge_target", strategyId: "weighted_region_merge" });
  });

  describe("multi-floor-only strategies", () => {
    const withFloorOnlyStrategy = [
      ...availableStrategies,
      { id: "vertical_passage_region_merge", handles: "merge_target", params: [], experimental: false, nested_slots: [], visibility: { type: "multi_floor_only" as const } },
    ];

    it("hides a multi-floor-only strategy on a single floor", () => {
      useMazeStore.setState({ availableStrategies: withFloorOnlyStrategy, floors: [{ id: "f1", title: "Floor 1" }] });
      render(<NestedStrategySelectDialog ruleId="g1" path={path} slotKind="merge_target" currentStrategyId="priority_region_merge" onClose={vi.fn()} />);
      expect(screen.queryByText("Vertical passage region merge")).not.toBeInTheDocument();
    });

    it("shows it again with 2+ floors", () => {
      useMazeStore.setState({ availableStrategies: withFloorOnlyStrategy, floors: [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }] });
      render(<NestedStrategySelectDialog ruleId="g1" path={path} slotKind="merge_target" currentStrategyId="priority_region_merge" onClose={vi.fn()} />);
      expect(screen.getByText("Vertical passage region merge")).toBeInTheDocument();
    });
  });
});
