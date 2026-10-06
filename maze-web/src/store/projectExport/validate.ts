import {
  CURRENT_VERSION,
  type ProjectFile,
  type ProjectFileDirtyFlags,
  type ProjectFileAnalytics,
  type ProjectFileDebug,
  type ProjectFileUi,
  type ProjectFileStage,
  type ProjectFileFloors,
  type ProjectFileFloorField,
} from "./types";
import { buildPredefinedConfig } from "../storeHelpers";
import type { InitialGenerationConfig, ElementsConfig } from "../../wasm/types";
import type { FeatureId } from "../mazeStore";
import {
  assertObject, assertString, assertNumber, assertBoolean, assertArray, assertStringRecord, assertStringRecordRecord, assertBoolRecord,
  optBool, optNumber, optEnum, optSection, validateFloors, validateSplitGeneration, assertUniqueIds, validatePairArray,
} from "./validatePrimitives";
import {
  validateFloorFieldConfig, validatePostEdit, validatePresetEndpoint, validatePresetConnectionEntry, validateQcRule,
  validateQcStage, validatePresetTeleportEntry, validatePresetVerticalPassageEntry, validatePresetElevatorEntry,
  validateNodeLockKind, validateSplitPoints,
} from "./validateSections";
import { validateImageExport } from "./validateImageExport";
import type { BackgroundImageLayerMode } from "../tessellationTypes";

// ─── Migrations ──────────────────────────────────────────────────────────────
// No migrations currently registered — old files at an unregistered version fail to load with a
// clear error (see migrateToLatest below). Per project policy, migrations are added only on
// explicit user request, not automatically when a serialized shape changes.

const migrations: Record<number, (data: unknown) => unknown> = {};

function assertFiniteNumber(v: unknown, path: string): number {
  const value = assertNumber(v, path);
  if (!Number.isFinite(value)) throw new Error(`Expected finite number at ${path}`);
  return value;
}

function assertPositiveFiniteNumber(v: unknown, path: string): number {
  const value = assertFiniteNumber(v, path);
  if (value <= 0) throw new Error(`Expected positive number at ${path}`);
  return value;
}

function migrateToLatest(data: unknown, fromVersion: number): unknown {
  let result = data;
  for (let v = fromVersion; v < CURRENT_VERSION; v++) {
    const migrate = migrations[v];
    if (!migrate) throw new Error(`No migration for version ${v}`);
    result = migrate(result);
  }
  return result;
}

// ─── Top-level parse ─────────────────────────────────────────────────────────

