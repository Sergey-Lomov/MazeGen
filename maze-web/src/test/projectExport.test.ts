import { describe, it, expect } from "vitest";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import type { MazeState, PostEditEdge } from "../store/mazeStore";

function makeState(overrides: Partial<MazeState> = {}): MazeState {
  const base = {
    tessellationConfig: { type: "square", width: 5, height: 5 },
    savedConfigs: {},
    seed: 42,
    randomSeed: false,
    initialConfig: { method: "recursive_backtracker" },
    elementsConfig: {},
    rules: [{ id: "rule_1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: { param_a: "1" } }], nextLocalCheckId: 1, strategyId: "strategy_a", disabled: false, ruleDisabled: false, nestedStrategies: [] }],
    stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false }],
    strategyParams: { strategy_a: { param_b: "2" } },
    repairMaxIterations: 10,
    repairTimeBudgetSecs: null,
    presetConnections: new Map(),
    lockedNodes: new Map(),
    defaultEdgeState: "undefined",
    autoLock: true,
    presetStart: [1, 2],
    presetFinish: [3, 4],
    presetGenSource: null,
    presetTeleports: [],
    postEditDirty: false,
    postEditDraftEdges: null,
    postEditDraftMeta: null,
    postEditDraftTeleports: [],
    fieldDirty: false,
    presetsDirty: false,
    mazeDirty: false,
    showMazeOverlay: true,
    showComponentsOverlay: false,
    showGraphOverlay: false,
    showNavGraphOverlay: false,
    showPureCyclesOverlay: false,
    showRouteOverlay: false,
    showRegionClassesOverlay: false,
    analyticsSectionsExpanded: { layers: true },
    debugMode: false,
    showDebugFrontier: true,
    debugStep: 0,
    debugAutoPlayDelay: 200,
    showPresetOrigin: false,
    showFieldOrigin: true,
    openCard: "basic_config",
    postEditAutoConfirm: true,
  };
  return { ...base, ...overrides } as unknown as MazeState;
}

