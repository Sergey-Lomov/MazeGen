import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import type { QcRuleState } from "../store/qcRuleTypes";
import { buildZoneScopesWire, zoneScopeHasNoZones, zoneScopeProblem, zoneScopeUnsupported } from "../domain/qcZoneScope";
import { problematicRuleCount, ruleIsSendable } from "../store/qcDerivedProblems";
import { baseStoreState, makeRule } from "./storeTestHelpers";

const zone = (id: number, cells: Zone["cells"]): Zone => ({ id, name: `Z${id}`, kind: "manual", cells });
const zones = [zone(1, [[0, 0, 0], [0, 1, 0]]), zone(2, [[0, 1, 0], [0, 2, 0]]), zone(3, [])];
const groups = [{ id: 7, name: "G", zoneIds: [1, 2] }];
const checks = [{ localId: 0, typeId: "c", params: {}, disabled: false }];
const scoped = (zoneScope: NonNullable<QcRuleState["zoneScope"]>): Pick<QcRuleState, "zoneScope"> => ({ zoneScope });

describe("zone scope wire (GitHub issue #1039)", () => {
  it("is absent for a rule without a zone scope", () => {
    expect(buildZoneScopesWire({}, zones, groups)).toBeUndefined();
  });

  it("makes a zone one scope and keeps a zone without cells", () => {
    expect(buildZoneScopesWire(scoped({ kind: "zone", id: 1 }), zones, groups)).toEqual([{ id: "zone:1", cells: [[0, 0, 0], [0, 1, 0]] }]);
    expect(buildZoneScopesWire(scoped({ kind: "zone", id: 3 }), zones, groups)).toEqual([{ id: "zone:3", cells: [] }]);
  });

  it("merges the zones of a union group into one scope without repeating shared cells", () => {
    const wire = buildZoneScopesWire(scoped({ kind: "group", id: 7, mode: "union" }), zones, groups);
    expect(wire).toEqual([{ id: "group:7", cells: [[0, 0, 0], [0, 1, 0], [0, 2, 0]] }]);
  });

  it("splits an iteration group into one scope per zone", () => {
    const wire = buildZoneScopesWire(scoped({ kind: "group", id: 7, mode: "iteration" }), zones, groups);
    expect(wire?.map((s) => s.id)).toEqual(["zone:1", "zone:2"]);
  });

  it("gives an empty list for a target that no longer exists", () => {
    expect(buildZoneScopesWire(scoped({ kind: "zone", id: 99 }), zones, groups)).toEqual([]);
    expect(buildZoneScopesWire(scoped({ kind: "group", id: 99, mode: "union" }), zones, groups)).toEqual([]);
  });
});

describe("zone scope problem (GitHub issue #1039)", () => {
  it("fires only when the bound zone or group no longer exists", () => {
    expect(zoneScopeHasNoZones({}, zones, groups)).toBe(false);
    expect(zoneScopeHasNoZones(scoped({ kind: "zone", id: 99 }), zones, groups)).toBe(true);
    expect(zoneScopeHasNoZones(scoped({ kind: "group", id: 99, mode: "union" }), zones, groups)).toBe(true);
    expect(zoneScopeHasNoZones(scoped({ kind: "zone", id: 1 }), zones, groups)).toBe(false);
    expect(zoneScopeHasNoZones(scoped({ kind: "group", id: 7, mode: "union" }), zones, groups)).toBe(false);
    // Why it has nothing: deleted ("missing") or still there but without cells ("empty").
    const hollowZones = [{ id: 1, name: "", kind: "manual" as const, cells: [] }];
    expect(zoneScopeProblem(scoped({ kind: "zone", id: 99 }), hollowZones, [])).toBe("missing");
    expect(zoneScopeProblem(scoped({ kind: "zone", id: 1 }), hollowZones, [])).toBe("empty");
    expect(zoneScopeProblem(scoped({ kind: "group", id: 5, mode: "union" }), hollowZones, [{ id: 5, name: "", zoneIds: [] }])).toBe("empty");
    expect(zoneScopeProblem({}, hollowZones, [])).toBeNull();
    // A zone with no cell has nothing to scope to either, alone or as the only member of a group.
    const hollow = [{ id: 1, name: "", kind: "manual" as const, cells: [] }];
    expect(zoneScopeHasNoZones(scoped({ kind: "zone", id: 1 }), hollow, [{ id: 7, name: "", zoneIds: [1] }])).toBe(true);
    expect(zoneScopeHasNoZones(scoped({ kind: "group", id: 7, mode: "union" }), hollow, [{ id: 7, name: "", zoneIds: [1] }])).toBe(true);
  });

  it("keeps such a rule out of the config and counts it as problematic", () => {
    const rule = { checks, ...scoped({ kind: "zone", id: 99 }) };
    expect(ruleIsSendable(rule, zones, groups)).toBe(false);
    expect(ruleIsSendable({ checks }, zones, groups)).toBe(true);
    expect(problematicRuleCount([{ id: "a", ...rule }, { id: "b", checks }], [], [], zones, groups)).toBe(1);
  });
});

describe("rule zone scope action", () => {
  const s = () => useMazeStore.getState();
  const scopeOf = (id: string) => s().rules.find((r) => r.id === id)?.zoneScope;

  beforeEach(() => {
    useMazeStore.setState({
      ...baseStoreState(),
      ...zonesInitialState,
      zones: [zone(1, [[0, 0, 0]]), zone(2, [[0, 1, 1]])],
      zoneGroups: [{ id: 7, name: "G", zoneIds: [1, 2] }],
      rules: [makeRule({ id: "a" }), makeRule({ id: "b" })],
    });
  });

  it("binds a rule to one target, replaces it on the next pick and unbinds to the whole map", () => {
    s().setRuleZoneScope("a", { kind: "zone", id: 1 });
    s().setRuleZoneScope("a", { kind: "group", id: 7, mode: "iteration" });
    expect(scopeOf("a")).toEqual({ kind: "group", id: 7, mode: "iteration" });
    expect(scopeOf("b")).toBeUndefined();
    s().setRuleZoneScope("a", null);
    expect("zoneScope" in s().rules[0]).toBe(false);
  });

  it("keeps the binding of a deleted zone or group, so the rule warns instead of widening", () => {
    s().setRuleZoneScope("a", { kind: "zone", id: 1 });
    s().setRuleZoneScope("b", { kind: "group", id: 7, mode: "union" });
    s().removeZone(1);
    s().removeZoneGroup(7);
    expect(scopeOf("a")).toEqual({ kind: "zone", id: 1 });
    expect(zoneScopeHasNoZones(s().rules[0], s().zones, s().zoneGroups)).toBe(true);
    expect(zoneScopeHasNoZones(s().rules[1], s().zones, s().zoneGroups)).toBe(true);
  });
});

describe("zoneScopeUnsupported", () => {
  const descriptors = [{ id: "unreachable_finish", zone_scope_unsupported: true }, { id: "max_dead_end_count" }];
  it("is set for a rule holding a whole-maze check", () => {
    expect(zoneScopeUnsupported({ checks: [{ typeId: "unreachable_finish" }] }, descriptors)).toBe(true);
  });
  it("is clear for a rule of checks a zone can narrow, or without checks", () => {
    expect(zoneScopeUnsupported({ checks: [{ typeId: "max_dead_end_count" }] }, descriptors)).toBe(false);
    expect(zoneScopeUnsupported({ checks: [] }, descriptors)).toBe(false);
  });
});