export function parseAndValidate(raw: unknown): ProjectFile {
  const obj = assertObject(raw, "root");

  const version = assertNumber(obj.version, "version");
  if (version > CURRENT_VERSION)
    throw new Error(`File version ${version} is newer than supported (${CURRENT_VERSION})`);

  const migrated = assertObject(migrateToLatest(obj, version), "root (migrated)");

  // tessellation (kind/orientation only — per-floor field shape is `floorFields`, GitHub issue #338)
  const tessObj = assertObject(migrated.tessellation, "tessellation");
  const kind = optEnum(tessObj, "kind", ["square", "hex", "triangle"] as const, "square");
  const hexOrientation = optEnum(tessObj, "hexOrientation", ["flat_top", "pointy_top"] as const, "flat_top");
  const triOrientation = optEnum(tessObj, "triOrientation", ["r0", "r90", "r180", "r270"] as const, "r0");

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
  // Optional — absent in project files saved before the settings panel's open state became
  // persistent (GitHub issue #351's follow-up); old files default to closed.
  const vertexSettingsPanelOpen = optBool(genObj, "vertexSettingsPanelOpen", false);
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
    .map((v, i) => validateQcRule(v, `quality.rules[${i}]`))
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
    stages = [{ id: "stage_1", name: "Stage 1", ruleIds: rules.map((r) => r.id), disabled: false, collapsed: false }];
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
  // Optional — absent in project files saved before GitHub issue #640. Defaults to "default"
  // (today's centroid-nearest behavior), never "random", so opening an old project never silently
  // changes its reproducibility.
  const generationSourceMode = presetsObj.generationSourceMode === "random" ? "random" : "default";
  // Optional — absent in project files saved before preset teleports existed.
  const teleports = presetsObj.teleports != null
    ? assertArray(presetsObj.teleports, "presets.teleports").map((v, i) => validatePresetTeleportEntry(v, `presets.teleports[${i}]`))
    : [];
  assertUniqueIds(teleports, (t) => t.id, "teleport id", "presets.teleports");
  // Optional — absent in project files saved before preset vertical passages/elevators existed
  // (GitHub issue #357).
  const verticalPassages = presetsObj.verticalPassages != null
    ? assertArray(presetsObj.verticalPassages, "presets.verticalPassages").map((v, i) => validatePresetVerticalPassageEntry(v, `presets.verticalPassages[${i}]`))
    : [];
  assertUniqueIds(verticalPassages, (p) => p.id, "vertical passage id", "presets.verticalPassages");
  const elevators = presetsObj.elevators != null
    ? assertArray(presetsObj.elevators, "presets.elevators").map((v, i) => validatePresetElevatorEntry(v, `presets.elevators[${i}]`))
    : [];
  assertUniqueIds(elevators, (e) => e.id, "elevator id", "presets.elevators");
  // Optional — absent in project files saved before preset split points existed (GitHub issue #231).
  const presetSplitPoints = presetsObj.splitPoints != null ? validateSplitPoints(presetsObj.splitPoints, "presets.splitPoints") : {};
  const presetSplitPointIds = presetsObj.splitPointIds != null
    ? assertStringRecord(presetsObj.splitPointIds, "presets.splitPointIds")
    : undefined;
  const presetEntityOrder = presetsObj.entityOrder != null
    ? assertArray(presetsObj.entityOrder, "presets.entityOrder").map((key, i) => assertString(key, `presets.entityOrder[${i}]`))
    : undefined;

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
  const validFeatureIds: FeatureId[] = ["basic_config", "floors", "field_setup", "preset_connections", "quality", "generation", "post_edit", "analytics", "image_export"];
  const ui: ProjectFileUi = {
    showPresetOrigin: optBool(uiObj, "showPresetOrigin", false),
    showPresetLocks: optBool(uiObj, "showPresetLocks", true),
    showFieldOrigin: optBool(uiObj, "showFieldOrigin", true),
    openCard: uiObj != null && typeof uiObj.openCard === "string" && validFeatureIds.includes(uiObj.openCard as FeatureId) ? uiObj.openCard as FeatureId : "basic_config",
    postEditAutoConfirm: optBool(uiObj, "postEditAutoConfirm", true),
  };

  const backgroundImage = migrated.backgroundImage == null
    ? null
    : (() => {
      const image = assertObject(migrated.backgroundImage, "backgroundImage");
      return {
        dataUrl: assertString(image.dataUrl, "backgroundImage.dataUrl"),
        naturalWidth: assertPositiveFiniteNumber(image.naturalWidth, "backgroundImage.naturalWidth"),
        naturalHeight: assertPositiveFiniteNumber(image.naturalHeight, "backgroundImage.naturalHeight"),
        ...validateBackgroundCrop(image),
        displayWidth: assertPositiveFiniteNumber(image.displayWidth, "backgroundImage.displayWidth"),
        displayHeight: assertPositiveFiniteNumber(image.displayHeight, "backgroundImage.displayHeight"),
        centerX: assertFiniteNumber(image.centerX, "backgroundImage.centerX"),
        centerY: assertFiniteNumber(image.centerY, "backgroundImage.centerY"),
        layer: optEnum(image, "layer", ["below_grid", "above_grid", "above_floor", "above_everything"] as const, "below_grid") as BackgroundImageLayerMode,
        opacity: validateBackgroundOpacity(image),
      };
    })();
  const showBackgroundImage = backgroundImage !== null && optBool(migrated, "showBackgroundImage", false);
  const backgroundImageManualPositioning = optBool(migrated, "backgroundImageManualPositioning", false);
  const backgroundImageCropping = optBool(migrated, "backgroundImageCropping", false);

  // floors (optional section — defaults to a single floor for old files)
  const floors: ProjectFileFloors = validateFloors(migrated.floors, "floors");

  // floorFields (GitHub issue #338) — one entry per floor id in `floors`. A floor missing its own
  // entry (file saved before this issue, or hand-edited) falls back to the kind's bare default
  // shape, same convention `defaultFloorFieldConfig` (storeHelpers.ts) uses for a brand-new floor.
  const floorFieldsObj = migrated.floorFields != null ? assertObject(migrated.floorFields, "floorFields") : {};
  const defaultConfig = buildPredefinedConfig(kind, kind === "hex" ? "hexagon" : "parallelogram", kind === "triangle" ? "triangle" : "rect", hexOrientation, triOrientation);
  const floorFields: Record<string, ProjectFileFloorField> = {};
  for (const floor of floors.floors) {
    const raw = floorFieldsObj[floor.id];
    floorFields[floor.id] = raw != null
      ? validateFloorFieldConfig(raw, `floorFields.${floor.id}`)
      : { config: defaultConfig, savedConfigs: [defaultConfig], freeFieldPoints: { square: [], hex: [], triangle: [] }, fieldEditMode: "default" };
  }

  return {
    version: CURRENT_VERSION,
    tessellation: { kind, hexOrientation, triOrientation },
    floorFields,
    generation: { seed, randomSeed, initial, elements, splitGeneration, qcExperiment, vertexSettingsPanelOpen, seedHistory, seedHistoryIndex },
    quality: { rules, stages, strategyParams, repairMaxIterations, repairTimeBudgetSecs },
    presets: {
      connections,
      lockedNodes,
      defaultEdgeState: defaultEdgeState as "undefined" | "wall" | "passage",
      autoLock,
      start: presetStart,
      finish: presetFinish,
      genSource,
      generationSourceMode,
      teleports,
      verticalPassages,
      elevators,
      splitPoints: presetSplitPoints,
      splitPointIds: presetSplitPointIds,
      entityOrder: presetEntityOrder,
    },
    postEdit,
    dirtyFlags,
    analytics,
    debug,
    ui,
    showBackgroundImage,
    backgroundImage,
    backgroundImageManualPositioning,
    backgroundImageCropping,
    imageExport: validateImageExport(migrated.imageExport, "imageExport"),
    floors,
  };
}

