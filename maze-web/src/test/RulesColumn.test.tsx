import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RulesColumn } from "../components/features/quality/RulesColumn";
import { useMazeStore } from "../store/mazeStore";
import type { StrategySlotVM, StrategyVM, CheckVM, QualityStageVM } from "../components/features/useQualityViewModel";

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
const strategyWithParams: StrategyVM = {
  id: "s2",
  label: "Strategy Two",
  handles: "k1",
  params: [{ id: "weight", label: "Weight", kind: { type: "float", default: 1, min: 0, max: 10 } }],
  experimental: false,
  nestedSlots: [],
};
const checkA: CheckVM = { id: "g1:0", ruleId: "g1", localId: 0, typeId: "c1", label: "Check One", cardLabel: "Check One", description: "", params: [], disabled: false };
const checkB: CheckVM = { id: "g1:1", ruleId: "g1", localId: 1, typeId: "c2", label: "Check Two", cardLabel: "Check Two", description: "", params: [], disabled: false };
const checkWithParams: CheckVM = {
  id: "g1:0",
  ruleId: "g1",
  localId: 0,
  typeId: "c1",
  label: "Check One",
  cardLabel: "Check One",
  description: "",
  params: [{ id: "threshold", label: "Threshold", kind: { type: "float", default: 1, min: 0, max: 10 } }],
  disabled: false,
};

// Default backing rule for checkA/checkB (ruleId "g1", localIds 0/1) — RuleCheckRow looks up its
// own check's params from `store.rules` by (ruleId, localId), so any `slots` fixture referencing
// checkA/checkB needs a matching store rule present, even when the test only cares about props.
function defaultRules() {
  return [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }, { localId: 1, typeId: "c2", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }];
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

