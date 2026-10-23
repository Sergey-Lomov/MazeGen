import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StrategySelectDialog } from "../components/features/StrategySelectDialog";
import { useMazeStore } from "../store/mazeStore";

const addSplitConfigParam = { id: "split_config", label: "Split node count", kind: { type: "add_split_config" as const, max_split_nodes_default: 3 } };

const availableStrategies = [
  { id: "random_endpoints", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [] },
  { id: "farthest_endpoints", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [] },
  { id: "invalid_loop_random", handles: "invalid_loop", params: [], experimental: false, nested_slots: [] },
  { id: "add_split", handles: "isolated_node", params: [addSplitConfigParam], experimental: false, nested_slots: [] },
];

beforeEach(() => {
  useMazeStore.setState({
    availableStrategies,
    rules: [{ id: "g1", name: "Rule 1", kind: "missing_endpoints", checks: [{ localId: 0, typeId: "missing_endpoints", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "random_endpoints", strategyParams: {}, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
  });
});

describe("StrategySelectDialog", () => {
  it("only lists strategies handling the given kind, plus no_fix", () => {
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
    expect(screen.getByText("Random endpoints")).toBeInTheDocument();
    expect(screen.getByText("Farthest endpoints")).toBeInTheDocument();
    expect(screen.queryByText("Random invalid loop break")).not.toBeInTheDocument();
  });

  it("preselects the rule's current strategy", () => {
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Select"));
    expect(useMazeStore.getState().rules[0].strategyId).toBe("random_endpoints");
  });

  it("selecting a different strategy and confirming calls setStrategy", () => {
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Farthest endpoints"));
    fireEvent.click(screen.getByText("Select"));
    expect(useMazeStore.getState().rules[0].strategyId).toBe("farthest_endpoints");
  });

  it("selecting no_fix and confirming calls clearStrategy", () => {
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Logging"));
    fireEvent.click(screen.getByText("Select"));
    expect(useMazeStore.getState().rules[0].strategyId).toBeNull();
  });

  it("Cancel closes without modifying the store", () => {
    const onClose = vi.fn();
    render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={onClose} />);
    fireEvent.click(screen.getByText("Farthest endpoints"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(useMazeStore.getState().rules[0].strategyId).toBe("random_endpoints");
  });

  describe("multi-floor-only strategies", () => {
    const withFloorOnlyStrategy = [
      ...availableStrategies,
      { id: "add_vertical_passage", handles: "missing_endpoints", params: [], experimental: false, nested_slots: [], visibility: { type: "multi_floor_only" as const } },
    ];

    it("hides a multi-floor-only strategy on a single floor", () => {
      useMazeStore.setState({ availableStrategies: withFloorOnlyStrategy, floors: [{ id: "f1", title: "Floor 1" }] });
      render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
      expect(screen.queryByText("Random vertical passage")).not.toBeInTheDocument();
    });

    it("shows it again with 2+ floors", () => {
      useMazeStore.setState({ availableStrategies: withFloorOnlyStrategy, floors: [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }] });
      render(<StrategySelectDialog ruleId="g1" kind="missing_endpoints" onClose={vi.fn()} />);
      expect(screen.getByText("Random vertical passage")).toBeInTheDocument();
    });
  });

  describe("add_split's rule-level pattern override", () => {
    it("renders the plain node-count input when the rule has no split_patterns", () => {
      useMazeStore.setState({
        rules: [{ id: "g2", name: "Rule 2", kind: "isolated_node", checks: [], nextLocalCheckId: 0, strategyId: "add_split", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
      });
      render(<StrategySelectDialog ruleId="g2" kind="isolated_node" onClose={vi.fn()} />);
      expect(screen.getByText("Nodes in tile")).toBeInTheDocument();
      expect(screen.queryByText("Weight settings")).not.toBeInTheDocument();
    });

    it("renders the locked pattern-weights control when the rule has split_patterns", () => {
      useMazeStore.setState({
        rules: [{ id: "g2", name: "Rule 2", kind: "isolated_node", checks: [], nextLocalCheckId: 0, strategyId: "add_split", disabled: false, ruleDisabled: false, params: { split_patterns: JSON.stringify([{ node_count: 2, faces: [], weight: 1 }]) }, nestedStrategies: [], collapsed: false }],
      });
      render(<StrategySelectDialog ruleId="g2" kind="isolated_node" onClose={vi.fn()} />);
      expect(screen.getByText("Pattern weights")).toBeInTheDocument();
      expect(screen.getByText("Weight settings")).toBeInTheDocument();
      expect(screen.queryByText("Nodes in tile")).not.toBeInTheDocument();
    });
  });
});