function validateBackgroundOpacity(image: Record<string, unknown>): number {
  if (!("opacity" in image)) return 0.5;
  const opacity = assertFiniteNumber(image.opacity, "backgroundImage.opacity");
  if (opacity < 0 || opacity > 1) throw new Error("Expected backgroundImage.opacity between 0 and 1");
  return opacity;
}

function validateBackgroundCrop(image: Record<string, unknown>): {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
} {
  const naturalWidth = assertPositiveFiniteNumber(image.naturalWidth, "backgroundImage.naturalWidth");
  const naturalHeight = assertPositiveFiniteNumber(image.naturalHeight, "backgroundImage.naturalHeight");
  const cropX = optionalFiniteNumber(image.cropX, 0, "backgroundImage.cropX");
  const cropY = optionalFiniteNumber(image.cropY, 0, "backgroundImage.cropY");
  const cropWidth = optionalFiniteNumber(image.cropWidth, naturalWidth, "backgroundImage.cropWidth");
  const cropHeight = optionalFiniteNumber(image.cropHeight, naturalHeight, "backgroundImage.cropHeight");
  if (cropX < 0 || cropY < 0 || cropWidth <= 0 || cropHeight <= 0
    || cropX + cropWidth > naturalWidth || cropY + cropHeight > naturalHeight) {
    throw new Error("Expected backgroundImage crop to be inside the source image");
  }
  return { cropX, cropY, cropWidth, cropHeight };
}

function optionalFiniteNumber(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  return assertFiniteNumber(value, path);
}
