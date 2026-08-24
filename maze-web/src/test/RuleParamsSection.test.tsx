import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RuleParamsSection } from "../components/features/quality/RuleParamsSection";
import { useMazeStore } from "../store/mazeStore";
import type { StrategySlotVM, StrategyVM, CheckVM } from "../components/features/useQualityViewModel";
import type { RuleParamDescriptor } from "../wasm/types";

const protectRouteParam: RuleParamDescriptor = {
  id: "protect_route",
  label: "Protect start-finish route",
  kind: { type: "bool", default: true },
  applies_to: ["teleport_waypoint_distance", "teleport_group_select"],
};

function makeCheck(typeId: string): CheckVM {
  return { id: `g1:${typeId}`, ruleId: "g1", localId: 0, typeId, label: typeId, cardLabel: typeId, description: "", params: [], disabled: false };
}

function makeStrategy(id: string): StrategyVM {
  return { id, label: id, handles: "k1", params: [], experimental: false, nestedSlots: [] };
}

function makeSlot(overrides: Partial<StrategySlotVM> = {}): StrategySlotVM {
  return {
    ruleId: "g1",
    name: "Rule 1",
    kind: "k1",
    label: "Kind One",
    strategy: null,
    disabled: false,
    ruleDisabled: false,
    producedBy: [],
    nestedStrategies: [],
    params: {},
    collapsed: false,
    ...overrides,
  };
}

beforeEach(() => {
  useMazeStore.setState({ availableRuleParams: [protectRouteParam], rules: [] });
});

describe("RuleParamsSection", () => {
  it("renders nothing when no rule param applies to this rule's own checks/strategy", () => {
    // min_region_count isn't in protect_route's applies_to — no panel should render.
    const slot = makeSlot({ producedBy: [makeCheck("min_region_count")] });
    const { container } = render(<RuleParamsSection slot={slot} selection={null} onSelectParam={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the panel when a member check is in the param's applies_to", () => {
    const slot = makeSlot({ producedBy: [makeCheck("teleport_waypoint_distance")] });
    render(<RuleParamsSection slot={slot} selection={null} onSelectParam={() => {}} />);
    expect(screen.getByText("Protect start-finish route")).toBeInTheDocument();
  });

  it("renders the panel when the rule's strategy (not any check) is in the param's applies_to", () => {
    const slot = makeSlot({ producedBy: [makeCheck("min_region_count")], strategy: makeStrategy("teleport_group_select") });
    render(<RuleParamsSection slot={slot} selection={null} onSelectParam={() => {}} />);
    expect(screen.getByText("Protect start-finish route")).toBeInTheDocument();
  });

  it("resolves the display label via i18n instead of the raw wasm descriptor label", () => {
    // The store descriptor's own `label` is a debug/fallback-only value (see check_descriptor.rs's
    // doc comment) — the real UI text always comes from qualityI18n's resolveParamLabel, keyed by
    // id. Give the descriptor an obviously-wrong raw label; the resolved i18n text must win.
    useMazeStore.setState({ availableRuleParams: [{ ...protectRouteParam, label: "RAW_LABEL_SHOULD_NOT_APPEAR" }] });
    const slot = makeSlot({ producedBy: [makeCheck("teleport_waypoint_distance")] });
    render(<RuleParamsSection slot={slot} selection={null} onSelectParam={() => {}} />);
    expect(screen.queryByText("RAW_LABEL_SHOULD_NOT_APPEAR")).not.toBeInTheDocument();
    expect(screen.getByText("Protect start-finish route")).toBeInTheDocument();
  });

  it("reads the initial value from the rule's own params, defaulting to the descriptor default when unset", () => {
    const slotUnset = makeSlot({ producedBy: [makeCheck("teleport_waypoint_distance")], params: {} });
    const { unmount } = render(<RuleParamsSection slot={slotUnset} selection={null} onSelectParam={() => {}} />);
    const toggle = screen.getByRole("checkbox") as HTMLInputElement;
    expect(toggle.checked).toBe(true); // default: true
    unmount();

    const slotSet = makeSlot({ producedBy: [makeCheck("teleport_waypoint_distance")], params: { protect_route: "false" } });
    render(<RuleParamsSection slot={slotSet} selection={null} onSelectParam={() => {}} />);
    const toggle2 = screen.getByRole("checkbox") as HTMLInputElement;
    expect(toggle2.checked).toBe(false);
  });

  it("commits a value change to the owning rule via setRuleParam, not some other rule", async () => {
    useMazeStore.setState({
      rules: [
        { id: "g1", name: "Rule 1", kind: "k1", checks: [], nextLocalCheckId: 0, strategyId: null, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false },
        { id: "g2", name: "Rule 2", kind: "k1", checks: [], nextLocalCheckId: 0, strategyId: null, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false },
      ],
    });
    const slot = makeSlot({ ruleId: "g1", producedBy: [makeCheck("teleport_waypoint_distance")] });
    render(<RuleParamsSection slot={slot} selection={null} onSelectParam={() => {}} />);
    const toggle = screen.getByRole("checkbox");
    fireEvent.click(toggle);
    // useParamEditor debounces the commit (300ms) — wait for it rather than asserting immediately.
    await waitFor(() => {
      const rules = useMazeStore.getState().rules;
      expect(rules.find((r) => r.id === "g1")?.params.protect_route).toBe("false");
    });
    expect(useMazeStore.getState().rules.find((r) => r.id === "g2")?.params.protect_route).toBeUndefined();
  });
});