describe("RulesColumn", () => {
  it("renders one card per rule, with no-fix label when no strategy assigned", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: null, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Logging")).toBeInTheDocument();
  });

  it("hides checks and strategy panel when the rule is collapsed", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: true }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByText("Check One")).not.toBeInTheDocument();
    expect(screen.queryByText("Strategy One")).not.toBeInTheDocument();
  });

  it("clicking a rule card's collapse chevron toggles the store's collapsed flag, showing content again on second click", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<LiveSlots slots={slots} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Check One")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Collapse rule"));
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.collapsed).toBe(true);
    expect(screen.queryByText("Check One")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Expand rule"));
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.collapsed).toBe(false);
    expect(screen.getByText("Check One")).toBeInTheDocument();
  });

  it("hides a stage's rule cards when the stage is collapsed", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    const stages: QualityStageVM[] = [{ stageId: "stage_1", name: "Stage 1", slots, disabled: false, collapsed: true }];
    render(<RulesColumn stages={stages} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByText("Rule 1")).not.toBeInTheDocument();
  });

  it("shows strategy label when rule has a strategy", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("renders both member checks nested under one rule card", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA, checkB], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    expect(screen.getAllByText("Strategy One")).toHaveLength(1);
    expect(screen.getByText("Check One")).toBeInTheDocument();
    expect(screen.getByText("Check Two")).toBeInTheDocument();
  });

  it("calls onSelect with strategy selection on header click when strategy exists", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Strategy One"));
    expect(onSelect).toHaveBeenCalledWith({ type: "strategy", ruleId: "g1", strategyId: "s1" });
  });

  it("calls onSelect with logging selection on header click when no strategy", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: null, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Logging"));
    expect(onSelect).toHaveBeenCalledWith({ type: "logging", ruleId: "g1" });
  });

  it("calls onSelect with check selection on a member-check row click", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Check One"));
    expect(onSelect).toHaveBeenCalledWith({ type: "check", id: "g1:0" });
  });

  it("removing a check clears its selection, calls store removeCheck, and leaves the empty rule in place", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    // LiveSlots (not RulesColumn directly) — `producedBy` must track the store within the same
    // commit as the click, the same way the real parent (QualityCanvas) does via
    // useQualityViewModel, otherwise RuleCheckRow renders a check whose backing rule entry the
    // click just removed.
    render(<LiveSlots slots={slots} selection={{ type: "check", id: "g1:0" }} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Remove"));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(useMazeStore.getState().rules).toEqual([{ id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }]);
  });

  it("clicking a nested strategy's name calls onSelect with its (slotId, index) path", () => {
    const onSelect = vi.fn();
    const nestedStrategy: StrategyVM = { id: "expand_region_passage", label: "expand_region_passage", handles: "k2", params: [], experimental: false, nestedSlots: [] };
    const strategyWithSlot: StrategyVM = {
      id: "s1", label: "Strategy One", handles: "k1", params: [], experimental: false,
      nestedSlots: [{ slotId: "slot_a", kind: "k2", min: 1, max: 1, dispatchKind: "unordered" }],
    };
    const slots: StrategySlotVM[] = [{
      ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: strategyWithSlot,
      disabled: false, ruleDisabled: false, producedBy: [checkA],
      params: {}, nestedStrategies: [{ slotId: "slot_a", strategy: nestedStrategy, params: [], nested: [] }], collapsed: false,
    }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Region expansion via passage"));
    expect(onSelect).toHaveBeenCalledWith({ type: "nested_strategy", ruleId: "g1", path: [{ slotId: "slot_a", index: 0 }] });
  });

  it("clicking a nested strategy's name calls onSelect when the slot allows multiple entries (weight row shown)", () => {
    const onSelect = vi.fn();
    const nestedStrategy: StrategyVM = { id: "expand_region_passage", label: "expand_region_passage", handles: "k2", params: [], experimental: false, nestedSlots: [] };
    const strategyWithSlot: StrategyVM = {
      id: "weighted_region_merge", label: "Strategy One", handles: "k1", params: [], experimental: false,
      nestedSlots: [{ slotId: "merge_target", kind: "k2", min: 1, max: null, dispatchKind: "weighted" }],
    };
    const slots: StrategySlotVM[] = [{
      ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: strategyWithSlot,
      disabled: false, ruleDisabled: false, producedBy: [checkA],
      params: {}, nestedStrategies: [{ slotId: "merge_target", strategy: nestedStrategy, params: [], nested: [] }], collapsed: false,
    }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Region expansion via passage"));
    expect(onSelect).toHaveBeenCalledWith({ type: "nested_strategy", ruleId: "g1", path: [{ slotId: "merge_target", index: 0 }] });
  });

  it("a priority slot shows each entry's rank instead of a weight input, and clicking the up arrow reorders", () => {
    const first: StrategyVM = { id: "missing_loops_random", label: "missing_loops_random", handles: "k2", params: [], experimental: false, nestedSlots: [] };
    const second: StrategyVM = { id: "missing_loops_split", label: "missing_loops_split", handles: "k2", params: [], experimental: false, nestedSlots: [] };
    const topLevel: StrategyVM = {
      id: "priority_missing_loops", label: "Priority-fallback loop seeding", handles: "k1", params: [], experimental: false,
      nestedSlots: [{ slotId: "loop_seed_target", kind: "k2", min: 1, max: null, dispatchKind: "priority" }],
    };
    const slots: StrategySlotVM[] = [{
      ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: topLevel,
      disabled: false, ruleDisabled: false, producedBy: [checkA],
      params: {}, nestedStrategies: [
        { slotId: "loop_seed_target", strategy: first, params: [], nested: [] },
        { slotId: "loop_seed_target", strategy: second, params: [], nested: [] },
      ],
      collapsed: false,
    }];
    // The rendered slots above are a plain VM prop (not derived from the store), but
    // moveNestedStrategy itself acts on the real store — seed a matching "g1" rule there too, or
    // the click below would be a silent no-op against the untouched defaultRules() fixture.
    useMazeStore.setState({
      rules: [{
        id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 0,
        strategyId: "priority_missing_loops", disabled: false, ruleDisabled: false,
        params: {}, nestedStrategies: [
          { slotId: "loop_seed_target", strategyId: "missing_loops_random", params: {}, nested: [] },
          { slotId: "loop_seed_target", strategyId: "missing_loops_split", params: {}, nested: [] },
        ],
        collapsed: false,
      }],
    });
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);

    // Rank labels, not weight input — "Priority 1"/"Priority 2", no "Weight" label at all.
    expect(screen.getByText("Priority 1")).toBeInTheDocument();
    expect(screen.getByText("Priority 2")).toBeInTheDocument();
    expect(screen.queryByText("Weight")).not.toBeInTheDocument();

    // The first entry's "up" arrow must be disabled (already top rank); the second's "down"
    // arrow must likewise be disabled (already lowest rank).
    const upButtons = screen.getAllByTitle("Move up (higher priority)");
    const downButtons = screen.getAllByTitle("Move down (lower priority)");
    expect(upButtons[0]).toBeDisabled();
    expect(upButtons[1]).not.toBeDisabled();
    expect(downButtons[0]).not.toBeDisabled();
    expect(downButtons[1]).toBeDisabled();

    // The first entry's "down" arrow reorders it below the second.
    fireEvent.click(downButtons[0]);
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.nestedStrategies).toEqual([
      { slotId: "loop_seed_target", strategyId: "missing_loops_split", params: {}, nested: [] },
      { slotId: "loop_seed_target", strategyId: "missing_loops_random", params: {}, nested: [] },
    ]);

    // The (now second) entry's "up" arrow reorders it back above the first.
    const upButtonsAfter = screen.getAllByTitle("Move up (higher priority)");
    fireEvent.click(upButtonsAfter[1]);
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.nestedStrategies).toEqual([
      { slotId: "loop_seed_target", strategyId: "missing_loops_random", params: {}, nested: [] },
      { slotId: "loop_seed_target", strategyId: "missing_loops_split", params: {}, nested: [] },
    ]);
  });

  it("swapping a nested strategy at the same path shows the new strategy's own default param value, not a stale one", () => {
    const strategyA: StrategyVM = { id: "expand_region_passage", label: "expand_region_passage", handles: "k2", experimental: false, nestedSlots: [], params: [] };
    const strategyB: StrategyVM = {
      id: "teleport_region_merge", label: "teleport_region_merge", handles: "k2", experimental: false, nestedSlots: [],
      params: [{ id: "min_distance", label: "Minimum logical distance between teleport endpoints", kind: { type: "float", default: 1, min: 0, max: 1000 } }],
    };
    const topLevel: StrategyVM = {
      id: "s1", label: "Strategy One", handles: "k1", params: [], experimental: false,
      nestedSlots: [{ slotId: "slot_a", kind: "k2", min: 1, max: 1, dispatchKind: "unordered" }],
    };
    function slotsWith(nested: StrategyVM): StrategySlotVM[] {
      return [{
        ruleId: "g1", name: "Rule 1", kind: "k1", label: "Issue One", strategy: topLevel,
        disabled: false, ruleDisabled: false, producedBy: [checkA],
        params: {}, nestedStrategies: [{ slotId: "slot_a", strategy: nested, params: nested.params, nested: [] }], collapsed: false,
      }];
    }
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 0, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [{ slotId: "slot_a", strategyId: "teleport_region_merge", params: { min_distance: "1" }, nested: [] }], collapsed: false }],
    });
    const { rerender } = render(<RulesColumn stages={wrapStage(slotsWith(strategyA))} selection={null} onSelect={vi.fn()} />);
    rerender(<RulesColumn stages={wrapStage(slotsWith(strategyB))} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByDisplayValue("1")).toBeInTheDocument();
  });

  it("removing a rule with a selected nested_strategy inside it clears the selection", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={{ type: "nested_strategy", ruleId: "g1", path: [{ slotId: "slot_a", index: 0 }] }} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Remove rule"));
    fireEvent.click(screen.getByText("Ok"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("removing a rule with a selected check inside it clears the selection", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={{ type: "check", id: "g1:0" }} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Remove rule"));
    fireEvent.click(screen.getByText("Ok"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("removing a rule does not clear a selection belonging to a different rule", () => {
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={{ type: "nested_strategy", ruleId: "other_rule", path: [{ slotId: "slot_a", index: 0 }] }} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Remove rule"));
    fireEvent.click(screen.getByText("Ok"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders check params inline and commits changes to the store", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkWithParams], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    vi.runAllTimers();
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0)?.params.threshold).toBe("7");
    vi.useRealTimers();
  });

  it("flushes a pending check-param edit before removing the check, instead of dropping it", () => {
    vi.useFakeTimers();
    // checkWithParams (localId 0) is the one being edited and removed — its own pending edit is
    // necessarily discarded along with the instance itself, since params live inline on the
    // CheckInstance now (no separate global dict for them to survive in, unlike the old model).
    // checkB (localId 1) stays in the rule throughout, so it's the one that proves the flush
    // actually committed rather than being silently dropped by the unrelated removal.
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }, { localId: 1, typeId: "c2", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    const checkBWithParams: CheckVM = { ...checkWithParams, id: "g1:1", localId: 1, typeId: "c2", label: "Check Two" };
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkWithParams, checkBWithParams], params: {}, nestedStrategies: [], collapsed: false }];
    // LiveSlots, see comment in "removing a check..." above.
    render(<LiveSlots slots={slots} selection={null} onSelect={vi.fn()} />);
    const inputs = screen.getAllByDisplayValue("1") as HTMLInputElement[];
    fireEvent.change(inputs[1], { target: { value: "7" } });
    // Remove the other check immediately, well inside the 300ms debounce window — each row's
    // debounce/flush is scoped to its own useParamEditor instance, so removing row 0 must not
    // interfere with row 1's still-pending edit.
    fireEvent.click(screen.getAllByTitle("Remove")[0]);
    vi.runAllTimers();
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 1)?.params.threshold).toBe("7");
    vi.useRealTimers();
  });

  it("flushes a pending check-param edit before changing selection, instead of dropping it", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkWithParams], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={onSelect} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.click(screen.getByText("Check One"));
    expect(useMazeStore.getState().rules.find((r) => r.id === "g1")?.checks.find((c) => c.localId === 0)?.params.threshold).toBe("7");
    vi.useRealTimers();
  });

  it("flushes a pending strategy-param edit before opening the strategy edit dialog", () => {
    vi.useFakeTimers();
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s2", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
      strategyParams: {},
    });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: strategyWithParams, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByTitle("Edit strategy", { exact: false }));
    expect(useMazeStore.getState().strategyParams.s2?.weight).toBe("5");
    vi.useRealTimers();
  });

  it("opens strategy dialog via edit button", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("strategy-select-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit strategy", { exact: false }));
    expect(screen.getByTestId("strategy-select-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("strategy-select-dialog")).not.toBeInTheDocument();
  });

  it("toggles strategy disabled state via the strategy-panel toggle, keeping selection intact", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    // Four switches now: stage-level disabled (first), card-level ruleDisabled (second),
    // per-check disabled (third, one member check), and strategy-only disabled (fourth).
    fireEvent.click(screen.getAllByRole("checkbox")[3]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.disabled).toBe(true);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(false);
    expect(screen.getByText("Strategy One")).toBeInTheDocument();
  });

  it("toggles ruleDisabled via the card-level toggle, independent from the strategy toggle", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(true);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.disabled).toBe(false);
  });

  it("toggles a check's own disabled via its row toggle, independent from ruleDisabled/strategy disabled", () => {
    useMazeStore.setState({
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }, { localId: 1, typeId: "c2", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA, checkB], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    // stage (0), ruleDisabled (1), checkA's own toggle (2), checkB's own toggle (3), strategy (4).
    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    const g = useMazeStore.getState().rules.find((g) => g.id === "g1")!;
    expect(g.checks.find((c) => c.localId === 0)?.disabled).toBe(true);
    expect(g.checks.find((c) => c.localId === 1)?.disabled).toBe(false);
    expect(g.ruleDisabled).toBe(false);
    expect(g.disabled).toBe(false);
  });

  it("renders strategy params inline and commits changes to the store", () => {
    vi.useFakeTimers();
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s2", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }], strategyParams: {} });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: strategyWithParams, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    const input = screen.getByDisplayValue("1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    vi.runAllTimers();
    expect(useMazeStore.getState().strategyParams.s2?.weight).toBe("5");
    vi.useRealTimers();
  });

  it("renders the stage toggle and card-level toggle (not a strategy toggle) when rule has no strategy", () => {
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy: null, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    // stage toggle + card-level ruleDisabled toggle + one per-check toggle (checkA), no strategy toggle.
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("shows empty hint when no rules", () => {
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByText("Logging")).not.toBeInTheDocument();
  });

  it("opens the issue-select dialog via the bottom add-new-rule button, then the check dialog filtered to the picked issue", () => {
    useMazeStore.setState({ availableStrategies: [] });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("issue-select-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Add new rule"));
    expect(screen.getByTestId("issue-select-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("pick-k1"));
    expect(screen.queryByTestId("issue-select-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("check-select-dialog")).toHaveTextContent("k1");
  });

  it("Back from the check dialog returns to the issue-select dialog", () => {
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("go-back"));
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("issue-select-dialog")).toBeInTheDocument();
  });

  it("advances to the strategy dialog after picking checks, when a strategy handles the kind", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      availableStrategies: [{ id: "s1", handles: "k1", params: [], experimental: false, nested_slots: [] }],
    });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("pick-checks"));
    expect(screen.queryByTestId("check-select-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-rule-strategy-dialog")).toBeInTheDocument();
  });

  it("Back from the strategy dialog returns to the check dialog", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      availableStrategies: [{ id: "s1", handles: "k1", params: [], experimental: false, nested_slots: [] }],
    });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Add new rule"));
    fireEvent.click(screen.getByText("pick-k1"));
    fireEvent.click(screen.getByText("pick-checks"));
    fireEvent.click(screen.getByText("go-back-2"));
    expect(screen.queryByTestId("new-rule-strategy-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("check-select-dialog")).toBeInTheDocument();
  });

  it("creates the rule with the picked checks and strategy on strategy-dialog confirm", () => {
    useMazeStore.setState({
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      availableStrategies: [{ id: "s1", handles: "k1", params: [], experimental: false, nested_slots: [] }],
      rules: [],
    });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Add new rule"));
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
      availableChecks: [{ id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false }],
      availableStrategies: [],
      rules: [],
    });
    render(<RulesColumn stages={wrapStage([])} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Add new rule"));
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
        { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
        { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
      ],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
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
        { id: "c1", label: "Check One", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
        { id: "c2", label: "Check Two", description: "", issue_kinds: ["k1"], params: [], allow_multiple_instances: false },
      ],
      rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }],
    });
    const slots: StrategySlotVM[] = [
      { ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false },
    ];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    fireEvent.click(screen.getByText("Check Two"));
    fireEvent.click(screen.getByText("Add"));
    expect(useMazeStore.getState().rules).toEqual([
      { id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }, { localId: 1, typeId: "c2", params: {}, disabled: false }], nextLocalCheckId: 2, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false },
    ]);
  });

  it("shows an alert instead of an empty picker when no candidate checks are available", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add check"));
    expect(screen.getByText("All checks compatible with this rule are already added.")).toBeInTheDocument();
  });

  it("toggles ruleDisabled and visually dims the card title row", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.ruleDisabled).toBe(true);
  });

  it("renames a rule via the edit button's inline input, committed on Enter", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Rename rule"));
    const input = screen.getByDisplayValue("Rule 1");
    fireEvent.change(input, { target: { value: "My rule" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useMazeStore.getState().rules.find((g) => g.id === "g1")?.name).toBe("My rule");
  });

  it("removes a rule via the X button after confirming, clearing strategy selection for it", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const onSelect = vi.fn();
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    // LiveSlots, see comment in "removing a check..." above — removing the whole rule needs the
    // same store-tracking treatment.
    render(<LiveSlots slots={slots} selection={{ type: "strategy", ruleId: "g1", strategyId: "s1" }} onSelect={onSelect} />);
    fireEvent.click(screen.getByTitle("Remove rule"));
    fireEvent.click(screen.getByText("Ok"));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(useMazeStore.getState().rules).toEqual([]);
  });

  it("cancelling the remove-rule confirmation leaves the rule intact", () => {
    useMazeStore.setState({ rules: [{ id: "g1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "c1", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: "s1", disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false }] });
    const slots: StrategySlotVM[] = [{ ruleId: "g1", name: "Rule 1", kind: "k1", label: "Kind One", strategy, disabled: false, ruleDisabled: false, producedBy: [checkA], params: {}, nestedStrategies: [], collapsed: false }];
    render(<RulesColumn stages={wrapStage(slots)} selection={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Remove rule"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(useMazeStore.getState().rules).toHaveLength(1);
  });
});
