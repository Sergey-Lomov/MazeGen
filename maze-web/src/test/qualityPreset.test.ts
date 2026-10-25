import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import {
  serializeQualityPreset,
  parseQualityPreset,
  dropUnknownQualityIds,
  prepareQualityPresetLoad,
  qualityPresetFileAccept,
  QUALITY_PRESET_FILE_EXTENSION,
  serializeVisualPreset,
  parseVisualPreset,
  parseAndValidate,
  serializeProject,
  FileKindMismatchError,
  QUALITY_PRESET_KIND,
  QUALITY_PRESET_VERSION,
  type ProjectFileQuality,
} from "../store/projectExport";
import type { QcRuleState, RepairStageState } from "../store/storeTypes";
import type { CheckDescriptor, StrategyDescriptor } from "../wasm/types";

vi.mock("../wasm/mazeService", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/mazeService")>()),
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

function rule(id: string, typeIds: string[], strategyId: string | null, extra: Partial<QcRuleState> = {}): QcRuleState {
  return {
    id,
    name: null,
    kind: "invalid_loop",
    checks: typeIds.map((typeId, localId) => ({ localId, typeId, params: {}, disabled: false })),
    nextLocalCheckId: typeIds.length,
    strategyId,
    strategyParams: {},
    disabled: false,
    ruleDisabled: false,
    nestedStrategies: [],
    params: {},
    collapsed: false,
    ...extra,
  };
}

function stage(id: string, ruleIds: string[]): RepairStageState {
  return { id, name: id, ruleIds, disabled: false, collapsed: false };
}

const sourceRules = [
  rule("rule_a", ["min_loop_length"], "invalid_loop_random", { name: "Loops", strategyParams: { attempts: "7" }, checks: [{ localId: 4, typeId: "min_loop_length", params: { min: "6" }, disabled: true }] }),
  rule("rule_b", ["max_loop_length"], null, { ruleDisabled: true }),
];

function resetStore() {
  useMazeStore.setState({
    ...baseStoreState(),
    rules: [],
    stages: [],
    repairMaxIterations: 100,
    repairTimeBudgetSecs: 10,
  });
}

/** Configures the store as the "source" project and returns its quality preset, JSON round-tripped. */
function saveSourcePreset() {
  useMazeStore.setState({
    rules: sourceRules,
    stages: [stage("stage_x", ["rule_a"]), stage("stage_y", ["rule_b"])],
    repairMaxIterations: null,
    repairTimeBudgetSecs: 3.5,
  });
  return JSON.parse(JSON.stringify(serializeQualityPreset(useMazeStore.getState())));
}

const checks = ["min_loop_length", "max_loop_length"].map((id) => ({ id, issue_kinds: ["invalid_loop"] }) as unknown as CheckDescriptor);
const strategies = [
  { id: "invalid_loop_random", handles: "invalid_loop", nested_slots: [] },
  { id: "dispatcher", handles: "invalid_loop", nested_slots: [{ slot_id: "a" }, { slot_id: "c" }] },
] as unknown as StrategyDescriptor[];
const registry = { registryLoaded: true, availableChecks: checks, availableStrategies: strategies };

beforeEach(resetStore);

describe("quality preset (GitHub issue #751)", () => {
  it("saves only the quality settings", () => {
    const raw = saveSourcePreset();
    expect(raw.kind).toBe(QUALITY_PRESET_KIND);
    expect(raw.version).toBe(QUALITY_PRESET_VERSION);
    expect(Object.keys(raw).sort()).toEqual(["kind", "quality", "version"]);
    expect(Object.keys(raw.quality).sort()).toEqual(["repairMaxIterations", "repairTimeBudgetSecs", "rules", "stages"]);
    expect(raw.quality.rules[0].nextLocalCheckId).toBeUndefined();
  });

  it("loading replaces the quality settings and leaves the rest of the project untouched", () => {
    const raw = saveSourcePreset();
    resetStore();
    useMazeStore.setState({ seed: 777, rules: [rule("rule_old", ["max_loop_length"], null)], stages: [stage("stage_old", ["rule_old"])] });
    const before = useMazeStore.getState();

    useMazeStore.getState().loadQualityPreset(parseQualityPreset(raw).quality);

    const after = useMazeStore.getState();
    expect(after.rules).toEqual([{ ...sourceRules[0], nextLocalCheckId: 5 }, sourceRules[1]]);
    expect(after.stages).toEqual([stage("stage_x", ["rule_a"]), stage("stage_y", ["rule_b"])]);
    expect(after.repairMaxIterations).toBeNull();
    expect(after.repairTimeBudgetSecs).toBe(3.5);
    expect(after.seed).toBe(777);
    expect(after.initialConfig).toBe(before.initialConfig);
    expect(after.vectorByWallsSettings).toBe(before.vectorByWallsSettings);
    expect(after.presetConnections).toBe(before.presetConnections);
  });

  it("fills keys missing in an older preset with defaults", () => {
    const preset = parseQualityPreset({
      kind: QUALITY_PRESET_KIND,
      version: 1,
      quality: { rules: [{ id: "r1", kind: "invalid_loop", checks: [{ localId: 0, typeId: "min_loop_length" }], disabled: false }], futureKey: 1 },
    });
    expect(preset.quality.stages).toEqual([{ id: "stage_1", name: "Stage 1", ruleIds: ["r1"], disabled: false, collapsed: false }]);
    expect(preset.quality.repairMaxIterations).toBe(100);
    expect(preset.quality.repairTimeBudgetSecs).toBe(10);
    expect(preset.quality.rules[0]).toMatchObject({ name: null, strategyId: null, ruleDisabled: false, collapsed: false, nestedStrategies: [], params: {} });
    expect("futureKey" in preset.quality).toBe(false);
  });

  it("rejects a preset saved by a newer app version", () => {
    const raw = saveSourcePreset();
    raw.version = QUALITY_PRESET_VERSION + 1;
    expect(() => parseQualityPreset(raw)).toThrow(/newer/);
  });

  it("rejects malformed presets as a whole", () => {
    const raw = saveSourcePreset();
    expect(() => parseQualityPreset({ ...raw, quality: undefined })).toThrow();
    expect(() => parseQualityPreset({ ...raw, quality: { ...raw.quality, rules: "x" } })).toThrow();
    expect(() => parseQualityPreset({ ...raw, quality: { ...raw.quality, stages: [stage("s", [])] } })).toThrow(/not assigned to any stage/);
    expect(() => parseQualityPreset({ ...raw, version: "1" })).toThrow();
    const dupRules = { ...raw.quality, rules: [raw.quality.rules[0], raw.quality.rules[0]], stages: [stage("s", ["rule_a"])] };
    expect(() => parseQualityPreset({ ...raw, quality: dupRules })).toThrow(/Duplicate rule id rule_a/);
    const dupStages = { ...raw.quality, stages: [stage("s", ["rule_a"]), stage("s", ["rule_b"])] };
    expect(() => parseQualityPreset({ ...raw, quality: dupStages })).toThrow(/Duplicate stage id s/);
  });

  it("rejects project and visual preset files, and vice versa", () => {
    const project = JSON.parse(JSON.stringify(serializeProject(useMazeStore.getState())));
    const visual = JSON.parse(JSON.stringify(serializeVisualPreset(useMazeStore.getState())));
    const quality = saveSourcePreset();
    expect(() => parseQualityPreset(project)).toThrow(FileKindMismatchError);
    expect(() => parseQualityPreset(visual)).toThrow(FileKindMismatchError);
    expect(() => parseAndValidate(quality)).toThrow(FileKindMismatchError);
    expect(() => parseVisualPreset(quality)).toThrow(FileKindMismatchError);
  });

  it("rejects unrelated JSON with a plain error", () => {
    expect(() => parseQualityPreset({ foo: 1 })).toThrow("Not a quality preset file");
    expect(() => parseQualityPreset({ foo: 1 })).not.toThrow(FileKindMismatchError);
  });
});

describe("dropUnknownQualityIds", () => {
  it("keeps a fully known configuration unchanged", () => {
    const quality = parseQualityPreset(saveSourcePreset()).quality;
    expect(dropUnknownQualityIds(quality, checks, strategies)).toEqual({ quality, skipped: { checks: [], strategies: [], nestedSlots: [], issueKinds: [] } });
  });

  it("skips unknown checks and strategies and reports each id once", () => {
    const quality: ProjectFileQuality = {
      rules: [
        { ...rule("r_mixed", ["min_loop_length", "removed_check"], "removed_strategy"), nestedStrategies: [{ slotId: "s", strategyId: "removed_strategy", params: {}, nested: [] }] },
        rule("r_gone", ["removed_check"], "invalid_loop_random"),
        rule("r_empty", [], "dispatcher", {
          nestedStrategies: [
            { slotId: "a", strategyId: "invalid_loop_random", params: {}, nested: [{ slotId: "b", strategyId: "future_strategy", params: {}, nested: [] }] },
            { slotId: "c", strategyId: "future_strategy", params: {}, nested: [] },
            { slotId: "removed_slot", strategyId: "invalid_loop_random", params: {}, nested: [] },
          ],
        }),
        rule("r_kind", [], null, { kind: "removed_kind" }),
      ].map(({ nextLocalCheckId: _n, ...r }) => r),
      stages: [stage("s1", ["r_mixed", "r_gone"]), stage("s2", ["r_empty", "r_kind"])],
      repairMaxIterations: 5,
      repairTimeBudgetSecs: null,
    };

    const { quality: out, skipped } = dropUnknownQualityIds(quality, checks, strategies);

    expect(skipped).toEqual({
      checks: ["removed_check"],
      strategies: ["removed_strategy", "future_strategy"],
      nestedSlots: ["dispatcher.removed_slot", "invalid_loop_random.b"],
      issueKinds: ["removed_kind"],
    });
    expect(out.rules.map((r) => r.id)).toEqual(["r_mixed", "r_empty"]);
    expect(out.rules[0].checks.map((c) => c.typeId)).toEqual(["min_loop_length"]);
    expect(out.rules[0].strategyId).toBeNull();
    expect(out.rules[0].nestedStrategies).toEqual([]);
    expect(out.rules[1].strategyId).toBe("dispatcher");
    expect(out.rules[1].nestedStrategies).toEqual([{ slotId: "a", strategyId: "invalid_loop_random", params: {}, nested: [] }]);
    expect(out.stages).toEqual([stage("s1", ["r_mixed"]), stage("s2", ["r_empty"])]);
    expect(out.repairMaxIterations).toBe(5);
    expect(out.repairTimeBudgetSecs).toBeNull();
  });
});

describe("prepareQualityPresetLoad", () => {
  const raw = () => {
    const preset = saveSourcePreset();
    preset.quality.rules[0].checks.push({ localId: 9, typeId: "removed_check", params: {}, disabled: false });
    return preset;
  };

  it("filters unknown ids against a loaded registry and flattens the skipped list", () => {
    const { quality, skipped } = prepareQualityPresetLoad(raw(), registry);
    expect(skipped).toEqual(["removed_check"]);
    expect(quality.rules[0].checks.map((c) => c.typeId)).toEqual(["min_loop_length"]);
  });

  it("keeps every id before the registry is loaded", () => {
    const { quality, skipped } = prepareQualityPresetLoad(raw(), { ...registry, registryLoaded: false, availableChecks: [], availableStrategies: [] });
    expect(skipped).toEqual([]);
    expect(quality.rules[0].checks.map((c) => c.typeId)).toEqual(["min_loop_length", "removed_check"]);
  });
});

describe("qualityPresetFileAccept", () => {
  const nav = (userAgent: string, platform: string, maxTouchPoints: number) => ({ userAgent, platform, maxTouchPoints });

  it("filters by the quality preset extension on desktop", () => {
    expect(qualityPresetFileAccept(nav("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", 0))).toBe(QUALITY_PRESET_FILE_EXTENSION);
  });

  it("drops the filter on iOS and iPadOS", () => {
    expect(qualityPresetFileAccept(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iPhone", 5))).toBeUndefined();
    expect(qualityPresetFileAccept(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5))).toBeUndefined();
  });
});
