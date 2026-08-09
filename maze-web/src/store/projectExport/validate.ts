import type { NodeLockKind } from "../../wasm/types";
import type { PresetConnectionEntry, PresetTeleportEntry } from "../../pixi/fieldEditUtils";
import type { PostEditEdge, PostEditTeleportEntry, FeatureId, RenderModeId } from "../mazeStore";
import type { PostEditEndpoint } from "../../pixi/postEditEndpoint";
import type { PresetEndpoint } from "../../pixi/presetEndpoint";
import {
  MAX_NESTED_STRATEGY_DEPTH, type MarkerSettings, type VectorByWallsSettings, type VectorByCorridorsSettings, type TeleportSettingsFields, type MarkerWidenShape, type PngExportSettings,
  type PngExportOutputMode, type PngCanvasMode, type PrintDensity, type PaperSize, type PaperOrientation, type PrintAnchor,
  type DigitalExportSettings, type PrintExportSettings,
} from "../storeTypes";
import type { MarkerShape } from "../../pixi/renderers/types";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_PNG_EXPORT_SETTINGS } from "../slices/imageExportSlice";
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
  type ProjectFileImageExport,
} from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { InitialGenerationConfig, ElementsConfig, SplitPattern } from "../../wasm/types";
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

function optEnum<T extends string>(obj: Record<string, unknown> | null, key: string, allowed: readonly T[], fallback: T): T {
  const v = obj?.[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function optSection(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> | null {
  return parent[key] != null ? assertObject(parent[key], path) : null;
}

/** Validates `generation.splitGeneration` (GitHub issue #222) — absent in project files saved
 * before this feature existed, so it defaults cleanly to "feature off" rather than throwing.
 * Malformed patterns are dropped individually (never fail the whole load) — a hand-edited or
 * corrupted pattern only degrades that one pattern's availability, not the entire file; the same
 * leniency `validatePairArray`'s callers apply to individually-recoverable entries elsewhere. */
function validateSplitGeneration(v: unknown, path: string): { patternMode: boolean; maxSplitNodes: number; patterns: SplitPattern[] } {
  if (v == null) return { patternMode: false, maxSplitNodes: 2, patterns: [] };
  let obj: Record<string, unknown>;
  try {
    obj = assertObject(v, path);
  } catch {
    return { patternMode: false, maxSplitNodes: 2, patterns: [] };
  }
  const patternMode = optBool(obj, "patternMode", false);
  const maxSplitNodes = Math.max(1, Math.trunc(optNumber(obj, "maxSplitNodes", 2)));
  const rawPatterns = Array.isArray(obj.patterns) ? obj.patterns : [];
  const patterns: SplitPattern[] = [];
  for (const raw of rawPatterns) {
    const pattern = tryValidateSplitPattern(raw);
    if (pattern) patterns.push(pattern);
  }
  return { patternMode, maxSplitNodes, patterns };
}

function tryValidateSplitPattern(v: unknown): SplitPattern | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.node_count !== "number" || !Array.isArray(obj.faces)) return null;
  const faces: SplitPattern["faces"] = [];
  for (const nodeFaces of obj.faces) {
    if (!Array.isArray(nodeFaces)) return null;
    const validatedNodeFaces: SplitPattern["faces"][number] = [];
    for (const face of nodeFaces) {
      const validatedFace = tryValidateSplitPatternFace(face);
      if (!validatedFace) return null;
      validatedNodeFaces.push(validatedFace);
    }
    faces.push(validatedNodeFaces);
  }
  const weight = typeof obj.weight === "number" ? obj.weight : 1.0;
  return { node_count: obj.node_count, faces, weight };
}

function tryValidateSplitPatternFace(v: unknown): SplitPattern["faces"][number][number] | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.face_index !== "number") return null;
  const requirement = tryValidateSplitFaceRequirement(obj.requirement);
  if (!requirement) return null;
  const sibling_target = typeof obj.sibling_target === "number" ? obj.sibling_target : undefined;
  return { face_index: obj.face_index, requirement, sibling_target };
}

