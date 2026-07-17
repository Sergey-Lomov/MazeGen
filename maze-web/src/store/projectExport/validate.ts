import type { NodeLockKind } from "../../wasm/types";
import type { PresetConnectionEntry, PresetTeleportEntry } from "../../pixi/fieldEditUtils";
import type { PostEditEdge, PostEditTeleportEntry, FeatureId } from "../mazeStore";
import { MAX_NESTED_STRATEGY_DEPTH } from "../storeTypes";
import {
  CURRENT_VERSION,
  type ProjectFile,
  type ProjectFilePostEdit,
  type ProjectFileDirtyFlags,
  type ProjectFileAnalytics,
  type ProjectFileDebug,
  type ProjectFileUi,
  type ProjectFileQcRule,
  type ProjectFileStage,
  type ProjectFileNestedStrategy,
} from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { InitialGenerationConfig, ElementsConfig } from "../../wasm/types";
import * as m from "~/paraglide/messages";

// ─── Migrations ──────────────────────────────────────────────────────────────
// No migrations currently registered — old files at an unregistered version fail to load with a
// clear error (see migrateToLatest below). Per project policy, migrations are added only on
// explicit user request, not automatically when a serialized shape changes.

const migrations: Record<number, (data: unknown) => unknown> = {};

function migrateToLatest(data: unknown, fromVersion: number): unknown {
  let result = data;
  for (let v = fromVersion; v < CURRENT_VERSION; v++) {
    const migrate = migrations[v];
    if (!migrate) throw new Error(`No migration for version ${v}`);
    result = migrate(result);
  }
  return result;
}

// ─── Primitive asserts ───────────────────────────────────────────────────────

function assertString(v: unknown, path: string): string {
  if (typeof v !== "string") throw new Error(`Expected string at ${path}, got ${typeof v}`);
  return v;
}

function assertNumber(v: unknown, path: string): number {
  if (typeof v !== "number") throw new Error(`Expected number at ${path}, got ${typeof v}`);
  return v;
}

function assertBoolean(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new Error(`Expected boolean at ${path}, got ${typeof v}`);
  return v;
}

function assertArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`Expected array at ${path}`);
  return v;
}

function assertObject(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(`Expected object at ${path}`);
  return v as Record<string, unknown>;
}

function assertStringRecord(v: unknown, path: string): Record<string, string> {
  const obj = assertObject(v, path);
  for (const [k, val] of Object.entries(obj)) {
    assertString(val, `${path}.${k}`);
  }
  return obj as Record<string, string>;
}

function assertBoolRecord(v: unknown, path: string): Record<string, boolean> {
  const obj = assertObject(v, path);
  for (const [k, val] of Object.entries(obj)) {
    assertBoolean(val, `${path}.${k}`);
  }
  return obj as Record<string, boolean>;
}

function assertStringRecordRecord(v: unknown, path: string): Record<string, Record<string, string>> {
  const obj = assertObject(v, path);
  for (const [k, val] of Object.entries(obj)) {
    assertStringRecord(val, `${path}.${k}`);
  }
  return obj as Record<string, Record<string, string>>;
}

function assertHexOrientation(v: unknown, path: string): void {
  const s = assertString(v, path);
  if (s !== "flat_top" && s !== "pointy_top")
    throw new Error(`Invalid hex orientation at ${path}: ${s}`);
}

function assertTriOrientation(v: unknown, path: string): void {
  const s = assertString(v, path);
  if (s !== "r0" && s !== "r90" && s !== "r180" && s !== "r270")
    throw new Error(`Invalid triangle orientation at ${path}: ${s}`);
}

// ─── Optional-field helpers (sections with defaults for old files) ──────────

function optBool(obj: Record<string, unknown> | null, key: string, fallback: boolean): boolean {
  return obj != null && typeof obj[key] === "boolean" ? (obj[key] as boolean) : fallback;
}

function optNumber(obj: Record<string, unknown> | null, key: string, fallback: number): number {
  return obj != null && typeof obj[key] === "number" ? (obj[key] as number) : fallback;
}

