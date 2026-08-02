import { describe, it, expect } from "vitest";
import { leafKind, resolveTimingRowLabel } from "../components/features/AnalyticsFeature";

describe("leafKind", () => {
  it("resolves a known check id to check", () => {
    const checkIds = new Set(["min_loop_length"]);
    expect(leafKind("min_loop_length", checkIds)).toBe("check");
  });

  it("resolves an id absent from availableChecks to strategy", () => {
    const checkIds = new Set(["min_loop_length"]);
    expect(leafKind("invalid_loop_random", checkIds)).toBe("strategy");
  });

  it("resolves any id to strategy when checkIds is empty", () => {
    expect(leafKind("anything", new Set())).toBe("strategy");
  });
});

describe("resolveTimingRowLabel", () => {
  it("returns the id verbatim for a root row (already-localized label)", () => {
    expect(resolveTimingRowLabel("root", "Initial generation", new Map(), new Map())).toBe("Initial generation");
  });

  it("prefixes a stage row with the resolved stage name", () => {
    const stageNames = new Map([["s1", "Waypoints"]]);
    expect(resolveTimingRowLabel("stage", "s1", stageNames, new Map())).toContain("Waypoints");
  });

  it("falls back to the raw id when a stage name is unknown", () => {
    expect(resolveTimingRowLabel("stage", "unknown_stage", new Map(), new Map())).toContain("unknown_stage");
  });

  it("prefixes a rule row with the resolved rule name", () => {
    const ruleNames = new Map([["r1", "Fix loops"]]);
    expect(resolveTimingRowLabel("rule", "r1", new Map(), ruleNames)).toContain("Fix loops");
  });

  it("falls back to the raw id when a rule name is unknown", () => {
    expect(resolveTimingRowLabel("rule", "unknown_rule", new Map(), new Map())).toContain("unknown_rule");
  });

  it("falls back to the raw id for an unregistered check id", () => {
    expect(resolveTimingRowLabel("check", "totally_unknown_check", new Map(), new Map())).toContain("totally_unknown_check");
  });

  it("falls back to the raw id for an unregistered strategy id", () => {
    expect(resolveTimingRowLabel("strategy", "totally_unknown_strategy", new Map(), new Map())).toContain("totally_unknown_strategy");
  });
});