function tryValidateSplitFaceRequirement(v: unknown): SplitPattern["faces"][number][number]["requirement"] | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  switch (obj.kind) {
    case "passage": return { kind: "passage" };
    case "wall": return { kind: "wall" };
    case "unspecified": return { kind: "unspecified" };
    case "one_way":
      return obj.direction === "forward" || obj.direction === "backward"
        ? { kind: "one_way", direction: obj.direction }
        : null;
    default: return null;
  }
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

/** Validates a `PostEditEndpoint` tagged union (GitHub issue #221) — `kind: "node"` (a plain
 * resolved id) or `kind: "split"` (a `(point, slotId)` reference to one of a split point's extra
 * nodes). Only *format* is checked here — whether a `split` endpoint's point still actually
 * exists in the tessellation can't be verified at project-load time (no `Field` to check against
 * yet); that's `apply_split_points` on the WASM side's job, surfacing as an ordinary
 * `confirmPostEdit` error on first confirm after load, not a load-time failure. */
function validatePostEditEndpoint(v: unknown, path: string): PostEditEndpoint {
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

function validatePostEditEdge(v: unknown, path: string): PostEditEdge {
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

function validatePostEditTeleportEntry(v: unknown, path: string): PostEditTeleportEntry {
  const obj = assertObject(v, path);
  return {
    id: assertNumber(obj.id, `${path}.id`),
    from: validatePostEditEndpoint(obj.from, `${path}.from`),
    to: validatePostEditEndpoint(obj.to, `${path}.to`),
    direction: validateTeleportDirection(obj.direction, `${path}.direction`),
  };
}

/** Validates `postEdit.splitPoints` (GitHub issue #221) — each value must be an array of unique
 * non-negative integer slotIds. Format only, same rationale as `validatePostEditEndpoint`. */
function validateSplitPoints(v: unknown, path: string): Record<string, number[]> {
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

function validatePostEdit(v: unknown): ProjectFilePostEdit {
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
  return { edges, meta, teleports, splitPoints };
}

function validateCoordPair(v: unknown, path: string): [number, number] {
  const arr = assertArray(v, path);
  return [assertNumber(arr[0], `${path}[0]`), assertNumber(arr[1], `${path}[1]`)];
}

// GitHub issue #231 — a preset endpoint is a point plus an optional slot. `slotId` is optional in
// the loaded JSON (omitted entirely for a plain, non-split endpoint) rather than `null`, matching
// how `presetEndpoint()` constructs entries client-side (`{ point }`, no `slotId` key at all).
function validatePresetEndpoint(v: unknown, path: string): PresetEndpoint {
  const obj = assertObject(v, path);
  const point = validateCoordPair(obj.point, `${path}.point`);
  if (obj.slotId === undefined) return { point };
  const slotId = assertNumber(obj.slotId, `${path}.slotId`);
  if (!Number.isInteger(slotId) || slotId < 0) throw new Error(`Expected non-negative integer slotId at ${path}.slotId, got ${slotId}`);
  return { point, slotId };
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
    from: validatePresetEndpoint(obj.from, `${path}.from`),
    to: validatePresetEndpoint(obj.to, `${path}.to`),
    state: state as PresetConnectionEntry["state"],
    source: source as "user" | "default",
  };
}

// `disabled` defaults to `false` for project files saved before the per-check toggle existed —
// same pattern as `ruleDisabled`'s default in `validateQcRule` below.
function validateCheckInstance(v: unknown, path: string): { localId: number; typeId: string; params: Record<string, string>; disabled: boolean } {
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
  // Absent entirely for project files saved before rule-level params existed (GitHub issue
  // #253) — same recovery pattern `nestedStrategies` above uses.
  const params = assertStringRecord(obj.params ?? {}, `${path}.params`);
  return { id, name, kind, checks, strategyId, disabled, ruleDisabled, nestedStrategies, params };
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
    from: validatePresetEndpoint(obj.from, `${path}.from`),
    to: validatePresetEndpoint(obj.to, `${path}.to`),
    direction: validateTeleportDirection(obj.direction, `${path}.direction`),
  };
}

function validateNodeLockKind(v: unknown, path: string): NodeLockKind {
  const kind = assertString(v, path);
  if (kind !== "in" && kind !== "out" && kind !== "both")
    throw new Error(`Invalid NodeLockKind at ${path}: ${kind}`);
  return kind;
}

// ─── Image Export (GitHub issue #295) ────────────────────────────────────────

const MARKER_SHAPES = ["circle", "triangle", "square", "diamond", "pentagon", "star", "hexagon", "cross"] as const;
function optMarkerShape(obj: Record<string, unknown> | null, key: string, fallback: MarkerSettings["shape"]): MarkerSettings["shape"] {
  const v = obj?.[key];
  return typeof v === "string" && (MARKER_SHAPES as readonly string[]).includes(v) ? (v as MarkerSettings["shape"]) : fallback;
}

function optTeleportCornerStyle(obj: Record<string, unknown> | null, key: string, fallback: "sharp" | "round"): "sharp" | "round" {
  const v = obj?.[key];
  return v === "sharp" || v === "round" ? v : fallback;
}

function optMarkerWidenShape(obj: Record<string, unknown> | null, key: string, fallback: MarkerWidenShape): MarkerWidenShape {
  const v = obj?.[key];
  return v === "circle" || v === "square" || v === "match_marker" ? v : fallback;
}

function optJoin(obj: Record<string, unknown> | null, key: string, fallback: "round" | "miter"): "round" | "miter" {
  const v = obj?.[key];
  return v === "round" || v === "miter" ? v : fallback;
}

function optOneWayPattern(obj: Record<string, unknown> | null, key: string, fallback: "triangle" | "chevron" | "arrow"): "triangle" | "chevron" | "arrow" {
  const v = obj?.[key];
  return v === "triangle" || v === "chevron" || v === "arrow" ? v : fallback;
}

function optTeleportConnectorStyle(obj: Record<string, unknown> | null, key: string, fallback: "none" | "straight" | "orthogonal"): "none" | "straight" | "orthogonal" {
  const v = obj?.[key];
  return v === "none" || v === "straight" || v === "orthogonal" ? v : fallback;
}

function optTeleportArrowMode(obj: Record<string, unknown> | null, key: string, fallback: "none" | "center" | "double" | "periodic"): "none" | "center" | "double" | "periodic" {
  const v = obj?.[key];
  return v === "none" || v === "center" || v === "double" || v === "periodic" ? v : fallback;
}

function validateMarkerSettings(v: unknown, path: string, fallback: MarkerSettings): MarkerSettings {
  if (v == null) return fallback;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return fallback;
  }
  return {
    shape: optMarkerShape(obj, "shape", fallback.shape),
    cornerStyle: optTeleportCornerStyle(obj, "cornerStyle", fallback.cornerStyle),
    fillColor: optNumber(obj, "fillColor", fallback.fillColor),
    borderColor: optNumber(obj, "borderColor", fallback.borderColor),
    borderWidth: optNumber(obj, "borderWidth", fallback.borderWidth),
    gapWidth: optNumber(obj, "gapWidth", fallback.gapWidth),
    size: optNumber(obj, "size", fallback.size),
  };
}