describe("serializeProject / parseAndValidate round-trip", () => {
  it("round-trips a default state", () => {
    const state = makeState();
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed).toEqual(serialized);
  });

  it("round-trips explicitly disabled repair limits (both null), not the default", () => {
    const state = makeState({ repairMaxIterations: null, repairTimeBudgetSecs: null });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.quality.repairMaxIterations).toBeNull();
    expect(reparsed.quality.repairTimeBudgetSecs).toBeNull();
  });

  it("defaults showPureCyclesOverlay/showRegionClassesOverlay for a project file saved before these toggles existed", () => {
    const state = makeState({ showPureCyclesOverlay: true, showRegionClassesOverlay: true });
    const serialized = serializeProject(state);
    const raw = JSON.parse(JSON.stringify(serialized));
    delete raw.analytics.showPureCyclesOverlay;
    delete raw.analytics.showRegionClassesOverlay;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.analytics.showPureCyclesOverlay).toBe(false);
    expect(reparsed.analytics.showRegionClassesOverlay).toBe(false);
  });

  it("defaults repair limits for a project file saved before this setting existed", () => {
    const state = makeState();
    const serialized = serializeProject(state);
    const raw = JSON.parse(JSON.stringify(serialized));
    delete raw.quality.repairMaxIterations;
    delete raw.quality.repairTimeBudgetSecs;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.quality.repairMaxIterations).toBe(10);
    expect(reparsed.quality.repairTimeBudgetSecs).toBeNull();
  });

  it("round-trips dirty post-edit draft edges", () => {
    const edges: Record<string, PostEditEdge> = {
      "0-1": { from: 0, to: 1, kind: "basic" },
      "1-2": { from: 1, to: 2, kind: "one_way_forward" },
    };
    const state = makeState({
      postEditDirty: true,
      postEditDraftEdges: edges,
      postEditDraftMeta: { start: 0, finish: 2 },
    });
    const serialized = serializeProject(state);
    expect(serialized.postEdit).not.toBeNull();
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit).toEqual(serialized.postEdit);
  });

  it("round-trips dirty post-edit teleports", () => {
    const state = makeState({
      postEditDirty: true,
      postEditDraftEdges: {},
      postEditDraftMeta: null,
      postEditDraftTeleports: [
        { id: 1, from: 0, to: 2, direction: "forward" },
        { id: 2, from: 1, to: 3, direction: "two_way" },
      ],
    });
    const serialized = serializeProject(state);
    expect(serialized.postEdit).not.toBeNull();
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit?.teleports).toEqual(serialized.postEdit?.teleports);
  });

  it("defaults postEdit.teleports to empty array for a project file saved before post-edit teleport editing existed", () => {
    const state = makeState({ postEditDirty: true, postEditDraftEdges: {}, postEditDraftMeta: null });
    const data = JSON.parse(JSON.stringify(serializeProject(state)));
    delete data.postEdit.teleports;
    const result = parseAndValidate(data);
    expect(result.postEdit?.teleports).toEqual([]);
  });

  it("postEdit is null when not dirty", () => {
    const state = makeState({ postEditDirty: false });
    const serialized = serializeProject(state);
    expect(serialized.postEdit).toBeNull();
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit).toBeNull();
  });

  it("round-trips preset connections and locked nodes", () => {
    const state = makeState({
      presetConnections: new Map([
        ["0,0-1,0", { from: [0, 0], to: [1, 0], state: "passage", source: "user" }],
      ]),
      lockedNodes: new Map([["2,3", "both"]]),
    });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.presets.connections).toEqual(serialized.presets.connections);
    expect(reparsed.presets.lockedNodes).toEqual(serialized.presets.lockedNodes);
  });

  it("round-trips preset teleports", () => {
    const state = makeState({
      presetTeleports: [
        { id: 1, from: [0, 0], to: [2, 2], direction: "forward" },
        { id: 2, from: [1, 1], to: [3, 3], direction: "two_way" },
      ],
    });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.presets.teleports).toEqual(serialized.presets.teleports);
  });

  it("defaults presets.teleports to empty array for a project file saved before teleports existed", () => {
    const data = JSON.parse(JSON.stringify(serializeProject(makeState())));
    delete data.presets.teleports;
    const result = parseAndValidate(data);
    expect(result.presets.teleports).toEqual([]);
  });
});

describe("parseAndValidate — malformed input", () => {
  const valid = () => JSON.parse(JSON.stringify(serializeProject(makeState())));

  it("throws on missing version", () => {
    const data = valid();
    delete data.version;
    expect(() => parseAndValidate(data)).toThrow();
  });

  it("throws on version newer than supported", () => {
    const data = valid();
    data.version = 999;
    expect(() => parseAndValidate(data)).toThrow(/newer than supported/);
  });

  it("throws on unknown tessellation type", () => {
    const data = valid();
    data.tessellation.config.type = "not_a_real_type";
    expect(() => parseAndValidate(data)).toThrow(/Unknown tessellation config type/);
  });

  it("throws on invalid hex orientation", () => {
    const data = valid();
    data.tessellation.config = { type: "hex_parallelogram", cols: 3, rows: 3, orientation: "sideways" };
    expect(() => parseAndValidate(data)).toThrow(/Invalid hex orientation/);
  });

  it("throws on invalid postEditEdge kind", () => {
    const data = valid();
    data.postEdit = { edges: [["0-1", { from: 0, to: 1, kind: "bogus" }]], meta: null };
    expect(() => parseAndValidate(data)).toThrow(/Invalid PostEditEdge kind/);
  });

  it("throws on invalid defaultEdgeState", () => {
    const data = valid();
    data.presets.defaultEdgeState = "bogus";
    expect(() => parseAndValidate(data)).toThrow(/Invalid defaultEdgeState/);
  });

  it("throws on duplicate teleport id", () => {
    const data = valid();
    data.presets.teleports = [
      { id: 1, from: [0, 0], to: [2, 2], direction: "forward" },
      { id: 1, from: [1, 1], to: [3, 3], direction: "two_way" },
    ];
    expect(() => parseAndValidate(data)).toThrow(/Duplicate teleport id/);
  });

  it("throws on duplicate post-edit teleport id", () => {
    const data = valid();
    data.postEdit = {
      edges: [],
      meta: null,
      teleports: [
        { id: 1, from: 0, to: 2, direction: "forward" },
        { id: 1, from: 1, to: 3, direction: "two_way" },
      ],
    };
    expect(() => parseAndValidate(data)).toThrow(/Duplicate teleport id/);
  });

  it("throws when root is not an object", () => {
    expect(() => parseAndValidate("not an object")).toThrow(/Expected object/);
  });

  it("throws when a required field has the wrong type", () => {
    const data = valid();
    data.generation.seed = "42";
    expect(() => parseAndValidate(data)).toThrow(/Expected number/);
  });
});

