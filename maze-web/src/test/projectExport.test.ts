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
    selectedChecks: ["check_a"],
    rules: [{ id: "rule_1", name: "Rule 1", kind: "k1", checks: ["check_a"], strategyId: "strategy_a", disabled: false, ruleDisabled: false }],
    checkParams: { check_a: { param_a: "1" } },
    strategyParams: { strategy_a: { param_b: "2" } },
    presetConnections: new Map(),
    lockedNodes: new Map(),
    defaultEdgeState: "undefined",
    autoLock: true,
    presetStart: [1, 2],
    presetFinish: [3, 4],
    presetGenSource: null,
    postEditDirty: false,
    postEditDraftEdges: null,
    postEditDraftMeta: null,
    fieldDirty: false,
    presetsDirty: false,
    mazeDirty: false,
    showMazeOverlay: true,
    showComponentsOverlay: false,
    showGraphOverlay: false,
    showNavGraphOverlay: false,
    showRouteOverlay: false,
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
    expect(result.quality.rules).toEqual([{ id: "rule_1", name: "Rule 1", kind: "k1", checks: ["check_a"], strategyId: "strategy_a", disabled: false, ruleDisabled: false }]);
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