/** Format-only validation of one group's override — an unresolvable `shape` just falls back to
 * the base style at render time (same "never throw" convention as `resolveRenderMode`), so a
 * malformed entry is dropped rather than failing the whole file. */
function tryValidateTeleportGroupOverride(v: unknown): { fillColor?: number; borderColor?: number; shape?: MarkerShape } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  const result: { fillColor?: number; borderColor?: number; shape?: MarkerShape } = {};
  if (typeof obj.fillColor === "number") result.fillColor = obj.fillColor;
  if (typeof obj.borderColor === "number") result.borderColor = obj.borderColor;
  if (typeof obj.shape === "string" && (MARKER_SHAPES as readonly string[]).includes(obj.shape)) result.shape = obj.shape as MarkerShape;
  return result;
}

/** Shared by `validateVectorByWallsSettings`/`validateVectorByCorridorsSettings` (GitHub issue
 * #313) — `TeleportSettingsFields` is `extends`-ed identically by both settings interfaces, so the
 * two never need their own separate recovery logic for it. */
function validateTeleportSettingsFields(obj: Record<string, unknown> | null, path: string, d: TeleportSettingsFields): TeleportSettingsFields {
  return {
    teleportLineCornerStyle: optTeleportCornerStyle(obj, "teleportLineCornerStyle", d.teleportLineCornerStyle),
    teleportLineShape: optMarkerShape(obj, "teleportLineShape", d.teleportLineShape),
    teleportLineSize: optNumber(obj, "teleportLineSize", d.teleportLineSize),
    teleportEdgeColor: optNumber(obj, "teleportEdgeColor", d.teleportEdgeColor),
    teleportEdgeBorderColor: optNumber(obj, "teleportEdgeBorderColor", d.teleportEdgeBorderColor),
    teleportEdgeBorderWidth: optNumber(obj, "teleportEdgeBorderWidth", d.teleportEdgeBorderWidth),
    teleportEdgeGapWidth: optNumber(obj, "teleportEdgeGapWidth", d.teleportEdgeGapWidth),
    teleportConnectorColor: optNumber(obj, "teleportConnectorColor", d.teleportConnectorColor),
    teleportConnectorWidth: optNumber(obj, "teleportConnectorWidth", d.teleportConnectorWidth),
    teleportConnectorStyle: optTeleportConnectorStyle(obj, "teleportConnectorStyle", d.teleportConnectorStyle),
    teleportAvoidFieldExit: optBool(obj, "teleportAvoidFieldExit", d.teleportAvoidFieldExit),
    teleportArrowMode: optTeleportArrowMode(obj, "teleportArrowMode", d.teleportArrowMode),
    teleportArrowPeriod: optNumber(obj, "teleportArrowPeriod", d.teleportArrowPeriod),
    teleportArrowSize: optNumber(obj, "teleportArrowSize", d.teleportArrowSize),
    teleportConnectorGapWidth: optNumber(obj, "teleportConnectorGapWidth", d.teleportConnectorGapWidth),
    teleportGroupCustomization: optBool(obj, "teleportGroupCustomization", d.teleportGroupCustomization),
    teleportGroupOverrides: validateTeleportGroupOverrides(obj?.teleportGroupOverrides, `${path}.teleportGroupOverrides`),
  };
}

