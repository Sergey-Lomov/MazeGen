import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { NodeLockKind, InitialGenerationConfig, ElementsConfig, SplitPattern } from "../../wasm/types";
import type { PresetConnectionEntry, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../../pixi/fieldEditUtils";
import type { PresetEndpoint } from "../../pixi/presetEndpoint";
import type { FeatureId, RenderModeId, LinkIconVisibility, BackgroundImageLayerMode } from "../mazeStore";
import type { PostEditCommand } from "../postEditCommandTypes";
import type { VectorByWallsSettings, VectorByCorridorsSettings, PngExportSettings, HexOrientation, TriOrientation } from "../storeTypes";
import type { ParamLink } from "../parameterLinks";
import type { VectorByWallsParamPath, VectorByCorridorsParamPath } from "../parameterLinksRegistry";

export interface ProjectFileBackgroundImage {
  dataUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Optional source-image crop rectangle; absent means the complete image. */
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  displayWidth: number;
  displayHeight: number;
  centerX: number;
  centerY: number;
  /** Optional for files saved before background-image settings existed; defaults to below_grid. */
  layer?: BackgroundImageLayerMode;
  /** Optional for files saved before background-image settings existed; defaults to 0.5. */
  opacity?: number;
}

/** Replayable command log (GitHub issue #543) — replaces the old per-entity draft snapshot +
 * suppression-set persistence shape. `commands` replays on top of the freshly-regenerated
 * baseline at load time (see `mazeStore.ts`'s load path); the high-water marks are persisted
 * separately from the log and never recomputed as max-of-log, since a point-reset can prune a
 * previously-issued high id out of the log while the mark itself must never go backwards (or a
 * later id could be reissued and collide with something still referenced elsewhere in the file).
 * Breaking change from the old per-entity shape — no migration, `CURRENT_VERSION` bumped. */
export interface ProjectFilePostEdit {
  commands: PostEditCommand[];
  nextTeleportId: number;
  nextVerticalPassageId: number;
  nextElevatorId: number;
  /** Per point key ("x,y" or "x,y@level") high-water mark for that point's split slot ids. */
  nextSplitSlotId: Record<string, number>;
  /** High-water mark for split point (whole-tile) ids (GitHub issue #564). */
  nextSplitPointId: number;
}

export interface ProjectFileAnalytics {
  showMazeOverlay: boolean;
  showComponentsOverlay: boolean;
  showGraphOverlay: boolean;
  showNavGraphOverlay: boolean;
  showPureCyclesOverlay: boolean;
  showRouteOverlay: boolean;
  showRegionClassesOverlay: boolean;
  sectionsExpanded: Record<string, boolean>;
}

export interface ProjectFileDebug {
  debugMode: boolean;
  debugStep: number;
  debugAutoPlayDelay: number;
}

export interface ProjectFileUi {
  showPresetOrigin: boolean;
  showPresetLocks: boolean;
  showFieldOrigin: boolean;
  openCard: FeatureId;
  postEditAutoConfirm: boolean;
}

/** Image Export feature's persisted state (GitHub issue #295) — `activeRenderMode`/
 * `openRenderModeSettings` degrade to `null` on load if they name an unknown/future
 * `RenderModeId` (same "never throw" convention `resolveRenderMode` itself uses). */
export interface ProjectFileImageExport {
  activeRenderMode: RenderModeId | null;
  openRenderModeSettings: RenderModeId | null;
  vectorByWallsSettings: VectorByWallsSettings;
  /** Expanded/collapsed state per "Vector by walls" settings section, keyed by section id —
   * mirrors `analytics.sectionsExpanded`. */
  vectorByWallsSectionsExpanded: Record<string, boolean>;
  showColorWarnings: boolean;
  /** GitHub issue #652 follow-up — see `ImageExportState.linkIconVisibility`'s own doc comment. */
  linkIconVisibility: LinkIconVisibility;
  vectorByCorridorsSettings: VectorByCorridorsSettings;
  /** Expanded/collapsed state per "Vector by corridors" settings section, keyed by section id —
   * mirrors `vectorByWallsSectionsExpanded`. */
  vectorByCorridorsSectionsExpanded: Record<string, boolean>;
  pngExportSettings: PngExportSettings;
  /** See `ImageExportState.floorLabelModeChosen`. */
  floorLabelModeChosen: boolean;
  /** `vectorByWallsSettings.links`, persisted only when it deviates from
   * `DEFAULT_VECTOR_BY_WALLS_LINKS` (GitHub issue #651) — `null` for a project untouched since
   * load (or saved before this issue existed), meaning "use the current defaults as-is" rather than
   * freezing today's defaults into the file; a non-`null` value is the full link list verbatim. */
  vectorByWallsLinks: ParamLink<VectorByWallsParamPath>[] | null;
  /** Same role as `vectorByWallsLinks`, for `vectorByCorridorsSettings.links` against
   * `DEFAULT_VECTOR_BY_CORRIDORS_LINKS`. */
  vectorByCorridorsLinks: ParamLink<VectorByCorridorsParamPath>[] | null;
}

/** Floor list — GitHub issue #335, epic #333. See `FloorsState`'s doc comment for why
 * `nextFloorNumber` must be persisted rather than recomputed from `floors` on load. */
export interface ProjectFileFloors {
  floors: { id: string; title: string; titleCustomized?: boolean }[];
  nextFloorNumber: number;
  /** Active floor selection (GitHub issue #354) — absent in project files saved before this
   * issue, defaulting to `floors[0].id` on load (see `validateFloors` in validatePrimitives.ts). */
  activeFloorId: string;
}

/** One floor's own field-shape state — GitHub issue #338. Mirrors `FloorFieldConfig`
 * (storeTypes.ts), minus `fieldPoints`/`isEditingField` (both re-derived on load from
 * `freeFieldPoints`/shape, same as the pre-#338 maze-wide `tessellation` section always did). */
export interface ProjectFileFloorField {
  config: TessellationConfig;
  savedConfigs: TessellationConfig[];
  /** Per-kind free-field points, as flat coordinate arrays keyed by kind. */
  freeFieldPoints: Record<"square" | "hex" | "triangle" | "cairo", [number, number][]>;
  fieldEditMode: "default" | "custom";
}

export interface ProjectFileDirtyFlags {
  postEdit: boolean;
  field: boolean;
  presets: boolean;
  maze: boolean;
}

/** One active check, inlined inside its owning rule — see GitHub issue #60. `localId` is unique
 * only within this rule's `checks`, not globally; not stable across save/load cycles (see
 * `CheckInstance`'s doc comment in storeTypes.ts) — only uniqueness-at-load-time matters. */
export interface ProjectFileCheckInstance {
  localId: number;
  typeId: string;
  params: Record<string, string>;
  disabled: boolean;
}

/** Mirrors `NestedStrategyState` — see its doc comment in storeTypes.ts. Recursive. */
export interface ProjectFileNestedStrategy {
  slotId: string;
  strategyId: string;
  params: Record<string, string>;
  nested: ProjectFileNestedStrategy[];
}

export interface ProjectFileQcRule {
  id: string;
  /** Mirrors `QcRuleState.name` — `null` means "no custom name" (GitHub issue #556). */
  name: string | null;
  kind: string;
  checks: ProjectFileCheckInstance[];
  strategyId: string | null;
  disabled: boolean;
  ruleDisabled: boolean;
  nestedStrategies: ProjectFileNestedStrategy[];
  /** Mirrors `QcRuleState.params` — rule-level parameters (GitHub issue #253). */
  params: Record<string, string>;
  /** Mirrors `QcRuleState.collapsed` — UI-only rule card collapse state (GitHub issue #320). */
  collapsed: boolean;
}

/** A named, ordered group of rule ids — see GitHub issue #65 and `RepairStageState`'s doc
 * comment in storeTypes.ts. Flat sibling of `ProjectFileQcRule[]`, nothing computed on load. */
export interface ProjectFileStage {
  id: string;
  name: string;
  ruleIds: string[];
  disabled: boolean;
  /** Mirrors `RepairStageState.collapsed` — UI-only stage section collapse state (GitHub issue
   * #320). */
  collapsed: boolean;
}

/** Quality control settings — the project file's `quality` section, also the whole payload of a
 *  quality preset (`QualityPresetFile`). */
export interface ProjectFileQuality {
  rules: ProjectFileQcRule[];
  stages: ProjectFileStage[];
  strategyParams: Record<string, Record<string, string>>;
  repairMaxIterations: number | null;
  repairTimeBudgetSecs: number | null;
}

export interface ProjectFile {
  version: number;
  /** Maze-wide kind/orientation confirmation only (Specs/field-editor.md) — per-floor field shape
   * moved to `floorFields` (GitHub issue #338). `hexOrientation`/`triOrientation` are always
   * present (unlike the pre-#338 shape) since they're no longer derivable from a single shared
   * `config`. */
  tessellation: { kind: "square" | "hex" | "triangle" | "cairo"; hexOrientation: HexOrientation; triOrientation: TriOrientation };
  /** One entry per floor id in `floors.floors`, its own field-shape state (GitHub issue #338). */
  floorFields: Record<string, ProjectFileFloorField>;
  generation: {
    seed: number;
    randomSeed: boolean;
    initial: InitialGenerationConfig;
    elements: ElementsConfig;
    /** CustomVertexBased-only automatic split-point assignment settings (GitHub issue #222) —
     * scoped to the tessellation active when saved, same as `presets.splitPoints` below. */
    splitGeneration: {
      patternMode: boolean;
      maxSplitNodes: number;
      patterns: SplitPattern[];
    };
    qcExperiment: boolean;
    /** Whether the CustomVertexBased settings side panel was open when saved (GitHub issue #351's
     * follow-up) — restored on load so the panel reappears in the same state. */
    vertexSettingsPanelOpen: boolean;
    seedHistory: number[];
    seedHistoryIndex: number;
  };
  quality: ProjectFileQuality;
  presets: {
    connections: [string, PresetConnectionEntry][];
    lockedNodes: [string, NodeLockKind][];
    defaultEdgeState: "undefined" | "wall" | "passage";
    autoLock: boolean;
    start: PresetEndpoint | null;
    finish: PresetEndpoint | null;
    genSource: PresetEndpoint | null;
    /** Geometric fallback mode for the generation start point when `genSource` is unset (GitHub
     * issue #640) — absent in a project file saved before this issue, defaulting to `"default"`
     * on load (see `mazeStore.ts`), never `"random"`, so opening an old project never silently
     * changes its reproducibility. */
    generationSourceMode?: "default" | "random";
    teleports: PresetTeleportEntry[];
    /** Preset `VerticalPassage`/`Elevator` links (GitHub issue #357) — absent in a project file
     * saved before this issue, defaulting to empty on load (see `validate.ts`). */
    verticalPassages: PresetVerticalPassageEntry[];
    elevators: PresetElevatorEntry[];
    /** slotIds of each split point's extra nodes declared on the preset stage, keyed by "x,y"
     * (GitHub issue #231) — mirrors `postEdit.splitPoints` below. */
    splitPoints: Record<string, number[]>;
    /** Optional stable ids/order for the preset list; absent in older project files. */
    splitPointIds?: Record<string, string>;
    entityOrder?: string[];
  };
  postEdit: ProjectFilePostEdit | null;
  dirtyFlags: ProjectFileDirtyFlags;
  analytics: ProjectFileAnalytics;
  debug: ProjectFileDebug;
  ui: ProjectFileUi;
  /** Shared editor-only underlay (GitHub issue #673). */
  showBackgroundImage?: boolean;
  backgroundImage?: ProjectFileBackgroundImage | null;
  /** Shared underlay direct-manipulation mode (GitHub issue #674). */
  backgroundImageManualPositioning?: boolean;
  /** Shared underlay source-image crop mode (GitHub issue #680). */
  backgroundImageCropping?: boolean;
  imageExport: ProjectFileImageExport;
  floors: ProjectFileFloors;
}

// v4 -> v5 (GitHub issue #564): stable ids for one-way edges/split points; `suppressGenerationPair`
// and the `suppressPair(s)` fields removed; generation-baked vertical passages/elevators are now
// full baseline draft entries. Breaking, no migration — same policy as v3 -> v4.
export const CURRENT_VERSION = 5;

/** Project files are plain JSON saved under a dedicated extension, so the load dialog shows only
 *  project files (not debug configs or other JSON). */
export const PROJECT_FILE_EXTENSION = ".maze";

type PlatformInfo = Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">;

/** iOS/iPadOS file pickers map `accept` to system file types (UTIs); an unknown extension like
 *  `.maze` has none, so the picker can grey out every file. iPadOS reports a desktop Mac user agent,
 *  hence the touch-points check. */
function isIOS(nav: PlatformInfo): boolean {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

/** `accept` value for the project load dialog: the project extension, or no filter on iOS/iPadOS
 *  (see `isIOS`). */
export function projectFileAccept(nav: PlatformInfo): string | undefined {
  return isIOS(nav) ? undefined : PROJECT_FILE_EXTENSION;
}

/** Standalone visual preset (GitHub issue #750): the Image Export renderer/export settings and their
 *  parameter links, without generation settings or maze content. `kind` tells it apart from a
 *  project file, which has no `kind` field. */
export const VISUAL_PRESET_KIND = "maze-visual-preset";
export const VISUAL_PRESET_VERSION = 1;
export const VISUAL_PRESET_FILE_EXTENSION = ".mazestyle";

/** `ProjectFileImageExport` minus the per-section expanded/collapsed UI state. The renderer
 *  settings omit maze-bound data (`floorLabel.positionsByFloorId`, `teleportGroupOverrides`) when
 *  saved; loading keeps the target project's values for those. */
export type VisualPresetImageExport = Omit<ProjectFileImageExport, "openRenderModeSettings" | "vectorByWallsSectionsExpanded" | "vectorByCorridorsSectionsExpanded">;

export interface VisualPresetFile {
  kind: typeof VISUAL_PRESET_KIND;
  version: number;
  imageExport: VisualPresetImageExport;
}

/** Raised when a project file is loaded as a visual preset or the other way round, so the UI can
 *  show a dedicated message instead of a generic validation error. */
export type FileKind = "project" | "visual_preset" | "quality_preset";

export class FileKindMismatchError extends Error {
  constructor(readonly expected: FileKind, readonly found: FileKind) {
    super(`Expected a ${expected} file, got a ${found} file`);
    this.name = "FileKindMismatchError";
  }
}

/** A project file has no `kind` marker; recognize it by its mandatory top-level sections. */
export function looksLikeProjectFile(obj: Record<string, unknown>): boolean {
  return obj.kind === undefined && obj.generation != null && obj.tessellation != null;
}

/** `accept` value for the visual preset load dialog — same iOS/iPadOS exception as
 *  `projectFileAccept`. */
export function visualPresetFileAccept(nav: PlatformInfo): string | undefined {
  return isIOS(nav) ? undefined : VISUAL_PRESET_FILE_EXTENSION;
}

/** Standalone quality preset (GitHub issue #751): only the quality control settings (rules,
 *  stages, strategy params, repair limits), without anything else from the project. */
export const QUALITY_PRESET_KIND = "maze-quality-preset";
export const QUALITY_PRESET_VERSION = 1;
export const QUALITY_PRESET_FILE_EXTENSION = ".mazequality";

export interface QualityPresetFile {
  kind: typeof QUALITY_PRESET_KIND;
  version: number;
  quality: ProjectFileQuality;
}

/** `accept` value for the quality preset load dialog — same iOS/iPadOS exception as
 *  `projectFileAccept`. */
export function qualityPresetFileAccept(nav: PlatformInfo): string | undefined {
  return isIOS(nav) ? undefined : QUALITY_PRESET_FILE_EXTENSION;
}