function optSection(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> | null {
  return parent[key] != null ? assertObject(parent[key], path) : null;
}

function optCoordPair(v: unknown, path: string): [number, number] | null {
  return v === null || v === undefined ? null : validateCoordPair(v, path);
}

function validatePairArray<T>(
  v: unknown,
  path: string,
  validateValue: (value: unknown, path: string) => T,
): [string, T][] {
  const arr = assertArray(v, path);
  return arr.map((entry, i) => {
    const pair = assertArray(entry, `${path}[${i}]`);
    return [
      assertString(pair[0], `${path}[${i}][0]`),
      validateValue(pair[1], `${path}[${i}][1]`),
    ] as [string, T];
  });
}

/** Throws if any entry in `items` shares an `id` with an earlier entry — shared by every
 * validated array whose entries carry a client-minted id (`postEdit.teleports`,
 * `quality.rules[].checks`, `presets.teleports`), where a duplicate signals file corruption
 * rather than something recoverable with a default. `label` names the id field in the error
 * message (e.g. "teleport id", "localId"). */
function assertUniqueIds<T>(items: T[], getId: (item: T) => number, label: string, path: string): void {
  const seen = new Set<number>();
  for (const item of items) {
    const id = getId(item);
    if (seen.has(id)) throw new Error(`Duplicate ${label} ${id} at ${path}`);
    seen.add(id);
  }
}

function validateTeleportDirection(v: unknown, path: string): "forward" | "backward" | "two_way" {
  const direction = assertString(v, path);
  if (direction !== "forward" && direction !== "backward" && direction !== "two_way")
    throw new Error(`Invalid teleport direction at ${path}: ${direction}`);
  return direction;
}

// ─── Section validators ──────────────────────────────────────────────────────

function validateTessellationConfig(v: unknown, path = "tessellation.config"): TessellationConfig {
  const obj = assertObject(v, path);
  const type = assertString(obj.type, `${path}.type`);
  switch (type) {
    case "square":
      assertNumber(obj.width, `${path}.width`);
      assertNumber(obj.height, `${path}.height`);
      return obj as unknown as TessellationConfig;
    case "hex_parallelogram":
      assertNumber(obj.cols, `${path}.cols`);
      assertNumber(obj.rows, `${path}.rows`);
      assertHexOrientation(obj.orientation, `${path}.orientation`);
      return obj as unknown as TessellationConfig;
    case "hex_hexagon":
      assertNumber(obj.radius, `${path}.radius`);
      assertHexOrientation(obj.orientation, `${path}.orientation`);
      return obj as unknown as TessellationConfig;
    case "triangle_rect":
      assertNumber(obj.cols, `${path}.cols`);
      assertNumber(obj.rows, `${path}.rows`);
      assertTriOrientation(obj.orientation, `${path}.orientation`);
      return obj as unknown as TessellationConfig;
    case "triangle_triangle":
      assertNumber(obj.side, `${path}.side`);
      assertTriOrientation(obj.orientation, `${path}.orientation`);
      return obj as unknown as TessellationConfig;
    case "triangle_hexagon":
      assertNumber(obj.radius, `${path}.radius`);
      assertTriOrientation(obj.orientation, `${path}.orientation`);
      return obj as unknown as TessellationConfig;
    case "square_custom":
      assertArray(obj.points, `${path}.points`);
      return obj as unknown as TessellationConfig;
    case "hex_custom":
      assertArray(obj.points, `${path}.points`);
      assertHexOrientation(obj.orientation, `${path}.orientation`);
      return obj as unknown as TessellationConfig;
    case "tri_custom":
      assertArray(obj.points, `${path}.points`);
      assertTriOrientation(obj.orientation, `${path}.orientation`);
      return obj as unknown as TessellationConfig;
    default:
      throw new Error(`Unknown tessellation config type: ${type}`);
  }
}

function validatePostEditEdge(v: unknown, path: string): PostEditEdge {
  const obj = assertObject(v, path);
  const kind = assertString(obj.kind, `${path}.kind`);
  if (kind !== "wall" && kind !== "basic" && kind !== "one_way_forward" && kind !== "one_way_backward")
    throw new Error(`Invalid PostEditEdge kind at ${path}.kind: ${kind}`);
  return {
    from: assertNumber(obj.from, `${path}.from`),
    to: assertNumber(obj.to, `${path}.to`),
    kind,
  };
}

function validatePostEditTeleportEntry(v: unknown, path: string): PostEditTeleportEntry {
  const obj = assertObject(v, path);
  return {
    id: assertNumber(obj.id, `${path}.id`),
    from: assertNumber(obj.from, `${path}.from`),
    to: assertNumber(obj.to, `${path}.to`),
    direction: validateTeleportDirection(obj.direction, `${path}.direction`),
  };
}

function validatePostEdit(v: unknown): ProjectFilePostEdit {
  const obj = assertObject(v, "postEdit");
  const edges = validatePairArray(obj.edges, "postEdit.edges", validatePostEditEdge);
  let meta: ProjectFilePostEdit["meta"] = null;
  if (obj.meta !== null && obj.meta !== undefined) {
    const m = assertObject(obj.meta, "postEdit.meta");
    meta = {
      start: m.start === null ? null : assertNumber(m.start, "postEdit.meta.start"),
      finish: m.finish === null ? null : assertNumber(m.finish, "postEdit.meta.finish"),
    };
  }
  // Optional — absent in project files saved before post-edit teleport editing existed.
  const teleports = obj.teleports != null
    ? assertArray(obj.teleports, "postEdit.teleports").map((t, i) => validatePostEditTeleportEntry(t, `postEdit.teleports[${i}]`))
    : [];
  assertUniqueIds(teleports, (t) => t.id, "teleport id", "postEdit.teleports");
  return { edges, meta, teleports };
}

function validateCoordPair(v: unknown, path: string): [number, number] {
  const arr = assertArray(v, path);
  return [assertNumber(arr[0], `${path}[0]`), assertNumber(arr[1], `${path}[1]`)];
}

function validatePresetConnectionEntry(v: unknown, path: string): PresetConnectionEntry {
  const obj = assertObject(v, path);
  const state = assertString(obj.state, `${path}.state`);
  const source = assertString(obj.source, `${path}.source`);
  if (state !== "wall" && state !== "passage" && state !== "one_way_forward" && state !== "one_way_backward" && state !== "undefined")
    throw new Error(`Invalid preset connection state at ${path}.state: ${state}`);
  if (source !== "user" && source !== "default")
    throw new Error(`Invalid preset connection source at ${path}.source: ${source}`);
  return {
    from: validateCoordPair(obj.from, `${path}.from`),
    to: validateCoordPair(obj.to, `${path}.to`),
    state: state as PresetConnectionEntry["state"],
    source: source as "user" | "default",
  };
}

function validateCheckInstance(v: unknown, path: string): { localId: number; typeId: string; params: Record<string, string> } {
  const obj = assertObject(v, path);
  return {
    localId: assertNumber(obj.localId, `${path}.localId`),
    typeId: assertString(obj.typeId, `${path}.typeId`),
    params: assertStringRecord(obj.params ?? {}, `${path}.params`),
  };
}

// Mirrors `NestedStrategyState` — absent entirely for project files saved before nested
// strategies existed, same recovery pattern `ruleDisabled`/stage `disabled` already use.
// `depth` guards against a maliciously or accidentally deep `nested` chain in a loaded file —
// this is the one nested-strategy recursion that crosses a real trust boundary (an arbitrary
// file from disk, not web-UI-generated state), so it's the one that must not blow the call stack.
function validateNestedStrategy(v: unknown, path: string, depth = 0): ProjectFileNestedStrategy {
  if (depth >= MAX_NESTED_STRATEGY_DEPTH) {
    throw new Error(`${path}: nested strategy chain exceeds max depth of ${MAX_NESTED_STRATEGY_DEPTH}`);
  }
  const obj = assertObject(v, path);
  const slotId = assertString(obj.slotId, `${path}.slotId`);
  const strategyId = assertString(obj.strategyId, `${path}.strategyId`);
  const params = assertStringRecord(obj.params ?? {}, `${path}.params`);
  const nested = obj.nested != null
    ? assertArray(obj.nested, `${path}.nested`).map((n, i) => validateNestedStrategy(n, `${path}.nested[${i}]`, depth + 1))
    : [];
  return { slotId, strategyId, params, nested };
}

// `name` defaults by array position for project files saved before rule naming existed —
// keeps old files loadable without a migration entry for what is a purely cosmetic field.
// `ruleDisabled` defaults to false for the same reason (files saved before the whole-rule
// toggle existed never had any of their checks excluded). `kind` defaults to "" for files saved
// before rules carried their own kind (it used to be derived from the first member check at
// runtime) — an empty-string kind only affects the "add check to rule" candidate match, not
// loading itself, and gets corrected as soon as the user adds or removes a member check.
function validateQcRule(v: unknown, path: string, index: number): ProjectFileQcRule {
  const obj = assertObject(v, path);
  const id = assertString(obj.id, `${path}.id`);
  const name = typeof obj.name === "string" ? obj.name : m["quality.default_rule_name"]({ n: index + 1 });
  const kind = typeof obj.kind === "string" ? obj.kind : "";
  const checks = assertArray(obj.checks, `${path}.checks`).map((c, i) => validateCheckInstance(c, `${path}.checks[${i}]`));
  assertUniqueIds(checks, (c) => c.localId, "localId", `${path}.checks`);
  const strategyId = obj.strategyId === null || obj.strategyId === undefined ? null : assertString(obj.strategyId, `${path}.strategyId`);
  const disabled = assertBoolean(obj.disabled, `${path}.disabled`);
  const ruleDisabled = typeof obj.ruleDisabled === "boolean" ? obj.ruleDisabled : false;
  const nestedStrategies = obj.nestedStrategies != null
    ? assertArray(obj.nestedStrategies, `${path}.nestedStrategies`).map((n, i) => validateNestedStrategy(n, `${path}.nestedStrategies[${i}]`))
    : [];
  return { id, name, kind, checks, strategyId, disabled, ruleDisabled, nestedStrategies };
}

// See GitHub issue #65. Shape-only validation here — cross-stage integrity (duplicate rule id
// across stages, unknown rule id referenced, rule missing from every stage) is checked once, in
// `parseAndValidate`, after every rule and stage has been individually validated (needs the full
// `rules` list to check against, not available per-stage).
// `disabled` defaults to `false` for stages saved before the whole-stage toggle existed (see
// GitHub issue #65's UI follow-up) — same pattern as `ruleDisabled`'s default in `validateQcRule`.
function validateQcStage(v: unknown, path: string): ProjectFileStage {
  const obj = assertObject(v, path);
  const id = assertString(obj.id, `${path}.id`);
  const name = assertString(obj.name, `${path}.name`);
  const ruleIds = assertArray(obj.ruleIds, `${path}.ruleIds`).map((r, i) => assertString(r, `${path}.ruleIds[${i}]`));
  const disabled = typeof obj.disabled === "boolean" ? obj.disabled : false;
  return { id, name, ruleIds, disabled };
}

function validatePresetTeleportEntry(v: unknown, path: string): PresetTeleportEntry {
  const obj = assertObject(v, path);
  return {
    id: assertNumber(obj.id, `${path}.id`),
    from: validateCoordPair(obj.from, `${path}.from`),
    to: validateCoordPair(obj.to, `${path}.to`),
    direction: validateTeleportDirection(obj.direction, `${path}.direction`),
  };
}

function validateNodeLockKind(v: unknown, path: string): NodeLockKind {
  const kind = assertString(v, path);
  if (kind !== "in" && kind !== "out" && kind !== "both")
    throw new Error(`Invalid NodeLockKind at ${path}: ${kind}`);
  return kind;
}

// ─── Top-level parse ─────────────────────────────────────────────────────────

export function parseAndValidate(raw: unknown): ProjectFile {
  const obj = assertObject(raw, "root");

  const version = assertNumber(obj.version, "version");
  if (version > CURRENT_VERSION)
    throw new Error(`File version ${version} is newer than supported (${CURRENT_VERSION})`);

  const migrated = assertObject(migrateToLatest(obj, version), "root (migrated)");

  // tessellation
  const tessObj = assertObject(migrated.tessellation, "tessellation");
  const config = validateTessellationConfig(tessObj.config);
  const savedConfigs: TessellationConfig[] = tessObj.savedConfigs != null
    ? assertArray(tessObj.savedConfigs, "tessellation.savedConfigs").map((v, i) => validateTessellationConfig(v, `tessellation.savedConfigs[${i}]`))
    : [];

  // generation
  const genObj = assertObject(migrated.generation, "generation");
  const seed = assertNumber(genObj.seed, "generation.seed");
  const randomSeed = assertBoolean(genObj.randomSeed, "generation.randomSeed");
  const initial = assertObject(genObj.initial, "generation.initial") as unknown as InitialGenerationConfig;
  assertString((initial as Record<string, unknown>).method as unknown, "generation.initial.method");
  const elements = assertObject(genObj.elements, "generation.elements") as unknown as ElementsConfig;
  // Optional — absent in project files saved before QC Only became a persistent toggle (see
  // GitHub issue #96); old files default to off, same as a fresh store.
  const qcExperiment = optBool(genObj, "qcExperiment", false);
  // Optional — absent in project files saved before seed history existed (see GitHub issue #114).
  // Elements are filtered to safe integers, not just `typeof === "number"`, to drop NaN/Infinity/
  // fractional garbage from a corrupted file. `seedHistoryIndex` is clamped into range rather than
  // rejected outright — an out-of-range or missing index just falls back to "most recent".
  const rawSeedHistory = Array.isArray(genObj.seedHistory) ? genObj.seedHistory : [];
  const seedHistory = rawSeedHistory.filter((v): v is number => typeof v === "number" && Number.isSafeInteger(v));
  const seedHistoryIndex = seedHistory.length === 0
    ? 0
    : Math.min(Math.max(optNumber(genObj, "seedHistoryIndex", seedHistory.length - 1), 0), seedHistory.length - 1);

  // quality
  const qualObj = assertObject(migrated.quality, "quality");
  // Rules with no kind (e.g. corrupted or saved before rules carried a kind) can never accept a
  // check via "add check to rule" again (the candidate filter matches by kind) — drop them on load
  // rather than keep them around as permanently inert cards.
  const rules = assertArray(qualObj.rules, "quality.rules")
    .map((v, i) => validateQcRule(v, `quality.rules[${i}]`, i))
    .filter((r) => r.kind !== "");
  // See GitHub issue #65 and Specs/quality-feature.md's "Project file persistence" section.
  // Two cases: the key is absent entirely (file saved before this feature — recovery synthesizes
  // one stage covering every rule, not a registered migration, same pattern as
  // repairMaxIterations/ruleDisabled below) vs. the key is present (validated for full
  // consistency against `rules` — any violation is a hard parse error, not a silent recovery,
  // since a present-but-inconsistent key means the file is corrupted, not merely old).
  const ruleIds = new Set(rules.map((r) => r.id));
  let stages: ProjectFileStage[];
  if (!("stages" in qualObj)) {
    stages = [{ id: "stage_1", name: "Stage 1", ruleIds: rules.map((r) => r.id), disabled: false }];
  } else {
    const parsedStages = assertArray(qualObj.stages, "quality.stages").map((v, i) => validateQcStage(v, `quality.stages[${i}]`));
    // A `ruleId` in a stage that doesn't resolve to a surviving rule is only ever a rule dropped
    // by the kind-drop recovery above (see "Rules with no kind" comment) — that rule never
    // reaches `rules`/`ruleIds`, so a strict "unknown rule id" error here would fire on every
    // legacy file exercising that same recovery path. Scrub it silently instead; genuinely
    // unknown ids (never present in the file's own `quality.rules` at all) are indistinguishable
    // from this case at this point and get the same silent scrub — a stricter check would need to
    // track "known but kind-dropped" separately, which isn't worth the complexity for a
    // stale-reference cleanup that's a no-op either way.
    stages = parsedStages.map((s) => ({ ...s, ruleIds: s.ruleIds.filter((id) => ruleIds.has(id)) }));
    const seenInStage = new Set<string>();
    for (const stage of stages) {
      for (const ruleId of stage.ruleIds) {
        if (seenInStage.has(ruleId)) throw new Error(`quality.stages: rule id ${ruleId} appears in more than one stage`);
        seenInStage.add(ruleId);
      }
    }
    for (const r of rules) {
      if (!seenInStage.has(r.id)) throw new Error(`quality.stages: rule id ${r.id} is not assigned to any stage`);
    }
  }
  const strategyParams = assertStringRecordRecord(qualObj.strategyParams, "quality.strategyParams");
  // Optional — files saved before this setting existed (key absent entirely) default to the same
  // values as a fresh store (see generationSlice's initial state): max_iterations capped, no time
  // budget. A key that *is* present but `null` (the user explicitly disabled that limit) must
  // stay `null`, not fall back to the default — checked via `in`, not `typeof === "number"`,
  // which would also catch the legitimate "disabled" case and silently re-enable it on load.
  const repairMaxIterations = "repairMaxIterations" in qualObj
    ? (typeof qualObj.repairMaxIterations === "number" ? qualObj.repairMaxIterations : null)
    : 100;
  const repairTimeBudgetSecs = "repairTimeBudgetSecs" in qualObj
    ? (typeof qualObj.repairTimeBudgetSecs === "number" ? qualObj.repairTimeBudgetSecs : null)
    : 10;

  // presets
  const presetsObj = assertObject(migrated.presets, "presets");
  const connections = validatePairArray(presetsObj.connections, "presets.connections", validatePresetConnectionEntry);
  const lockedNodes = validatePairArray(presetsObj.lockedNodes, "presets.lockedNodes", validateNodeLockKind);
  const defaultEdgeState = assertString(presetsObj.defaultEdgeState, "presets.defaultEdgeState");
  if (defaultEdgeState !== "undefined" && defaultEdgeState !== "wall" && defaultEdgeState !== "passage")
    throw new Error(`Invalid defaultEdgeState: ${defaultEdgeState}`);
  const autoLock = assertBoolean(presetsObj.autoLock, "presets.autoLock");
  const presetStart = optCoordPair(presetsObj.start, "presets.start");
  const presetFinish = optCoordPair(presetsObj.finish, "presets.finish");
  const genSource = optCoordPair(presetsObj.genSource, "presets.genSource");
  // Optional — absent in project files saved before preset teleports existed.
  const teleports = presetsObj.teleports != null
    ? assertArray(presetsObj.teleports, "presets.teleports").map((v, i) => validatePresetTeleportEntry(v, `presets.teleports[${i}]`))
    : [];
  assertUniqueIds(teleports, (t) => t.id, "teleport id", "presets.teleports");

  // postEdit
  const postEdit = migrated.postEdit === null || migrated.postEdit === undefined
    ? null
    : validatePostEdit(migrated.postEdit);

  // dirtyFlags (optional section — defaults false for old files)
  const dirtyFlagsObj = optSection(migrated, "dirtyFlags", "dirtyFlags");
  const dirtyFlags: ProjectFileDirtyFlags = {
    postEdit: optBool(dirtyFlagsObj, "postEdit", false),
    field: optBool(dirtyFlagsObj, "field", false),
    presets: optBool(dirtyFlagsObj, "presets", false),
    maze: optBool(dirtyFlagsObj, "maze", false),
  };

  // analytics
  const analyticsObj = assertObject(migrated.analytics, "analytics");
  const analytics: ProjectFileAnalytics = {
    showMazeOverlay: assertBoolean(analyticsObj.showMazeOverlay, "analytics.showMazeOverlay"),
    showComponentsOverlay: assertBoolean(analyticsObj.showComponentsOverlay, "analytics.showComponentsOverlay"),
    showGraphOverlay: assertBoolean(analyticsObj.showGraphOverlay, "analytics.showGraphOverlay"),
    showNavGraphOverlay: assertBoolean(analyticsObj.showNavGraphOverlay, "analytics.showNavGraphOverlay"),
    // Optional — absent in project files saved before these toggles existed.
    showPureCyclesOverlay: optBool(analyticsObj, "showPureCyclesOverlay", false),
    showRouteOverlay: assertBoolean(analyticsObj.showRouteOverlay, "analytics.showRouteOverlay"),
    showRegionClassesOverlay: optBool(analyticsObj, "showRegionClassesOverlay", false),
    sectionsExpanded: analyticsObj.sectionsExpanded != null
      ? assertBoolRecord(analyticsObj.sectionsExpanded, "analytics.sectionsExpanded")
      : { layers: true },
  };

  // debug (optional section — defaults for old files)
  const debugObj = optSection(migrated, "debug", "debug");
  const debug: ProjectFileDebug = {
    debugMode: optBool(debugObj, "debugMode", false),
    debugStep: optNumber(debugObj, "debugStep", 0),
    debugAutoPlayDelay: optNumber(debugObj, "debugAutoPlayDelay", 200),
  };

  // ui (optional section — defaults for old files)
  const uiObj = optSection(migrated, "ui", "ui");
  const validFeatureIds: FeatureId[] = ["basic_config", "field_setup", "preset_connections", "quality", "generation", "post_edit", "analytics"];
  const ui: ProjectFileUi = {
    showPresetOrigin: optBool(uiObj, "showPresetOrigin", false),
    showFieldOrigin: optBool(uiObj, "showFieldOrigin", true),
    openCard: uiObj != null && typeof uiObj.openCard === "string" && validFeatureIds.includes(uiObj.openCard as FeatureId) ? uiObj.openCard as FeatureId : "basic_config",
    postEditAutoConfirm: optBool(uiObj, "postEditAutoConfirm", true),
  };

  return {
    version: CURRENT_VERSION,
    tessellation: { config, savedConfigs },
    generation: { seed, randomSeed, initial, elements, qcExperiment, seedHistory, seedHistoryIndex },
    quality: { rules, stages, strategyParams, repairMaxIterations, repairTimeBudgetSecs },
    presets: {
      connections,
      lockedNodes,
      defaultEdgeState: defaultEdgeState as "undefined" | "wall" | "passage",
      autoLock,
      start: presetStart,
      finish: presetFinish,
      genSource,
      teleports,
    },
    postEdit,
    dirtyFlags,
    analytics,
    debug,
    ui,
  };
}
