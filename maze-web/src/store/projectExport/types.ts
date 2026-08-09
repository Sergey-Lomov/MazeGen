import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { NodeLockKind, InitialGenerationConfig, ElementsConfig, SplitPattern } from "../../wasm/types";
import type { PresetConnectionEntry, PresetTeleportEntry } from "../../pixi/fieldEditUtils";
import type { PresetEndpoint } from "../../pixi/presetEndpoint";
import type { PostEditEdge, PostEditMeta, PostEditTeleportEntry, FeatureId, RenderModeId } from "../mazeStore";
import type { VectorByWallsSettings, VectorByCorridorsSettings, PngExportSettings } from "../storeTypes";

export interface ProjectFilePostEdit {
  edges: [string, PostEditEdge][];
  meta: PostEditMeta | null;
  teleports: PostEditTeleportEntry[];
  /** slotIds of each split point's extra nodes, keyed by "x,y" (GitHub issue #221). Without this,
   * saving/reloading a project would silently lose every manually created split point. */
  splitPoints: Record<string, number[]>;
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
}

/** A named, ordered group of rule ids — see GitHub issue #65 and `RepairStageState`'s doc
 * comment in storeTypes.ts. Flat sibling of `ProjectFileQcRule[]`, nothing computed on load. */
export interface ProjectFileStage {
  id: string;
  name: string;
  ruleIds: string[];
  disabled: boolean;
}

export interface ProjectFile {
  version: number;
  tessellation: { config: TessellationConfig; savedConfigs: TessellationConfig[] };
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
}

export const CURRENT_VERSION = 2;
