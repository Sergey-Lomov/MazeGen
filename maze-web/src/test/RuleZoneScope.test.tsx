import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RuleZoneScopeDialog } from "../components/dialogs/RuleZoneScopeDialog";
import { RuleZoneScope } from "../components/features/quality/RuleZoneScope";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import { baseStoreState, makeRule } from "./storeTestHelpers";
import * as m from "~/paraglide/messages";

const zones: Zone[] = [{ id: 2, name: "Beta", kind: "manual", cells: [[0, 1, 0]] }];
const groups = [{ id: 7, name: "Team", zoneIds: [2] }];

beforeEach(() => useMazeStore.setState({ ...baseStoreState(), ...zonesInitialState, zones, zoneGroups: groups, rules: [makeRule({ id: "a" })] }));

describe("rule zone scope dialog (GitHub issue #1039)", () => {
  const rule = () => useMazeStore.getState().rules[0];

  it("binds a group with the chosen mode and closes", () => {
    const onClose = vi.fn();
    render(<RuleZoneScopeDialog ruleId="a" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: m["zones.target_mode_groups"]() }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "iteration" } });
    fireEvent.click(screen.getByTestId("zone-group-cell"));
    expect(rule().zoneScope).toEqual({ kind: "group", id: 7, mode: "iteration" });
    expect(onClose).toHaveBeenCalled();
  });

  it("enables deleting the restriction only while the rule has one", () => {
    const { unmount } = render(<RuleZoneScopeDialog ruleId="a" onClose={() => {}} />);
    expect(screen.getByText(m["quality.zone_scope_delete"]())).toBeDisabled();
    unmount();
    useMazeStore.getState().setRuleZoneScope("a", { kind: "zone", id: 2 });
    const onClose = vi.fn();
    render(<RuleZoneScopeDialog ruleId="a" onClose={onClose} />);
    fireEvent.click(screen.getByText(m["quality.zone_scope_delete"]()));
    expect(rule().zoneScope).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("rule zone scope caption", () => {
  const scope = (target: Parameters<ReturnType<typeof useMazeStore.getState>["setRuleZoneScope"]>[1]) => {
    useMazeStore.getState().setRuleZoneScope("a", target);
    render(<RuleZoneScope ruleId="a" />);
    return screen.getByTestId("rule-zone-scope").textContent ?? "";
  };

  it("shows nothing for a rule on the whole map", () => {
    const { container } = render(<RuleZoneScope ruleId="a" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the kind of binding and the target", () => {
    expect(scope({ kind: "zone", id: 2 })).toBe(`${m["quality.zone_scope_zone"]()}Beta`);
  });

  it("names a union group", () => {
    expect(scope({ kind: "group", id: 7, mode: "union" })).toBe(`${m["quality.zone_scope_group"]()}Team`);
  });

  it("tells a group taken zone by zone", () => {
    expect(scope({ kind: "group", id: 7, mode: "iteration" })).toBe(`${m["quality.zone_scope_each"]()}Team`);
  });

  it("shows a deleted zone as missing", () => {
    useMazeStore.getState().setRuleZoneScope("a", { kind: "zone", id: 2 });
    useMazeStore.getState().removeZone(2);
    render(<RuleZoneScope ruleId="a" />);
    expect(screen.getByTestId("rule-zone-scope").textContent).toContain(m["quality.zone_scope_missing"]());
  });
});
