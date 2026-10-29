import { describe, it, expect } from "vitest";
import { parseAndValidate } from "../store/projectExport";
import { makeState, toJson } from "./projectExportKit";

describe("parseAndValidate — legacy files missing optional sections", () => {
  it("defaults dirtyFlags, debug, and ui sections when absent", () => {
    const data = valid_without_optional_sections();
    const result = parseAndValidate(data);
    expect(result.dirtyFlags).toEqual({ postEdit: false, field: false, presets: false, maze: false });
    expect(result.debug).toEqual({
      debugMode: false,
      debugStep: 0,
      debugAutoPlayDelay: 200,
    });
    expect(result.ui).toEqual({
      showPresetOrigin: false,
      showPresetLocks: true,
      showFieldOrigin: true,
      openCard: "basic_config",
      postEditAutoConfirm: true,
    });
  });

  it("defaults floorFields.<floorId>.savedShapes to empty array when absent", () => {
    const data = valid_without_optional_sections();
    const result = parseAndValidate(data);
    expect(result.floorFields.floor_1.savedShapes).toEqual([]);
  });

  it("falls back to basic_config when ui.openCard is not a valid FeatureId", () => {
    const data = valid_without_optional_sections();
    data.ui = { openCard: "not_a_real_card" };
    const result = parseAndValidate(data);
    expect(result.ui.openCard).toBe("basic_config");
  });

  it("round-trips quality.rules", () => {
    const data = valid_without_optional_sections();
    const result = parseAndValidate(data);
    expect(result.quality.rules).toEqual([{ id: "rule_1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: { param_a: "1" }, disabled: false }], strategyId: "strategy_a", strategyParams: { param_b: "2" }, disabled: false, ruleDisabled: false, nestedStrategies: [], params: {}, collapsed: false }]);
  });

  it("copies legacy shared strategy params to every matching rule", () => {
    const data = valid_without_optional_sections();
    const quality = data.quality as { rules: Record<string, unknown>[]; stages?: unknown; strategyParams?: unknown };
    const firstRule = quality.rules[0];
    delete firstRule.strategyParams;
    quality.rules.push({ ...firstRule, id: "rule_2" });
    delete quality.stages;
    quality.strategyParams = { strategy_a: { param_b: "2" } };

    const result = parseAndValidate(data);

    expect(result.quality.rules.map((rule) => rule.strategyParams)).toEqual([
      { param_b: "2" },
      { param_b: "2" },
    ]);
  });

  it("defaults check disabled to false when absent (pre-toggle project files)", () => {
    const data = valid_without_optional_sections();
    delete (data.quality as { rules: { checks: Record<string, unknown>[] }[] }).rules[0].checks[0].disabled;
    const result = parseAndValidate(data);
    expect(result.quality.rules[0].checks[0].disabled).toBe(false);
  });

  it("defaults rule name to null when absent (pre-naming project files) — VM resolves it to the issue kind's live-locale label", () => {
    const data = valid_without_optional_sections();
    delete (data.quality as { rules: Record<string, unknown>[] }).rules[0].name;
    const result = parseAndValidate(data);
    expect(result.quality.rules[0].name).toBeNull();
  });

  it("drops rules with no kind (pre-kind project files — can never accept a check again)", () => {
    const data = valid_without_optional_sections();
    delete (data.quality as { rules: Record<string, unknown>[] }).rules[0].kind;
    const result = parseAndValidate(data);
    expect(result.quality.rules).toEqual([]);
  });

  it("rejects a rule with duplicate localId among its checks", () => {
    const data = valid_without_optional_sections();
    const rule = (data.quality as { rules: Record<string, unknown>[] }).rules[0];
    const check = (rule.checks as Record<string, unknown>[])[0];
    rule.checks = [check, { ...check, typeId: "check_b" }];
    expect(() => parseAndValidate(data)).toThrow(/Duplicate localId/);
  });

  // --- Stages (GitHub issue #65) ---

  it("recovers a single stage covering every rule when quality.stages is absent (legacy file)", () => {
    const data = valid_without_optional_sections();
    delete (data.quality as { stages?: unknown }).stages;
    const result = parseAndValidate(data);
    expect(result.quality.stages).toEqual([{ id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false, collapsed: false }]);
  });

  it("rejects quality.stages when a known rule is not assigned to any stage", () => {
    const data = valid_without_optional_sections();
    (data.quality as { stages: unknown }).stages = [{ id: "stage_1", name: "Stage 1", ruleIds: [] }];
    expect(() => parseAndValidate(data)).toThrow(/not assigned to any stage/);
  });

  it("rejects quality.stages when a rule id appears in more than one stage", () => {
    const data = valid_without_optional_sections();
    (data.quality as { stages: unknown }).stages = [
      { id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"] },
      { id: "stage_2", name: "Stage 2", ruleIds: ["rule_1"] },
    ];
    expect(() => parseAndValidate(data)).toThrow(/appears in more than one stage/);
  });

  // --- generationSourceMode (GitHub issue #640) ---

  it("defaults presets.generationSourceMode to 'default' when absent (pre-#640 project files)", () => {
    const data = valid_without_optional_sections();
    delete (data.presets as Record<string, unknown>).generationSourceMode;
    const result = parseAndValidate(data);
    expect(result.presets.generationSourceMode).toBe("default");
  });

  it("falls back presets.generationSourceMode to 'default' on a garbage value", () => {
    const data = valid_without_optional_sections();
    (data.presets as Record<string, unknown>).generationSourceMode = "not_a_real_mode";
    const result = parseAndValidate(data);
    expect(result.presets.generationSourceMode).toBe("default");
  });

  it("silently scrubs a stage's reference to a rule dropped by the kind-drop recovery", () => {
    const data = valid_without_optional_sections();
    delete (data.quality as { rules: Record<string, unknown>[] }).rules[0].kind;
    (data.quality as { stages: unknown }).stages = [{ id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"] }];
    const result = parseAndValidate(data);
    expect(result.quality.rules).toEqual([]);
    expect(result.quality.stages).toEqual([{ id: "stage_1", name: "Stage 1", ruleIds: [], disabled: false, collapsed: false }]);
  });

  it("round-trips quality.stages", () => {
    const data = valid_without_optional_sections();
    const result = parseAndValidate(data);
    expect(result.quality.stages).toEqual([{ id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false, collapsed: false }]);
  });

  // --- Floors (GitHub issue #335) ---

  it("defaults to a single floor when floors is absent (pre-floors project files)", () => {
    const data = valid_without_optional_sections();
    delete data.floors;
    const result = parseAndValidate(data);
    expect(result.floors.floors).toHaveLength(1);
    expect(result.floors.floors[0].title).toBe("Floor 1");
    expect(result.floors.nextFloorNumber).toBe(2);
  });

  it("round-trips floors", () => {
    const data = valid_without_optional_sections();
    const result = parseAndValidate(data);
    expect(result.floors).toEqual({ floors: [{ id: "floor_1", title: "Floor 1" }], nextFloorNumber: 2, activeFloorId: "floor_1" });
  });

  it("round-trips a customized floor title", () => {
    const data = valid_without_optional_sections();
    (data.floors as { floors: unknown[] }).floors = [{ id: "floor_1", title: "Ground", titleCustomized: true }];
    const result = parseAndValidate(data);
    expect(result.floors.floors).toEqual([{ id: "floor_1", title: "Ground", titleCustomized: true }]);
  });

  it("drops a malformed floor entry (missing title) and keeps the rest", () => {
    const data = valid_without_optional_sections();
    (data.floors as { floors: unknown[] }).floors = [
      { id: "floor_1", title: "Floor 1" },
      { id: "floor_2" }, // missing title
    ];
    const result = parseAndValidate(data);
    expect(result.floors.floors).toEqual([{ id: "floor_1", title: "Floor 1" }]);
  });

  it("falls back to a single default floor when every entry is malformed", () => {
    const data = valid_without_optional_sections();
    (data.floors as { floors: unknown[] }).floors = [{ id: "floor_1" }];
    const result = parseAndValidate(data);
    expect(result.floors.floors).toHaveLength(1);
    expect(result.floors.floors[0].title).toBe("Floor 1");
  });

  it("drops a floor entry sharing an id with an earlier entry", () => {
    const data = valid_without_optional_sections();
    (data.floors as { floors: unknown[] }).floors = [
      { id: "floor_1", title: "Floor 1" },
      { id: "floor_1", title: "Duplicate Id" },
      { id: "floor_2", title: "Floor 2" },
    ];
    const result = parseAndValidate(data);
    expect(result.floors.floors).toEqual([
      { id: "floor_1", title: "Floor 1" },
      { id: "floor_2", title: "Floor 2" },
    ]);
  });

  it("falls back to floors[0].id when activeFloorId names an unknown/dropped floor", () => {
    const data = valid_without_optional_sections();
    (data.floors as Record<string, unknown>).activeFloorId = "floor_does_not_exist";
    const result = parseAndValidate(data);
    expect(result.floors.activeFloorId).toBe("floor_1");
  });

  it("falls back to floors[0].id when activeFloorId is absent (pre-#354 file)", () => {
    const data = valid_without_optional_sections();
    delete (data.floors as Record<string, unknown>).activeFloorId;
    const result = parseAndValidate(data);
    expect(result.floors.activeFloorId).toBe("floor_1");
  });

  function valid_without_optional_sections(): Record<string, unknown> {
    const data = toJson(makeState());
    delete data.dirtyFlags;
    delete data.debug;
    delete data.ui;
    delete data.floorFields.floor_1.savedShapes;
    return data;
  }
});