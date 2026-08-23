import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { NodeLockKind, InitialGenerationConfig, ElementsConfig, SplitPattern } from "../../wasm/types";
import type { PresetConnectionEntry, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../../pixi/fieldEditUtils";
import type { PresetEndpoint } from "../../pixi/presetEndpoint";
import type { PostEditEdge, PostEditMeta, PostEditTeleportEntry, PostEditVerticalPassageEntry, PostEditElevatorEntry, FeatureId, RenderModeId } from "../mazeStore";
import type { VectorByWallsSettings, VectorByCorridorsSettings, PngExportSettings, HexOrientation, TriOrientation } from "../storeTypes";

export interface ProjectFilePostEdit {
  edges: [string, PostEditEdge][];
  meta: PostEditMeta | null;
  teleports: PostEditTeleportEntry[];
  /** slotIds of each split point's extra nodes, keyed by "x,y" (GitHub issue #221). Without this,
   * saving/reloading a project would silently lose every manually created split point. */
  splitPoints: Record<string, number[]>;
  /** User-placed vertical passages/elevators (GitHub issue #341) — optional, absent in project
   * files saved before this feature existed. */
  verticalPassages: PostEditVerticalPassageEntry[];
  elevators: PostEditElevatorEntry[];
  /** Node-id pairs (`"min,max"`) of generation-time `elevator` edges suppressed by an elevator edit
   * (GitHub issue #341 follow-up) — without this, reloading a project would silently resurrect a
   * generation-time floor connection the user had explicitly removed via the elevator dialog. */
  suppressedElevatorPairs: string[];
  /** Node-id pairs (`"min,max"`) of generation-time `vertical_passage` edges suppressed by a
   * vertical-passage edit (GitHub issue #341 follow-up) — mirrors `suppressedElevatorPairs`. */
  suppressedVerticalPassagePairs: string[];
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
  vectorByCorridorsSettings: VectorByCorridorsSettings;
  /** Expanded/collapsed state per "Vector by corridors" settings section, keyed by section id —
   * mirrors `vectorByWallsSectionsExpanded`. */
  vectorByCorridorsSectionsExpanded: Record<string, boolean>;
  pngExportSettings: PngExportSettings;
}

/** Floor list — GitHub issue #335, epic #333. See `FloorsState`'s doc comment for why
 * `nextFloorNumber` must be persisted rather than recomputed from `floors` on load. */
export interface ProjectFileFloors {
  floors: { id: string; title: string }[];
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
  freeFieldPoints: Record<"square" | "hex" | "triangle", [number, number][]>;
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
  name: string;
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

export interface ProjectFile {
  version: number;
  /** Maze-wide kind/orientation confirmation only (Specs/field-editor.md) — per-floor field shape
   * moved to `floorFields` (GitHub issue #338). `hexOrientation`/`triOrientation` are always
   * present (unlike the pre-#338 shape) since they're no longer derivable from a single shared
   * `config`. */
  tessellation: { kind: "square" | "hex" | "triangle"; hexOrientation: HexOrientation; triOrientation: TriOrientation };
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
    seedHistory: number[];
    seedHistoryIndex: number;
  };
  quality: {
    rules: ProjectFileQcRule[];
    stages: ProjectFileStage[];
    strategyParams: Record<string, Record<string, string>>;
    repairMaxIterations: number | null;
    repairTimeBudgetSecs: number | null;
  };
  presets: {
    connections: [string, PresetConnectionEntry][];
    lockedNodes: [string, NodeLockKind][];
    defaultEdgeState: "undefined" | "wall" | "passage";
    autoLock: boolean;
    start: PresetEndpoint | null;
    finish: PresetEndpoint | null;
    genSource: PresetEndpoint | null;
    teleports: PresetTeleportEntry[];
    /** Preset `VerticalPassage`/`Elevator` links (GitHub issue #357) — absent in a project file
     * saved before this issue, defaulting to empty on load (see `validate.ts`). */
    verticalPassages: PresetVerticalPassageEntry[];
    elevators: PresetElevatorEntry[];
    /** slotIds of each split point's extra nodes declared on the preset stage, keyed by "x,y"
     * (GitHub issue #231) — mirrors `postEdit.splitPoints` below. */
    splitPoints: Record<string, number[]>;
  };
  postEdit: ProjectFilePostEdit | null;
  dirtyFlags: ProjectFileDirtyFlags;
  analytics: ProjectFileAnalytics;
  debug: ProjectFileDebug;
  ui: ProjectFileUi;
  imageExport: ProjectFileImageExport;
  floors: ProjectFileFloors;
}

export const CURRENT_VERSION = 3;
