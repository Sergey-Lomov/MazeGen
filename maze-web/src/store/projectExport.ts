import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { NodeLockKind, InitialGenerationConfig, ElementsConfig } from "../wasm/types";
import type { PresetConnectionEntry } from "../pixi/presetConnectionsUtils";
import type { PostEditEdge, PostEditMeta, MazeState, FeatureId } from "./mazeStore";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectFilePostEdit {
  edges: [string, PostEditEdge][];
  meta: PostEditMeta | null;
}

export interface ProjectFileAnalytics {
  showMazeOverlay: boolean;
  showComponentsOverlay: boolean;
  showGraphOverlay: boolean;
  showNavGraphOverlay: boolean;
  showRouteOverlay: boolean;
}

export interface ProjectFileDebug {
  debugMode: boolean;
  showDebugFrontier: boolean;
  debugStep: number;
  debugAutoPlayDelay: number;
}

export interface ProjectFileUi {
  showPresetOrigin: boolean;
  showFieldOrigin: boolean;
  openCard: FeatureId;
  postEditAutoConfirm: boolean;
}

export interface ProjectFile {
  version: number;
  tessellation: { config: TessellationConfig; savedConfigs: TessellationConfig[] };
  generation: {
    seed: number;
    randomSeed: boolean;
    initial: InitialGenerationConfig;
    elements: ElementsConfig;
  };
  quality: {
    selectedChecks: string[];
    selectedStrategies: Record<string, string>;
    checkParams: Record<string, Record<string, string>>;
    strategyParams: Record<string, Record<string, string>>;
  };
  presets: {
    connections: [string, PresetConnectionEntry][];
    lockedNodes: [string, NodeLockKind][];
    defaultEdgeState: "undefined" | "wall" | "passage";
    autoLock: boolean;
    start: [number, number] | null;
    finish: [number, number] | null;
    genSource: [number, number] | null;
  };
  postEdit: ProjectFilePostEdit | null;
  analytics: ProjectFileAnalytics;
  debug: ProjectFileDebug;
  ui: ProjectFileUi;
}

const CURRENT_VERSION = 1;

// ─── Migrations ──────────────────────────────────────────────────────────────

const migrations: Record<number, (data: unknown) => unknown> = {
  // future: 1 → 2, etc.
};

function migrateToLatest(data: unknown, fromVersion: number): unknown {
  let result = data;
  for (let v = fromVersion; v < CURRENT_VERSION; v++) {
    const migrate = migrations[v];
    if (!migrate) throw new Error(`No migration for version ${v}`);
    result = migrate(result);
  }
  return result;
}

// ─── Validator ───────────────────────────────────────────────────────────────

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

function validatePostEdit(v: unknown): ProjectFilePostEdit {
  const obj = assertObject(v, "postEdit");
  const edgesArr = assertArray(obj.edges, "postEdit.edges");
  const edges: [string, PostEditEdge][] = edgesArr.map((entry, i) => {
    const pair = assertArray(entry, `postEdit.edges[${i}]`);
    return [
      assertString(pair[0], `postEdit.edges[${i}][0]`),
      validatePostEditEdge(pair[1], `postEdit.edges[${i}][1]`),
    ];
  });
  let meta: PostEditMeta | null = null;
  if (obj.meta !== null && obj.meta !== undefined) {
    const m = assertObject(obj.meta, "postEdit.meta");
    meta = {
      start: m.start === null ? null : assertNumber(m.start, "postEdit.meta.start"),
      finish: m.finish === null ? null : assertNumber(m.finish, "postEdit.meta.finish"),
    };
  }
  return { edges, meta };
}

function validateCoordPair(v: unknown, path: string): [number, number] {
  const arr = assertArray(v, path);
  return [assertNumber(arr[0], `${path}[0]`), assertNumber(arr[1], `${path}[1]`)];
}

