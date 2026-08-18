import type { NodeLockKind } from "../../wasm/types";
import type { PresetConnectionEntry, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../../pixi/fieldEditUtils";
import type { PostEditEdge, PostEditTeleportEntry, PostEditVerticalPassageEntry, PostEditElevatorEntry } from "../mazeStore";
import type { PostEditEndpoint } from "../../pixi/postEditEndpoint";
import type { PresetEndpoint } from "../../pixi/presetEndpoint";
import { MAX_NESTED_STRATEGY_DEPTH } from "../storeTypes";
import type {
  ProjectFilePostEdit,
  ProjectFileQcRule,
  ProjectFileStage,
  ProjectFileNestedStrategy,
} from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import * as m from "~/paraglide/messages";
import {
  assertObject, assertString, assertNumber, assertBoolean, assertArray, assertHexOrientation, assertTriOrientation,
  assertStringRecord, optEnum, validatePairArray, assertUniqueIds, validateTeleportDirection, validateVerticalPassageDirection,
} from "./validatePrimitives";

// ─── Section validators ──────────────────────────────────────────────────────

export function validateTessellationConfig(v: unknown, path = "tessellation.config"): TessellationConfig {
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

/** Validates one floor's own field-shape state (GitHub issue #338) — `config`/`savedConfigs` reuse
 * `validateTessellationConfig`; `freeFieldPoints` are plain coordinate arrays on disk (`fieldPoints`
 * itself is re-derived on load, same as the pre-#338 shape always did). */
export function validateFloorFieldConfig(v: unknown, path: string): { config: TessellationConfig; savedConfigs: TessellationConfig[]; freeFieldPoints: Record<"square" | "hex" | "triangle", [number, number][]>; fieldEditMode: "default" | "custom" } {
  const obj = assertObject(v, path);
  const config = validateTessellationConfig(obj.config, `${path}.config`);
  const savedConfigs: TessellationConfig[] = obj.savedConfigs != null
    ? assertArray(obj.savedConfigs, `${path}.savedConfigs`).map((sv, i) => validateTessellationConfig(sv, `${path}.savedConfigs[${i}]`))
    : [];
  const validatePoints = (raw: unknown, kindPath: string): [number, number][] => {
    if (raw == null) return [];
    return assertArray(raw, kindPath).map((pt, i) => {
      const pair = assertArray(pt, `${kindPath}[${i}]`);
      return [assertNumber(pair[0], `${kindPath}[${i}][0]`), assertNumber(pair[1], `${kindPath}[${i}][1]`)] as [number, number];
    });
  };
  const freeObj = obj.freeFieldPoints != null ? assertObject(obj.freeFieldPoints, `${path}.freeFieldPoints`) : {};
  const freeFieldPoints = {
    square: validatePoints(freeObj.square, `${path}.freeFieldPoints.square`),
    hex: validatePoints(freeObj.hex, `${path}.freeFieldPoints.hex`),
    triangle: validatePoints(freeObj.triangle, `${path}.freeFieldPoints.triangle`),
  };
  const fieldEditMode = optEnum(obj, "fieldEditMode", ["default", "custom"] as const, "default");
  return { config, savedConfigs, freeFieldPoints, fieldEditMode };
}

/** Validates a `PostEditEndpoint` tagged union (GitHub issue #221) — `kind: "node"` (a plain
 * resolved id) or `kind: "split"` (a `(point, slotId)` reference to one of a split point's extra
 * nodes). Only *format* is checked here — whether a `split` endpoint's point still actually
 * exists in the tessellation can't be verified at project-load time (no `Field` to check against
 * yet); that's `apply_split_points` on the WASM side's job, surfacing as an ordinary
 * `confirmPostEdit` error on first confirm after load, not a load-time failure. */
export function validatePostEditEndpoint(v: unknown, path: string): PostEditEndpoint {
  const obj = assertObject(v, path);
  const kind = assertString(obj.kind, `${path}.kind`);
  if (kind === "node") {
    return { kind: "node", id: assertNumber(obj.id, `${path}.id`) };
  }
  if (kind === "split") {
    return {
      kind: "split",
      point: validateCoordPair(obj.point, `${path}.point`),
      slotId: assertNumber(obj.slotId, `${path}.slotId`),
    };
  }
  throw new Error(`Invalid PostEditEndpoint kind at ${path}.kind: ${kind}`);
}

export function validatePostEditEdge(v: unknown, path: string): PostEditEdge {
  const obj = assertObject(v, path);
  const kind = assertString(obj.kind, `${path}.kind`);
  if (kind !== "wall" && kind !== "basic" && kind !== "one_way_forward" && kind !== "one_way_backward")
    throw new Error(`Invalid PostEditEdge kind at ${path}.kind: ${kind}`);
  return {
    from: validatePostEditEndpoint(obj.from, `${path}.from`),
    to: validatePostEditEndpoint(obj.to, `${path}.to`),
    kind,
  };
}

export function validatePostEditTeleportEntry(v: unknown, path: string): PostEditTeleportEntry {
  const obj = assertObject(v, path);
  return {
    id: assertNumber(obj.id, `${path}.id`),
    from: validatePostEditEndpoint(obj.from, `${path}.from`),
    to: validatePostEditEndpoint(obj.to, `${path}.to`),
    direction: validateTeleportDirection(obj.direction, `${path}.direction`),
  };
}

export function validatePostEditVerticalPassageEntry(v: unknown, path: string): PostEditVerticalPassageEntry {
  const obj = assertObject(v, path);
  return {
    id: assertNumber(obj.id, `${path}.id`),
    from: validatePostEditEndpoint(obj.from, `${path}.from`),
    to: validatePostEditEndpoint(obj.to, `${path}.to`),
    direction: validateVerticalPassageDirection(obj.direction, `${path}.direction`),
  };
}

export function validatePostEditElevatorEntry(v: unknown, path: string): PostEditElevatorEntry {
  const obj = assertObject(v, path);
  return {
    id: assertNumber(obj.id, `${path}.id`),
    floors: assertArray(obj.floors, `${path}.floors`).map((f, i) => validatePostEditEndpoint(f, `${path}.floors[${i}]`)),
  };
}

/** Validates `postEdit.splitPoints` (GitHub issue #221) — each value must be an array of unique
 * non-negative integer slotIds. Format only, same rationale as `validatePostEditEndpoint`. */
export function validateSplitPoints(v: unknown, path: string): Record<string, number[]> {
  const obj = assertObject(v, path);
  const result: Record<string, number[]> = {};
  for (const [key, raw] of Object.entries(obj)) {
    const arr = assertArray(raw, `${path}.${key}`);
    const slots = arr.map((s, i) => {
      const n = assertNumber(s, `${path}.${key}[${i}]`);
      if (!Number.isInteger(n) || n < 0) throw new Error(`Expected non-negative integer slotId at ${path}.${key}[${i}], got ${n}`);
      return n;
    });
    if (new Set(slots).size !== slots.length) throw new Error(`Duplicate slotId in ${path}.${key}`);
    result[key] = slots;
  }
  return result;
}

export function validatePostEdit(v: unknown): ProjectFilePostEdit {
  const obj = assertObject(v, "postEdit");
  const edges = validatePairArray(obj.edges, "postEdit.edges", validatePostEditEdge);
  let meta: ProjectFilePostEdit["meta"] = null;
  if (obj.meta !== null && obj.meta !== undefined) {
    const m = assertObject(obj.meta, "postEdit.meta");
    meta = {
      start: m.start === null ? null : validatePostEditEndpoint(m.start, "postEdit.meta.start"),
      finish: m.finish === null ? null : validatePostEditEndpoint(m.finish, "postEdit.meta.finish"),
    };
  }
  // Optional — absent in project files saved before post-edit teleport editing existed.
  const teleports = obj.teleports != null
    ? assertArray(obj.teleports, "postEdit.teleports").map((t, i) => validatePostEditTeleportEntry(t, `postEdit.teleports[${i}]`))
    : [];
  assertUniqueIds(teleports, (t) => t.id, "teleport id", "postEdit.teleports");
  // Optional — absent in project files saved before split points existed (GitHub issue #221).
  const splitPoints = obj.splitPoints != null ? validateSplitPoints(obj.splitPoints, "postEdit.splitPoints") : {};
  // Optional — absent in project files saved before post-edit vertical passages/elevators existed
  // (GitHub issue #341).
  const verticalPassages = obj.verticalPassages != null
    ? assertArray(obj.verticalPassages, "postEdit.verticalPassages").map((v, i) => validatePostEditVerticalPassageEntry(v, `postEdit.verticalPassages[${i}]`))
    : [];
  assertUniqueIds(verticalPassages, (p) => p.id, "vertical passage id", "postEdit.verticalPassages");
  const elevators = obj.elevators != null
    ? assertArray(obj.elevators, "postEdit.elevators").map((v, i) => validatePostEditElevatorEntry(v, `postEdit.elevators[${i}]`))
    : [];
  assertUniqueIds(elevators, (e) => e.id, "elevator id", "postEdit.elevators");
  // Optional — absent in project files saved before elevator editing existed (GitHub issue #341
  // follow-up).
  const suppressedElevatorPairs = obj.suppressedElevatorPairs != null
    ? assertArray(obj.suppressedElevatorPairs, "postEdit.suppressedElevatorPairs").map((s, i) => assertString(s, `postEdit.suppressedElevatorPairs[${i}]`))
    : [];
  // Optional — absent in project files saved before vertical-passage editing existed (GitHub issue
  // #341 follow-up).
  const suppressedVerticalPassagePairs = obj.suppressedVerticalPassagePairs != null
    ? assertArray(obj.suppressedVerticalPassagePairs, "postEdit.suppressedVerticalPassagePairs").map((s, i) => assertString(s, `postEdit.suppressedVerticalPassagePairs[${i}]`))
    : [];
  return { edges, meta, teleports, splitPoints, verticalPassages, elevators, suppressedElevatorPairs, suppressedVerticalPassagePairs };
}

export function validateCoordPair(v: unknown, path: string): [number, number] {
  const arr = assertArray(v, path);
  return [assertNumber(arr[0], `${path}[0]`), assertNumber(arr[1], `${path}[1]`)];
}

// GitHub issue #231 — a preset endpoint is a point plus an optional slot. `slotId` is optional in
// the loaded JSON (omitted entirely for a plain, non-split endpoint) rather than `null`, matching
// how `presetEndpoint()` constructs entries client-side (`{ point }`, no `slotId` key at all).
// GitHub issue #340 — `level` is likewise optional (absent means floor 0), matching
// `presetEndpoint()`'s own optional-key convention.
export function validatePresetEndpoint(v: unknown, path: string): PresetEndpoint {
  const obj = assertObject(v, path);
  const point = validateCoordPair(obj.point, `${path}.point`);
  let slotId: number | undefined;
  if (obj.slotId !== undefined) {
    slotId = assertNumber(obj.slotId, `${path}.slotId`);
    if (!Number.isInteger(slotId) || slotId < 0) throw new Error(`Expected non-negative integer slotId at ${path}.slotId, got ${slotId}`);
  }
  let level: number | undefined;
  if (obj.level !== undefined) {
    level = assertNumber(obj.level, `${path}.level`);
    if (!Number.isInteger(level) || level < 0) throw new Error(`Expected non-negative integer level at ${path}.level, got ${level}`);
  }
  return { point, ...(slotId !== undefined ? { slotId } : {}), ...(level !== undefined ? { level } : {}) };
}

export function validatePresetConnectionEntry(v: unknown, path: string): PresetConnectionEntry {
  const obj = assertObject(v, path);
  const state = assertString(obj.state, `${path}.state`);
  const source = assertString(obj.source, `${path}.source`);
  if (state !== "wall" && state !== "passage" && state !== "one_way_forward" && state !== "one_way_backward" && state !== "undefined")
    throw new Error(`Invalid preset connection state at ${path}.state: ${state}`);
  if (source !== "user" && source !== "default")
    throw new Error(`Invalid preset connection source at ${path}.source: ${source}`);
  return {
    from: validatePresetEndpoint(obj.from, `${path}.from`),
    to: validatePresetEndpoint(obj.to, `${path}.to`),
    state: state as PresetConnectionEntry["state"],
    source: source as "user" | "default",
  };
}

// `disabled` defaults to `false` for project files saved before the per-check toggle existed —
// same pattern as `ruleDisabled`'s default in `validateQcRule` below.
export function validateCheckInstance(v: unknown, path: string): { localId: number; typeId: string; params: Record<string, string>; disabled: boolean } {
  const obj = assertObject(v, path);
  return {
    localId: assertNumber(obj.localId, `${path}.localId`),
    typeId: assertString(obj.typeId, `${path}.typeId`),
    params: assertStringRecord(obj.params ?? {}, `${path}.params`),
    disabled: typeof obj.disabled === "boolean" ? obj.disabled : false,
  };
}

// Mirrors `NestedStrategyState` — absent entirely for project files saved before nested
// strategies existed, same recovery pattern `ruleDisabled`/stage `disabled` already use.
// `depth` guards against a maliciously or accidentally deep `nested` chain in a loaded file —
// this is the one nested-strategy recursion that crosses a real trust boundary (an arbitrary
// file from disk, not web-UI-generated state), so it's the one that must not blow the call stack.
export function validateNestedStrategy(v: unknown, path: string, depth = 0): ProjectFileNestedStrategy {
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
export function validateQcRule(v: unknown, path: string, index: number): ProjectFileQcRule {
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
  // Absent entirely for project files saved before rule-level params existed (GitHub issue
  // #253) — same recovery pattern `nestedStrategies` above uses.
  const params = assertStringRecord(obj.params ?? {}, `${path}.params`);
  // `collapsed` defaults to `false` for files saved before rule collapsing existed (GitHub issue
  // #320) — same recovery pattern `ruleDisabled` above uses.
  const collapsed = typeof obj.collapsed === "boolean" ? obj.collapsed : false;
  return { id, name, kind, checks, strategyId, disabled, ruleDisabled, nestedStrategies, params, collapsed };
}

// See GitHub issue #65. Shape-only validation here — cross-stage integrity (duplicate rule id
// across stages, unknown rule id referenced, rule missing from every stage) is checked once, in
// `parseAndValidate`, after every rule and stage has been individually validated (needs the full
// `rules` list to check against, not available per-stage).
// `disabled` defaults to `false` for stages saved before the whole-stage toggle existed (see
// GitHub issue #65's UI follow-up) — same pattern as `ruleDisabled`'s default in `validateQcRule`.
export function validateQcStage(v: unknown, path: string): ProjectFileStage {
  const obj = assertObject(v, path);
  const id = assertString(obj.id, `${path}.id`);
  const name = assertString(obj.name, `${path}.name`);
  const ruleIds = assertArray(obj.ruleIds, `${path}.ruleIds`).map((r, i) => assertString(r, `${path}.ruleIds[${i}]`));
  const disabled = typeof obj.disabled === "boolean" ? obj.disabled : false;
  // `collapsed` defaults to `false` for files saved before stage collapsing existed (GitHub
  // issue #320) — same pattern as `disabled`'s own default above.
  const collapsed = typeof obj.collapsed === "boolean" ? obj.collapsed : false;
  return { id, name, ruleIds, disabled, collapsed };
}

export function validatePresetTeleportEntry(v: unknown, path: string): PresetTeleportEntry {
  const obj = assertObject(v, path);
  return {
    id: assertNumber(obj.id, `${path}.id`),
    from: validatePresetEndpoint(obj.from, `${path}.from`),
    to: validatePresetEndpoint(obj.to, `${path}.to`),
    direction: validateTeleportDirection(obj.direction, `${path}.direction`),
  };
}

export function validatePresetVerticalPassageEntry(v: unknown, path: string): PresetVerticalPassageEntry {
  const obj = assertObject(v, path);
  return {
    id: assertNumber(obj.id, `${path}.id`),
    from: validatePresetEndpoint(obj.from, `${path}.from`),
    to: validatePresetEndpoint(obj.to, `${path}.to`),
    direction: validateVerticalPassageDirection(obj.direction, `${path}.direction`),
  };
}

export function validatePresetElevatorEntry(v: unknown, path: string): PresetElevatorEntry {
  const obj = assertObject(v, path);
  return {
    id: assertNumber(obj.id, `${path}.id`),
    floors: assertArray(obj.floors, `${path}.floors`).map((f, i) => validatePresetEndpoint(f, `${path}.floors[${i}]`)),
  };
}

export function validateNodeLockKind(v: unknown, path: string): NodeLockKind {
  const kind = assertString(v, path);
  if (kind !== "in" && kind !== "out" && kind !== "both")
    throw new Error(`Invalid NodeLockKind at ${path}: ${kind}`);
  return kind;
}