function validateTeleportGroupOverrides(v: unknown, path: string): Record<string, { fillColor?: number; borderColor?: number; shape?: MarkerShape }> {
  if (v == null) return {};
  let obj: Record<string, unknown>;
  try {
    obj = assertObject(v, path);
  } catch {
    return {};
  }
  const result: Record<string, { fillColor?: number; borderColor?: number; shape?: MarkerShape }> = {};
  for (const [key, raw] of Object.entries(obj)) {
    const override = tryValidateTeleportGroupOverride(raw);
    if (override) result[key] = override;
  }
  return result;
}

/** Lenient — every field falls back to its own default when absent or malformed, same recovery
 * pattern `validateSplitGeneration` uses, since this whole section is optional (absent entirely
 * for project files saved before GitHub issue #295). */
function validateVectorByWallsSettings(v: unknown, path: string): VectorByWallsSettings {
  const d = DEFAULT_VECTOR_BY_WALLS_SETTINGS;
  if (v == null) return d;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return d;
  }
  return {
    background: optNumber(obj, "background", d.background),
    showGrid: optBool(obj, "showGrid", d.showGrid),
    gridColor: optNumber(obj, "gridColor", d.gridColor),
    floorColor: optNumber(obj, "floorColor", d.floorColor),
    wallColor: optNumber(obj, "wallColor", d.wallColor),
    wallJoin: optJoin(obj, "wallJoin", d.wallJoin),
    wallThickness: optNumber(obj, "wallThickness", d.wallThickness),
    oneWayPattern: optOneWayPattern(obj, "oneWayPattern", d.oneWayPattern),
    oneWayColor: optNumber(obj, "oneWayColor", d.oneWayColor),
    oneWayGapWidth: optNumber(obj, "oneWayGapWidth", d.oneWayGapWidth),
    oneWaySize: optNumber(obj, "oneWaySize", d.oneWaySize),
    oneWayThickness: optNumber(obj, "oneWayThickness", d.oneWayThickness),
    oneWayJoin: optJoin(obj, "oneWayJoin", d.oneWayJoin),
    startMarker: validateMarkerSettings(obj.startMarker, `${path}.startMarker`, d.startMarker),
    finishMarker: validateMarkerSettings(obj.finishMarker, `${path}.finishMarker`, d.finishMarker),
    ...validateTeleportSettingsFields(obj, path, d),
    splitNodeColors: Array.isArray(obj.splitNodeColors) ? obj.splitNodeColors.filter((n): n is number => typeof n === "number") : d.splitNodeColors,
    splitSpecialShapes: optBool(obj, "splitSpecialShapes", d.splitSpecialShapes),
  };
}

