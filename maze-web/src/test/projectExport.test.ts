import { describe, it, expect } from "vitest";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import type { MazeState } from "../store/mazeStore";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { buildPostEditBaseline } from "../store/slices/postEditSliceHelpers";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_PNG_EXPORT_SETTINGS } from "../store/slices/imageExportSlice";

function makeState(overrides: Partial<MazeState> = {}): MazeState {
  const base = {
    tessellationKind: "square",
    hexOrientation: "flat_top",
    triOrientation: "r0",
    floorFields: {
      floor_1: {
        squareShape: "rect",
        hexShape: "parallelogram",
        triangleShape: "rect",
        tessellationConfig: { type: "square", width: 5, height: 5 },
        savedConfigs: {},
        freeFieldPoints: { square: new Set<number>(), hex: new Set<number>(), triangle: new Set<number>() },
        isEditingField: false,
        fieldPoints: new Set<number>(),
        fieldEditMode: "default",
        fieldPrimitive: "point",
        fieldDirty: false,
      },
    },
    seed: 42,
    randomSeed: false,
    seedHistory: [],
    seedHistoryIndex: 0,
    initialConfig: { method: "recursive_backtracker" },
    elementsConfig: {},
    splitPatternMode: false,
    splitMaxNodes: 2,
    splitPatterns: [],
    qcExperiment: false,
    vertexSettingsPanelOpen: false,
    rules: [{ id: "rule_1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: { param_a: "1" }, disabled: false }], nextLocalCheckId: 1, strategyId: "strategy_a", disabled: false, ruleDisabled: false, nestedStrategies: [], params: {}, collapsed: false }],
    stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false, collapsed: false }],
    strategyParams: { strategy_a: { param_b: "2" } },
    repairMaxIterations: 100,
    repairTimeBudgetSecs: 10,
    presetConnections: new Map(),
    lockedNodes: new Map(),
    defaultEdgeState: "undefined",
    autoLock: true,
    presetStart: presetEndpoint([1, 2]),
    presetFinish: presetEndpoint([3, 4]),
    presetGenSource: null,
    presetTeleports: [],
    presetVerticalPassages: [],
    presetVerticalPassagePending: null,
    presetElevators: [],
    presetElevatorPending: null,
    presetSplitPoints: {},
    presetActiveSplitNode: {},
    presetFocusedPoint: null,
    postEditDirty: false,
    postEditCommands: [],
    postEditBaseline: buildPostEditBaseline([], [], 0, null, null),
    postEditDerived: buildPostEditBaseline([], [], 0, null, null).derived,
    postEditDraftEdges: null,
    postEditDraftMeta: null,
    postEditDraftTeleports: [],
    postEditDraftSplitPoints: {},
    postEditActiveSplitNode: {},
    postEditDraftVerticalPassages: [],
    postEditVerticalPassagePending: null,
    _nextPostEditTeleportId: 1,
    _nextPostEditVerticalPassageId: 1,
    postEditDraftElevators: [],
    postEditElevatorPending: null,
    _nextPostEditElevatorId: 1,
    _nextSplitSlotId: {},
    postEditSuppressedElevatorPairs: new Set<string>(),
    postEditSuppressedVerticalPassagePairs: new Set<string>(),
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
    debugStep: 0,
    debugAutoPlayDelay: 200,
    showPresetOrigin: false,
    showFieldOrigin: true,
    openCard: "basic_config",
    postEditAutoConfirm: true,
    activeRenderMode: null,
    openRenderModeSettings: null,
    vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
    vectorByWallsSectionsExpanded: {},
    vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
    vectorByCorridorsSectionsExpanded: {},
    pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
    floors: [{ id: "floor_1", title: "Floor 1" }],
    nextFloorNumber: 2,
    activeFloorId: "floor_1",
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

  it("defaults generation.qcExperiment to false for a project file saved before this toggle existed", () => {
    const state = makeState({ qcExperiment: true });
    const serialized = serializeProject(state);
    const raw = JSON.parse(JSON.stringify(serialized));
    delete raw.generation.qcExperiment;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.qcExperiment).toBe(false);
  });

  it("defaults generation.vertexSettingsPanelOpen to false for a project file saved before this toggle existed", () => {
    const state = makeState({ vertexSettingsPanelOpen: true });
    const serialized = serializeProject(state);
    const raw = JSON.parse(JSON.stringify(serialized));
    delete raw.generation.vertexSettingsPanelOpen;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.vertexSettingsPanelOpen).toBe(false);
  });

  it("round-trips a non-empty seed history and index", () => {
    const state = makeState({ seedHistory: [10, 20, 30], seedHistoryIndex: 1 });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.generation.seedHistory).toEqual([10, 20, 30]);
    expect(reparsed.generation.seedHistoryIndex).toBe(1);
  });

  it("defaults seedHistory/seedHistoryIndex for a project file saved before seed history existed", () => {
    const state = makeState();
    const raw = JSON.parse(JSON.stringify(serializeProject(state)));
    delete raw.generation.seedHistory;
    delete raw.generation.seedHistoryIndex;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.seedHistory).toEqual([]);
    expect(reparsed.generation.seedHistoryIndex).toBe(0);
  });

  it("drops non-integer garbage from seedHistory and clamps an out-of-range seedHistoryIndex", () => {
    const state = makeState({ seedHistory: [10, 20, 30], seedHistoryIndex: 2 });
    const raw = JSON.parse(JSON.stringify(serializeProject(state)));
    raw.generation.seedHistory = [10, NaN, "20", 1.5, 30];
    raw.generation.seedHistoryIndex = 99;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.seedHistory).toEqual([10, 30]);
    expect(reparsed.generation.seedHistoryIndex).toBe(1);
  });

  it("round-trips a non-empty splitGeneration config (GitHub issue #222)", () => {
    const state = makeState({
      splitPatternMode: true,
      splitMaxNodes: 3,
      splitPatterns: [
        {
          node_count: 2,
          faces: [
            [
              { face_index: 0, requirement: { kind: "passage" } },
              { face_index: 1, requirement: { kind: "one_way", direction: "forward" }, sibling_target: 1 },
            ],
            [
              { face_index: 2, requirement: { kind: "wall" } },
            ],
          ],
          weight: 2.5,
        },
      ],
    });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.generation.splitGeneration).toEqual(serialized.generation.splitGeneration);
    expect(reparsed.generation.splitGeneration.patternMode).toBe(true);
    expect(reparsed.generation.splitGeneration.maxSplitNodes).toBe(3);
    expect(reparsed.generation.splitGeneration.patterns).toHaveLength(1);
  });

  it("defaults splitGeneration cleanly for a project file saved before this feature existed", () => {
    const state = makeState();
    const raw = JSON.parse(JSON.stringify(serializeProject(state)));
    delete raw.generation.splitGeneration;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.splitGeneration).toEqual({ patternMode: false, maxSplitNodes: 2, patterns: [] });
  });

  it("drops a malformed split pattern without failing the whole file", () => {
    const state = makeState({ splitPatternMode: true, splitMaxNodes: 2, splitPatterns: [] });
    const raw = JSON.parse(JSON.stringify(serializeProject(state)));
    raw.generation.splitGeneration.patterns = [{ node_count: "not a number" }, { garbage: true }];
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.splitGeneration.patterns).toEqual([]);
  });

  it("defaults repair limits for a project file saved before this setting existed", () => {
    const state = makeState();
    const serialized = serializeProject(state);
    const raw = JSON.parse(JSON.stringify(serialized));
    delete raw.quality.repairMaxIterations;
    delete raw.quality.repairTimeBudgetSecs;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.quality.repairMaxIterations).toBe(100);
    expect(reparsed.quality.repairTimeBudgetSecs).toBe(10);
  });

  it("round-trips dirty post-edit command log", () => {
    const commands: PostEditCommand[] = [
      { kind: "setEdge", from: nodeEndpoint(0), to: nodeEndpoint(1), edgeKind: "basic" },
      { kind: "setEdge", from: nodeEndpoint(1), to: nodeEndpoint(2), edgeKind: "one_way_forward" },
      { kind: "setMeta", slot: "start", endpoint: nodeEndpoint(0) },
      { kind: "setMeta", slot: "finish", endpoint: nodeEndpoint(2) },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands });
    const serialized = serializeProject(state);
    expect(serialized.postEdit).not.toBeNull();
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit).toEqual(serialized.postEdit);
  });

  // GitHub issue #425: a split endpoint's `level` (non-zero floor) was silently dropped by
  // `validatePostEditEndpoint` on project load, collapsing every floor-1+ split reference onto
  // floor 0 after a save/load round-trip even though `level` was correctly serialized.
  it("round-trips a split post-edit endpoint's non-zero level (GitHub issue #425)", () => {
    const commands: PostEditCommand[] = [
      { kind: "setEdge", from: splitEndpoint([0, 0], 0, 1), to: nodeEndpoint(12), edgeKind: "basic" },
      { kind: "setMeta", slot: "start", endpoint: splitEndpoint([0, 0], 0, 1) },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit).toEqual(serialized.postEdit);
    const reparsedFrom = reparsed.postEdit?.commands[0].kind === "setEdge" ? reparsed.postEdit.commands[0].from : undefined;
    expect(reparsedFrom).toEqual(splitEndpoint([0, 0], 0, 1));
  });

  it("round-trips dirty post-edit teleports", () => {
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: 1, from: nodeEndpoint(0), to: nodeEndpoint(2), direction: "forward" },
      { kind: "addTeleport", id: 2, from: nodeEndpoint(1), to: nodeEndpoint(3), direction: "two_way" },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands, _nextPostEditTeleportId: 3 });
    const serialized = serializeProject(state);
    expect(serialized.postEdit).not.toBeNull();
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit?.commands).toEqual(serialized.postEdit?.commands);
  });

  it("round-trips split points", () => {
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [3, 4], slotId: 0 },
      { kind: "addSplitNode", point: [3, 4], slotId: 1 },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands, _nextSplitSlotId: { "3,4": 2 } });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit?.commands).toEqual(commands);
    expect(reparsed.postEdit?.nextSplitSlotId).toEqual({ "3,4": 2 });
  });

  it("rejects a project file with an unregistered version", () => {
    const state = makeState({ postEditDirty: true, postEditCommands: [] });
    const data = JSON.parse(JSON.stringify(serializeProject(state)));
    data.version = 3;
    expect(() => parseAndValidate(data)).toThrow();
  });

  it("rejects an invalid PostEditEndpoint kind", () => {
    const commands: PostEditCommand[] = [
      { kind: "setMeta", slot: "start", endpoint: { kind: "bogus" } as unknown as ReturnType<typeof nodeEndpoint> },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands });
    const data = JSON.parse(JSON.stringify(serializeProject(state)));
    expect(() => parseAndValidate(data)).toThrow();
  });

  it("rejects an unknown PostEditCommand kind", () => {
    const state = makeState({ postEditDirty: true, postEditCommands: [] });
    const data = JSON.parse(JSON.stringify(serializeProject(state)));
    data.postEdit.commands = [{ kind: "bogus" }];
    expect(() => parseAndValidate(data)).toThrow();
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
        ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage", source: "user" }],
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
        { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([2, 2]), direction: "forward" },
        { id: 2, from: presetEndpoint([1, 1]), to: presetEndpoint([3, 3]), direction: "two_way" },
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
    data.floorFields.floor_1.config.type = "not_a_real_type";
    expect(() => parseAndValidate(data)).toThrow(/Unknown tessellation config type/);
  });

  it("throws on invalid hex orientation", () => {
    const data = valid();
    data.floorFields.floor_1.config = { type: "hex_parallelogram", cols: 3, rows: 3, orientation: "sideways" };
    expect(() => parseAndValidate(data)).toThrow(/Invalid hex orientation/);
  });

  it("throws on invalid postEditEdge kind", () => {
    const data = valid();
    data.postEdit = {
      commands: [{ kind: "setEdge", from: nodeEndpoint(0), to: nodeEndpoint(1), edgeKind: "bogus" }],
      nextTeleportId: 1, nextVerticalPassageId: 1, nextElevatorId: 1, nextSplitSlotId: {},
    };
    expect(() => parseAndValidate(data)).toThrow(/Invalid PostEditEdgeKind/);
  });

  it("throws on invalid defaultEdgeState", () => {
    const data = valid();
    data.presets.defaultEdgeState = "bogus";
    expect(() => parseAndValidate(data)).toThrow(/Invalid defaultEdgeState/);
  });

  it("throws on duplicate teleport id", () => {
    const data = valid();
    data.presets.teleports = [
      { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([2, 2]), direction: "forward" },
      { id: 1, from: presetEndpoint([1, 1]), to: presetEndpoint([3, 3]), direction: "two_way" },
    ];
    expect(() => parseAndValidate(data)).toThrow(/Duplicate teleport id/);
  });

  it("throws on invalid post-edit teleport direction", () => {
    const data = valid();
    data.postEdit = {
      commands: [{ kind: "addTeleport", id: 1, from: nodeEndpoint(0), to: nodeEndpoint(2), direction: "bogus" }],
      nextTeleportId: 2, nextVerticalPassageId: 1, nextElevatorId: 1, nextSplitSlotId: {},
    };
    expect(() => parseAndValidate(data)).toThrow(/Invalid.*[Dd]irection/);
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

  it("defaults floorFields.<floorId>.savedConfigs to empty array when absent", () => {
    const data = valid_without_optional_sections();
    const result = parseAndValidate(data);
    expect(result.floorFields.floor_1.savedConfigs).toEqual([]);
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
    expect(result.quality.rules).toEqual([{ id: "rule_1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: { param_a: "1" }, disabled: false }], strategyId: "strategy_a", disabled: false, ruleDisabled: false, nestedStrategies: [], params: {}, collapsed: false }]);
  });

  it("defaults check disabled to false when absent (pre-toggle project files)", () => {
    const data = valid_without_optional_sections();
    delete (data.quality as { rules: { checks: Record<string, unknown>[] }[] }).rules[0].checks[0].disabled;
    const result = parseAndValidate(data);
    expect(result.quality.rules[0].checks[0].disabled).toBe(false);
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
    const data = JSON.parse(JSON.stringify(serializeProject(makeState())));
    delete data.dirtyFlags;
    delete data.debug;
    delete data.ui;
    delete data.floorFields.floor_1.savedConfigs;
    return data;
  }
});

describe("parseAndValidate — imageExport (GitHub issue #295)", () => {
  it("defaults activeRenderMode/openRenderModeSettings/vectorByWallsSettings/vectorByWallsSectionsExpanded for a project file saved before this section existed", () => {
    const raw = JSON.parse(JSON.stringify(serializeProject(makeState())));
    delete raw.imageExport;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport).toEqual({
      activeRenderMode: null,
      openRenderModeSettings: null,
      vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      vectorByWallsSectionsExpanded: {},
      vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
      vectorByCorridorsSectionsExpanded: {},
      pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
    });
  });

  it("round-trips pngExportSettings", () => {
    const settings = {
      outputMode: "print" as const,
      digital: { ...DEFAULT_PNG_EXPORT_SETTINGS.digital, scale: 4, canvasMode: "fixed_size" as const, fixedWidth: 800, fixedHeight: 600 },
      print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, paperSize: "a3" as const, orientation: "landscape" as const, anchor: "top_left" as const },
    };
    const state = makeState({ pngExportSettings: settings });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.imageExport.pngExportSettings).toEqual(settings);
  });

  it("defaults pngExportSettings fields to their own defaults when malformed, without throwing", () => {
    const raw = JSON.parse(JSON.stringify(serializeProject(makeState())));
    raw.imageExport.pngExportSettings = {
      outputMode: "not-a-mode",
      digital: { scale: "not-a-number", canvasMode: "not-a-mode" },
      print: { density: "not-a-density", paperSize: "not-a-size" },
    };
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.pngExportSettings).toEqual(DEFAULT_PNG_EXPORT_SETTINGS);
  });

  it("degrades a completely missing pngExportSettings to defaults", () => {
    const raw = JSON.parse(JSON.stringify(serializeProject(makeState())));
    delete raw.imageExport.pngExportSettings;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.pngExportSettings).toEqual(DEFAULT_PNG_EXPORT_SETTINGS);
  });

  it("round-trips vectorByWallsSectionsExpanded", () => {
    const state = makeState({ vectorByWallsSectionsExpanded: { background: true, tiles: false } });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.imageExport.vectorByWallsSectionsExpanded).toEqual({ background: true, tiles: false });
  });

  it("degrades an unknown/future activeRenderMode and openRenderModeSettings to null instead of throwing", () => {
    const state = makeState({ activeRenderMode: "vector_by_walls", openRenderModeSettings: "vector_by_walls" });
    const raw = JSON.parse(JSON.stringify(serializeProject(state)));
    raw.imageExport.activeRenderMode = "some_future_mode";
    raw.imageExport.openRenderModeSettings = "some_future_mode";
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.activeRenderMode).toBeNull();
    expect(reparsed.imageExport.openRenderModeSettings).toBeNull();
  });

  it("round-trips a non-default vectorByWallsSettings", () => {
    const state = makeState({
      activeRenderMode: "vector_by_walls",
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, floorColor: 0x123456, wallThickness: 7, teleportGroupOverrides: { g1: { fillColor: 0xabcdef, shape: "star" } } },
    });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.imageExport).toEqual(serialized.imageExport);
  });

  it("falls back per-field to defaults when vectorByWallsSettings is malformed, without throwing", () => {
    const raw = JSON.parse(JSON.stringify(serializeProject(makeState())));
    raw.imageExport.vectorByWallsSettings = {
      floorColor: "not-a-number",
      wallJoin: "bevel",
      startMarker: { shape: "not-a-shape" },
      splitNodeColors: "not-an-array",
      teleportGroupOverrides: { g1: { shape: "not-a-shape", fillColor: "nope" }, g2: { fillColor: 0x111111 } },
    };
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.vectorByWallsSettings.floorColor).toBe(DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorColor);
    expect(reparsed.imageExport.vectorByWallsSettings.wallJoin).toBe(DEFAULT_VECTOR_BY_WALLS_SETTINGS.wallJoin);
    expect(reparsed.imageExport.vectorByWallsSettings.startMarker.shape).toBe(DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker.shape);
    expect(reparsed.imageExport.vectorByWallsSettings.splitNodeColors).toEqual([]);
    expect(reparsed.imageExport.vectorByWallsSettings.teleportGroupOverrides).toEqual({ g1: {}, g2: { fillColor: 0x111111 } });
  });

  it("treats a non-object vectorByWallsSettings/imageExport as absent rather than throwing", () => {
    const raw = JSON.parse(JSON.stringify(serializeProject(makeState())));
    raw.imageExport = "not-an-object";
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport).toEqual({
      activeRenderMode: null,
      openRenderModeSettings: null,
      vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      vectorByWallsSectionsExpanded: {},
      vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
      vectorByCorridorsSectionsExpanded: {},
      pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
    });
  });
});

describe("parseAndValidate — migrations", () => {
  it("throws when a file's version has no registered migration path to current", () => {
    const data = JSON.parse(JSON.stringify(serializeProject(makeState())));
    data.version = 0;
    expect(() => parseAndValidate(data)).toThrow(/No migration for version/);
  });
});