function validatePresetConnectionEntry(v: unknown, path: string): PresetConnectionEntry {
  const obj = assertObject(v, path);
  const fromArr = assertArray(obj.from, `${path}.from`);
  const toArr = assertArray(obj.to, `${path}.to`);
  const state = assertString(obj.state, `${path}.state`);
  const source = assertString(obj.source, `${path}.source`);
  if (state !== "wall" && state !== "passage" && state !== "one_way_forward" && state !== "one_way_backward" && state !== "undefined")
    throw new Error(`Invalid preset connection state at ${path}.state: ${state}`);
  if (source !== "user" && source !== "default")
    throw new Error(`Invalid preset connection source at ${path}.source: ${source}`);
  return {
    from: [assertNumber(fromArr[0], `${path}.from[0]`), assertNumber(fromArr[1], `${path}.from[1]`)],
    to: [assertNumber(toArr[0], `${path}.to[0]`), assertNumber(toArr[1], `${path}.to[1]`)],
    state: state as PresetConnectionEntry["state"],
    source: source as "user" | "default",
  };
}

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

  // quality
  const qualObj = assertObject(migrated.quality, "quality");
  const selectedChecks = assertArray(qualObj.selectedChecks, "quality.selectedChecks").map((v, i) => assertString(v, `quality.selectedChecks[${i}]`));
  const selectedStrategies = assertStringRecord(qualObj.selectedStrategies, "quality.selectedStrategies");
  const checkParams = assertStringRecordRecord(qualObj.checkParams, "quality.checkParams");
  const strategyParams = assertStringRecordRecord(qualObj.strategyParams, "quality.strategyParams");

  // presets
  const presetsObj = assertObject(migrated.presets, "presets");
  const connectionsArr = assertArray(presetsObj.connections, "presets.connections");
  const connections: [string, PresetConnectionEntry][] = connectionsArr.map((entry, i) => {
    const pair = assertArray(entry, `presets.connections[${i}]`);
    return [
      assertString(pair[0], `presets.connections[${i}][0]`),
      validatePresetConnectionEntry(pair[1], `presets.connections[${i}][1]`),
    ];
  });
  const lockedNodesArr = assertArray(presetsObj.lockedNodes, "presets.lockedNodes");
  const lockedNodes: [string, NodeLockKind][] = lockedNodesArr.map((entry, i) => {
    const pair = assertArray(entry, `presets.lockedNodes[${i}]`);
    const kind = assertString(pair[1], `presets.lockedNodes[${i}][1]`);
    if (kind !== "in" && kind !== "out" && kind !== "both")
      throw new Error(`Invalid NodeLockKind at presets.lockedNodes[${i}][1]: ${kind}`);
    return [assertString(pair[0], `presets.lockedNodes[${i}][0]`), kind as NodeLockKind];
  });
  const defaultEdgeState = assertString(presetsObj.defaultEdgeState, "presets.defaultEdgeState");
  if (defaultEdgeState !== "undefined" && defaultEdgeState !== "wall" && defaultEdgeState !== "passage")
    throw new Error(`Invalid defaultEdgeState: ${defaultEdgeState}`);
  const autoLock = assertBoolean(presetsObj.autoLock, "presets.autoLock");
  const presetStart = presetsObj.start === null || presetsObj.start === undefined ? null : validateCoordPair(presetsObj.start, "presets.start");
  const presetFinish = presetsObj.finish === null || presetsObj.finish === undefined ? null : validateCoordPair(presetsObj.finish, "presets.finish");
  const genSource = presetsObj.genSource === null || presetsObj.genSource === undefined ? null : validateCoordPair(presetsObj.genSource, "presets.genSource");

  // postEdit
  const postEdit = migrated.postEdit === null || migrated.postEdit === undefined
    ? null
    : validatePostEdit(migrated.postEdit);

  // analytics
  const analyticsObj = assertObject(migrated.analytics, "analytics");
  const analytics: ProjectFileAnalytics = {
    showMazeOverlay: assertBoolean(analyticsObj.showMazeOverlay, "analytics.showMazeOverlay"),
    showComponentsOverlay: assertBoolean(analyticsObj.showComponentsOverlay, "analytics.showComponentsOverlay"),
    showGraphOverlay: assertBoolean(analyticsObj.showGraphOverlay, "analytics.showGraphOverlay"),
    showNavGraphOverlay: assertBoolean(analyticsObj.showNavGraphOverlay, "analytics.showNavGraphOverlay"),
    showRouteOverlay: assertBoolean(analyticsObj.showRouteOverlay, "analytics.showRouteOverlay"),
  };

  // debug (optional section — defaults for old files)
  const debugObj = migrated.debug != null ? assertObject(migrated.debug, "debug") : null;
  const debug: ProjectFileDebug = {
    debugMode: debugObj != null && typeof debugObj.debugMode === "boolean" ? debugObj.debugMode : false,
    showDebugFrontier: debugObj != null && typeof debugObj.showDebugFrontier === "boolean" ? debugObj.showDebugFrontier : true,
    debugStep: debugObj != null && typeof debugObj.debugStep === "number" ? debugObj.debugStep : 0,
    debugAutoPlayDelay: debugObj != null && typeof debugObj.debugAutoPlayDelay === "number" ? debugObj.debugAutoPlayDelay : 200,
  };

  // ui (optional section — defaults for old files)
  const uiObj = migrated.ui != null ? assertObject(migrated.ui, "ui") : null;
  const validFeatureIds: FeatureId[] = ["basic_config", "field_setup", "preset_connections", "quality", "generation", "post_edit", "analytics"];
  const ui: ProjectFileUi = {
    showPresetOrigin: uiObj != null && typeof uiObj.showPresetOrigin === "boolean" ? uiObj.showPresetOrigin : false,
    showFieldOrigin: uiObj != null && typeof uiObj.showFieldOrigin === "boolean" ? uiObj.showFieldOrigin : true,
    openCard: uiObj != null && typeof uiObj.openCard === "string" && validFeatureIds.includes(uiObj.openCard as FeatureId) ? uiObj.openCard as FeatureId : "basic_config",
    postEditAutoConfirm: uiObj != null && typeof uiObj.postEditAutoConfirm === "boolean" ? uiObj.postEditAutoConfirm : true,
  };

  return {
    version: CURRENT_VERSION,
    tessellation: { config, savedConfigs },
    generation: { seed, randomSeed, initial, elements },
    quality: { selectedChecks, selectedStrategies, checkParams, strategyParams },
    presets: {
      connections,
      lockedNodes,
      defaultEdgeState: defaultEdgeState as "undefined" | "wall" | "passage",
      autoLock,
      start: presetStart,
      finish: presetFinish,
      genSource,
    },
    postEdit,
    analytics,
    debug,
    ui,
  };
}