const KNOWN_RENDER_MODE_IDS: RenderModeId[] = ["vector_by_walls", "vector_by_corridors"];

/** Degrades to `null` for an unknown/future `RenderModeId` — same "never throw" convention
 * `resolveRenderMode` itself uses, so a project file naming a since-removed/renamed mode loads
 * as "no mode selected" rather than failing the whole file. */
function optRenderModeId(obj: Record<string, unknown> | null, key: string): RenderModeId | null {
  const v = obj?.[key];
  return typeof v === "string" && (KNOWN_RENDER_MODE_IDS as readonly string[]).includes(v) ? (v as RenderModeId) : null;
}

const KNOWN_OUTPUT_MODES: PngExportOutputMode[] = ["digital", "print"];
const KNOWN_CANVAS_MODES: PngCanvasMode[] = ["edge_to_edge", "margin_px", "margin_cells", "fixed_size"];
const KNOWN_PRINT_DENSITIES: PrintDensity[] = ["screen_96", "draft_150", "print_300", "high_600"];
const KNOWN_PAPER_SIZES: PaperSize[] = ["a4", "a3", "a5", "a2", "a1", "a0", "letter", "legal", "tabloid", "custom"];
const KNOWN_ORIENTATIONS: PaperOrientation[] = ["portrait", "landscape"];
const KNOWN_ANCHORS: PrintAnchor[] = [
  "top_left", "top_center", "top_right",
  "center_left", "center", "center_right",
  "bottom_left", "bottom_center", "bottom_right",
  "custom",
];

function validateDigitalExportSettings(v: unknown, path: string): DigitalExportSettings {
  const d = DEFAULT_PNG_EXPORT_SETTINGS.digital;
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  return {
    scale: optNumber(obj, "scale", d.scale),
    canvasMode: optEnum(obj, "canvasMode", KNOWN_CANVAS_MODES, d.canvasMode),
    marginValue: optNumber(obj, "marginValue", d.marginValue),
    fixedWidth: optNumber(obj, "fixedWidth", d.fixedWidth),
    fixedHeight: optNumber(obj, "fixedHeight", d.fixedHeight),
  };
}

function validatePrintExportSettings(v: unknown, path: string): PrintExportSettings {
  const d = DEFAULT_PNG_EXPORT_SETTINGS.print;
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  return {
    density: optEnum(obj, "density", KNOWN_PRINT_DENSITIES, d.density),
    paperSize: optEnum(obj, "paperSize", KNOWN_PAPER_SIZES, d.paperSize),
    customWidthMm: optNumber(obj, "customWidthMm", d.customWidthMm),
    customHeightMm: optNumber(obj, "customHeightMm", d.customHeightMm),
    orientation: optEnum(obj, "orientation", KNOWN_ORIENTATIONS, d.orientation),
    marginHMm: optNumber(obj, "marginHMm", d.marginHMm),
    marginVMm: optNumber(obj, "marginVMm", d.marginVMm),
    scale: optNumber(obj, "scale", d.scale),
    scaleAutoFit: optBool(obj, "scaleAutoFit", d.scaleAutoFit),
    anchor: optEnum(obj, "anchor", KNOWN_ANCHORS, d.anchor),
    offsetXMm: optNumber(obj, "offsetXMm", d.offsetXMm),
    offsetYMm: optNumber(obj, "offsetYMm", d.offsetYMm),
  };
}

function validatePngExportSettings(v: unknown, path: string): PngExportSettings {
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  return {
    outputMode: optEnum(obj, "outputMode", KNOWN_OUTPUT_MODES, DEFAULT_PNG_EXPORT_SETTINGS.outputMode),
    digital: validateDigitalExportSettings(obj?.digital, `${path}.digital`),
    print: validatePrintExportSettings(obj?.print, `${path}.print`),
  };
}