describe("parseAndValidate — legacy files missing optional sections", () => {
  it("defaults dirtyFlags, debug, and ui sections when absent", () => {
    const data = valid_without_optional_sections();
    const result = parseAndValidate(data);
    expect(result.dirtyFlags).toEqual({ postEdit: false, field: false, presets: false, maze: false });
    expect(result.debug).toEqual({
      debugMode: false,
      showDebugFrontier: true,
      debugStep: 0,
      debugAutoPlayDelay: 200,
    });
    expect(result.ui).toEqual({
      showPresetOrigin: false,
      showFieldOrigin: true,
      openCard: "basic_config",
      postEditAutoConfirm: true,
    });
  });

  it("defaults tessellation.savedConfigs to empty array when absent", () => {
    const data = valid_without_optional_sections();
    const result = parseAndValidate(data);
    expect(result.tessellation.savedConfigs).toEqual([]);
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
    expect(result.quality.rules).toEqual([{ id: "rule_1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: { param_a: "1" } }], strategyId: "strategy_a", disabled: false, ruleDisabled: false, nestedStrategies: [] }]);
  });

  it("defaults rule name by array position when absent (pre-naming project files)", () => {
    const data = valid_without_optional_sections();
    delete (data.quality as { rules: Record<string, unknown>[] }).rules[0].name;
    const result = parseAndValidate(data);
    expect(result.quality.rules[0].name).toBe("Rule 1");
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
    expect(result.quality.stages).toEqual([{ id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false }]);
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

  it("silently scrubs a stage's reference to a rule dropped by the kind-drop recovery", () => {
    const data = valid_without_optional_sections();
    delete (data.quality as { rules: Record<string, unknown>[] }).rules[0].kind;
    (data.quality as { stages: unknown }).stages = [{ id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"] }];
    const result = parseAndValidate(data);
    expect(result.quality.rules).toEqual([]);
    expect(result.quality.stages).toEqual([{ id: "stage_1", name: "Stage 1", ruleIds: [], disabled: false }]);
  });

  it("round-trips quality.stages", () => {
    const data = valid_without_optional_sections();
    const result = parseAndValidate(data);
    expect(result.quality.stages).toEqual([{ id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false }]);
  });

  function valid_without_optional_sections(): Record<string, unknown> {
    const data = JSON.parse(JSON.stringify(serializeProject(makeState())));
    delete data.dirtyFlags;
    delete data.debug;
    delete data.ui;
    delete data.tessellation.savedConfigs;
    return data;
  }
});

describe("parseAndValidate — migrations", () => {
  it("throws when a file's version has no registered migration path to current", () => {
    const data = JSON.parse(JSON.stringify(serializeProject(makeState())));
    data.version = 0;
    expect(() => parseAndValidate(data)).toThrow(/No migration for version/);
  });
});