// ─── Serializer ──────────────────────────────────────────────────────────────

export function serializeProject(state: MazeState): ProjectFile {
  // Save draft (unconfirmed edits) — postEditDraftEdges is always the authoritative working copy
  const postEdit: ProjectFilePostEdit | null = state.postEditDraftEdges !== null
    ? {
        edges: Object.entries(state.postEditDraftEdges) as [string, PostEditEdge][],
        meta: state.postEditDraftMeta,
      }
    : null;

  return {
    version: CURRENT_VERSION,
    tessellation: {
      config: state.tessellationConfig,
      savedConfigs: Object.values(state.savedConfigs) as TessellationConfig[],
    },
    generation: {
      seed: state.seed,
      randomSeed: state.randomSeed,
      initial: state.initialConfig,
      elements: state.elementsConfig,
    },
    quality: {
      selectedChecks: state.selectedChecks,
      selectedStrategies: state.selectedStrategies,
      checkParams: state.checkParams,
      strategyParams: state.strategyParams,
    },
    presets: {
      connections: Array.from(state.presetConnections.entries()),
      lockedNodes: Array.from(state.lockedNodes.entries()),
      defaultEdgeState: state.defaultEdgeState,
      autoLock: state.autoLock,
      start: state.presetStart,
      finish: state.presetFinish,
      genSource: state.presetGenSource,
    },
    postEdit,
    analytics: {
      showMazeOverlay: state.showMazeOverlay,
      showComponentsOverlay: state.showComponentsOverlay,
      showGraphOverlay: state.showGraphOverlay,
      showNavGraphOverlay: state.showNavGraphOverlay,
      showRouteOverlay: state.showRouteOverlay,
    },
    debug: {
      debugMode: state.debugMode,
      showDebugFrontier: state.showDebugFrontier,
      debugStep: state.debugStep,
      debugAutoPlayDelay: state.debugAutoPlayDelay,
    },
    ui: {
      showPresetOrigin: state.showPresetOrigin,
      showFieldOrigin: state.showFieldOrigin,
      openCard: state.openCard,
      postEditAutoConfirm: state.postEditAutoConfirm,
    },
  };
}

// ─── Download helper ─────────────────────────────────────────────────────────

export function downloadProjectFile(state: MazeState): void {
  const data = serializeProject(state);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "maze-project.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