/** Same recovery-default convention as `validateVectorByWallsSettings` (GitHub issue #310). */
function validateVectorByCorridorsSettings(v: unknown, path: string): VectorByCorridorsSettings {
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  const d = DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS;
  return {
    color: optNumber(obj, "color", d.color),
    thickness: optNumber(obj, "thickness", d.thickness),
    join: optJoin(obj, "join", d.join),
    startMarker: validateMarkerSettings(obj?.startMarker, `${path}.startMarker`, d.startMarker),
    finishMarker: validateMarkerSettings(obj?.finishMarker, `${path}.finishMarker`, d.finishMarker),
    markerWidenPadding: optNumber(obj, "markerWidenPadding", d.markerWidenPadding),
    markerWidenShape: optMarkerWidenShape(obj, "markerWidenShape", d.markerWidenShape),
    ...validateTeleportSettingsFields(obj, path, d),
  };
}

function validateImageExport(v: unknown, path: string): ProjectFileImageExport {
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  return {
    activeRenderMode: optRenderModeId(obj, "activeRenderMode"),
    openRenderModeSettings: optRenderModeId(obj, "openRenderModeSettings"),
    vectorByWallsSettings: validateVectorByWallsSettings(obj?.vectorByWallsSettings, `${path}.vectorByWallsSettings`),
    vectorByWallsSectionsExpanded: obj?.vectorByWallsSectionsExpanded != null
      ? assertBoolRecord(obj.vectorByWallsSectionsExpanded, `${path}.vectorByWallsSectionsExpanded`)
      : {},
    vectorByCorridorsSettings: validateVectorByCorridorsSettings(obj?.vectorByCorridorsSettings, `${path}.vectorByCorridorsSettings`),
    vectorByCorridorsSectionsExpanded: obj?.vectorByCorridorsSectionsExpanded != null
      ? assertBoolRecord(obj.vectorByCorridorsSectionsExpanded, `${path}.vectorByCorridorsSectionsExpanded`)
      : {},
    pngExportSettings: validatePngExportSettings(obj?.pngExportSettings, `${path}.pngExportSettings`),
  };
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
  // Optional — absent in project files saved before automatic split-point assignment existed
  // (GitHub issue #222). Defaults cleanly (never throws) to the feature-off shape.
  const splitGeneration = validateSplitGeneration(genObj.splitGeneration, "generation.splitGeneration");
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
  const presetStart = presetsObj.start == null ? null : validatePresetEndpoint(presetsObj.start, "presets.start");
  const presetFinish = presetsObj.finish == null ? null : validatePresetEndpoint(presetsObj.finish, "presets.finish");
  const genSource = presetsObj.genSource == null ? null : validatePresetEndpoint(presetsObj.genSource, "presets.genSource");
  // Optional — absent in project files saved before preset teleports existed.
  const teleports = presetsObj.teleports != null
    ? assertArray(presetsObj.teleports, "presets.teleports").map((v, i) => validatePresetTeleportEntry(v, `presets.teleports[${i}]`))
    : [];
  assertUniqueIds(teleports, (t) => t.id, "teleport id", "presets.teleports");
  // Optional — absent in project files saved before preset split points existed (GitHub issue #231).
  const presetSplitPoints = presetsObj.splitPoints != null ? validateSplitPoints(presetsObj.splitPoints, "presets.splitPoints") : {};

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
  const validFeatureIds: FeatureId[] = ["basic_config", "field_setup", "preset_connections", "quality", "generation", "post_edit", "analytics", "image_export"];
  const ui: ProjectFileUi = {
    showPresetOrigin: optBool(uiObj, "showPresetOrigin", false),
    showFieldOrigin: optBool(uiObj, "showFieldOrigin", true),
    openCard: uiObj != null && typeof uiObj.openCard === "string" && validFeatureIds.includes(uiObj.openCard as FeatureId) ? uiObj.openCard as FeatureId : "basic_config",
    postEditAutoConfirm: optBool(uiObj, "postEditAutoConfirm", true),
  };

  return {
    version: CURRENT_VERSION,
    tessellation: { config, savedConfigs },
    generation: { seed, randomSeed, initial, elements, splitGeneration, qcExperiment, seedHistory, seedHistoryIndex },
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
      splitPoints: presetSplitPoints,
    },
    postEdit,
    dirtyFlags,
    analytics,
    debug,
    ui,
    imageExport: validateImageExport(migrated.imageExport, "imageExport"),
  };
}
